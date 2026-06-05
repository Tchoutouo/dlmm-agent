import type { JournalEntry, LearningReport } from "../types.js";
import { computeMetrics, metricsByGroup, calibrate } from "./performance.js";
import { detectRecurringErrors } from "./recurringErrors.js";
import { buildSuggestions } from "./suggestions.js";

/**
 * Agent 5 — Apprentissage & Optimisation.
 *
 * Fonction PURE sur les entrées de journal : produit un rapport qui évalue les
 * performances, identifie les erreurs récurrentes, mesure la calibration du
 * modèle et propose des améliorations concrètes. La « mémoire stratégique » est
 * matérialisée par les agrégats par régime et par pool, qui s'affinent à mesure
 * que les issues s'accumulent.
 */
export function analyzeJournal(entries: JournalEntry[]): LearningReport {
  const overall = computeMetrics(entries);
  const byRegime = metricsByGroup(entries, (e) => e.features?.feeRegime);
  const byPool = metricsByGroup(entries, (e) => e.poolName);
  const byVerdict = metricsByGroup(entries, (e) =>
    e.decision === "ENTER" ? "ENTER" : e.decision
  );
  const calibration = calibrate(entries);
  const recurringErrors = detectRecurringErrors(entries);
  const suggestions = buildSuggestions({ overall, errors: recurringErrors, calibration, byRegime });

  return { overall, byRegime, byPool, byVerdict, calibration, recurringErrors, suggestions };
}

/** Rendu texte lisible du rapport (CLI / superviseur). */
export function formatReport(report: LearningReport): string {
  const lines: string[] = [];
  const m = report.overall;
  lines.push("══ Rapport d'apprentissage ══");
  lines.push(
    `Global : ${m.decisions} décisions, ${m.entered} ENTER, ${m.withOutcome} avec issue` +
      (m.winRate !== null
        ? ` | win rate ${(m.winRate * 100).toFixed(0)}%, PnL total $${m.totalPnlUsd.toFixed(0)}`
        : "")
  );

  if (Object.keys(report.byRegime).length) {
    lines.push("\nPar régime de fees :");
    for (const [k, g] of Object.entries(report.byRegime)) {
      lines.push(
        `  ${k.padEnd(9)} ${g.withOutcome} issues` +
          (g.winRate !== null ? `, win ${(g.winRate * 100).toFixed(0)}%, PnL moy $${(g.avgPnlUsd ?? 0).toFixed(1)}` : "")
      );
    }
  }

  const c = report.calibration;
  if (c.samples > 0) {
    lines.push(
      `\nCalibration (${c.samples}) : prédit ${((c.avgPredictedNetApr ?? 0) * 100).toFixed(0)}% ` +
        `vs réalisé ${((c.avgRealizedReturnAnnualized ?? 0) * 100).toFixed(0)}%` +
        (c.correlation !== null ? `, corrélation ${c.correlation.toFixed(2)}` : "")
    );
  }

  if (report.recurringErrors.length) {
    lines.push("\nErreurs récurrentes :");
    for (const e of report.recurringErrors) lines.push(`  [${e.severity}] ${e.description}`);
  }

  lines.push("\nSuggestions :");
  for (const s of report.suggestions) lines.push(`  • (${s.area}) ${s.recommendation}\n      → ${s.rationale}`);

  return lines.join("\n");
}
