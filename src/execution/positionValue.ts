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

/**
 * Prix USD utilisables pour marquer une position : les DEUX doivent être
 * connus et positifs. Sinon null — on ne marque pas : un prix absent valorisé
 * à 0 ferait chuter la valeur de moitié et déclencherait un faux stop-loss.
 */
export function markablePrices(
  prices: Record<string, number>,
  mintX: string,
  mintY: string
): { priceXUsd: number; priceYUsd: number } | null {
  const priceXUsd = prices[mintX];
  const priceYUsd = prices[mintY];
  if (priceXUsd === undefined || priceYUsd === undefined) return null;
  if (!(priceXUsd > 0) || !(priceYUsd > 0)) return null;
  return { priceXUsd, priceYUsd };
}
