export interface PositionValueInput {
  /** Montants détenus, en unités de base (lamports du token). */
  amountXRaw: number;
  amountYRaw: number;
  /** Fees réclamables, en unités de base. */
  feeXRaw: number;
  feeYRaw: number;
  decimalsX: number;
  decimalsY: number;
  priceXUsd: number;
  priceYUsd: number;
}

export interface PositionValue {
  valueUsd: number; // valeur des tokens détenus
  feesUsd: number; // fees réclamables
  markValueUsd: number; // valeur + fees
}

/**
 * Convertit les montants on-chain d'une position en valeur USD.
 * Pur (sans dépendance SDK) pour être testable : le manager convertit les BN en
 * nombres puis appelle cette fonction.
 */
export function positionValueUsd(i: PositionValueInput): PositionValue {
  const amountX = i.amountXRaw / 10 ** i.decimalsX;
  const amountY = i.amountYRaw / 10 ** i.decimalsY;
  const feeX = i.feeXRaw / 10 ** i.decimalsX;
  const feeY = i.feeYRaw / 10 ** i.decimalsY;

  const valueUsd = amountX * i.priceXUsd + amountY * i.priceYUsd;
  const feesUsd = feeX * i.priceXUsd + feeY * i.priceYUsd;
  return { valueUsd, feesUsd, markValueUsd: valueUsd + feesUsd };
}
