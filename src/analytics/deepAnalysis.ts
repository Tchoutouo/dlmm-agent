import type {
  Candle,
  DeepAnalysis,
  ScoredOpportunity,
  Timeframe,
} from "../types.js";
import { computeVolatility, detectVolumeAnomalies } from "./volatility.js";
import { classifyFeeRegime } from "./dlmmFees.js";
import { concentratedIl, suggestRange } from "./impermanentLoss.js";
import { netAprAfterIl } from "./feeApr.js";

export interface DeepAnalysisOptions {
  timeframe?: Timeframe;
  /** Horizon de détention supposé (jours), pour annualiser l'IL. */
  horizonDays?: number;
  /** Nombre d'écarts-types couverts par le range. */
  rangeSigma?: number;
  /**
   * Volatilité journalière FUTURE prédite (couche ML). Si fournie, elle dimensionne
   * le range à la place de la vol réalisée trailing — plus pertinent puisqu'on
   * couvre l'horizon à venir, pas le passé. Absente → comportement inchangé.
   */
  forwardDailyVol?: number;
}

/**
 * Analyse approfondie d'UNE opportunité déjà pré-sélectionnée par le scanner.
 *
 * C'est l'étage coûteux : il consomme les bougies OHLCV (1 requête/pool) et
 * produit la vue ajustée du risque. À n'appeler que sur le top-N candidates.
 */
export function deepAnalyze(
  opportunity: ScoredOpportunity,
  candles: Candle[],
  options: DeepAnalysisOptions = {}
): DeepAnalysis {
  const timeframe = options.timeframe ?? "1h";
  const horizonDays = options.horizonDays ?? 1;
  const rangeSigma = options.rangeSigma ?? 2;

  const pool = opportunity.pool;
  const price = pool.currentPrice;

  // 1. Volatilité réalisée
  const volatility = computeVolatility(candles, timeframe);

  // Vol journalière retenue pour le dimensionnement : prédite (ML) si fournie,
  // sinon réalisée trailing. On couvre l'horizon à venir, pas le passé.
  const sizingDailyVol =
    options.forwardDailyVol !== undefined && options.forwardDailyVol > 0
      ? options.forwardDailyVol
      : volatility.sigmaDaily;

  // 2. Régime de frais (calme / actif / volatil)
  const feeRegime = classifyFeeRegime(pool);

  // 3. Anomalies de volume (proxy whale)
  const anomalies = detectVolumeAnomalies(candles);

  // 4. Range dimensionné sur la vol journalière (couvre ±rangeSigma σ)
  const suggestedRange = suggestRange(price, sizingDailyVol, rangeSigma);

  // 5. IL estimé pour deux scénarios :
  //    - mouvement de ±1σ journalier (cas courant)
  //    - mouvement jusqu'au bord du range (cas adverse ~±rangeSigma σ)
  const il1Up = concentratedIl({
    entryPrice: price,
    currentPrice: price * (1 + sizingDailyVol),
    ...suggestedRange,
  }).ilPct;
  const il1Down = concentratedIl({
    entryPrice: price,
    currentPrice: price * (1 - sizingDailyVol),
    ...suggestedRange,
  }).ilPct;
  const ilAt1Sigma = (il1Up + il1Down) / 2;

  const ilAtRangeEdge = concentratedIl({
    entryPrice: price,
    currentPrice: suggestedRange.priceHigh * 0.999, // juste avant la sortie
    ...suggestedRange,
  }).ilPct;

  // 6. APR ajusté du risque = fees − traînée d'IL (scénario 1σ) annualisée
  const expectedFeeApr = opportunity.estimatedFeeApr;
  const riskAdjustedNetApr = netAprAfterIl(expectedFeeApr, ilAt1Sigma, horizonDays);

  // 7. Rationale lisible pour le journal
  const rationale = buildRationale({
    poolName: pool.name,
    volatility,
    feeRegime,
    anomalies: anomalies.length,
    expectedFeeApr,
    riskAdjustedNetApr,
    ilAt1Sigma,
  });

  return {
    volatility,
    feeRegime,
    anomalies,
    suggestedRange,
    ilAt1Sigma,
    ilAtRangeEdge,
    expectedFeeApr,
    riskAdjustedNetApr,
    rationale,
  };
}

function buildRationale(x: {
  poolName: string;
  volatility: { sigmaAnnual: number; sigmaDaily: number };
  feeRegime: { label: string; ratio: number };
  anomalies: number;
  expectedFeeApr: number;
  riskAdjustedNetApr: number;
  ilAt1Sigma: number;
}): string[] {
  const r: string[] = [];
  r.push(`Vol. annualisée ≈ ${(x.volatility.sigmaAnnual * 100).toFixed(0)}% ` +
    `(journalière ≈ ${(x.volatility.sigmaDaily * 100).toFixed(1)}%)`);
  r.push(`Régime de frais : ${x.feeRegime.label} ` +
    `(fee effectif / fee base = ${x.feeRegime.ratio.toFixed(1)}×)`);

  if (x.feeRegime.label === "volatile")
    r.push("Frais variable dominant : revenus élevés mais IL/sortie de range probable");
  else if (x.feeRegime.label === "calm")
    r.push("Frais de base dominant : revenus modérés, IL limité");

  if (x.anomalies > 0)
    r.push(`${x.anomalies} pic(s) de volume anormaux détectés (activité importante)`);

  r.push(`Fee APR ≈ ${(x.expectedFeeApr * 100).toFixed(1)}% | ` +
    `net d'IL (1σ) ≈ ${(x.riskAdjustedNetApr * 100).toFixed(1)}%`);

  if (x.riskAdjustedNetApr <= 0)
    r.push("⚠ IL estimé absorbe les fees sur cet horizon — opportunité douteuse");

  return r;
}
