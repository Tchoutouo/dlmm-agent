export interface JournalRow {
  id: number;
  timestamp: string;
  poolName: string;
  decision: string;
  sizeUsd: number | null;
  realizedPnlUsd: number | null;
  feesCollectedUsd: number | null;
  holdingDays: number | null;
  wentOutOfRange: boolean | null;
  features: { feeRegime?: string; expectedNetApr?: number } | null;
}

export interface Metrics {
  withOutcome: number;
  winRate: number | null;
  totalPnlUsd: number;
  avgPnlUsd: number | null;
}

export interface LearningSummary {
  overall: Metrics;
  byRegime: Record<string, Metrics>;
  recurringErrors: string[];
  suggestions: string[];
  calibration: { samples: number; correlation: number | null };
}

function metrics(rows: JournalRow[]): Metrics {
  const r = rows.filter((x) => x.realizedPnlUsd != null);
  const total = r.reduce((s, x) => s + (x.realizedPnlUsd ?? 0), 0);
  const wins = r.filter((x) => (x.realizedPnlUsd ?? 0) > 0).length;
  return {
    withOutcome: r.length,
    winRate: r.length ? wins / r.length : null,
    totalPnlUsd: total,
    avgPnlUsd: r.length ? total / r.length : null,
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    n += a * b; dx += a * a; dy += b * b;
  }
  const d = Math.sqrt(dx * dy);
  return d === 0 ? 0 : n / d;
}

/** Résumé d'apprentissage (miroir compact de l'Agent 5 pour l'affichage). */
export function summarize(entries: JournalRow[]): LearningSummary {
  const enters = entries.filter((e) => e.decision === "ENTER" && e.realizedPnlUsd != null);
  const overall = metrics(enters);

  const byRegime: Record<string, Metrics> = {};
  const groups: Record<string, JournalRow[]> = {};
  for (const e of enters) {
    const k = e.features?.feeRegime;
    if (!k) continue;
    (groups[k] ??= []).push(e);
  }
  for (const [k, rows] of Object.entries(groups)) byRegime[k] = metrics(rows);

  const recurringErrors: string[] = [];
  const suggestions: string[] = [];
  for (const [regime, m] of Object.entries(byRegime)) {
    if (m.withOutcome >= 3 && m.winRate !== null && m.winRate < 0.5 && (m.avgPnlUsd ?? 0) < 0) {
      recurringErrors.push(
        `Régime « ${regime} » : ${m.withOutcome} positions, win ${(m.winRate * 100).toFixed(0)}%, PnL moy $${(m.avgPnlUsd ?? 0).toFixed(1)}`
      );
      if (regime === "volatile")
        suggestions.push("Durcir le filtre en régime volatil (MIN_NET_APR / MAX_VOLATILITY).");
    }
  }
  const oor = enters.filter((e) => e.wentOutOfRange);
  if (oor.length >= 3) {
    const m = metrics(oor);
    if ((m.avgPnlUsd ?? 0) < 0) {
      recurringErrors.push(`Sorties de range : ${oor.length} positions, PnL moy $${(m.avgPnlUsd ?? 0).toFixed(1)}`);
      suggestions.push("Élargir les ranges (rangeSigma) ou rééquilibrer plus tôt.");
    }
  }
  if (overall.withOutcome > 0 && recurringErrors.length === 0)
    suggestions.push("Aucun pattern perdant détecté — continuer à accumuler des données.");
  if (overall.withOutcome === 0)
    suggestions.push("Pas encore d'issue : lancer `npm run paper` pour générer des résultats.");

  const cal = enters.filter(
    (e) => e.features?.expectedNetApr != null && e.sizeUsd && e.holdingDays && e.holdingDays > 0
  );
  const predicted = cal.map((e) => e.features!.expectedNetApr!);
  const realized = cal.map((e) => ((e.realizedPnlUsd ?? 0) / (e.sizeUsd as number) / (e.holdingDays as number)) * 365);

  return {
    overall,
    byRegime,
    recurringErrors,
    suggestions,
    calibration: { samples: cal.length, correlation: pearson(predicted, realized) },
  };
}
