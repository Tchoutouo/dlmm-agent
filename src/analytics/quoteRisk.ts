import type { Candle, QuoteProfile, Timeframe } from "../types.js";
import { STABLE_MINTS } from "../data/priceOracle.js";
import { computeVolatility } from "./volatility.js";
import { config } from "../config.js";

/**
 * Construit le profil du token de quote.
 *
 * - Quote stable (USDC/USDT) : prix = 1, vol USD = 0 → aucun risque quote/USD.
 * - Quote non-stable (ex. SOL) : on prend son prix USD (fourni par l'oracle) et
 *   sa volatilité journalière USD, soit calculée depuis une série de référence
 *   (bougies d'une pool SOL/USDC), soit estimée par défaut (config).
 *
 * @param mint       mint du token de quote (mintY de la pool)
 * @param usdPrice   prix USD du quote (déjà récupéré via l'oracle)
 * @param refCandles bougies d'une paire quote/USD pour calculer la vol (optionnel)
 */
export function buildQuoteProfile(
  mint: string,
  usdPrice: number,
  opts: { refCandles?: Candle[]; timeframe?: Timeframe; defaultDailyVol?: number } = {}
): QuoteProfile {
  const isStable = STABLE_MINTS.has(mint);
  if (isStable) {
    return { mint, usdPrice: 1, isStable: true, dailyVolUsd: 0 };
  }

  let dailyVolUsd: number;
  if (opts.refCandles && opts.refCandles.length >= 3) {
    dailyVolUsd = computeVolatility(opts.refCandles, opts.timeframe ?? "1h").sigmaDaily;
  } else {
    dailyVolUsd = opts.defaultDailyVol ?? config.QUOTE_DAILY_VOL_PCT / 100;
  }

  return { mint, usdPrice, isStable: false, dailyVolUsd };
}

/**
 * Mouvement adverse du quote/USD utilisé dans le scénario de stress (≤ 0).
 * Couvre kSigma écarts-types journaliers à la baisse. Nul pour un quote stable.
 *
 * Hypothèse conservatrice : lors d'un stress, le token ET son quote (SOL) chutent
 * ensemble (corrélation positive observée dans les krachs).
 */
export function quoteStressShock(profile: QuoteProfile, kSigma = 2): number {
  if (profile.isStable) return 0;
  return -kSigma * profile.dailyVolUsd;
}
