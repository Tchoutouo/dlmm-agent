import { positionValueRatio } from "../analytics/impermanentLoss.js";
import { bidAskFeeMultiplier, bidAskLayout, bidAskValueRatio } from "../analytics/bidAsk.js";
import type { PositionShape } from "../analytics/positionPlan.js";

const YEAR_SECONDS = 365 * 24 * 3600;

/** Position simulée (paper) avec son état d'accumulation des fees. */
export interface PaperPosition {
  id?: number;
  journalId?: number;
  poolAddress: string;
  poolName: string;
  mintX: string;
  mintY: string;
  sizeUsd: number;
  entryPrice: number;
  rangeLow: number;
  rangeHigh: number;
  feeAprAnnual: number;
  accruedFeesUsd: number;
  everOutOfRange: boolean;
  openedAtSec: number;
  lastMarkAtSec: number;
  /** Forme de la position (absent = spot, positions antérieures). */
  shape?: PositionShape;
  /** Bin step de la pool (requis pour la forme sol_bidask). */
  binStep?: number;
}

export interface PaperMark {
  lpValueUsd: number; // valeur LP hors fees
  accruedFeesUsd: number; // fees cumulés mis à jour
  feeAccruedNow: number; // fees ajoutés à ce marquage
  markValueUsd: number; // lpValue + fees cumulés
  inRange: boolean;
}

export interface PaperOutcome {
  realizedPnlUsd: number;
  feesCollectedUsd: number;
  wentOutOfRange: boolean;
  holdingDays: number;
}

/**
 * Marque une position au prix courant et accumule les fees depuis le dernier
 * marquage. Modèle de fees cohérent avec le backtest (conservateur) :
 * on n'accumule des fees QUE lorsque le prix est dans le range.
 *
 *   feeAccruedNow = sizeUsd × feeAprAnnual × (Δt / an)   si in-range, sinon 0
 *   lpValueUsd    = sizeUsd × positionValueRatio(entry → courant)
 *
 * Hypothèse : token Y = quote stable (valorisation USD). Pour TOKEN/SOL, la
 * valeur USD devrait être ajustée par le prix de SOL (cohérent avec l'agent de
 * risque ; raffinement de valorisation possible).
 */
export function markPaperPosition(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number
): PaperMark {
  const elapsed = Math.max(0, nowSec - pos.lastMarkAtSec);
  const inRange = currentPrice >= pos.rangeLow && currentPrice <= pos.rangeHigh;

  // Bid-ask d'un côté : valeur par bins, fees selon la liquidité du bin actif
  let feeMultiplier = inRange ? 1 : 0;
  let ratio: number;
  if (pos.shape === "sol_bidask" && pos.binStep) {
    const layout = bidAskLayout(pos.rangeLow, pos.rangeHigh, pos.binStep);
    feeMultiplier = bidAskFeeMultiplier(currentPrice, layout);
    ratio = bidAskValueRatio(currentPrice, layout);
  } else {
    ratio = positionValueRatio(pos.entryPrice, currentPrice, pos.rangeLow, pos.rangeHigh);
  }

  const feeAccruedNow = pos.sizeUsd * pos.feeAprAnnual * (elapsed / YEAR_SECONDS) * feeMultiplier;
  const accruedFeesUsd = pos.accruedFeesUsd + feeAccruedNow;
  const lpValueUsd = pos.sizeUsd * ratio;

  return {
    lpValueUsd,
    accruedFeesUsd,
    feeAccruedNow,
    markValueUsd: lpValueUsd + accruedFeesUsd,
    inRange,
  };
}

/** Calcule l'issue d'une clôture à partir du dernier marquage. */
export function paperCloseOutcome(
  pos: PaperPosition,
  mark: PaperMark,
  closeAtSec: number
): PaperOutcome {
  return {
    realizedPnlUsd: mark.markValueUsd - pos.sizeUsd,
    feesCollectedUsd: mark.accruedFeesUsd,
    wentOutOfRange: pos.everOutOfRange || !mark.inRange,
    holdingDays: Math.max(0, (closeAtSec - pos.openedAtSec) / 86_400),
  };
}

/** Une position a-t-elle atteint son horizon de détention ? */
export function isDue(pos: PaperPosition, nowSec: number, holdingDays: number): boolean {
  return (nowSec - pos.openedAtSec) / 86_400 >= holdingDays;
}
