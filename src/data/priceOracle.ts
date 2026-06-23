import { config } from "../config.js";

/** Mints de référence sur Solana. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Stablecoins traités comme valant 1 USD (vol nulle). */
export const STABLE_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

interface JupPriceResponse {
  [mint: string]: { usdPrice: number; decimals: number; priceChange24h: number } | undefined;
}

/**
 * Oracle de prix USD basé sur Jupiter Price API V3.
 *
 *   GET https://lite-api.jup.ag/price/v3?ids=<mint1>,<mint2>
 *   → { "<mint>": { usdPrice, decimals, priceChange24h } }
 *
 * Les stablecoins court-circuitent l'appel réseau (prix = 1).
 * Limite : 50 mints par requête.
 */
export class PriceOracle {
  constructor(private readonly base: string = config.JUPITER_PRICE_API) {}

  /** Prix USD d'un mint (1 pour les stablecoins connus). */
  async getUsdPrice(mint: string): Promise<number> {
    if (STABLE_MINTS.has(mint)) return 1;
    const prices = await this.getUsdPrices([mint]);
    const p = prices[mint];
    if (p === undefined) throw new Error(`Prix introuvable pour ${mint}`);
    return p;
  }

  /** Prix USD pour plusieurs mints (stables = 1, le reste via l'API). */
  async getUsdPrices(mints: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const toFetch: string[] = [];
    for (const m of mints) {
      if (STABLE_MINTS.has(m)) out[m] = 1;
      else toFetch.push(m);
    }
    if (toFetch.length === 0) return out;

    // L'API accepte jusqu'à 50 ids ; on découpe par prudence.
    for (let i = 0; i < toFetch.length; i += 50) {
      const batch = toFetch.slice(i, i + 50);
      const url = `${this.base}?ids=${batch.join(",")}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`Jupiter Price -> HTTP ${res.status}`);
        const json = (await res.json()) as JupPriceResponse;
        for (const m of batch) {
          const entry = json[m];
          if (entry?.usdPrice) out[m] = entry.usdPrice;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }
}
