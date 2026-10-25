import type { Candle, Timeframe } from "../types.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

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

/** Fenêtre max acceptée par l'endpoint OHLCV (au-delà : HTTP 400 "time range too large"). */
export const MAX_OHLCV_RANGE_SECONDS = 4 * 86_400;

const log = logger.child({ module: "DataApiClient" });

/** Erreur HTTP non transitoire (4xx hors 429) : inutile de réessayer. */
class NonRetryableError extends Error {}

/**
 * Régulateur de débit (token bucket).
 * Limite les appels à `rps` requêtes par seconde pour respecter le rate limit
 * officiel de l'API Meteora (30 RPS).
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly rps: number) {
    this.tokens = rps;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1_000;
    this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1_000);
    log.debug("Rate limit — pause avant prochain appel", { waitMs });
    await new Promise((r) => setTimeout(r, waitMs));
    this.tokens = 0;
    this.lastRefill = Date.now();
  }
}

/**
 * Client de l'API de DONNÉES Meteora (dlmm.datapi.meteora.ag).
 *
 * Distincte de l'API pair/all : celle-ci fournit l'historique (OHLCV, volume),
 * indispensable au calcul de volatilité réelle. Rate limit officiel : 30 RPS.
 *
 * Chaque requête :
 * - respecte le rate limit (token bucket 30 RPS partagé par instance)
 * - a un timeout de 10 s (AbortController)
 * - est retentée 2 fois en cas d'erreur réseau, 429 ou 5xx (backoff 1 s → 2 s) ;
 *   les autres 4xx échouent immédiatement
 */
export class DataApiClient {
  private readonly bucket = new TokenBucket(30);

  constructor(private readonly base: string = config.METEORA_DATA_API_BASE) {}

  /**
   * Récupère les bougies OHLCV d'une pool.
   *
   * @param address   adresse base58 de la pool
   * @param timeframe intervalle (défaut 1h)
   * @param lookback  nombre de bougies à remonter (calcule start_time)
   *
   * Au-delà de 4 jours, la période est découpée en tranches successives
   * (limite de l'API), puis les bougies sont fusionnées sans doublon.
   */
  async getOhlcv(
    address: string,
    timeframe: Timeframe = "1h",
    lookback = 96
  ): Promise<Candle[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - lookback * TIMEFRAME_SECONDS[timeframe];

    const byTimestamp = new Map<number, Candle>();
    for (let from = start; from < end; from += MAX_OHLCV_RANGE_SECONDS) {
      const to = Math.min(from + MAX_OHLCV_RANGE_SECONDS, end);
      const url =
        `${this.base}/pools/${address}/ohlcv` +
        `?timeframe=${timeframe}&start_time=${from}&end_time=${to}`;
      const json = await this.fetchJson<OhlcvResponse>(url);
      for (const d of json.data) {
        byTimestamp.set(d.timestamp, {
          timestamp: d.timestamp,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        });
      }
    }
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async fetchJson<T>(url: string, attempt = 0): Promise<T> {
    const maxAttempts = 3;
    const timeoutMs = 10_000;

    await this.bucket.acquire();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        const msg = `HTTP ${res.status} ${res.statusText}`;
        const transient = res.status === 429 || res.status >= 500;
        throw transient ? new Error(msg) : new NonRetryableError(msg);
      }
      return (await res.json()) as T;
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const msg = isTimeout ? "timeout (10 s)" : (err instanceof Error ? err.message : String(err));

      if (err instanceof NonRetryableError) {
        log.error("Data API — erreur non transitoire", { url, reason: msg });
        throw new Error(`Data API OHLCV -> ${msg}`);
      }
      if (attempt < maxAttempts - 1) {
        const delayMs = 1_000 * (attempt + 1);
        log.warn("Data API — nouvelle tentative", { url, attempt: attempt + 1, reason: msg, delayMs });
        await new Promise((r) => setTimeout(r, delayMs));
        return this.fetchJson<T>(url, attempt + 1);
      }

      log.error("Data API — abandon après retries", { url, attempts: maxAttempts, reason: msg });
      throw new Error(`Data API OHLCV -> ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
