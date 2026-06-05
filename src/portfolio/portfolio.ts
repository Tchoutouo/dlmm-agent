import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PortfolioSnapshot, PortfolioPosition } from "../types.js";
import { config } from "../config.js";

/**
 * Portefeuille persistant (SQLite). Suit le cash, les positions ouvertes, le NAV
 * et le pic de NAV (pour le drawdown). Produit des PortfolioSnapshot consommés
 * par l'agent de risque.
 *
 * La valorisation mark-to-market (markToMarket) est alimentée de l'extérieur :
 * en lecture seule (Phase 1/2 devnet) on peut la mettre à jour depuis le prix
 * courant des pools ; en production elle viendra de l'agent d'exécution.
 */
export class Portfolio {
  private db: Database.Database;

  constructor(dbPath: string = config.JOURNAL_DB_PATH, initialCashUsd = config.INITIAL_CASH_USD) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init(initialCashUsd);
  }

  private init(initialCashUsd: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_address  TEXT NOT NULL,
        pool_name     TEXT NOT NULL,
        mint_x        TEXT NOT NULL,
        mint_y        TEXT NOT NULL,
        size_usd      REAL NOT NULL,
        value_usd     REAL NOT NULL,
        entry_price   REAL NOT NULL,
        range_low     REAL NOT NULL,
        range_high    REAL NOT NULL,
        status        TEXT NOT NULL DEFAULT 'OPEN',
        opened_at     TEXT NOT NULL,
        closed_at     TEXT,
        realized_pnl_usd REAL
      );
      CREATE TABLE IF NOT EXISTS portfolio_meta (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL
      );
    `);
    // Initialise cash + peak au premier lancement
    const row = this.db.prepare(`SELECT value FROM portfolio_meta WHERE key='cash'`).get();
    if (!row) {
      const set = this.db.prepare(`INSERT INTO portfolio_meta(key,value) VALUES(?,?)`);
      set.run("cash", initialCashUsd);
      set.run("peak_nav", initialCashUsd);
    }
  }

  private getMeta(key: string): number {
    const row = this.db.prepare(`SELECT value FROM portfolio_meta WHERE key=?`).get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  private setMeta(key: string, value: number): void {
    this.db
      .prepare(`INSERT INTO portfolio_meta(key,value) VALUES(?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  /** Ouvre une position : engage `sizeUsd` de cash. */
  openPosition(p: {
    poolAddress: string;
    poolName: string;
    mintX: string;
    mintY: string;
    sizeUsd: number;
    entryPrice: number;
    rangeLow: number;
    rangeHigh: number;
  }): number {
    const cash = this.getMeta("cash");
    if (p.sizeUsd > cash) throw new Error("Cash insuffisant pour ouvrir la position");
    const info = this.db
      .prepare(
        `INSERT INTO positions
         (pool_address,pool_name,mint_x,mint_y,size_usd,value_usd,entry_price,range_low,range_high,opened_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        p.poolAddress, p.poolName, p.mintX, p.mintY,
        p.sizeUsd, p.sizeUsd, p.entryPrice, p.rangeLow, p.rangeHigh,
        new Date().toISOString()
      );
    this.setMeta("cash", cash - p.sizeUsd);
    return Number(info.lastInsertRowid);
  }

  /** Met à jour la valeur mark-to-market d'une position ouverte. */
  markToMarket(id: number, valueUsd: number): void {
    this.db.prepare(`UPDATE positions SET value_usd=? WHERE id=? AND status='OPEN'`).run(valueUsd, id);
  }

  /** Ferme une position : rend `exitValueUsd` au cash, calcule le PnL réalisé. */
  closePosition(id: number, exitValueUsd: number): void {
    const pos = this.db.prepare(`SELECT size_usd FROM positions WHERE id=? AND status='OPEN'`).get(id) as
      | { size_usd: number }
      | undefined;
    if (!pos) throw new Error("Position introuvable ou déjà fermée");
    const pnl = exitValueUsd - pos.size_usd;
    this.db
      .prepare(`UPDATE positions SET status='CLOSED', closed_at=?, realized_pnl_usd=?, value_usd=0 WHERE id=?`)
      .run(new Date().toISOString(), pnl, id);
    this.setMeta("cash", this.getMeta("cash") + exitValueUsd);
  }

  /** Produit la photo du portefeuille (et met à jour le pic de NAV). */
  snapshot(): PortfolioSnapshot {
    const rows = this.db
      .prepare(`SELECT pool_address,pool_name,mint_x,mint_y,size_usd,value_usd FROM positions WHERE status='OPEN'`)
      .all() as Array<{
        pool_address: string; pool_name: string; mint_x: string; mint_y: string;
        size_usd: number; value_usd: number;
      }>;

    const positions: PortfolioPosition[] = rows.map((r) => ({
      poolAddress: r.pool_address,
      poolName: r.pool_name,
      mintX: r.mint_x,
      mintY: r.mint_y,
      sizeUsd: r.size_usd,
      valueUsd: r.value_usd,
    }));

    const cashUsd = this.getMeta("cash");
    const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
    const navUsd = cashUsd + deployedUsd;

    let peakNavUsd = this.getMeta("peak_nav");
    if (navUsd > peakNavUsd) {
      peakNavUsd = navUsd;
      this.setMeta("peak_nav", peakNavUsd);
    }
    const drawdownPct = peakNavUsd > 0 ? ((peakNavUsd - navUsd) / peakNavUsd) * 100 : 0;

    const exposureByPool: Record<string, number> = {};
    for (const p of positions) {
      exposureByPool[p.poolAddress] = (exposureByPool[p.poolAddress] ?? 0) + p.valueUsd;
    }

    return { navUsd, cashUsd, deployedUsd, peakNavUsd, drawdownPct, positions, exposureByPool };
  }

  close(): void {
    this.db.close();
  }
}
