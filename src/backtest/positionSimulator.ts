import type { Candle } from "../types.js";
import { positionAmounts, positionValueRatio } from "../analytics/impermanentLoss.js";
import { bidAskFeeMultiplier, bidAskLayout, bidAskValueRatio } from "../analytics/bidAsk.js";
import type { PositionShape } from "../analytics/positionPlan.js";

export interface SimulatedOutcome {
  exitPrice: number;
  feesEarnedUsd: number;
  valueChangeUsd: number; // variation de la valeur LP (hors fees)
  realizedPnlUsd: number; // valueChange + fees
  /**
   * Variation qu'aurait eue la simple DÉTENTION des tokens déposés (USD).
   * valueChange − hodlChange = IL face à la détention (propre au LP) ;
   * hodlChange = mouvement du marché, que tout détenteur aurait subi.
   */
  hodlChangeUsd: number;
  /** Coût de l'aller-retour (swaps d'entrée/sortie, frais réseau), déduit du PnL. */
  tradeCostUsd: number;
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
  /**
   * Facteur de concentration des fees (part réelle des fees de la position face à
   * sa part de TVL, voir feeConcentration.ts). 1 par défaut (modèle de base).
   */
  feeConcentration?: number;
  /** Coût d'un aller-retour en % de la taille (swaps, frais réseau). 0 par défaut. */
  tradeCostPct?: number;
  /**
   * Prix USD du quote, à l'entrée puis à chaque bougie forward (même longueur).
   * La valeur LP, calculée en unités de quote, est convertie en USD par leur
   * rapport. Absent = quote supposé stable.
   */
  quoteUsdEntry?: number;
  quoteUsdPath?: Array<number | undefined>;
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
 * Variation de valeur LP via positionValueRatio (capital réel, pas IL vs HODL),
 * en unités de quote, convertie en USD si le chemin de prix du quote est fourni.
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
      hodlChangeUsd: 0,
      tradeCostUsd: 0,
      wentOutOfRange: false,
      fractionInRange: 0,
      holdingDays: 0,
      exitReason: "horizon",
    };
  }

  // Fees gagnées par bougie passée dans le range (pondérées par la liquidité
  // du bin actif pour une bid-ask)
  const k = input.feeConcentration ?? 1;
  const share = (input.feeShareOfVolume ?? 0) * k;
  const aprFeePerCandleUsd = sizeUsd * feeAprAnnual * k * (candleSeconds / 86_400 / 365);
  // Payé dès l'entrée (swaps vers les tokens de la pool) et à la sortie : compté
  // dans le PnL dès la première bougie, donc aussi dans les seuils TP/SL.
  const tradeCostUsd = sizeUsd * ((input.tradeCostPct ?? 0) / 100);
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
  const quoteFactor = (k: number) => {
    const q = input.quoteUsdPath?.[k];
    return input.quoteUsdEntry && q ? q / input.quoteUsdEntry : 1;
  };

  for (const c of forwardCandles) {
    const k = held;
    held++;
    const within = c.close >= range.priceLow && c.close <= range.priceHigh;
    if (within) inRange++;
    else wentOutOfRange = true;
    feesEarnedUsd += feeWeight(c.close, within) * feeOfCandle(c);

    exitPrice = c.close;
    valueChangeUsd = sizeUsd * (valueRatio(exitPrice) * quoteFactor(k) - 1);
    const pnlPct = sizeUsd > 0 ? ((valueChangeUsd + feesEarnedUsd - tradeCostUsd) / sizeUsd) * 100 : 0;

    if (tp > 0 && pnlPct >= tp) {
      exitReason = "take_profit";
      break;
    }
    if (sl > 0 && pnlPct <= -sl) {
      exitReason = "stop_loss";
      break;
    }
  }

  // Détention des tokens déposés : bid-ask = 100 % quote ; spot = montants à l'entrée
  let hodlRatio = 1;
  if (!layout) {
    const { x, y } = positionAmounts(entryPrice, range.priceLow, range.priceHigh);
    const atEntry = x * entryPrice + y;
    hodlRatio = atEntry > 0 ? (x * exitPrice + y) / atEntry : 1;
  }
  const hodlChangeUsd = sizeUsd * (hodlRatio * quoteFactor(held - 1) - 1);

  return {
    exitPrice,
    feesEarnedUsd,
    valueChangeUsd,
    realizedPnlUsd: valueChangeUsd + feesEarnedUsd - tradeCostUsd,
    hodlChangeUsd,
    tradeCostUsd,
    wentOutOfRange,
    fractionInRange: inRange / held,
    holdingDays: (held * candleSeconds) / 86_400,
    exitReason,
  };
}
