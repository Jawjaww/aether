// packages/core/src/reasoning/selector.ts
import Database from "better-sqlite3";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

let db: Database.Database | null = null;
let currentThreshold = 0.55; // Default threshold

export const initSelector = (projectHash: string) => {
  const dbDir = path.join(os.homedir(), ".aether", "projects", projectHash, "sqlite");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "telemetry.db");
  
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      score REAL,
      reasoning TEXT,
      success INTEGER
    );
  `);

  // Basic auto-calibration: if "no_think" failed often above a certain score, lower threshold.
  // This is a naive implementation placeholder for the ML auto-calibration.
  const stmt = db.prepare(`
    SELECT AVG(score) as avgFailScore 
    FROM telemetry 
    WHERE reasoning = 'no_think' AND success = 0
  `);
  const result = stmt.get() as { avgFailScore: number | null };
  if (result?.avgFailScore && result.avgFailScore > 0) {
    // If we fail without thinking at avgScore, let's lower threshold slightly below that
    currentThreshold = Math.max(0.1, result.avgFailScore - 0.1);
  }
};

export const shouldThink = (cyclomaticScore: number): "think" | "no_think" => {
  return cyclomaticScore >= currentThreshold ? "think" : "no_think";
};

export const recordTelemetry = (score: number, reasoning: "think" | "no_think", success: boolean) => {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO telemetry (ts, score, reasoning, success) 
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(Date.now(), score, reasoning, success ? 1 : 0);
};
