import type { Candle, Pool } from "../types.js";

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
 * Fees versées aux LP par dollar de volume ET par dollar de liquidité :
 *
 *   share = (fees_24h / volume_24h) / TVL
 *
 * Fees d'une position de taille S sur une bougie de volume V ≈ S × V × share
 * (part de liquidité S / TVL, sans boost de concentration : prudent).
 * Permet de rejouer l'historique avec le VOLUME réel de chaque bougie au lieu
 * d'étaler l'activité d'aujourd'hui sur tout le passé. 0 si données manquantes.
 */
export function feeShareOfVolume(pool: Pool): number {
  if (pool.volume24h <= 0 || pool.liquidityUsd <= 0) return 0;
  return pool.fees24h / pool.volume24h / pool.liquidityUsd;
}

/**
 * Fee APR estimé à partir du volume des dernières 24h de bougies (pas de
 * l'activité actuelle) : ce que l'agent « voyait » à ce moment de l'historique.
 * Repli sur feeAprProxy si la pool n'a pas de taux de fees exploitable.
 */
export function trailingFeeApr(pool: Pool, trailing: Candle[], candleSeconds: number): number {
  const share = feeShareOfVolume(pool);
  if (share <= 0) return feeAprProxy(pool);
  const perDay = Math.max(1, Math.round(86_400 / candleSeconds));
  const lastDay = trailing.slice(-perDay);
  const volume24h = lastDay.reduce((s, c) => s + c.volume, 0) * (perDay / Math.max(1, lastDay.length));
  return volume24h * share * 365;
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
