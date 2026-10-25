import type { Candle, Pool } from "../types.js";
import { SOL_MINT, STABLE_MINTS } from "../data/priceOracle.js";
import { MAX_BINS_PER_POSITION, bidAskEffectiveLow, bidAskLayout } from "./bidAsk.js";

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
 *
 * En `spot`, le range suggéré est borné à ce qu'UNE position peut couvrir
 * (69 bins centrés sur le prix) : c'est ce range-là que l'exécuteur réel ouvre,
 * donc celui que le risque, le paper trading et le backtest doivent évaluer.
 * Avec un petit bin step, le range exécutable est étroit (1 bps → ±0,34 %).
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
  return { shape: "spot", ...executableSpotRange(pool, suggestedRange) };
}

/** Range spot borné aux 69 bins d'une position, centrés sur le prix courant. */
function executableSpotRange(
  pool: Pool,
  suggested: { priceLow: number; priceHigh: number }
): { rangeLow: number; rangeHigh: number } {
  if (!(pool.binStep > 0) || !(pool.currentPrice > 0)) {
    return { rangeLow: suggested.priceLow, rangeHigh: suggested.priceHigh };
  }
  const half = Math.floor((MAX_BINS_PER_POSITION - 1) / 2);
  const reach = (1 + pool.binStep / 10_000) ** half;
  return {
    rangeLow: Math.max(suggested.priceLow, pool.currentPrice / reach),
    rangeHigh: Math.min(suggested.priceHigh, pool.currentPrice * reach),
  };
}
