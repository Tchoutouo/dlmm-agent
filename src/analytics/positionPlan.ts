import type { Candle, Pool } from "../types.js";
import { SOL_MINT, STABLE_MINTS } from "../data/priceOracle.js";
import { bidAskEffectiveLow, bidAskLayout } from "./bidAsk.js";

/**
 * Forme de position simulée :
 *  - spot       : deux côtés, range centré sur le prix (comportement historique) ;
 *  - sol_bidask : un seul côté en quote (SOL ou stable), bins sous le prix, forme bid-ask.
 */
export type PositionShape = "spot" | "sol_bidask";

/** Règle d'entrée « après une chute » : baisse depuis le plus haut des N dernières bougies. */
export interface DipRule {
  lookbackCandles: number;
  minDropPct: number;
}

/**
 * Baisse (en %) du dernier prix de clôture par rapport au plus haut des clôtures
 * des `lookbackCandles` dernières bougies. 0 si le prix est au plus haut.
 */
export function recentDropPct(candles: Candle[], lookbackCandles: number): number {
  const window = candles.slice(-Math.max(1, lookbackCandles));
  if (window.length === 0) return 0;
  const high = Math.max(...window.map((c) => c.close));
  const last = window[window.length - 1]!.close;
  return high > 0 ? Math.max(0, ((high - last) / high) * 100) : 0;
}

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
