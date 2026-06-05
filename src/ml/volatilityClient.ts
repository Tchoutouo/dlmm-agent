import type { Candle, Timeframe } from "../types.js";
import { config } from "../config.js";

export interface ForwardVol {
  dailyVol: number;
  annualVol: number;
  method: "model" | "ewma";
}

/**
 * Demande au microservice Python une prédiction de volatilité FUTURE à partir
 * des bougies fournies. Renvoie null si le ML est désactivé ou le service
 * injoignable — l'appelant retombe alors sur la volatilité réalisée (trailing).
 *
 * Le système fonctionne donc parfaitement sans le service ; le ML est un bonus
 * optionnel, et seulement s'il bat la baseline EWMA (décidé côté service).
 */
export async function predictForwardVol(
  candles: Candle[],
  timeframe: Timeframe = "1h",
  poolKey?: string
): Promise<ForwardVol | null> {
  if (!config.ML_ENABLED) return null;
  if (candles.length < 2) return null;

  try {
    const res = await fetch(`${config.ML_SERVICE_URL}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candles, timeframe, window: 24, key: poolKey }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      predicted_daily_vol: number;
      predicted_annual_vol: number;
      method: "model" | "ewma";
    };
    if (typeof data.predicted_daily_vol !== "number") return null;
    return {
      dailyVol: data.predicted_daily_vol,
      annualVol: data.predicted_annual_vol,
      method: data.method,
    };
  } catch {
    return null; // service indisponible : repli silencieux
  }
}
