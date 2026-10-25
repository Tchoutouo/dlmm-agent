import type { MeteoraPair, Pool } from "../types.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { SOL_MINT, STABLE_MINTS } from "./priceOracle.js";

/** Réponse paginée de GET /pools */
interface PaginatedPools {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: MeteoraPair[];
}

const log = logger.child({ module: "MeteoraClient" });

/** Erreur HTTP non transitoire (4xx hors 429) : inutile de réessayer. */
class NonRetryableError extends Error {}

/**
 * Client de LECTURE de l'API Meteora DLMM.
 *
 * Depuis juin 2026, toute la lecture des pools est sur dlmm.datapi.meteora.ag/pools
 * (l'ancien dlmm-api.meteora.ag est hors service).
 * L'OHLCV reste sur le même domaine via DataApiClient.
 *
 * Pattern : lecture via API REST (pas de clé privée), écriture via SDK.
 * Chaque requête a un timeout de 10 s et 2 tentatives de retry (backoff : 1 s → 2 s).
 */
export class MeteoraClient {
  constructor(private readonly base: string = config.METEORA_DATA_API_BASE) {}

  /**
   * Récupère toutes les pools DLMM actives (triées par volume 24h desc).
   * La nouvelle API est paginée ; on récupère jusqu'à 1000 pools en une requête,
   * ce qui couvre largement les opportunités pertinentes.
   */
  async getAllPairs(): Promise<Pool[]> {
    const url =
      `${this.base}/pools` +
      `?page=1&page_size=1000&sort_by=volume_24h:desc&filter_by=is_blacklisted%3Dfalse`;
    const raw = await this.fetchJson<PaginatedPools>(url);
    return raw.data.map((p) => this.normalize(p));
  }

  /** Récupère une pool précise par son adresse on-chain. */
  async getPair(address: string): Promise<Pool> {
    const raw = await this.fetchJson<MeteoraPair>(`${this.base}/pools/${address}`);
    return this.normalize(raw);
  }

  private async fetchJson<T>(url: string, attempt = 0): Promise<T> {
    const maxAttempts = 3;
    const timeoutMs = 10_000;
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
        log.error("Meteora API — erreur non transitoire", { url, reason: msg });
        throw new Error(`Meteora API ${url} -> ${msg}`);
      }
      if (attempt < maxAttempts - 1) {
        const delayMs = 1_000 * (attempt + 1);
        log.warn("Meteora API — nouvelle tentative", { url, attempt: attempt + 1, reason: msg, delayMs });
        await new Promise((r) => setTimeout(r, delayMs));
        return this.fetchJson<T>(url, attempt + 1);
      }

      log.error("Meteora API — abandon après retries", { url, attempts: maxAttempts, reason: msg });
      throw new Error(`Meteora API ${url} -> ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Normalise une pool brute vers l'interface Pool interne. */
  private normalize(p: MeteoraPair): Pool {
    // Token de base = le côté « le moins quote » (ex. BONK dans SOL-BONK comme dans
    // BONK-SOL, SOL dans SOL-USDC comme dans USDC-SOL)
    const base = quoteRank(p.token_y.address) < quoteRank(p.token_x.address) ? p.token_y : p.token_x;
    return {
      address: p.address,
      name: p.name,
      mintX: p.token_x.address,
      mintY: p.token_y.address,
      binStep: p.pool_config.bin_step,
      baseFeePct: p.pool_config.base_fee_pct,
      liquidityUsd: toNum(p.tvl),
      currentPrice: toNum(p.current_price),
      apr: toNum(p.apr),
      volume24h: toNum(p.volume?.["24h"]),
      fees24h: toNum(p.fees?.["24h"]),
      feeTvl24h: toNum(p.fee_tvl_ratio?.["24h"]),
      feeTvl1h: toNum(p.fee_tvl_ratio?.["1h"]),
      // Les deux tokens : sinon tout memecoin apparié à SOL/USDC (vérifiés) passerait.
      isVerified: Boolean(p.token_x.is_verified) && Boolean(p.token_y?.is_verified),
      isBlacklisted: Boolean(p.is_blacklisted),
      baseMint: base.address,
      baseSymbol: base.symbol,
      baseMarketCapUsd: toNum(base.market_cap),
      volume4h: toNum(p.volume?.["4h"]),
      // OnlyY (1) : toutes les fees en token Y — utile seulement si Y est SOL ou un stable
      feesInQuote: p.pool_config.collect_fee_mode === 1 && quoteRank(p.token_y.address) > 0,
    };
  }
}

/** Rang de quote : 0 = token ordinaire, 1 = SOL, 2 = stablecoin. */
function quoteRank(mint: string): number {
  if (STABLE_MINTS.has(mint)) return 2;
  return mint === SOL_MINT ? 1 : 0;
}

/** Conversion robuste vers number (gère null, undefined, NaN). */
function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
