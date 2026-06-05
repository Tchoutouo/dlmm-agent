import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

export interface ApprovalRequest {
  poolAddress: string;
  poolName: string;
  mintX: string;
  mintY: string;
  entryPrice: number;
  rangeLow: number;
  rangeHigh: number;
  sizeUsd: number;
  feeAprAnnual: number;
  verdict: string;
  volAnnual: number;
  regime: string;
  expectedNetApr: number;
  binStep: number;
  hedged: boolean;
  rationale: string;
}

export interface ApprovalRow extends ApprovalRequest {
  id: number;
  createdAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";
  decidedAt?: string;
}

/**
 * File d'approbation pour la supervision human-in-the-loop pilotée par le web.
 *
 * Contrairement à `interrupt()` de LangGraph (reprise en-process), ce modèle est
 * asynchrone et adapté à une UI : l'agent enfile une proposition PENDING, le
 * dashboard la résout (APPROVED/REJECTED), et l'agent ouvre les approuvées au
 * tick suivant. Table partagée avec le journal/broker (même fichier SQLite).
 */
export class ApprovalQueue {
  private db: Database.Database;

  constructor(dbPath: string = config.JOURNAL_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        mint_x TEXT NOT NULL,
        mint_y TEXT NOT NULL,
        entry_price REAL NOT NULL,
        range_low REAL NOT NULL,
        range_high REAL NOT NULL,
        size_usd REAL NOT NULL,
        fee_apr REAL NOT NULL,
        verdict TEXT NOT NULL,
        vol_annual REAL NOT NULL,
        regime TEXT NOT NULL,
        expected_net_apr REAL NOT NULL,
        bin_step INTEGER NOT NULL,
        hedged INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        decided_at TEXT
      );
    `);
  }

  enqueue(r: ApprovalRequest): number {
    const info = this.db
      .prepare(
        `INSERT INTO approvals
         (created_at,pool_address,pool_name,mint_x,mint_y,entry_price,range_low,range_high,
          size_usd,fee_apr,verdict,vol_annual,regime,expected_net_apr,bin_step,hedged,rationale)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        new Date().toISOString(), r.poolAddress, r.poolName, r.mintX, r.mintY,
        r.entryPrice, r.rangeLow, r.rangeHigh, r.sizeUsd, r.feeAprAnnual, r.verdict,
        r.volAnnual, r.regime, r.expectedNetApr, r.binStep, r.hedged ? 1 : 0, r.rationale
      );
    return Number(info.lastInsertRowid);
  }

  listPending(): ApprovalRow[] {
    return this.list(`status='PENDING'`);
  }
  listByStatus(status: ApprovalRow["status"]): ApprovalRow[] {
    return this.list(`status='${status}'`);
  }

  decide(id: number, approved: boolean): void {
    this.db
      .prepare(`UPDATE approvals SET status=?, decided_at=? WHERE id=? AND status='PENDING'`)
      .run(approved ? "APPROVED" : "REJECTED", new Date().toISOString(), id);
  }

  markExecuted(id: number): void {
    this.db.prepare(`UPDATE approvals SET status='EXECUTED' WHERE id=?`).run(id);
  }

  private list(where: string): ApprovalRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE ${where} ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      poolAddress: r.pool_address as string,
      poolName: r.pool_name as string,
      mintX: r.mint_x as string,
      mintY: r.mint_y as string,
      entryPrice: r.entry_price as number,
      rangeLow: r.range_low as number,
      rangeHigh: r.range_high as number,
      sizeUsd: r.size_usd as number,
      feeAprAnnual: r.fee_apr as number,
      verdict: r.verdict as string,
      volAnnual: r.vol_annual as number,
      regime: r.regime as string,
      expectedNetApr: r.expected_net_apr as number,
      binStep: r.bin_step as number,
      hedged: Boolean(r.hedged),
      rationale: r.rationale as string,
      status: r.status as ApprovalRow["status"],
      decidedAt: (r.decided_at as string) ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
