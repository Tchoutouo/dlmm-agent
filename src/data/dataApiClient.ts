import type { Candle, Timeframe } from "../types.js";
import { config } from "../config.js";

/** Réponse brute de l'endpoint OHLCV (spec OpenAPI officielle). */
interface OhlcvResponse {
  start_time: number;
  end_time: number;
  timeframe: string | null;
  data: Array<{
    timestamp: number;
    timestamp_str: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

/** Secondes par bougie selon le timeframe. */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "5m": 300,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "12h": 43200,
  "24h": 86400,
};

/**
 * Client de l'API de DONNÉES Meteora (dlmm.datapi.meteora.ag).
 *
 * Distincte de l'API pair/all : celle-ci fournit l'historique (OHLCV, volume),
 * indispensable au calcul de volatilité réelle. Rate limit officiel : 30 RPS.
 */
export class DataApiClient {
  constructor(private readonly base: string = config.METEORA_DATA_API_BASE) {}

  /**
   * Récupère les bougies OHLCV d'une pool.
   *
   * @param address   adresse base58 de la pool
   * @param timeframe intervalle (défaut 1h)
   * @param lookback  nombre de bougies à remonter (calcule start_time)
   */
  async getOhlcv(
    address: string,
    timeframe: Timeframe = "1h",
    lookback = 96 // 1h × 96 = 4 jours (limite API Meteora)
  ): Promise<Candle[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - lookback * TIMEFRAME_SECONDS[timeframe];
    const url =
      `${this.base}/pools/${address}/ohlcv` +
      `?timeframe=${timeframe}&start_time=${start}&end_time=${end}`;

    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Data API OHLCV -> HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as OhlcvResponse;
    return json.data
      .map((d) => ({
        timestamp: d.timestamp,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
