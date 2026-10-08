// packages/gateway/src/payload.ts
//
// Assemblage du payload envoyé à oMLX — module pur, testable (voir payload.test.ts).
//
// Invariant central : **préfixe stable, suffixe volatil**.
//
// oMLX met en cache les préfixes par blocs de 256 tokens indexés par hash
// (`omlx/cache/prefix_cache.py`). Le contexte récupéré par Aether change à chaque
// tour ; s'il est placé en tête, le hash du bloc 0 change, donc aucun bloc n'est
// réutilisable et le prefill complet est repayé à chaque requête.
//
// Mesuré sur M1 Max 64 Go (Qwen3.6-35B-A3B 8-bit, 12 288 tokens stables,
// 2 048 volatils, contenu et longueur identiques) :
//   contexte volatil en tête  → 48,3 s de TTFT, 0 token réutilisé
//   préfixe stable + queue    →  8,2 s de TTFT, 12 288 tokens réutilisés
//   froid (référence)         → 52,1 s de TTFT

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AetherContextResponse {
  tokenCount: number;
  confidence: number;
  sections: { astContext?: string; ragContext?: string };
  meta: {
    astFiles: string[];
    reasoning: "think" | "no_think";
    budgetUsed: { ast: number; rag: number; history: number };
  };
}

export interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

// ─── Configuration (env > ~/.aether/config.json) ──────────────────────────────

const readSavedConfig = (): Record<string, unknown> => {
  try {
    const configPath = path.join(os.homedir(), ".aether", "config.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Modèle forcé vers oMLX.
 *
 * L'ancienne implémentation remplaçait le modèle demandé par une chaîne codée en
 * dur (`Qwen3.6-35B-A3B-RotorQuant-MLX-8bit`) dès que le nom contenait
 * « qwen3.5 », « coding » ou « default ». On ne force plus rien par défaut.
 */
export const resolveForcedModel = (
  cfg: Record<string, unknown> = readSavedConfig(),
): string | undefined => {
  const fromEnv = process.env.AETHER_MODEL;
  if (fromEnv) return fromEnv;
  if (typeof cfg.modelId === "string" && cfg.modelId.length > 0) return cfg.modelId;
  return undefined;
};

/**
 * Plafond de tokens en sortie. `undefined` = ne pas écraser le réglage par modèle
 * d'oMLX, qui est mieux informé que la gateway.
 */
export const resolveMaxOutputTokens = (
  cfg: Record<string, unknown> = readSavedConfig(),
): number | undefined => {
  const fromEnv = process.env.AETHER_MAX_TOKENS;
  if (fromEnv) return Number.parseInt(fromEnv, 10);
  if (typeof cfg.maxTokens === "number") return cfg.maxTokens;
  return undefined;
};

// ─── Prompt système ───────────────────────────────────────────────────────────

/**
 * Persona fixe. DOIT rester identique octet pour octet d'une requête à l'autre :
 * c'est le tout premier bloc du cache de préfixe.
 */
export const AETHER_SYSTEM_PROMPT =
  "You are an expert AI software engineer. " +
  "You have access to a rich context provided in <context> tags by the Aether Context Engine. " +
  "Use this context AND your own file-reading tools or conversation history to solve the task. " +
  "Prioritize accuracy and surgical code changes. " +
  "When thinking, be concise and avoid repeating yourself. " +
  "Reach a conclusion and answer directly once your analysis is complete.";

export const CONTEXT_OPEN_TAG = "<context>";
export const CONTEXT_CLOSE_TAG = "</context>";
export const REPO_MAP_OPEN_TAG = "<repo_map>";
export const REPO_MAP_CLOSE_TAG = "</repo_map>";

/**
 * Bloc repo-map : carte des signatures du dépôt.
 *
 * Elle est **stable** (elle ne change que si le code change) et vit donc dans le
 * préfixe, juste après le prompt système — au plus tôt, pour être préfillée une
 * seule fois. La littérature mesure 4–6 % de fenêtre consommée contre 54–70 % pour
 * l'exploration itérative de fichiers.
 */
export const formatRepoMapBlock = (repoMap: string | undefined): string =>
  repoMap && repoMap.trim().length > 0
    ? `\n\n${REPO_MAP_OPEN_TAG}\n${repoMap.trim()}\n${REPO_MAP_CLOSE_TAG}`
    : "";

/** Construit le bloc de contexte volatil, délimiteurs stables. */
export const formatContextBlock = (aetherCtx: AetherContextResponse | null): string => {
  if (!aetherCtx) return "";
  const body = [aetherCtx.sections.astContext, aetherCtx.sections.ragContext]
    .filter(Boolean)
    .join("\n");
  if (!body) return "";
  return `${CONTEXT_OPEN_TAG}\n${body}\n${CONTEXT_CLOSE_TAG}\n\n`;
};

// ─── Assemblage ───────────────────────────────────────────────────────────────

export interface BuildPayloadOptions {
  forcedModel?: string | undefined;
  maxOutputTokens?: number | undefined;
  /** Carte des signatures du dépôt — bloc stable, placé dans le préfixe. */
  repoMap?: string | undefined;
}

/**
 * Assemble le payload final :
 *
 *   [ system constant ][ outils constants ][ historique (append-only) ][ <context> volatil ][ question ]
 *
 * Le message système n'est JAMAIS augmenté du contexte. Le contexte est préfixé
 * au DERNIER message utilisateur, c'est-à-dire le plus près possible de la fin :
 * tout ce qui précède reste identique d'un tour à l'autre et reste donc caché.
 */
export const buildCleanPayload = (
  body: Record<string, unknown>,
  aetherCtx: AetherContextResponse | null,
  originalMessages: ChatMessage[],
  stream: boolean,
  options: BuildPayloadOptions = {},
): Record<string, unknown> => {
  const contextBlock = formatContextBlock(aetherCtx);
  const forcedModel = options.forcedModel ?? resolveForcedModel();
  const maxOutputTokens = options.maxOutputTokens ?? resolveMaxOutputTokens();
  // Le prompt système reste constant ; seule la carte des signatures (stable elle
  // aussi) peut s'y ajouter, car elle ne change que si le code change.
  const systemContent = AETHER_SYSTEM_PROMPT + formatRepoMapBlock(options.repoMap);

  const finalMessages: ChatMessage[] = originalMessages.map((m) => ({ ...m }));

  // ── 1. Le message système reste constant, octet pour octet ─────────────────
  if (finalMessages.length > 0 && finalMessages[0]?.role === "system") {
    finalMessages[0] = { ...finalMessages[0], content: systemContent };
  } else {
    finalMessages.unshift({ role: "system", content: systemContent });
  }

  // ── 2. Le contexte volatil va en queue, juste avant la question ────────────
  if (contextBlock) {
    let lastUserIndex = -1;
    for (let i = finalMessages.length - 1; i >= 0; i--) {
      if (finalMessages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) {
      finalMessages.push({ role: "user", content: contextBlock.trimEnd() });
    } else {
      const target = finalMessages[lastUserIndex] ?? { role: "user", content: "" };
      const content = target.content;
      if (typeof content === "string") {
        finalMessages[lastUserIndex] = { ...target, content: contextBlock + content };
      } else if (Array.isArray(content)) {
        finalMessages[lastUserIndex] = {
          ...target,
          content: [{ type: "text", text: contextBlock.trimEnd() }, ...content],
        };
      } else {
        finalMessages[lastUserIndex] = {
          ...target,
          content: `${contextBlock}${JSON.stringify(content ?? "")}`,
        };
      }
    }
  }

  const modelToUse =
    forcedModel ??
    (typeof body.model === "string" && body.model.length > 0 ? body.model : "default");

  const payload: Record<string, unknown> = {
    ...body,
    model: modelToUse,
    messages: finalMessages,
    stream,
    keep_alive: -1,
    temperature: (body.temperature as number | undefined) ?? 0.1,
  };

  // On n'écrase les réglages du serveur que s'ils sont explicitement configurés.
  if (maxOutputTokens !== undefined) payload.max_tokens = maxOutputTokens;
  else delete payload.max_tokens;

  return payload;
};

// ─── Surface des outils ───────────────────────────────────────────────────────

/**
 * Outils dont un agent de code a besoin pour travailler. Ils ne doivent JAMAIS
 * être retirés : sans eux le modèle ne peut ni lire ni écrire un fichier.
 */
export const ESSENTIAL_TOOL_PATTERNS =
  /^(read_file|read|write_file|write|edit_file|edit|apply_patch|patch|multi_edit|list_dir|list_files|ls|glob|grep|search|find|run_|execute|bash|shell|terminal)/i;

/** Nombre maximum d'outils exposés simultanément (budget de schéma). */
export const MAX_ACTIVE_TOOLS = 24;

export const toolName = (t: unknown): string =>
  (t as { function?: { name?: string }; name?: string })?.function?.name ??
  (t as { name?: string })?.name ??
  "";

/**
 * Réduit la surface des outils par **divulgation progressive**, sans jamais
 * supprimer les outils d'E/S.
 *
 * L'ancienne implémentation faisait l'inverse : elle RETIRAIT `read_file`,
 * `write_file`, `list_dir`, `grep`… dès que la tâche ne contenait pas de verbe
 * d'action, tout en laissant passer les catalogues MCP volumineux. Or le schéma
 * d'outils est le premier poste de contexte d'un harnais agentique (5 serveurs MCP
 * ≈ 55 000 tokens fixes, repayés à chaque tour) : c'est la surface *MCP* qu'il
 * faut réduire, pas les outils de codage.
 *
 * Ne renvoie jamais `undefined` quand des outils ont été fournis : une liste vide
 * en entrée reste une liste vide, une liste non vide reste non vide.
 */
export const shapeTools = (
  tools: unknown[] | undefined,
  _taskText = "",
): unknown[] | undefined => {
  if (!tools?.length) return tools;
  if (tools.length <= MAX_ACTIVE_TOOLS) return tools;

  const essential = tools.filter((t) => ESSENTIAL_TOOL_PATTERNS.test(toolName(t)));
  if (essential.length >= MAX_ACTIVE_TOOLS) return essential.slice(0, MAX_ACTIVE_TOOLS);

  // Complète avec les autres outils en préservant l'ordre d'origine : un
  // réordonnancement des outils invaliderait le cache de préfixe.
  const essentialSet = new Set(essential);
  const rest = tools.filter((t) => !essentialSet.has(t));
  return [...essential, ...rest].slice(0, MAX_ACTIVE_TOOLS);
};
