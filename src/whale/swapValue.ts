export interface SwapDelta {
  /** Variation du coffre X (unités token, post − pre). <0 = X sort (achat de X). */
  deltaXTokens: number;
  deltaYTokens: number;
  priceXUsd: number;
  priceYUsd: number;
}

export interface SwapMagnitude {
  amountUsd: number;
  /** "buyX" si X sort du coffre (acheté), "sellX" si X entre, "none" sinon. */
  side: "buyX" | "sellX" | "none";
}

/**
 * Magnitude USD d'un swap déduite des variations des coffres de la pool.
 * Pour un swap, une jambe entre et l'autre sort ; on prend le max des deux
 * jambes valorisées (robuste aux frais/arrondis). Pur et testable.
 */
export function swapMagnitudeUsd(d: SwapDelta): SwapMagnitude {
  const xUsd = Math.abs(d.deltaXTokens) * d.priceXUsd;
  const yUsd = Math.abs(d.deltaYTokens) * d.priceYUsd;
  const amountUsd = Math.max(xUsd, yUsd);
  let side: SwapMagnitude["side"] = "none";
  if (d.deltaXTokens < 0) side = "buyX";
  else if (d.deltaXTokens > 0) side = "sellX";
  return { amountUsd, side };
}
