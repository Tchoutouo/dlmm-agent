import type { Pool } from "../types.js";
import { SOL_MINT, STABLE_MINTS } from "../data/priceOracle.js";
import { bidAskEffectiveLow, bidAskLayout } from "./bidAsk.js";

/**
 * Forme de position simulée :
 *  - spot       : deux côtés, range centré sur le prix (comportement historique) ;
 *  - sol_bidask : un seul côté en quote (SOL ou stable), bins sous le prix, forme bid-ask.
 */
export type PositionShape = "spot" | "sol_bidask";

export interface PositionPlan {
  shape: PositionShape;
  rangeLow: number;
  rangeHigh: number;
}

/** La bid-ask d'un côté n'a de sens que si le quote (token Y) est SOL ou un stable. */
export function quoteIsSolOrStable(pool: Pool): boolean {
  return pool.mintY === SOL_MINT || STABLE_MINTS.has(pool.mintY);
}

/**
 * Range et forme de la position selon la stratégie demandée.
 * En `sol_bidask`, le range va du bas du range suggéré (dimensionné sur la vol)
 * jusqu'au prix courant, borné à 69 bins ; sinon repli sur la position spot.
 */
export function planPosition(
  strategy: PositionShape,
  pool: Pool,
  suggestedRange: { priceLow: number; priceHigh: number }
): PositionPlan {
  if (strategy === "sol_bidask" && quoteIsSolOrStable(pool) && suggestedRange.priceLow < pool.currentPrice) {
    const layout = bidAskLayout(suggestedRange.priceLow, pool.currentPrice, pool.binStep);
    return { shape: "sol_bidask", rangeLow: bidAskEffectiveLow(layout), rangeHigh: pool.currentPrice };
  }
  return { shape: "spot", rangeLow: suggestedRange.priceLow, rangeHigh: suggestedRange.priceHigh };
}
