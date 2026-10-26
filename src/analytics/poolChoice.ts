import type { Candle, DeepAnalysis, ScoredOpportunity } from "../types.js";
import { deepAnalyze, type DeepAnalysisOptions } from "./deepAnalysis.js";
import { feeAprProxy } from "./feeApr.js";
import { planPosition } from "./positionPlan.js";
import { rangeCoverage } from "../risk/riskAgent.js";
import { config } from "../config.js";
import { appliedFeeFactor } from "./feeConcentration.js";
import { binRangeForPrices } from "../execution/executionMath.js";

export interface PoolChoice {
  opportunity: ScoredOpportunity;
  analysis: DeepAnalysis;
  /** Part du range dicté par la volatilité que la position exécutable couvre. */
  coverage: number;
}

/**
 * Choisit, parmi la pool retenue par le scanner et les autres pools du même
 * token, celle dont le bin step couvre le mieux la volatilité.
 *
 * Une position DLMM est bornée à 69 bins : avec un petit bin step, elle ne
 * couvre qu'une fraction du mouvement attendu, sort du range et l'IL dépasse les
 * fees (constaté en backtest : avantage LP −262 $ → −29 $ en choisissant la pool
 * la mieux couverte). La volatilité est celle du TOKEN, mesurée sur les bougies
 * de la pool principale (la plus liquide) ; les fees sont celles de chaque pool.
 *
 * Parmi les pools dont l'APR net ajusté atteint MIN_NET_APR_PCT, on garde la
 * meilleure couverture (à égalité : la plus liquide) ; si aucune ne l'atteint,
 * la meilleure couverture tout court — l'agent de risque tranchera.
 */
export function chooseCoveredPool(
  main: ScoredOpportunity,
  candles: Candle[],
  options: DeepAnalysisOptions = {}
): PoolChoice {
  const choices: PoolChoice[] = [];
  for (const pool of [main.pool, ...(main.alternatives ?? [])]) {
    const opportunity: ScoredOpportunity =
      pool === main.pool
        ? main
        : {
            ...main,
            pool,
            estimatedFeeApr: feeAprProxy(pool),
            reasons: [...main.reasons, `Pool bin step ${pool.binStep} retenue : elle couvre mieux la volatilité`],
            alternatives: undefined,
          };
    try {
      const analysis = deepAnalyze(opportunity, candles, options);
      const plan = planPosition("spot", pool, analysis.suggestedRange);
      const coverage = rangeCoverage(pool.currentPrice, analysis.suggestedRange, {
        priceLow: plan.rangeLow,
        priceHigh: plan.rangeHigh,
      });
      choices.push({ opportunity, analysis, coverage });
    } catch {
      /* pool inexploitable (prix nul…) : ignorée */
    }
  }
  if (choices.length === 0) return { opportunity: main, analysis: deepAnalyze(main, candles, options), coverage: 0 };

  const minNetApr = config.MIN_NET_APR_PCT / 100;
  const viable = choices.filter((c) => c.analysis.riskAdjustedNetApr >= minNetApr);
  const pool = viable.length > 0 ? viable : choices;
  return pool.reduce((best, c) =>
    c.coverage > best.coverage + 1e-9 ||
    (Math.abs(c.coverage - best.coverage) <= 1e-9 && c.opportunity.pool.liquidityUsd > best.opportunity.pool.liquidityUsd)
      ? c
      : best
  );
}

/** Nombre de bins de la position spot exécutable pour cette analyse. */
export function spotPositionBins(choice: Pick<PoolChoice, "opportunity" | "analysis">): number {
  const { pool } = choice.opportunity;
  const plan = planPosition("spot", pool, choice.analysis.suggestedRange);
  const { minBinId, maxBinId } = binRangeForPrices(0, pool.currentPrice, plan.rangeLow, plan.rangeHigh, pool.binStep);
  return maxBinId - minBinId + 1;
}

/**
 * Applique le facteur de concentration mesuré (`rawFactor`, plafonné par
 * appliedFeeFactor) à l'APR de fees attendu, et refait l'analyse : l'APR net,
 * donc le verdict du risque, reflète la part réelle des fees de la position.
 */
export function withFeeConcentration(
  choice: PoolChoice,
  candles: Candle[],
  rawFactor: number | null | undefined,
  options: DeepAnalysisOptions = {}
): PoolChoice {
  const k = appliedFeeFactor(rawFactor);
  if (k === 1) return choice;
  const note =
    `Part réelle des fees ×${k.toFixed(2)} (liquidité concurrente près du prix, mesurée on-chain` +
    (rawFactor && rawFactor > k ? ` : ×${rawFactor.toFixed(2)}, plafonné)` : ")");
  const opportunity: ScoredOpportunity = {
    ...choice.opportunity,
    estimatedFeeApr: choice.opportunity.estimatedFeeApr * k,
    reasons: [...choice.opportunity.reasons, note],
  };
  const analysis = deepAnalyze(opportunity, candles, options);
  // Tracé au journal (rationale de l'analyse) : le facteur appliqué reste auditable
  return { ...choice, opportunity, analysis: { ...analysis, rationale: [...analysis.rationale, note] } };
}
