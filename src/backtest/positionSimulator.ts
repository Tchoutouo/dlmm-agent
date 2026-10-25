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
  /** Motif de sortie : fin de la fenêtre, take-profit ou stop-loss. */
  exitReason: "horizon" | "take_profit" | "stop_loss";
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
  /** Sortie dès que le PnL (valeur + fees) atteint +X % de la taille. 0/absent = désactivé. */
  takeProfitPct?: number;
  /** Sortie dès que le PnL tombe à −X % de la taille. 0/absent = désactivé. */
  stopLossPct?: number;
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
  const tp = input.takeProfitPct ?? 0;
  const sl = input.stopLossPct ?? 0;

  if (forwardCandles.length === 0) {
    return {
      exitPrice: entryPrice,
      feesEarnedUsd: 0,
      valueChangeUsd: 0,
      realizedPnlUsd: 0,
      wentOutOfRange: false,
      fractionInRange: 0,
      holdingDays: 0,
      exitReason: "horizon",
    };
  }

  // Fees gagnées par bougie passée dans le range
  const feePerCandleUsd = sizeUsd * feeAprAnnual * (candleSeconds / 86_400 / 365);

  let inRange = 0;
  let wentOutOfRange = false;
  let held = 0;
  let exitReason: SimulatedOutcome["exitReason"] = "horizon";
  let exitPrice = entryPrice;
  let valueChangeUsd = 0;

  // Marquage à chaque clôture ; TP/SL évalués sur les clôtures (pas en intra-bougie)
  for (const c of forwardCandles) {
    held++;
    if (c.close >= range.priceLow && c.close <= range.priceHigh) inRange++;
    else wentOutOfRange = true;

    exitPrice = c.close;
    valueChangeUsd = sizeUsd * (positionValueRatio(entryPrice, exitPrice, range.priceLow, range.priceHigh) - 1);
    const pnlPct = sizeUsd > 0 ? ((valueChangeUsd + inRange * feePerCandleUsd) / sizeUsd) * 100 : 0;

    if (tp > 0 && pnlPct >= tp) {
      exitReason = "take_profit";
      break;
    }
    if (sl > 0 && pnlPct <= -sl) {
      exitReason = "stop_loss";
      break;
    }
  }

  const feesEarnedUsd = inRange * feePerCandleUsd;

  return {
    exitPrice,
    feesEarnedUsd,
    valueChangeUsd,
    realizedPnlUsd: valueChangeUsd + feesEarnedUsd,
    wentOutOfRange,
    fractionInRange: inRange / held,
    holdingDays: (held * candleSeconds) / 86_400,
    exitReason,
  };
}
