import type { Candle } from "../types.js";
import { positionValueRatio } from "../analytics/impermanentLoss.js";
import { bidAskFeeMultiplier, bidAskLayout, bidAskValueRatio } from "../analytics/bidAsk.js";
import type { PositionShape } from "../analytics/positionPlan.js";

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
  /**
   * Fees par dollar de volume et par dollar de liquidité (feeShareOfVolume).
   * Si fourni (> 0), les fees de chaque bougie suivent son VOLUME réel ;
   * sinon, repli sur l'APR constant `feeAprAnnual`.
   */
  feeShareOfVolume?: number;
  /** Forme de la position (défaut spot). */
  shape?: PositionShape;
  /** Bin step de la pool (requis pour sol_bidask). */
  binStep?: number;
}

/**
 * Simule le résultat d'une position DLMM sur un chemin de prix.
 *
 * Modèle de fees (volontairement CONSERVATEUR), par bougie passée en range :
 *   - par volume (feeShareOfVolume fourni) : sizeUsd × volume_bougie × feeShareOfVolume
 *   - sinon : sizeUsd × feeAprAnnual × (durée bougie / an)
 * (× liquidité relative du bin actif pour une bid-ask)
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

  // Fees gagnées par bougie passée dans le range (pondérées par la liquidité
  // du bin actif pour une bid-ask)
  const share = input.feeShareOfVolume ?? 0;
  const aprFeePerCandleUsd = sizeUsd * feeAprAnnual * (candleSeconds / 86_400 / 365);
  const feeOfCandle = (c: Candle) => (share > 0 ? sizeUsd * c.volume * share : aprFeePerCandleUsd);
  const layout =
    input.shape === "sol_bidask" && input.binStep ? bidAskLayout(range.priceLow, range.priceHigh, input.binStep) : null;
  const valueRatio = (p: number) =>
    layout ? bidAskValueRatio(p, layout) : positionValueRatio(entryPrice, p, range.priceLow, range.priceHigh);
  const feeWeight = (p: number, within: boolean) => (layout ? bidAskFeeMultiplier(p, layout) : within ? 1 : 0);

  let inRange = 0;
  let feesEarnedUsd = 0;
  let wentOutOfRange = false;
  let held = 0;
  let exitReason: SimulatedOutcome["exitReason"] = "horizon";
  let exitPrice = entryPrice;
  let valueChangeUsd = 0;

  // Marquage à chaque clôture ; TP/SL évalués sur les clôtures (pas en intra-bougie)
  for (const c of forwardCandles) {
    held++;
    const within = c.close >= range.priceLow && c.close <= range.priceHigh;
    if (within) inRange++;
    else wentOutOfRange = true;
    feesEarnedUsd += feeWeight(c.close, within) * feeOfCandle(c);

    exitPrice = c.close;
    valueChangeUsd = sizeUsd * (valueRatio(exitPrice) - 1);
    const pnlPct = sizeUsd > 0 ? ((valueChangeUsd + feesEarnedUsd) / sizeUsd) * 100 : 0;

    if (tp > 0 && pnlPct >= tp) {
      exitReason = "take_profit";
      break;
    }
    if (sl > 0 && pnlPct <= -sl) {
      exitReason = "stop_loss";
      break;
    }
  }

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
