import type { Candle, Pool } from "../types.js";
import type { DataApiClient } from "../data/dataApiClient.js";
import { SOL_MINT, STABLE_MINTS } from "../data/priceOracle.js";

/** Prix USD du quote à un instant (secondes Unix), ou undefined si inconnu. */
export type QuoteUsdAt = (timestampSec: number) => number | undefined;

/**
 * Recherche du prix à partir d'une série de bougies : clôture de la dernière
 * bougie commencée au plus tard à `timestampSec` (la première si antérieur).
 */
export function quoteUsdLookup(candles: Candle[], invert = false): QuoteUsdAt {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  return (ts) => {
    if (sorted.length === 0) return undefined;
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sorted[mid]!.timestamp <= ts) lo = mid;
      else hi = mid - 1;
    }
    const close = sorted[lo]!.close;
    if (!(close > 0)) return undefined;
    return invert ? 1 / close : close;
  };
}

/**
 * Historique du prix USD d'un quote pour le backtest :
 *  - stablecoin → 1 en permanence ;
 *  - SOL → bougies de la pool SOL/stable la plus profonde de l'univers ;
 *  - autre token → null (pas d'historique fiable : valorisation en unités de quote).
 */
export async function loadQuoteUsdHistory(
  mint: string,
  universe: Pool[],
  data: DataApiClient,
  lookback: number
): Promise<QuoteUsdAt | null> {
  if (STABLE_MINTS.has(mint)) return () => 1;
  if (mint !== SOL_MINT) return null;

  const solStable = universe
    .filter(
      (p) =>
        (p.mintX === SOL_MINT && STABLE_MINTS.has(p.mintY)) ||
        (p.mintY === SOL_MINT && STABLE_MINTS.has(p.mintX))
    )
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
  if (!solStable) return null;

  const candles = await data.getOhlcv(solStable.address, "1h", lookback);
  // Prix d'une pool = token Y par token X : SOL-USDC donne directement des USD par SOL
  return quoteUsdLookup(candles, solStable.mintY === SOL_MINT);
}
