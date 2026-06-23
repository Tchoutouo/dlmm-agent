import { getDb, hasTable } from "./db";
import { summarize, type JournalRow, type LearningSummary } from "./analytics";

export interface Portfolio {
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  peakNavUsd: number;
  drawdownPct: number;
  openCount: number;
  isLive: boolean;
  /** NAV réelle lue on-chain lors du dernier mark (null si pas encore disponible) */
  realNavUsd: number | null;
  /** Dérive entre NAV suivie et NAV réelle (tracked - real), positif = sur-estimation */
  driftUsd: number | null;
}

export interface OpenPosition {
  poolName: string;
  poolAddress: string;
  mintX: string;
  mintY: string;
  sizeUsd: number;
  valueUsd: number;
  entryPrice: number;
  rangeLow: number;
  rangeHigh: number;
  accruedFees: number;
  positionPubkey?: string;
  isLive: boolean;
  outOfRangeSinceSec: number | null;
  openedAtSec: number;
}

export interface CloseRequest {
  id: number;
  poolAddress: string;
  positionPubkey: string;
  poolName: string;
  requestedAt: string;
  status: "PENDING" | "PROCESSING" | "DONE" | "ERROR";
  resultOk: boolean | null;
  resultNote: string | null;
  resultTx: string | null;
}

// ── Helpers meta ──────────────────────────────────────────────────────────────

function readMeta(table: string, key: string): number {
  if (!hasTable(table)) return 0;
  const r = getDb().prepare(`SELECT value FROM ${table} WHERE key=?`).get(key) as
    | { value: number }
    | undefined;
  return r?.value ?? 0;
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export function getPortfolio(): Portfolio {
  const positions = getOpenPositions();
  const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);

  // live_meta (positions réelles on-chain) prime sur les tables paper
  const hasLive = hasTable("live_meta");
  const cashUsd = hasLive
    ? readMeta("live_meta", "cash")
    : readMeta("portfolio_meta", "cash") || readMeta("paper_meta", "cash");
  const peakNavUsd = hasLive
    ? readMeta("live_meta", "peak_nav")
    : readMeta("portfolio_meta", "peak_nav") || readMeta("paper_meta", "peak_nav");

  const navUsd = cashUsd + deployedUsd;
  const drawdownPct = peakNavUsd > 0 ? ((peakNavUsd - navUsd) / peakNavUsd) * 100 : 0;

  // Vraie NAV on-chain stockée par le daemon après chaque realSnapshot()
  const realNavUsd = hasLive ? (readMeta("live_meta", "real_nav_usd") || null) : null;
  const driftUsd = realNavUsd != null ? navUsd - realNavUsd : null;

  return {
    navUsd,
    cashUsd,
    deployedUsd,
    peakNavUsd,
    drawdownPct,
    openCount: positions.length,
    isLive: hasLive,
    realNavUsd,
    driftUsd,
  };
}

// ── Positions ouvertes ────────────────────────────────────────────────────────

export function getOpenPositions(): OpenPosition[] {
  const result: OpenPosition[] = [];

  // 1. Positions RÉELLES on-chain (live_positions — LivePositionManager)
  if (hasTable("live_positions")) {
    const rows = getDb()
      .prepare(`SELECT * FROM live_positions WHERE status='OPEN' ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    for (const r of rows) {
      result.push({
        poolName: r.pool_name as string,
        poolAddress: r.pool_address as string,
        mintX: r.mint_x as string,
        mintY: r.mint_y as string,
        sizeUsd: r.size_usd as number,
        valueUsd: r.value_usd as number,
        entryPrice: 0,
        rangeLow: 0,
        rangeHigh: 0,
        accruedFees: r.fees_usd as number,
        positionPubkey: r.position_pubkey as string,
        isLive: true,
        outOfRangeSinceSec: (r.out_of_range_since_sec as number) ?? null,
        openedAtSec: (r.opened_at_sec as number) ?? 0,
      });
    }
  }

  // 2. Positions paper (Portfolio / paper broker) — en complément
  let paperTable: string | null = null;
  if (hasTable("paper_positions")) paperTable = "paper_positions";
  else if (hasTable("positions")) paperTable = "positions";
  if (paperTable) {
    const rows = getDb()
      .prepare(`SELECT * FROM ${paperTable} WHERE status='OPEN' ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    for (const r of rows) {
      result.push({
        poolName: r.pool_name as string,
        poolAddress: "",
        mintX: "",
        mintY: "",
        sizeUsd: r.size_usd as number,
        valueUsd: r.value_usd as number,
        entryPrice: (r.entry_price as number) ?? 0,
        rangeLow: (r.range_low as number) ?? 0,
        rangeHigh: (r.range_high as number) ?? 0,
        accruedFees: (r.accrued_fees as number) ?? 0,
        isLive: false,
        outOfRangeSinceSec: null,
        openedAtSec: 0,
      });
    }
  }

  return result;
}

// ── Journal des décisions ─────────────────────────────────────────────────────

export interface DecisionView {
  id: number;
  timestamp: string;
  poolName: string;
  decision: string;
  sizeUsd: number | null;
  realizedPnlUsd: number | null;
  regime: string | null;
  rationale: string;
}

function allJournalRows(limit = 2000): JournalRow[] {
  if (!hasTable("journal")) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM journal ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    timestamp: r.timestamp as string,
    poolName: r.pool_name as string,
    decision: r.decision as string,
    sizeUsd: (r.size_usd as number) ?? null,
    realizedPnlUsd: (r.realized_pnl_usd as number) ?? null,
    feesCollectedUsd: (r.fees_collected_usd as number) ?? null,
    holdingDays: (r.holding_days as number) ?? null,
    wentOutOfRange:
      r.went_out_of_range == null ? null : Boolean(r.went_out_of_range),
    features: r.features ? JSON.parse(r.features as string) : null,
  }));
}

export function getDecisions(limit = 30): DecisionView[] {
  if (!hasTable("journal")) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM journal ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => {
    const features = r.features ? JSON.parse(r.features as string) : null;
    return {
      id: r.id as number,
      timestamp: r.timestamp as string,
      poolName: r.pool_name as string,
      decision: r.decision as string,
      sizeUsd: (r.size_usd as number) ?? null,
      realizedPnlUsd: (r.realized_pnl_usd as number) ?? null,
      regime: features?.feeRegime ?? null,
      rationale: r.rationale as string,
    };
  });
}

// ── Courbe de PnL ─────────────────────────────────────────────────────────────

export interface EquityPoint {
  t: string;
  pnl: number;
}

export function getEquityCurve(): EquityPoint[] {
  if (!hasTable("journal")) return [];
  const rows = getDb()
    .prepare(
      `SELECT timestamp, realized_pnl_usd FROM journal
       WHERE realized_pnl_usd IS NOT NULL ORDER BY id ASC`
    )
    .all() as Array<{ timestamp: string; realized_pnl_usd: number }>;
  let cum = 0;
  return rows.map((r) => {
    cum += r.realized_pnl_usd;
    return { t: r.timestamp, pnl: cum };
  });
}

// ── Apprentissage ─────────────────────────────────────────────────────────────

export function getLearning(): LearningSummary {
  return summarize(allJournalRows());
}

// ── Demandes de clôture manuelle ──────────────────────────────────────────────

export function createCloseRequest(
  poolAddress: string,
  positionPubkey: string,
  poolName: string
): number {
  const res = getDb()
    .prepare(
      `INSERT INTO close_requests (pool_address, position_pubkey, pool_name, requested_at, status)
       VALUES (?, ?, ?, ?, 'PENDING')`
    )
    .run(poolAddress, positionPubkey, poolName, new Date().toISOString());
  return res.lastInsertRowid as number;
}

export function getCloseRequest(id: number): CloseRequest | null {
  const row = getDb()
    .prepare("SELECT * FROM close_requests WHERE id=?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    poolAddress: row.pool_address as string,
    positionPubkey: row.position_pubkey as string,
    poolName: row.pool_name as string,
    requestedAt: row.requested_at as string,
    status: row.status as CloseRequest["status"],
    resultOk: row.result_ok == null ? null : Boolean(row.result_ok),
    resultNote: (row.result_note as string) ?? null,
    resultTx: (row.result_tx as string) ?? null,
  };
}
