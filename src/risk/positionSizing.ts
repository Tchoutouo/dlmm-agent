import type { Pool, PortfolioSnapshot, RiskParams } from "../types.js";
import { positionValueRatio } from "../analytics/impermanentLoss.js";

export interface SizingResult {
  recommendedSizeUsd: number;
  caps: Record<string, number>;
  bindingCap: string;
  stressLossPct: number; // ≤ 0
}

/**
 * Dimensionne une position comme le MINIMUM de plusieurs plafonds indépendants.
 * Chaque plafond protège contre un risque distinct ; on prend le plus serré.
 *
 *  - absolute        : plafond dur par position (MAX_POSITION_USD)
 *  - availableCapital : capital encore déployable (limite d'exposition globale)
 *  - concentration   : limite de capital sur une même pool
 *  - poolLiquidity   : ne pas représenter plus de X % de la TVL de la pool
 *  - riskBudget      : perte au scénario de stress ≤ budget de risque par trade
 *
 * Le « stress » = le prix du token tombe au bas du range. Pour une paire TOKEN/SOL,
 * le quote (SOL) chute AUSSI en USD : on applique `quoteShock` (≤ 0) à toute la
 * valeur de la position. Pour une paire TOKEN/USDC, quoteShock = 0.
 *
 *   stressLossUSD = ratioToken(quote) × (1 + quoteShock) − 1
 */
export function sizePosition(
  pool: Pool,
  range: { priceLow: number; priceHigh: number },
  snapshot: PortfolioSnapshot,
  params: RiskParams,
  quoteShock = 0,
  /** Valeur (ratio du dépôt) au bas du range si la forme n'est pas spot (ex. bid-ask). */
  stressValueRatio?: number
): SizingResult {
  const nav = snapshot.navUsd;

  // Perte de stress en USD : prix du token au bas du range × chute du quote/USD
  const ratioTokenQuote =
    stressValueRatio ??
    positionValueRatio(pool.currentPrice, range.priceLow, range.priceLow, range.priceHigh);
  const usdRatioAtStress = ratioTokenQuote * (1 + quoteShock);
  const stressLossPct = Math.min(0, usdRatioAtStress - 1); // ≤ 0

  // Plafonds
  const absolute = params.maxPositionUsd;

  const availableCapital = Math.max(
    0,
    nav * params.maxPortfolioExposure - snapshot.deployedUsd
  );

  const currentPoolExposure = snapshot.exposureByPool[pool.address] ?? 0;
  const concentration = Math.max(
    0,
    nav * params.maxPoolConcentration - currentPoolExposure
  );

  const poolLiquidity = pool.liquidityUsd * params.maxPoolLiquidityShare;

  // Budget de risque : size × |stressLoss| ≤ nav × riskBudgetPerTrade
  const riskBudgetUsd = nav * params.riskBudgetPerTrade;
  const riskBudget =
    stressLossPct < 0 ? riskBudgetUsd / Math.abs(stressLossPct) : Infinity;

  const caps: Record<string, number> = {
    absolute,
    availableCapital,
    concentration,
    poolLiquidity,
    riskBudget,
  };

  // Plafond le plus contraignant
  let bindingCap = "absolute";
  let recommendedSizeUsd = Infinity;
  for (const [name, value] of Object.entries(caps)) {
    if (value < recommendedSizeUsd) {
      recommendedSizeUsd = value;
      bindingCap = name;
    }
  }

  return {
    recommendedSizeUsd: Math.max(0, recommendedSizeUsd),
    caps,
    bindingCap,
    stressLossPct,
  };
}
