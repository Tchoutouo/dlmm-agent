import type { JournalEntry, PerformanceMetrics, CalibrationResult } from "../types.js";

/** Une entrée « réalisée » : ENTER avec un PnL connu. */
function isRealizedEnter(e: JournalEntry): boolean {
  return e.decision === "ENTER" && e.realizedPnlUsd !== undefined;
}

/** Calcule les métriques de performance d'un groupe d'entrées. */
export function computeMetrics(entries: JournalEntry[]): PerformanceMetrics {
  const entered = entries.filter((e) => e.decision === "ENTER");
  const realized = entries.filter(isRealizedEnter);

  const totalPnlUsd = realized.reduce((s, e) => s + (e.realizedPnlUsd ?? 0), 0);
  const totalFeesUsd = realized.reduce((s, e) => s + (e.feesCollectedUsd ?? 0), 0);
  const wins = realized.filter((e) => (e.realizedPnlUsd ?? 0) > 0).length;

  const returns = realized
    .filter((e) => e.sizeUsd && e.sizeUsd > 0)
    .map((e) => (e.realizedPnlUsd ?? 0) / (e.sizeUsd as number));

  return {
    decisions: entries.length,
    entered: entered.length,
    withOutcome: realized.length,
    wins,
    winRate: realized.length > 0 ? wins / realized.length : null,
    totalPnlUsd,
    avgPnlUsd: realized.length > 0 ? totalPnlUsd / realized.length : null,
    totalFeesUsd,
    avgRealizedReturn: returns.length > 0 ? mean(returns) : null,
  };
}

/** Regroupe les entrées par une clé puis calcule les métriques de chaque groupe. */
export function metricsByGroup(
  entries: JournalEntry[],
  keyOf: (e: JournalEntry) => string | undefined
): Record<string, PerformanceMetrics> {
  const groups: Record<string, JournalEntry[]> = {};
  for (const e of entries) {
    const k = keyOf(e);
    if (k === undefined) continue;
    (groups[k] ??= []).push(e);
  }
  const out: Record<string, PerformanceMetrics> = {};
  for (const [k, es] of Object.entries(groups)) out[k] = computeMetrics(es);
  return out;
}

/**
 * Calibration : l'APR net prédit (features.expectedNetApr) explique-t-il le
 * rendement réalisé annualisé ? On annualise le rendement réalisé par la durée
 * de détention, puis on calcule la corrélation de Pearson avec la prédiction.
 *
 * Une corrélation faible/négative signale que le modèle prédit mal — signal fort
 * pour recalibrer (durcir l'estimation d'IL, MIN_NET_APR, etc.).
 */
export function calibrate(entries: JournalEntry[]): CalibrationResult {
  const pairs: Array<{ predicted: number; realized: number }> = [];
  for (const e of entries) {
    if (!isRealizedEnter(e)) continue;
    const predicted = e.features?.expectedNetApr;
    const size = e.sizeUsd;
    const days = e.holdingDays;
    if (predicted === undefined || !size || size <= 0 || !days || days <= 0) continue;
    const realizedReturn = (e.realizedPnlUsd as number) / size;
    const realizedAnnualized = (realizedReturn / days) * 365;
    pairs.push({ predicted, realized: realizedAnnualized });
  }

  if (pairs.length === 0) {
    return {
      samples: 0,
      avgPredictedNetApr: null,
      avgRealizedReturnAnnualized: null,
      correlation: null,
    };
  }

  const predicted = pairs.map((p) => p.predicted);
  const realized = pairs.map((p) => p.realized);
  return {
    samples: pairs.length,
    avgPredictedNetApr: mean(predicted),
    avgRealizedReturnAnnualized: mean(realized),
    correlation: pairs.length >= 2 ? pearson(predicted, realized) : null,
  };
}

// --- Helpers ---

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Corrélation de Pearson ; renvoie 0 si une série est constante. */
function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}
