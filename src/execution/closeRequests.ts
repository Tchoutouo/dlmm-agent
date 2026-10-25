import Database from "better-sqlite3";
import type { LivePositionManager } from "./livePositionManager.js";
import type { RealExecutor } from "./realExecutor.js";
import type { TradeJournal } from "../journal/journal.js";

/**
 * Demandes de clôture manuelles créées par le dashboard (table `close_requests`,
 * canal entre Next.js et le démon).
 */

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS close_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL, position_pubkey TEXT NOT NULL, pool_name TEXT NOT NULL,
      requested_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      result_ok INTEGER, result_note TEXT, result_tx TEXT
    );
  `);
}

/**
 * Au démarrage du démon : une demande restée PROCESSING vient d'un arrêt en
 * plein traitement. Elle repasse PENDING et sera retraitée — sans risque de
 * double clôture : la clôture relit la position on-chain et refuse une position
 * déjà fermée ou non suivie.
 */
export function recoverStuckCloseRequests(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    ensureTable(db);
    return db
      .prepare(`UPDATE close_requests SET status='PENDING', result_note='repris après redémarrage du démon' WHERE status='PROCESSING'`)
      .run().changes;
  } finally {
    db.close();
  }
}

/** Traite les demandes PENDING, une par une, via le gestionnaire de positions. */
export async function processCloseRequests(
  dbPath: string,
  manager: Pick<LivePositionManager, "closeByRequest">,
  executor: RealExecutor,
  journal: TradeJournal
): Promise<number> {
  const db = new Database(dbPath);
  try {
    ensureTable(db);
    const pending = db.prepare("SELECT * FROM close_requests WHERE status='PENDING' ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    for (const req of pending) {
      const id = req.id as number;
      db.prepare("UPDATE close_requests SET status='PROCESSING' WHERE id=?").run(id);
      console.log(`  🔒 Clôture ${req.pool_name as string} (${(req.position_pubkey as string).slice(0, 8)}…)`);
      try {
        const result = await manager.closeByRequest(
          req.pool_address as string,
          req.position_pubkey as string,
          executor,
          journal
        );
        db.prepare("UPDATE close_requests SET status=?, result_ok=?, result_note=?, result_tx=? WHERE id=?").run(
          result.ok ? "DONE" : "ERROR",
          result.ok ? 1 : 0,
          result.note,
          result.txHash ?? null,
          id
        );
        console.log(`  ${result.ok ? "✅" : "⚠️ "} ${result.note}`);
      } catch (err) {
        const msg = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
        db.prepare("UPDATE close_requests SET status='ERROR', result_note=? WHERE id=?").run(msg.slice(0, 200), id);
        console.log(`  ⚠️  Erreur clôture: ${msg.slice(0, 80)}`);
      }
    }
    return pending.length;
  } finally {
    db.close();
  }
}
