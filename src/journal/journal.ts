import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalEntry, DecisionType } from "../types.js";
import { config } from "../config.js";

/**
 * Journal de trading intelligent — graine de l'Agent 5 (Apprentissage).
 *
 * Ce n'est PAS un simple historique : chaque entrée capture le raisonnement
 * (rationale) et les hypothèses (score, IL estimé, range). Une fois l'issue
 * connue (PnL réalisé, fees récoltées), on peut comparer décision vs résultat
 * et faire émerger les erreurs récurrentes.
 */
export class TradeJournal {
  private db: Database.Database;

  constructor(dbPath: string = config.JOURNAL_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp        TEXT NOT NULL,
        pool_address     TEXT NOT NULL,
        pool_name        TEXT NOT NULL,
        decision         TEXT NOT NULL,
        score            REAL NOT NULL,
        estimated_fee_apr REAL NOT NULL,
        size_usd         REAL,
        range_low        REAL,
        range_high       REAL,
        estimated_il_pct REAL,
        features         TEXT,
        rationale        TEXT NOT NULL,
        realized_pnl_usd REAL,
        fees_collected_usd REAL,
        went_out_of_range INTEGER,
        holding_days     REAL,
        outcome_notes    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_journal_pool ON journal(pool_address);
      CREATE INDEX IF NOT EXISTS idx_journal_decision ON journal(decision);
    `);
  }

  /** Enregistre une décision. Renvoie l'id inséré. */
  record(entry: JournalEntry): number {
    const stmt = this.db.prepare(`
      INSERT INTO journal (
        timestamp, pool_address, pool_name, decision, score,
        estimated_fee_apr, size_usd, range_low, range_high, estimated_il_pct,
        features, rationale, realized_pnl_usd, fees_collected_usd,
        went_out_of_range, holding_days, outcome_notes
      ) VALUES (
        @timestamp, @poolAddress, @poolName, @decision, @score,
        @estimatedFeeApr, @sizeUsd, @rangeLow, @rangeHigh, @estimatedIlPct,
        @features, @rationale, @realizedPnlUsd, @feesCollectedUsd,
        @wentOutOfRange, @holdingDays, @outcomeNotes
      )
    `);
    const info = stmt.run({
      timestamp: entry.timestamp,
      poolAddress: entry.poolAddress,
      poolName: entry.poolName,
      decision: entry.decision,
      score: entry.score,
      estimatedFeeApr: entry.estimatedFeeApr,
      sizeUsd: entry.sizeUsd ?? null,
      rangeLow: entry.rangeLow ?? null,
      rangeHigh: entry.rangeHigh ?? null,
      estimatedIlPct: entry.estimatedIlPct ?? null,
      features: entry.features ? JSON.stringify(entry.features) : null,
      rationale: entry.rationale,
      realizedPnlUsd: entry.realizedPnlUsd ?? null,
      feesCollectedUsd: entry.feesCollectedUsd ?? null,
      wentOutOfRange:
        entry.wentOutOfRange === undefined ? null : entry.wentOutOfRange ? 1 : 0,
      holdingDays: entry.holdingDays ?? null,
      outcomeNotes: entry.outcomeNotes ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /** Complète une entrée avec son issue réelle (boucle de feedback). */
  recordOutcome(
    id: number,
    outcome: {
      realizedPnlUsd: number;
      feesCollectedUsd: number;
      wentOutOfRange?: boolean;
      holdingDays?: number;
      notes?: string;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE journal
         SET realized_pnl_usd = ?, fees_collected_usd = ?,
             went_out_of_range = ?, holding_days = ?, outcome_notes = ?
         WHERE id = ?`
      )
      .run(
        outcome.realizedPnlUsd,
        outcome.feesCollectedUsd,
        outcome.wentOutOfRange === undefined ? null : outcome.wentOutOfRange ? 1 : 0,
        outcome.holdingDays ?? null,
        outcome.notes ?? null,
        id
      );
  }

  /** Toutes les entrées (les plus récentes d'abord), pour l'apprentissage. */
  allEntries(limit = 1000): JournalEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM journal ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Décisions récentes (toutes ou filtrées par type). */
  recent(limit = 20, decision?: DecisionType): JournalEntry[] {
    const sql = decision
      ? `SELECT * FROM journal WHERE decision = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM journal ORDER BY id DESC LIMIT ?`;
    const rows = decision
      ? this.db.prepare(sql).all(decision, limit)
      : this.db.prepare(sql).all(limit);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * Analyse post-mortem agrégée par pool : taux de réussite, PnL moyen,
   * fees moyennes. Premier briquet du moteur d'apprentissage.
   */
  performanceByPool(): Array<{
    poolName: string;
    decisions: number;
    avgScore: number;
    avgRealizedPnl: number | null;
    totalFees: number | null;
    winRate: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT
           pool_name AS poolName,
           COUNT(*) AS decisions,
           AVG(score) AS avgScore,
           AVG(realized_pnl_usd) AS avgRealizedPnl,
           SUM(fees_collected_usd) AS totalFees,
           AVG(CASE WHEN realized_pnl_usd IS NULL THEN NULL
                    WHEN realized_pnl_usd > 0 THEN 1.0 ELSE 0.0 END) AS winRate
         FROM journal
         GROUP BY pool_name
         ORDER BY decisions DESC`
      )
      .all();
    return rows as ReturnType<TradeJournal["performanceByPool"]>;
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(r: Record<string, unknown>): JournalEntry {
  return {
    id: r.id as number,
    timestamp: r.timestamp as string,
    poolAddress: r.pool_address as string,
    poolName: r.pool_name as string,
    decision: r.decision as DecisionType,
    score: r.score as number,
    estimatedFeeApr: r.estimated_fee_apr as number,
    sizeUsd: (r.size_usd as number) ?? undefined,
    rangeLow: (r.range_low as number) ?? undefined,
    rangeHigh: (r.range_high as number) ?? undefined,
    estimatedIlPct: (r.estimated_il_pct as number) ?? undefined,
    features: r.features ? JSON.parse(r.features as string) : undefined,
    rationale: r.rationale as string,
    realizedPnlUsd: (r.realized_pnl_usd as number) ?? undefined,
    feesCollectedUsd: (r.fees_collected_usd as number) ?? undefined,
    wentOutOfRange:
      r.went_out_of_range === null || r.went_out_of_range === undefined
        ? undefined
        : Boolean(r.went_out_of_range),
    holdingDays: (r.holding_days as number) ?? undefined,
    outcomeNotes: (r.outcome_notes as string) ?? undefined,
  };
}
