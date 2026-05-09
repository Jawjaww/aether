// packages/core/src/reasoning/selector.ts
//
// Task Classifier & Reasoning Selector for the Aether Context Pipeline.
//
// Key changes vs. original:
//  1. Replaces cyclomatic-score thresholding with a heuristic TaskType classifier
//     that operates on the natural-language task request, not on AST complexity.
//  2. Adds a `confidence` score (0–1). When confidence < 0.6, the classifier
//     escalates to the next-higher budget tier to avoid under-provisioning.
//  3. `requiresThinking` is now derived from task complexity, not file depth.
//  4. Auto-calibration telemetry schema is preserved and extended with taskType.

import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── Task Types & Budgets ─────────────────────────────────────────────────────

export type TaskType =
  | "read_local"       // "Explain / summarise" — minimal context needed
  | "write_local"      // "Add parameter / fix this function"
  | "cross_file"       // "Refactor X to use Y everywhere"
  | "debug"            // "Why does this crash / fail / error?"
  | "generate_tests";  // "Write unit tests for…"

/** Token budgets per task type. */
export const BUDGET_BY_TASK: Record<TaskType, number> = {
  read_local:      3_000,
  write_local:     5_000,
  cross_file:     10_000,
  debug:          12_000,
  generate_tests:  6_000,
};

/** Task types that always benefit from extended thinking. */
const THINKING_TASKS = new Set<TaskType>(["debug", "cross_file"]);

// ─── Classification Result ────────────────────────────────────────────────────

export interface ClassificationResult {
  taskType: TaskType;
  /** 0–1. Low confidence (<0.6) causes automatic budget escalation. */
  confidence: number;
  /** Token budget, already escalated if confidence is low. */
  budgetTokens: number;
  /** Whether to prefix the prompt with /think for extended reasoning. */
  requiresThinking: boolean;
}

// ─── Heuristic patterns ───────────────────────────────────────────────────────
// Each rule is evaluated in order; first match wins.
// `patterns` are tested against the lowercased task text.

type TaskRule = {
  taskType: TaskType;
  patterns: RegExp[];
  baseConfidence: number;
};

const TASK_RULES: TaskRule[] = [
  {
    taskType: "debug",
    patterns: [
      /\b(bug|crash|error|exception|broken|fail(s|ing|ed)?|doesn'?t work|not working|unexpected)\b/i,
      /\bwhy (does|is|did)\b/i,
      /\bfix\b.*\b(crash|error|bug)\b/i,
    ],
    baseConfidence: 0.8,
  },
  {
    taskType: "cross_file",
    patterns: [
      /\b(refactor|rename|move|extract|migrate)\b/i,
      /\b(across|throughout|everywhere|all files?|whole (codebase|project))\b/i,
      /\b(update|change).*\b(import|export|usage|reference)\b/i,
    ],
    baseConfidence: 0.75,
  },
  {
    taskType: "generate_tests",
    patterns: [
      /\b(test|tests|spec|specs|jest|vitest|unit test|coverage)\b/i,
      /\b(write|generate|add|create)\b.*\btest\b/i,
    ],
    baseConfidence: 0.85,
  },
  {
    taskType: "write_local",
    patterns: [
      /\b(add|implement|write|create|update|change|modify|delete|remove)\b/i,
      /\b(parameter|prop|field|method|function|class|component|handler)\b/i,
    ],
    baseConfidence: 0.65,
  },
  {
    taskType: "read_local",
    patterns: [
      /\b(explain|describe|what (does|is)|how (does|is|do)|summaris[ez]|show me)\b/i,
      /\b(understand|overview|documentation|doc)\b/i,
    ],
    baseConfidence: 0.7,
  },
];

// Ordered budget escalation chain
const ESCALATION_ORDER: TaskType[] = [
  "read_local",
  "write_local",
  "generate_tests",
  "cross_file",
  "debug",
];

const escalate = (taskType: TaskType): TaskType => {
  const idx = ESCALATION_ORDER.indexOf(taskType);
  return ESCALATION_ORDER[Math.min(idx + 1, ESCALATION_ORDER.length - 1)]!;
};

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a natural-language task request into a TaskType with a confidence
 * score and a pre-computed token budget.
 *
 * Confidence algorithm:
 *   - Count matching patterns across all rules.
 *   - Normalise to 0–1. The winning rule's `baseConfidence` is the ceiling.
 *   - If no rule matches, default to `write_local` at low confidence (0.4).
 *   - If confidence < 0.6, escalate to the next budget tier.
 */
export const classifyTask = (taskText: string): ClassificationResult => {
  const lower = taskText.toLowerCase();

  let bestType: TaskType = "write_local";
  let bestScore = 0;
  let bestBase = 0.4;

  for (const rule of TASK_RULES) {
    const matchCount = rule.patterns.filter((p) => p.test(lower)).length;
    if (matchCount === 0) continue;

    // Score = base confidence × match density (more matches = more certain)
    const density = Math.min(1, matchCount / rule.patterns.length);
    const score = rule.baseConfidence * (0.6 + 0.4 * density);

    if (score > bestScore) {
      bestScore = score;
      bestType = rule.taskType;
      bestBase = rule.baseConfidence;
    }
  }

  const confidence = bestScore > 0 ? Math.min(bestBase, bestScore) : 0.4;
  const LOW_CONFIDENCE_THRESHOLD = 0.6;

  // Escalate budget when ambiguous
  const effectiveType =
    confidence < LOW_CONFIDENCE_THRESHOLD ? escalate(bestType) : bestType;

  return {
    taskType: effectiveType,
    confidence,
    budgetTokens: BUDGET_BY_TASK[effectiveType],
    requiresThinking: THINKING_TASKS.has(effectiveType),
  };
};

// ─── Telemetry ────────────────────────────────────────────────────────────────

let db: Database.Database | null = null;

export const initSelector = (projectHash: string): void => {
  const dbDir = path.join(os.homedir(), ".aether", "projects", projectHash, "sqlite");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "telemetry.db");

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER,
      taskType   TEXT,
      confidence REAL,
      budgetTokens INTEGER,
      reasoning  TEXT,
      success    INTEGER
    );
  `);
  const columns = db.pragma(`table_info(telemetry)`) as any[];
  const columnNames = columns.map(c => c.name);
  
  if (!columnNames.includes('taskType')) {
    db.exec(`ALTER TABLE telemetry ADD COLUMN taskType TEXT;`);
  }
  if (!columnNames.includes('confidence')) {
    db.exec(`ALTER TABLE telemetry ADD COLUMN confidence REAL;`);
  }
  if (!columnNames.includes('budgetTokens')) {
    db.exec(`ALTER TABLE telemetry ADD COLUMN budgetTokens INTEGER;`);
  }
};

export const recordTelemetry = (
  result: ClassificationResult,
  reasoning: "think" | "no_think",
  success: boolean,
): void => {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO telemetry (ts, taskType, confidence, budgetTokens, reasoning, success)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      result.taskType,
      result.confidence,
      result.budgetTokens,
      reasoning,
      success ? 1 : 0,
    );
  } catch (err) {
    console.warn(`[Aether] ⚠️ Telemetry write failed (non-fatal):`, err);
  }
};

// ─── Legacy shim ──────────────────────────────────────────────────────────────
// Kept for any callers that still use the old shouldThink(cyclomaticScore) API
// during the migration. Will be removed in a follow-up.

/** @deprecated Use classifyTask(taskText).requiresThinking instead. */
export const shouldThink = (cyclomaticScore: number): "think" | "no_think" => {
  // Retain the old threshold behaviour as a safety net
  return cyclomaticScore >= 0.55 ? "think" : "no_think";
};
