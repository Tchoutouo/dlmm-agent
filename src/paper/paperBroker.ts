import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PortfolioSnapshot, PortfolioPosition } from "../types.js";
import type { TradeJournal } from "../journal/journal.js";
import {
  markPaperPosition,
  paperCloseOutcome,
  isDue,
  type PaperPosition,
} from "./paperPnl.js";
import { config } from "../config.js";

/**
 * Broker de paper trading : tient des positions simulées persistées, les marque
 * au marché et les clôture à l'échéance. Aucune transaction réelle.
 *
 * Partage le fichier SQLite du journal pour que `recordOutcome` boucle l'issue
 * sur l'entrée ENTER d'origine (alimente l'Agent 5).
 */
export class PaperBroker {
  private db: Database.Database;

  constructor(dbPath: string = config.JOURNAL_DB_PATH, initialCashUsd = config.INITIAL_CASH_USD) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init(initialCashUsd);
  }

  private init(initialCashUsd: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_positions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        journal_id    INTEGER,
        pool_address  TEXT NOT NULL,
        pool_name     TEXT NOT NULL,
        mint_x        TEXT NOT NULL,
        mint_y        TEXT NOT NULL,
        size_usd      REAL NOT NULL,
        value_usd     REAL NOT NULL,
        entry_price   REAL NOT NULL,
        range_low     REAL NOT NULL,
        range_high    REAL NOT NULL,
        fee_apr       REAL NOT NULL,
        accrued_fees  REAL NOT NULL DEFAULT 0,
        ever_out      INTEGER NOT NULL DEFAULT 0,
        opened_at_sec INTEGER NOT NULL,
        last_mark_sec INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'OPEN'
      );
      CREATE TABLE IF NOT EXISTS paper_meta (key TEXT PRIMARY KEY, value REAL NOT NULL);
    `);
    if (!this.db.prepare(`SELECT 1 FROM paper_meta WHERE key='cash'`).get()) {
      const set = this.db.prepare(`INSERT INTO paper_meta(key,value) VALUES(?,?)`);
      set.run("cash", initialCashUsd);
      set.run("peak_nav", initialCashUsd);
    }
  }

  private meta(key: string): number {
    const r = this.db.prepare(`SELECT value FROM paper_meta WHERE key=?`).get(key) as
      | { value: number }
      | undefined;
    return r?.value ?? 0;
  }
  private setMeta(key: string, value: number): void {
    this.db
      .prepare(`INSERT INTO paper_meta(key,value) VALUES(?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  /** Ouvre une position simulée (engage le cash). */
  open(p: {
    journalId?: number;
    poolAddress: string;
    poolName: string;
    mintX: string;
    mintY: string;
    sizeUsd: number;
    entryPrice: number;
    rangeLow: number;
    rangeHigh: number;
    feeAprAnnual: number;
    nowSec: number;
  }): number {
    const cash = this.meta("cash");
    if (p.sizeUsd > cash) throw new Error("Cash papier insuffisant");
    const info = this.db
      .prepare(
        `INSERT INTO paper_positions
         (journal_id,pool_address,pool_name,mint_x,mint_y,size_usd,value_usd,
          entry_price,range_low,range_high,fee_apr,opened_at_sec,last_mark_sec)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        p.journalId ?? null, p.poolAddress, p.poolName, p.mintX, p.mintY,
        p.sizeUsd, p.sizeUsd, p.entryPrice, p.rangeLow, p.rangeHigh,
        p.feeAprAnnual, p.nowSec, p.nowSec
      );
    this.setMeta("cash", cash - p.sizeUsd);
    return Number(info.lastInsertRowid);
  }

  /** Positions ouvertes (état complet pour le marquage). */
  listOpen(): PaperPosition[] {
    const rows = this.db
      .prepare(`SELECT * FROM paper_positions WHERE status='OPEN'`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  /** Marque toutes les positions ouvertes au prix courant fourni. */
  markAll(priceOf: (poolAddress: string) => number | undefined, nowSec: number): void {
    for (const pos of this.listOpen()) {
      const price = priceOf(pos.poolAddress);
      if (price === undefined) continue;
      const mark = markPaperPosition(pos, price, nowSec);
      this.db
        .prepare(
          `UPDATE paper_positions
           SET value_usd=?, accrued_fees=?, ever_out=?, last_mark_sec=?
           WHERE id=?`
        )
        .run(
          mark.markValueUsd,
          mark.accruedFeesUsd,
          pos.everOutOfRange || !mark.inRange ? 1 : 0,
          nowSec,
          pos.id
        );
    }
  }

  /**
   * Clôture les positions ayant atteint leur horizon, réalise le PnL, rend le
   * cash et boucle l'issue sur le journal (recordOutcome).
   */
  closeDue(
    priceOf: (poolAddress: string) => number | undefined,
    nowSec: number,
    holdingDays: number,
    journal: TradeJournal
  ): number {
    let closed = 0;
    for (const pos of this.listOpen()) {
      if (!isDue(pos, nowSec, holdingDays)) continue;
      const price = priceOf(pos.poolAddress);
      if (price === undefined) continue;
      const mark = markPaperPosition(pos, price, nowSec);
      const outcome = paperCloseOutcome(pos, mark, nowSec);

      this.db
        .prepare(`UPDATE paper_positions SET status='CLOSED', value_usd=0 WHERE id=?`)
        .run(pos.id);
      this.setMeta("cash", this.meta("cash") + mark.markValueUsd);

      if (pos.journalId !== undefined) {
        journal.recordOutcome(pos.journalId, {
          realizedPnlUsd: outcome.realizedPnlUsd,
          feesCollectedUsd: outcome.feesCollectedUsd,
          wentOutOfRange: outcome.wentOutOfRange,
          holdingDays: outcome.holdingDays,
          notes: "paper",
        });
      }
      closed++;
    }
    return closed;
  }

  /** Photo du portefeuille papier pour l'agent de risque. */
  snapshot(): PortfolioSnapshot {
    const open = this.listOpen();
    const positions: PortfolioPosition[] = open.map((p) => ({
      poolAddress: p.poolAddress,
      poolName: p.poolName,
      mintX: p.mintX,
      mintY: p.mintY,
      sizeUsd: p.sizeUsd,
      valueUsd: this.valueOf(p.id!),
    }));
    const cashUsd = this.meta("cash");
    const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
    const navUsd = cashUsd + deployedUsd;
    let peak = this.meta("peak_nav");
    if (navUsd > peak) {
      peak = navUsd;
      this.setMeta("peak_nav", peak);
    }
    const drawdownPct = peak > 0 ? ((peak - navUsd) / peak) * 100 : 0;
    const exposureByPool: Record<string, number> = {};
    for (const p of positions) {
      exposureByPool[p.poolAddress] = (exposureByPool[p.poolAddress] ?? 0) + p.valueUsd;
    }
    return { navUsd, cashUsd, deployedUsd, peakNavUsd: peak, drawdownPct, positions, exposureByPool };
  }

  private valueOf(id: number): number {
    const r = this.db.prepare(`SELECT value_usd FROM paper_positions WHERE id=?`).get(id) as
      | { value_usd: number }
      | undefined;
    return r?.value_usd ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToPosition(r: Record<string, unknown>): PaperPosition {
  return {
    id: r.id as number,
    journalId: (r.journal_id as number) ?? undefined,
    poolAddress: r.pool_address as string,
    poolName: r.pool_name as string,
    mintX: r.mint_x as string,
    mintY: r.mint_y as string,
    sizeUsd: r.size_usd as number,
    entryPrice: r.entry_price as number,
    rangeLow: r.range_low as number,
    rangeHigh: r.range_high as number,
    feeAprAnnual: r.fee_apr as number,
    accruedFeesUsd: r.accrued_fees as number,
    everOutOfRange: Boolean(r.ever_out),
    openedAtSec: r.opened_at_sec as number,
    lastMarkAtSec: r.last_mark_sec as number,
  };
}
