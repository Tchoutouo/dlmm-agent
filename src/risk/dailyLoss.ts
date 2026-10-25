/**
 * Suivi de la perte journalière (jour UTC).
 *
 * Mémorise la NAV à la première photo du jour, puis mesure la baisse depuis.
 * Complète le disjoncteur de drawdown : un mauvais jour (série de pertes,
 * sur-trading) suspend les entrées sans attendre −15 % depuis le pic.
 */

/** Jour UTC sous forme numérique AAAAMMJJ (stockable dans les tables meta). */
export function utcDayKey(now: Date): number {
  return now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/**
 * Met à jour la NAV d'ouverture du jour si le jour a changé, et renvoie la perte
 * du jour en % (≥ 0 ; un gain renvoie 0).
 */
export function trackDailyLoss(
  getMeta: (key: string) => number,
  setMeta: (key: string, value: number) => void,
  navUsd: number,
  now: Date = new Date()
): number {
  const day = utcDayKey(now);
  if (getMeta("day_open_date") !== day) {
    setMeta("day_open_date", day);
    setMeta("day_open_nav", navUsd);
    return 0;
  }
  const open = getMeta("day_open_nav");
  if (open <= 0) return 0;
  return Math.max(0, ((open - navUsd) / open) * 100);
}
