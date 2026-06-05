import type {
  CalibrationResult,
  ErrorPattern,
  PerformanceMetrics,
  Suggestion,
} from "../types.js";

/**
 * Transforme les erreurs récurrentes et la calibration en suggestions concrètes,
 * souvent rattachées à un paramètre de configuration existant. C'est la sortie
 * « propose automatiquement des améliorations » de l'agent d'apprentissage.
 */
export function buildSuggestions(input: {
  overall: PerformanceMetrics;
  errors: ErrorPattern[];
  calibration: CalibrationResult;
  byRegime: Record<string, PerformanceMetrics>;
}): Suggestion[] {
  const out: Suggestion[] = [];

  // 1. Erreurs récurrentes → paramètre ciblé
  for (const e of input.errors) {
    if (e.feature === "regime=volatile") {
      out.push({
        area: "MIN_NET_APR_PCT / MAX_VOLATILITY_ANNUAL_PCT",
        recommendation:
          "Durcir le filtre en régime volatil (relever MIN_NET_APR_PCT ou abaisser MAX_VOLATILITY_ANNUAL_PCT)",
        rationale: e.description,
      });
    } else if (e.feature === "outOfRange=yes") {
      out.push({
        area: "largeur de range (rangeSigma)",
        recommendation:
          "Élargir les ranges (augmenter rangeSigma) ou rééquilibrer plus tôt — trop de sorties de range",
        rationale: e.description,
      });
    } else if (e.feature === "hedged=no") {
      out.push({
        area: "couverture (hedge)",
        recommendation:
          "Activer/exiger la couverture pour les positions directionnelles perdantes",
        rationale: e.description,
      });
    } else if (e.feature.startsWith("binStep")) {
      out.push({
        area: "sélection de pools (bin step)",
        recommendation: `Éviter ou sous-pondérer les pools avec ${e.feature}`,
        rationale: e.description,
      });
    }
  }

  // 2. Calibration → fiabilité du modèle
  const c = input.calibration;
  if (c.samples >= 3 && c.avgPredictedNetApr !== null && c.avgRealizedReturnAnnualized !== null) {
    if (c.avgPredictedNetApr > c.avgRealizedReturnAnnualized * 1.5) {
      out.push({
        area: "modèle d'IL / APR net",
        recommendation:
          "Le modèle surestime le rendement net : durcir l'estimation d'IL ou relever MIN_NET_APR_PCT",
        rationale:
          `APR net prédit moyen ${(c.avgPredictedNetApr * 100).toFixed(0)}% ` +
          `vs réalisé annualisé ${(c.avgRealizedReturnAnnualized * 100).toFixed(0)}%`,
      });
    }
    if (c.correlation !== null && c.correlation < 0.2) {
      out.push({
        area: "scoring / features",
        recommendation:
          "Faible corrélation prédiction↔réalisé : enrichir les features ou revoir le scoring",
        rationale: `Corrélation de Pearson = ${c.correlation.toFixed(2)}`,
      });
    }
  }

  // 3. Performance globale saine → autoriser plus de capital
  if (
    input.overall.withOutcome >= 10 &&
    input.overall.winRate !== null &&
    input.overall.winRate > 0.6 &&
    (input.overall.avgPnlUsd ?? 0) > 0
  ) {
    out.push({
      area: "MAX_POSITION_USD",
      recommendation:
        "Performance solide et régulière : envisager d'augmenter prudemment MAX_POSITION_USD",
      rationale:
        `Win rate ${(input.overall.winRate * 100).toFixed(0)}% sur ` +
        `${input.overall.withOutcome} positions, PnL moyen positif`,
    });
  }

  if (out.length === 0) {
    out.push({
      area: "données",
      recommendation: "Accumuler plus d'issues avant de tirer des conclusions",
      rationale: `Seulement ${input.overall.withOutcome} position(s) avec issue connue`,
    });
  }

  return out;
}
