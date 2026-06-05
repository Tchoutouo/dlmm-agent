import type { Pool } from "../types.js";

/**
 * Fee APR « proxy » : annualisation des fees des dernières 24h rapportées à la TVL.
 *
 *   feeApr ≈ (fees_24h / liquidity) × 365
 *
 * C'est une estimation rétrospective (pas une garantie). Elle suppose que le
 * régime de volume/fees des 24 dernières heures se maintient — ce que l'agent
 * d'analyse pondère ensuite par la soutenabilité (volume) et la profondeur.
 */
export function feeAprProxy(pool: Pool): number {
  if (pool.liquidityUsd <= 0) return 0;
  return (pool.fees24h / pool.liquidityUsd) * 365;
}

/**
 * Ratio de rotation du capital : volume 24h / liquidité.
 * Un ratio élevé = pool très active = fees plus soutenables.
 */
export function capitalTurnover(pool: Pool): number {
  if (pool.liquidityUsd <= 0) return 0;
  return pool.volume24h / pool.liquidityUsd;
}

/**
 * APR effectif net d'IL pour un scénario donné : on déduit l'IL estimé du
 * rendement en fees. Sert à comparer « fees brutes » vs « rendement réel ».
 *
 * @param feeApr        APR de fees (proxy ou fourni par l'API)
 * @param ilPctScenario IL estimé (négatif) sur l'horizon considéré
 * @param horizonDays   horizon de détention en jours (pour ramener l'IL à l'année)
 */
export function netAprAfterIl(
  feeApr: number,
  ilPctScenario: number,
  horizonDays: number
): number {
  if (horizonDays <= 0) return feeApr;
  // L'IL est ponctuel ; on l'annualise grossièrement pour comparaison.
  const ilAnnualized = (ilPctScenario / horizonDays) * 365;
  return feeApr + ilAnnualized; // ilPctScenario est négatif -> réduit l'APR
}
