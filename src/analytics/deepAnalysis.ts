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
import { planPosition } from "./positionPlan.js";
import { config } from "../config.js";

export interface DeepAnalysisOptions {
  timeframe?: Timeframe;
  /** Durée de détention (jours) : horizon du scénario d'IL et de son annualisation. */
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
  // Horizon = durée de détention réelle (PAPER_HOLDING_DAYS) : l'IL est subi à
  // chaque position, donc IL sur h jours / h × 365. L'ancien horizon fixe de 7 j
  // avec un σ journalier sous-estimait la traînée d'IL ~7× pour des positions
  // d'un jour (mesuré en backtest : IL réalisé −0,94 %/j contre −0,13 %/j prévu).
  const horizonDays = options.horizonDays ?? config.PAPER_HOLDING_DAYS;
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

  // 5. IL estimé sur la position EXÉCUTABLE (range spot borné à 69 bins, souvent
  //    plus étroit que le range suggéré), pour deux scénarios :
  //    - mouvement de ±1σ sur l'horizon de détention (σ journalier × √h)
  //    - mouvement jusqu'au bord du range suggéré (cas adverse ~±rangeSigma σ)
  const plan = planPosition("spot", pool, suggestedRange);
  const held = { priceLow: plan.rangeLow, priceHigh: plan.rangeHigh };
  const sigmaHorizon = sizingDailyVol * Math.sqrt(horizonDays);
  const il1Up = concentratedIl({
    entryPrice: price,
    currentPrice: price * (1 + sigmaHorizon),
    ...held,
  }).ilPct;
  // Borné à −99 % : au-delà de 100 % de vol sur l'horizon (memecoins), 1 − σ
  // rendrait le prix négatif et ferait échouer l'analyse au lieu d'un VETO motivé.
  const il1Down = concentratedIl({
    entryPrice: price,
    currentPrice: price * Math.max(1 - sigmaHorizon, 0.01),
    ...held,
  }).ilPct;
  const ilAt1Sigma = (il1Up + il1Down) / 2;

  const ilAtRangeEdge = concentratedIl({
    entryPrice: price,
    currentPrice: suggestedRange.priceHigh * 0.999, // juste avant la sortie du range suggéré
    ...held,
  }).ilPct;

  // 6. APR ajusté du risque = fees − traînée d'IL (scénario ±1σ sur h jours) annualisée
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
    horizonDays,
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
  horizonDays: number;
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
    `net d'IL (±1σ sur ${x.horizonDays} j : ${(x.ilAt1Sigma * 100).toFixed(2)}%) ≈ ${(x.riskAdjustedNetApr * 100).toFixed(1)}%`);

  if (x.riskAdjustedNetApr <= 0)
    r.push("⚠ IL estimé absorbe les fees sur cet horizon — opportunité douteuse");

  return r;
}
