import { getDb, hasTable } from "./db";
import { summarize, type JournalRow, type LearningSummary } from "./analytics";

export interface Portfolio {
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  peakNavUsd: number;
  drawdownPct: number;
  openCount: number;
}

export interface OpenPosition {
  poolName: string;
  sizeUsd: number;
  valueUsd: number;
  entryPrice: number;
  rangeLow: number;
  rangeHigh: number;
  accruedFees: number;
}

function meta(key: string): number {
  if (!hasTable("paper_meta")) return 0;
  const r = getDb().prepare("SELECT value FROM paper_meta WHERE key=?").get(key) as
    | { value: number }
    | undefined;
  return r?.value ?? 0;
}

export function getPortfolio(): Portfolio {
  const positions = getOpenPositions();
  const cashUsd = meta("cash");
  const peakNavUsd = meta("peak_nav");
  const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
  const navUsd = cashUsd + deployedUsd;
  const drawdownPct = peakNavUsd > 0 ? ((peakNavUsd - navUsd) / peakNavUsd) * 100 : 0;
  return { navUsd, cashUsd, deployedUsd, peakNavUsd, drawdownPct, openCount: positions.length };
}

export function getOpenPositions(): OpenPosition[] {
  if (!hasTable("paper_positions")) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM paper_positions WHERE status='OPEN' ORDER BY id DESC`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    poolName: r.pool_name as string,
    sizeUsd: r.size_usd as number,
    valueUsd: r.value_usd as number,
    entryPrice: r.entry_price as number,
    rangeLow: r.range_low as number,
    rangeHigh: r.range_high as number,
    accruedFees: r.accrued_fees as number,
  }));
}

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

export interface EquityPoint {
  t: string;
  pnl: number;
}

/** Courbe de PnL réalisé cumulé (ordre chronologique). */
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

export function getLearning(): LearningSummary {
  return summarize(allJournalRows());
}
