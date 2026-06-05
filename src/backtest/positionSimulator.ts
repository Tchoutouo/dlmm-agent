import type { Candle } from "../types.js";
import { positionValueRatio } from "../analytics/impermanentLoss.js";

export interface SimulatedOutcome {
  exitPrice: number;
  feesEarnedUsd: number;
  valueChangeUsd: number; // variation de la valeur LP (hors fees)
  realizedPnlUsd: number; // valueChange + fees
  wentOutOfRange: boolean;
  fractionInRange: number;
  holdingDays: number;
}

export interface SimulateInput {
  entryPrice: number;
  sizeUsd: number;
  range: { priceLow: number; priceHigh: number };
  /** Fee APR annuel de la pool (proxy). */
  feeAprAnnual: number;
  /** Chemin de prix après l'entrée (bougies forward). */
  forwardCandles: Candle[];
  /** Secondes par bougie (pour déduire la durée de détention). */
  candleSeconds: number;
}

/**
 * Simule le résultat d'une position DLMM sur un chemin de prix.
 *
 * Modèle de fees (volontairement CONSERVATEUR) :
 *   feesEarnedUsd = sizeUsd × feeAprAnnual × (holdingDays/365) × fractionInRange
 *
 * Il sous-estime probablement le boost de concentration (une position en range
 * serré capte une plus grande part des fees), ce qui est le bon biais pour un
 * outil dont le but est de NE PAS perdre : mieux vaut un backtest prudent.
 *
 * Variation de valeur LP via positionValueRatio (capital réel, pas IL vs HODL).
 * Hypothèse : token Y = quote stable (valorisation en USD).
 */
export function simulatePosition(input: SimulateInput): SimulatedOutcome {
  const { entryPrice, sizeUsd, range, feeAprAnnual, forwardCandles, candleSeconds } = input;

  if (forwardCandles.length === 0) {
    return {
      exitPrice: entryPrice,
      feesEarnedUsd: 0,
      valueChangeUsd: 0,
      realizedPnlUsd: 0,
      wentOutOfRange: false,
      fractionInRange: 0,
      holdingDays: 0,
    };
  }

  let inRange = 0;
  let wentOutOfRange = false;
  for (const c of forwardCandles) {
    const within = c.close >= range.priceLow && c.close <= range.priceHigh;
    if (within) inRange++;
    else wentOutOfRange = true;
  }
  const fractionInRange = inRange / forwardCandles.length;

  const holdingDays = (forwardCandles.length * candleSeconds) / 86_400;
  const feeForWindow = feeAprAnnual * (holdingDays / 365);
  const feesEarnedUsd = sizeUsd * feeForWindow * fractionInRange;

  const exitPrice = forwardCandles[forwardCandles.length - 1]!.close;
  const valueRatio = positionValueRatio(entryPrice, exitPrice, range.priceLow, range.priceHigh);
  const valueChangeUsd = sizeUsd * (valueRatio - 1);

  return {
    exitPrice,
    feesEarnedUsd,
    valueChangeUsd,
    realizedPnlUsd: valueChangeUsd + feesEarnedUsd,
    wentOutOfRange,
    fractionInRange,
    holdingDays,
  };
}
