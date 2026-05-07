import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fsp } from "node:fs";
import type { ASTChunk } from "./ast-extractor.js";

export interface FileMeta {
  path: string;
  mtime: number;
  size: number;
  hash: string;
  astVersion: number;
  ragVersion: number;
  astChunk?: ASTChunk;
}

type ManifestRow = {
  path: string;
  mtime: number;
  size: number;
  hash: string;
  astVersion: number;
  ragVersion: number;
  astChunk: string | null;
};

const MANIFEST_VERSION = 1;
const MANIFEST_DB_NAME = "manifest.sqlite";
const LEGACY_MANIFEST_NAME = "manifest.json";

export const resolveManifestPath = (projectId: string): string =>
  path.join(os.homedir(), ".aether", "projects", projectId, "sqlite", MANIFEST_DB_NAME);

const resolveLegacyManifestPath = (projectId: string): string =>
  path.join(os.homedir(), ".aether", "projects", projectId, LEGACY_MANIFEST_NAME);

export const createEmptyManifest = (): Map<string, FileMeta> => new Map();

const sanitizeEntry = (entry: FileMeta): FileMeta => ({
  path: entry.path,
  mtime: entry.mtime,
  size: entry.size,
  hash: entry.hash,
  astVersion: entry.astVersion,
  ragVersion: entry.ragVersion,
  ...(entry.astChunk ? { astChunk: entry.astChunk } : {}),
});

const serializeEntry = (entry: FileMeta): ManifestRow => ({
  path: entry.path,
  mtime: entry.mtime,
  size: entry.size,
  hash: entry.hash,
  astVersion: entry.astVersion,
  ragVersion: entry.ragVersion,
  astChunk: entry.astChunk ? JSON.stringify(entry.astChunk) : null,
});

const deserializeEntry = (row: ManifestRow): FileMeta => ({
  path: row.path,
  mtime: row.mtime,
  size: row.size,
  hash: row.hash,
  astVersion: row.astVersion,
  ragVersion: row.ragVersion,
  ...(row.astChunk ? { astChunk: JSON.parse(row.astChunk) as ASTChunk } : {}),
});

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const ensureManifestDirectory = async (projectId: string): Promise<void> => {
  const manifestDir = path.dirname(resolveManifestPath(projectId));
  await fsp.mkdir(manifestDir, { recursive: true });
};

const ensureSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      astVersion INTEGER NOT NULL,
      ragVersion INTEGER NOT NULL,
      astChunk TEXT
    );
  `);

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion !== MANIFEST_VERSION) {
    db.pragma(`user_version = ${MANIFEST_VERSION}`);
  }
};

const openManifestDb = (projectId: string): Database.Database => {
  const manifestPath = resolveManifestPath(projectId);
  const db = new Database(manifestPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
};

const readManifestFromDb = (projectId: string): Map<string, FileMeta> => {
  const db = openManifestDb(projectId);
  const manifest = new Map<string, FileMeta>();
  const rows = db.prepare(
    "SELECT path, mtime, size, hash, astVersion, ragVersion, astChunk FROM files ORDER BY path",
  ).all() as ManifestRow[];

  for (const row of rows) {
    try {
      manifest.set(row.path, deserializeEntry(row));
    } catch (err) {
      console.error(`[Aether] Failed to deserialize manifest row ${row.path}:`, err);
    }
  }

  db.close();
  return manifest;
};

const readLegacyManifest = async (projectId: string): Promise<Map<string, FileMeta>> => {
  const legacyPath = resolveLegacyManifestPath(projectId);

  try {
    const raw = await fsp.readFile(legacyPath, "utf8");
    const payload = JSON.parse(raw) as {
      version?: number;
      files?: Record<string, FileMeta>;
    };

    if (payload?.version !== MANIFEST_VERSION || !payload.files) {
      return createEmptyManifest();
    }

    const manifest = new Map<string, FileMeta>();
    for (const [filePath, entry] of Object.entries(payload.files)) {
      if (!entry || typeof entry !== "object") continue;
      manifest.set(filePath, sanitizeEntry(entry));
    }

    return manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[Aether] Failed to load legacy manifest ${legacyPath}:`, err);
    }
    return createEmptyManifest();
  }
};

const persistManifestToDb = (projectId: string, manifest: Map<string, FileMeta>): void => {
  const db = openManifestDb(projectId);
  const insert = db.prepare(`
    INSERT INTO files (path, mtime, size, hash, astVersion, ragVersion, astChunk)
    VALUES (@path, @mtime, @size, @hash, @astVersion, @ragVersion, @astChunk)
    ON CONFLICT(path) DO UPDATE SET
      mtime = excluded.mtime,
      size = excluded.size,
      hash = excluded.hash,
      astVersion = excluded.astVersion,
      ragVersion = excluded.ragVersion,
      astChunk = excluded.astChunk;
  `);

  const tx = db.transaction((entries: FileMeta[]) => {
    db.prepare("DELETE FROM files").run();
    for (const entry of entries) {
      insert.run(serializeEntry(sanitizeEntry(entry)));
    }
  });

  tx([...manifest.values()]);
  db.close();
};

const migrateLegacyManifestIfNeeded = async (
  projectId: string,
  manifest: Map<string, FileMeta>,
): Promise<void> => {
  const legacyPath = resolveLegacyManifestPath(projectId);
  const manifestPath = resolveManifestPath(projectId);

  if (!manifest.size || !(await fileExists(legacyPath)) || (await fileExists(manifestPath))) {
    return;
  }

  try {
    await ensureManifestDirectory(projectId);
    persistManifestToDb(projectId, manifest);
    await fsp.unlink(legacyPath);
    console.log(`[Aether] Migrated legacy manifest ${legacyPath} to SQLite`);
  } catch (err) {
    console.error(`[Aether] Failed to migrate legacy manifest ${legacyPath}:`, err);
  }
};

export const loadManifest = async (projectId: string): Promise<Map<string, FileMeta>> => {
  const manifestPath = resolveManifestPath(projectId);

  try {
    if (await fileExists(manifestPath)) {
      const manifest = readManifestFromDb(projectId);
      if (manifest.size > 0) return manifest;
    }

    const legacyManifest = await readLegacyManifest(projectId);
    if (legacyManifest.size > 0) {
      await migrateLegacyManifestIfNeeded(projectId, legacyManifest);
      return legacyManifest;
    }

    return createEmptyManifest();
  } catch (err) {
    console.error(`[Aether] Failed to load manifest ${manifestPath}:`, err);
    return createEmptyManifest();
  }
};

export const saveManifest = async (
  projectId: string,
  manifest: Map<string, FileMeta>,
): Promise<void> => {
  await ensureManifestDirectory(projectId);
  persistManifestToDb(projectId, manifest);
};

export const updateFileMeta = (
  manifest: Map<string, FileMeta>,
  filePath: string,
  meta: FileMeta,
): void => {
  manifest.set(filePath, sanitizeEntry(meta));
};

export const removeFileMeta = (
  manifest: Map<string, FileMeta>,
  filePath: string,
): void => {
  manifest.delete(filePath);
};
