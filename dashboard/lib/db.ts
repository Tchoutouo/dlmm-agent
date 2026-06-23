import Database from "better-sqlite3";
import path from "node:path";

let db: Database.Database | null = null;

/**
 * Ouvre (une fois) le fichier SQLite partagé avec les agents.
 * Par défaut ../data/journal.db (le dashboard est un sous-dossier du dépôt).
 * Surchargeable via DLMM_DB_PATH.
 */
export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.DLMM_DB_PATH ?? path.join(process.cwd(), "..", "data", "journal.db");
  db = new Database(dbPath, { fileMustExist: false });
  db.pragma("journal_mode = WAL");
  ensureApprovals(db);
  return db;
}

export function hasTable(name: string): boolean {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return Boolean(row);
}

/** Crée la table d'approbations si l'agent ne l'a pas encore créée. */
function ensureApprovals(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      pool_address TEXT NOT NULL, pool_name TEXT NOT NULL,
      mint_x TEXT NOT NULL, mint_y TEXT NOT NULL,
      entry_price REAL NOT NULL, range_low REAL NOT NULL, range_high REAL NOT NULL,
      size_usd REAL NOT NULL, fee_apr REAL NOT NULL, verdict TEXT NOT NULL,
      vol_annual REAL NOT NULL, regime TEXT NOT NULL, expected_net_apr REAL NOT NULL,
      bin_step INTEGER NOT NULL, hedged INTEGER NOT NULL, rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS close_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL, position_pubkey TEXT NOT NULL, pool_name TEXT NOT NULL,
      requested_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      result_ok INTEGER, result_note TEXT, result_tx TEXT
    );
  `);
}
