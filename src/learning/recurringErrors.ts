import type { JournalEntry, ErrorPattern } from "../types.js";
import { computeMetrics, metricsByGroup } from "./performance.js";

export interface ErrorDetectionOptions {
  /** Échantillon minimal pour qu'un groupe soit considéré (évite le bruit). */
  minSamples?: number;
  /** Win rate en dessous duquel un groupe est suspect. */
  maxWinRate?: number;
}

/**
 * Détecte les erreurs récurrentes : des groupes de décisions ENTER qui, partageant
 * une caractéristique, perdent de l'argent de façon systématique.
 *
 * On découpe par : régime de fees, couverture (oui/non), sortie de range,
 * tranche de bin step. Un groupe est flaggé s'il a assez d'échantillons ET un
 * win rate faible ET un PnL moyen négatif.
 */
export function detectRecurringErrors(
  entries: JournalEntry[],
  options: ErrorDetectionOptions = {}
): ErrorPattern[] {
  const minSamples = options.minSamples ?? 3;
  const maxWinRate = options.maxWinRate ?? 0.5;
  const realized = entries.filter(
    (e) => e.decision === "ENTER" && e.realizedPnlUsd !== undefined
  );

  const dimensions: Array<{ prefix: string; keyOf: (e: JournalEntry) => string | undefined }> = [
    { prefix: "regime", keyOf: (e) => e.features?.feeRegime },
    {
      prefix: "hedged",
      keyOf: (e) =>
        e.features?.hedged === undefined ? undefined : e.features.hedged ? "yes" : "no",
    },
    {
      prefix: "outOfRange",
      keyOf: (e) =>
        e.wentOutOfRange === undefined ? undefined : e.wentOutOfRange ? "yes" : "no",
    },
    { prefix: "binStep", keyOf: (e) => binStepBucket(e.features?.binStep) },
  ];

  const patterns: ErrorPattern[] = [];
  for (const dim of dimensions) {
    const groups = metricsByGroup(realized, dim.keyOf);
    for (const [value, m] of Object.entries(groups)) {
      if (m.withOutcome < minSamples) continue;
      if (m.winRate === null || m.winRate >= maxWinRate) continue;
      if ((m.avgPnlUsd ?? 0) >= 0) continue;

      patterns.push({
        feature: `${dim.prefix}=${value}`,
        samples: m.withOutcome,
        winRate: m.winRate,
        avgPnlUsd: m.avgPnlUsd ?? 0,
        severity: severityOf(m.withOutcome, m.avgPnlUsd ?? 0),
        description:
          `${m.withOutcome} positions « ${dim.prefix}=${value} » : ` +
          `win rate ${(m.winRate * 100).toFixed(0)}%, ` +
          `PnL moyen $${(m.avgPnlUsd ?? 0).toFixed(1)}`,
      });
    }
  }

  // Tri : les pertes les plus sévères et les plus fréquentes d'abord
  return patterns.sort(
    (a, b) => a.avgPnlUsd * a.samples - b.avgPnlUsd * b.samples
  );
}

function binStepBucket(binStep?: number): string | undefined {
  if (binStep === undefined) return undefined;
  if (binStep <= 10) return "≤10";
  if (binStep <= 50) return "11-50";
  return ">50";
}

function severityOf(samples: number, avgPnl: number): ErrorPattern["severity"] {
  const impact = Math.abs(avgPnl) * samples;
  if (impact >= 100 && samples >= 5) return "high";
  if (impact >= 30) return "medium";
  return "low";
}

/** Métriques globales utilitaires (réexport pratique pour le rapport). */
export { computeMetrics };
