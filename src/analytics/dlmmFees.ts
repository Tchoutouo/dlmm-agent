import type { Pool, FeeRegime } from "../types.js";

/**
 * Frais de base DLMM, selon la formule officielle :
 *
 *   f_b = B · s · 10 · 10^(base_fee_power_factor)
 *
 * où B = base factor, s = bin step (en basis points). Le résultat est un taux.
 * En pratique l'API fournit déjà `base_fee_percentage` ; cette fonction sert
 * surtout à comprendre/valider la mécanique et à reconstruire le taux si besoin.
 *
 * @returns taux de frais de base (fraction, ex. 0.002 = 0,2 %)
 */
export function baseFeeRate(
  baseFactor: number,
  binStep: number,
  powerFactor = 0
): number {
  // B·s·10·10^p donne un montant en unités de 1e... selon l'échelle on-chain.
  // On normalise vers une fraction lisible en divisant par 1e6 (bps × 100).
  const raw = baseFactor * binStep * 10 * 10 ** powerFactor;
  return raw / 1e6;
}

/**
 * Classe le régime de frais d'une pool en comparant le frais EFFECTIF réellement
 * encaissé (fees24h / volume24h) au frais de BASE.
 *
 * Rappel doc : f_s = f_b + f_v, où f_v (frais variable) croît avec la volatilité.
 * Donc un frais effectif >> frais de base signale une forte contribution du frais
 * variable, donc un marché volatil → fees élevés MAIS IL et risque de sortie de
 * range accrus. C'est le signal central pour arbitrer rendement vs risque.
 */
export function classifyFeeRegime(pool: Pool): FeeRegime {
  const effectiveFeeRate =
    pool.volume24h > 0 ? pool.fees24h / pool.volume24h : 0;
  const baseRate = pool.baseFeePct / 100;
  const ratio = baseRate > 0 ? effectiveFeeRate / baseRate : 1;

  let label: FeeRegime["label"];
  if (ratio < 1.2) label = "calm"; // dominé par le frais de base
  else if (ratio < 2) label = "active";
  else label = "volatile"; // le frais variable contribue fortement

  return { label, effectiveFeeRate, baseFeeRate: baseRate, ratio };
}
