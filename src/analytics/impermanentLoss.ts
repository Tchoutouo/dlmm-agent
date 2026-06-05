/**
 * Impermanent Loss pour liquidité CONCENTRÉE (DLMM / CLMM).
 *
 * Le DLMM place la liquidité dans des « bins » discrets sur un intervalle de prix
 * [priceLow, priceHigh]. On modélise la position comme une position de liquidité
 * concentrée continue sur cet intervalle (approximation standard, très bonne tant
 * que le binStep est fin).
 *
 * Convention de prix : price = quantité de token Y (quote) par token X (volatile).
 * Quand le prix monte, X prend de la valeur et la position vend X contre Y.
 *
 * Aux bornes :
 *  - price >= priceHigh : position 100% en Y (quote)
 *  - price <= priceLow  : position 100% en X (volatile)
 *
 * L'IL concentré est PLUS sévère que l'IL pleine échelle : c'est le prix à payer
 * pour un rendement en fees démultiplié. L'agent de risque arbitrera les deux.
 */

export interface IlInput {
  /** Prix d'entrée (doit idéalement être dans [priceLow, priceHigh]). */
  entryPrice: number;
  /** Prix courant / scénario évalué. */
  currentPrice: number;
  /** Borne basse du range de liquidité. */
  priceLow: number;
  /** Borne haute du range de liquidité. */
  priceHigh: number;
}

export interface IlResult {
  /** Valeur de la position LP (liquidité L=1) au prix courant, en unités de Y. */
  lpValue: number;
  /** Valeur d'un simple HODL des montants initiaux, en unités de Y. */
  hodlValue: number;
  /** IL = lpValue / hodlValue - 1  (négatif = perte vs HODL). */
  ilPct: number;
  /** True si le prix courant est sorti du range (position inactive, IL figé). */
  outOfRange: boolean;
}

/**
 * Quantités (x, y) détenues par une position de liquidité L dans [pa, pb]
 * à un prix p donné, selon les formules CLMM standard.
 *
 * x = token volatil, y = token quote. Exporté car réutilisé par l'agent de
 * risque (perte de stress, exposition directionnelle pour la couverture).
 */
export function positionAmounts(
  p: number,
  pa: number,
  pb: number,
  L = 1
): { x: number; y: number } {
  const sqrtP = Math.sqrt(p);
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);

  if (p <= pa) {
    // Tout en X (token volatil)
    return { x: L * (1 / sqrtPa - 1 / sqrtPb), y: 0 };
  }
  if (p >= pb) {
    // Tout en Y (quote)
    return { x: 0, y: L * (sqrtPb - sqrtPa) };
  }
  // Dans le range : mélange X / Y
  return {
    x: L * (1 / sqrtP - 1 / sqrtPb),
    y: L * (sqrtP - sqrtPa),
  };
}

/**
 * Calcule l'IL d'une position DLMM entre entryPrice et currentPrice.
 * L'IL est invariant d'échelle, on fixe donc L = 1.
 */
export function concentratedIl(input: IlInput): IlResult {
  const { entryPrice, currentPrice, priceLow, priceHigh } = input;

  if (priceLow <= 0 || priceHigh <= priceLow) {
    throw new Error("Range invalide : exige 0 < priceLow < priceHigh");
  }
  if (entryPrice <= 0 || currentPrice <= 0) {
    throw new Error("Les prix doivent être strictement positifs");
  }

  const L = 1;
  // Montants initiaux figés à l'entrée
  const { x: x0, y: y0 } = positionAmounts(entryPrice, priceLow, priceHigh, L);
  // Valeur si on avait simplement gardé ces montants (HODL), valorisée au prix courant
  const hodlValue = x0 * currentPrice + y0;

  // Valeur de la position LP au prix courant
  const { x, y } = positionAmounts(currentPrice, priceLow, priceHigh, L);
  const lpValue = x * currentPrice + y;

  const ilPct = hodlValue > 0 ? lpValue / hodlValue - 1 : 0;
  const outOfRange = currentPrice <= priceLow || currentPrice >= priceHigh;

  return { lpValue, hodlValue, ilPct, outOfRange };
}

/**
 * Ratio de valeur de la position entre un prix d'entrée et un prix cible,
 * valorisée en unités de Y (quote). Si Y est un stablecoin, c'est le ratio en USD.
 *
 *   ratio = V(cible) / V(entrée)
 *
 * Contrairement à l'IL (qui compare au HODL), ceci mesure la variation de capital
 * RÉELLE de la position — c'est ce dont l'agent de risque a besoin pour budgéter
 * la perte en cas de scénario adverse (stress).
 *
 * Hypothèse : Y est le token de quote (idéalement un stablecoin). Pour une paire
 * TOKEN/SOL, la conversion en USD exige en plus le prix de SOL (raffinement futur).
 */
export function positionValueRatio(
  entryPrice: number,
  targetPrice: number,
  priceLow: number,
  priceHigh: number
): number {
  const a0 = positionAmounts(entryPrice, priceLow, priceHigh);
  const v0 = a0.x * entryPrice + a0.y;
  if (v0 <= 0) return 1;
  const at = positionAmounts(targetPrice, priceLow, priceHigh);
  const vt = at.x * targetPrice + at.y;
  return vt / v0;
}

/**
 * Part directionnelle (delta) de la position : fraction de la valeur exposée au
 * token volatil X au prix donné. Sert à dimensionner une couverture (hedge).
 *
 *   hedgeRatio = valeur de la jambe X / valeur totale ∈ [0, 1]
 */
export function directionalExposure(
  price: number,
  priceLow: number,
  priceHigh: number
): number {
  const a = positionAmounts(price, priceLow, priceHigh);
  const legX = a.x * price;
  const total = legX + a.y;
  if (total <= 0) return 0;
  return legX / total;
}

/**
 * Largeur de range conseillée (facteur multiplicatif autour du prix courant)
 * en fonction de la volatilité réalisée. Plus c'est volatil, plus on élargit
 * pour réduire le risque de sortie de range — au prix d'un rendement dilué.
 *
 * Renvoie [priceLow, priceHigh].
 */
export function suggestRange(
  currentPrice: number,
  realizedVolatility: number,
  k = 2 // nombre d'écarts-types à couvrir
): { priceLow: number; priceHigh: number } {
  const halfWidth = Math.min(0.9, Math.max(0.01, k * realizedVolatility));
  return {
    priceLow: currentPrice * (1 - halfWidth),
    priceHigh: currentPrice * (1 + halfWidth),
  };
}
