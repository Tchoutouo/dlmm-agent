/**
 * Position DLMM « bid-ask » d'un seul côté, en quote token (SOL ou stable).
 *
 * La liquidité est déposée UNIQUEMENT en quote, dans des bins situés SOUS le
 * prix courant, avec plus de liquidité dans les bins les plus profonds (forme
 * bid-ask). Quand le prix baisse, chaque bin traversé convertit son quote en
 * token de base à son prix (achat échelonné de la baisse) et capte des fees ;
 * au rebond, l'inverse. Tant que le prix reste au-dessus du range, la position
 * reste 100 % en quote : pas d'IL, mais pas de fees non plus.
 *
 * Valeurs exprimées en unités de quote (ratio vs dépôt initial).
 */

/** Au-delà de ~70 bins, Meteora facture un loyer supplémentaire à la création. */
export const MAX_BINS_PER_POSITION = 69;

export interface BidAskLayout {
  /** Prix de chaque bin, du plus proche du prix d'entrée au plus profond. */
  prices: number[];
  /** Part du dépôt dans chaque bin (somme = 1), croissante en profondeur. */
  weights: number[];
  /** Facteur de prix entre deux bins (1 + binStep / 10 000). */
  step: number;
}

/** Répartit le dépôt en bins entre `low` et `high` (≤ prix d'entrée). */
export function bidAskLayout(low: number, high: number, binStep: number): BidAskLayout {
  if (!(high > 0) || !(low > 0) || low >= high) {
    throw new Error("Range bid-ask invalide : exige 0 < low < high");
  }
  if (!(binStep > 0)) throw new Error("binStep doit être > 0");
  const step = 1 + binStep / 10_000;
  const n = Math.min(
    MAX_BINS_PER_POSITION,
    // −1e-9 : un range déjà aligné sur les bins (borne effective) garde son nombre de bins
    Math.max(1, Math.ceil(Math.log(high / low) / Math.log(step) - 1e-9))
  );
  const prices = Array.from({ length: n }, (_, i) => high / step ** i);
  const raw = prices.map((_, i) => i + 1); // linéaire : bin le plus profond = le plus chargé
  const total = raw.reduce((s, w) => s + w, 0);
  return { prices, weights: raw.map((w) => w / total), step };
}

/** Borne basse effective du range une fois le nombre de bins plafonné. */
export function bidAskEffectiveLow(layout: BidAskLayout): number {
  return layout.prices[layout.prices.length - 1]! / layout.step;
}

/**
 * Valeur de la position au prix `price`, en ratio du dépôt (unités de quote).
 * Bins au-dessus du prix : convertis en base (valent q·P/p) ; en dessous : quote intact.
 */
export function bidAskValueRatio(price: number, layout: BidAskLayout): number {
  let value = 0;
  layout.prices.forEach((p, i) => {
    const w = layout.weights[i]!;
    value += price < p ? (w * price) / p : w;
  });
  return value;
}

/**
 * Multiplicateur de fees au prix `price` : liquidité du bin actif rapportée à
 * une répartition uniforme (1 = autant qu'une position spot). 0 hors range.
 * Une bid-ask capte peu de fees près du prix d'entrée, davantage en profondeur.
 */
export function bidAskFeeMultiplier(price: number, layout: BidAskLayout): number {
  const { prices, weights, step } = layout;
  if (price > prices[0]! || price <= bidAskEffectiveLow(layout)) return 0;
  const k = prices.findIndex((p) => price > p / step);
  return k < 0 ? 0 : weights[k]! * prices.length;
}
