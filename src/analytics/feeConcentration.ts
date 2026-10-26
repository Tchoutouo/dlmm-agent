import { config } from "../config.js";

/**
 * Facteur de concentration des fees.
 *
 * Le modèle de base suppose qu'une position touche une part des fees égale à sa
 * part de la TVL de la pool (taille / TVL). Or une position DLMM ne touche des
 * fees que dans SES bins, au prorata de sa liquidité face à celle des autres LP
 * de ces bins. Les échanges se faisant surtout près du prix, la part réelle est :
 *
 *   part réelle = (taille / bins) / (liquidité moyenne d'un bin près du prix + taille / bins)
 *
 * et le facteur k = part réelle / (taille / TVL). Mesuré on-chain (25 pools,
 * octobre 2026) : médiane ≈ 2, de 0,35 (LP concurrents très concentrés près du
 * prix) à 13 (liquidité clairsemée). k < 1 pénalise une pool très disputée.
 */
export function feeConcentrationFactor(i: {
  tvlUsd: number;
  /** Liquidité USD de chaque bin autour du bin actif (actif ± rayon). */
  nearBinLiquidityUsd: number[];
  /** Nombre de bins de la position. */
  positionBins: number;
  sizeUsd: number;
}): number {
  if (!(i.tvlUsd > 0) || !(i.positionBins > 0) || !(i.sizeUsd > 0) || i.nearBinLiquidityUsd.length === 0) return 1;
  const meanBin = i.nearBinLiquidityUsd.reduce((s, v) => s + v, 0) / i.nearBinLiquidityUsd.length;
  const perBin = i.sizeUsd / i.positionBins;
  const realShare = perBin / (meanBin + perBin);
  const modelShare = Math.min(1, i.sizeUsd / i.tvlUsd);
  const k = realShare / modelShare;
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/**
 * Facteur effectivement appliqué : plafonné par prudence (la mesure est faite à
 * un instant donné, la répartition de la liquidité change), et jamais sous 0,1.
 * MAX_FEE_CONCENTRATION = 0 désactive le modèle (facteur 1).
 */
export function appliedFeeFactor(k: number | null | undefined, cap: number = config.MAX_FEE_CONCENTRATION): number {
  if (!(cap > 0) || k === null || k === undefined || !Number.isFinite(k)) return 1;
  return Math.min(cap, Math.max(0.1, k));
}
