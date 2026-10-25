import { MAX_BINS_PER_POSITION } from "../analytics/bidAsk.js";

/**
 * Calculs purs de l'exécution réelle (testables sans RPC).
 *
 * Convention : `priceXinY` = prix d'un token X en token Y (unités affichées,
 * comme `current_price` de l'API ou `pricePerToken` du bin actif), et
 * `quoteUsd` = prix USD du token Y. Pour une pool TOKEN/SOL, le prix USD de X
 * est donc priceXinY × prix du SOL — pas priceXinY.
 */

/** Prix USD d'un token X à partir de son prix en Y et du prix USD de Y. */
export function priceXUsd(priceXinY: number, quoteUsd: number): number {
  const p = priceXinY * quoteUsd;
  if (!(p > 0) || !Number.isFinite(p)) {
    throw new Error(`Prix USD de X invalide (prix X/Y=${priceXinY}, quote=$${quoteUsd})`);
  }
  return p;
}

/** Quantité de X (unités affichées) valant `usd` dollars. */
export function tokenXForUsd(usd: number, priceXinY: number, quoteUsd: number): number {
  return usd / priceXUsd(priceXinY, quoteUsd);
}

/** Valeur USD d'un dépôt de x tokens X et y tokens Y (unités affichées). */
export function depositValueUsd(x: number, y: number, priceXinY: number, quoteUsd: number): number {
  return x * priceXinY * quoteUsd + y * quoteUsd;
}

/** Écart relatif entre deux prix (|a/b − 1|). */
export function priceDeviation(a: number, b: number): number {
  return Math.abs(a / b - 1);
}

/**
 * Bins [minBinId, maxBinId] couvrant le range de prix [rangeLow, rangeHigh]
 * autour du bin actif (au prix `activePrice`). Le range est arrondi vers
 * l'extérieur, puis plafonné à `maxBins` bins en réduisant d'abord le côté le
 * plus long (au-delà, la création de position coûte un loyer supplémentaire).
 */
export function binRangeForPrices(
  activeBinId: number,
  activePrice: number,
  rangeLow: number,
  rangeHigh: number,
  binStep: number,
  maxBins = MAX_BINS_PER_POSITION
): { minBinId: number; maxBinId: number } {
  if (!(rangeLow > 0) || !(rangeHigh > rangeLow) || !(activePrice > 0) || !(binStep > 0)) {
    throw new Error(`Range invalide [${rangeLow}, ${rangeHigh}] autour de ${activePrice}`);
  }
  const lnStep = Math.log(1 + binStep / 10_000);
  // ±1e-9 : un prix exactement sur une frontière de bin ne déborde pas d'un bin
  let down = Math.floor(Math.log(rangeLow / activePrice) / lnStep + 1e-9);
  let up = Math.ceil(Math.log(rangeHigh / activePrice) / lnStep - 1e-9);
  while (up - down + 1 > maxBins) {
    if (Math.abs(down) >= Math.abs(up)) down++;
    else up--;
  }
  return { minBinId: activeBinId + down, maxBinId: activeBinId + up };
}
