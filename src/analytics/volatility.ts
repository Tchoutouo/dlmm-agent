import type { Candle, Timeframe, VolatilityProfile, VolumeAnomaly } from "../types.js";
import { TIMEFRAME_SECONDS } from "../data/dataApiClient.js";

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const SECONDS_PER_DAY = 24 * 3600;

/**
 * Calcule un profil de volatilité à partir des bougies OHLCV.
 *
 * - Close-to-close : écart-type des log-returns, annualisé par √(périodes/an).
 * - Parkinson : estimateur basé sur high/low, plus efficace et pertinent pour
 *   le DLMM (le franchissement de bins est lié à l'amplitude high-low).
 *
 * On annualise puis on déduit la vol journalière (utile pour dimensionner un range
 * sur un horizon de détention typique d'une journée).
 */
export function computeVolatility(
  candles: Candle[],
  timeframe: Timeframe = "1h"
): VolatilityProfile {
  if (candles.length < 3) {
    throw new Error("Au moins 3 bougies sont nécessaires pour estimer la volatilité");
  }

  const dt = TIMEFRAME_SECONDS[timeframe];
  const periodsPerYear = SECONDS_PER_YEAR / dt;
  const periodsPerDay = SECONDS_PER_DAY / dt;

  // --- Close-to-close ---
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
  }
  const sigmaPeriod = sampleStdev(logReturns);
  const sigmaAnnual = sigmaPeriod * Math.sqrt(periodsPerYear);
  const sigmaDaily = sigmaPeriod * Math.sqrt(periodsPerDay);

  // --- Parkinson (high/low) ---
  // σ²_P = (1 / (4·ln2)) · moyenne( ln(high/low)² )  par période
  const k = 1 / (4 * Math.log(2));
  const hlSquares: number[] = [];
  for (const c of candles) {
    if (c.high > 0 && c.low > 0) {
      const r = Math.log(c.high / c.low);
      hlSquares.push(r * r);
    }
  }
  const parkinsonVar = k * mean(hlSquares);
  const parkinsonAnnual = Math.sqrt(parkinsonVar * periodsPerYear);

  return {
    timeframe,
    samples: candles.length,
    sigmaPeriod,
    sigmaAnnual,
    sigmaDaily,
    parkinsonAnnual,
  };
}

/**
 * Détecte les pics de volume anormaux (proxy d'activité « whale »).
 *
 * On calcule le z-score de chaque volume par rapport à la moyenne/écart-type de
 * la série, et on signale ceux qui dépassent le seuil.
 *
 * NOTE : c'est un proxy honnête, pas un suivi de wallets individuels. Le vrai
 * whale-tracking (flux par adresse) exige le parsing on-chain via RPC
 * (getSignaturesForAddress + décodage des swaps) ou un indexeur tiers — prévu
 * comme enrichissement de l'agent d'exécution en Phase 2.
 */
export function detectVolumeAnomalies(
  candles: Candle[],
  zThreshold = 2.5
): VolumeAnomaly[] {
  if (candles.length < 5) return [];
  const volumes = candles.map((c) => c.volume);
  const mu = mean(volumes);
  const sigma = sampleStdev(volumes);
  if (sigma === 0) return [];

  const anomalies: VolumeAnomaly[] = [];
  for (const c of candles) {
    const z = (c.volume - mu) / sigma;
    if (z >= zThreshold) {
      anomalies.push({ timestamp: c.timestamp, volume: c.volume, zScore: z });
    }
  }
  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

// --- Helpers statistiques ---

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Écart-type d'échantillon (dénominateur n-1). */
function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}
