import type { MeteoraPair, Pool } from "../types.js";
import { config } from "../config.js";

/** Réponse paginée de GET /pools */
interface PaginatedPools {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: MeteoraPair[];
}

/**
 * Client de LECTURE de l'API Meteora DLMM.
 *
 * Depuis juin 2026, toute la lecture des pools est sur dlmm.datapi.meteora.ag/pools
 * (l'ancien dlmm-api.meteora.ag est hors service).
 * L'OHLCV reste sur le même domaine via DataApiClient.
 *
 * Pattern : lecture via API REST (pas de clé privée), écriture via SDK.
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

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Meteora API ${url} -> HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** Normalise une pool brute vers l'interface Pool interne. */
  private normalize(p: MeteoraPair): Pool {
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
      isVerified: Boolean(p.token_x.is_verified),
      isBlacklisted: Boolean(p.is_blacklisted),
    };
  }
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
