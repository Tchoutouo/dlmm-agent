import { describe, it, expect } from "vitest";
import { BLUECHIP_MINTS, bluechipMints, inUniverse } from "../src/analytics/poolUniverse.js";
import { scanOpportunities } from "../src/analytics/opportunityScanner.js";
import type { Pool } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const FAKE_BTC = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump"; // « BTC » non vérifié de l'univers réel

function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "jup-sol", name: "JUP-SOL", mintX: JUP, mintY: SOL, binStep: 80, baseFeePct: 0.2, liquidityUsd: 2_000_000,
    currentPrice: 0.004, apr: 0, volume24h: 3_000_000, fees24h: 6_000, feeTvl24h: 0.003, feeTvl1h: 0, isVerified: true,
    isBlacklisted: false, baseMint: JUP, baseSymbol: "JUP", baseMarketCapUsd: 9e8, ...o,
  };
}

describe("univers de pools (POOL_UNIVERSE)", () => {
  it("all : toutes les pools", () => {
    expect(inUniverse(pool({ mintX: FAKE_BTC }), "all")).toBe(true);
    expect(inUniverse(pool({ mintX: USDC, mintY: USDT }), "all")).toBe(true);
  });

  it("bluechip_sol : blue chip (par mint) coté en SOL uniquement", () => {
    expect(inUniverse(pool(), "bluechip_sol")).toBe(true);
    expect(inUniverse(pool({ mintY: USDC }), "bluechip_sol")).toBe(false); // JUP-USDC
    expect(inUniverse(pool({ mintX: SOL, mintY: USDC }), "bluechip_sol")).toBe(false); // SOL-USDC
    expect(inUniverse(pool({ mintX: USDC, mintY: USDT }), "bluechip_sol")).toBe(false); // stable/stable
    // Le symbole ne compte pas : un mint inconnu nommé « BTC » est exclu
    expect(inUniverse(pool({ mintX: FAKE_BTC, baseSymbol: "BTC" }), "bluechip_sol")).toBe(false);
  });

  it("BLUECHIP_EXTRA_MINTS étend la liste intégrée", () => {
    const extra = "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg";
    expect(inUniverse(pool({ mintX: extra }), "bluechip_sol", bluechipMints([extra]))).toBe(true);
    expect(bluechipMints([]).size).toBe(BLUECHIP_MINTS.size);
  });

  it("le scanner ne garde que l'univers, alternatives comprises, et aucune stable", () => {
    const jupUsdc = pool({ address: "jup-usdc", name: "JUP-USDC", mintY: USDC, liquidityUsd: 5_000_000, volume24h: 9_000_000 });
    const jupSolWide = pool({ address: "jup-sol-100", binStep: 100, liquidityUsd: 200_000, volume24h: 100_000 });
    const fake = pool({ address: "fake-btc", name: "BTC-SOL", mintX: FAKE_BTC, baseMint: FAKE_BTC, baseSymbol: "BTC" });
    const stable = pool({ address: "usdc-usdt", name: "USDC-USDT", mintX: USDC, mintY: USDT, baseMint: undefined });
    const pools = [jupUsdc, pool(), jupSolWide, fake, stable];

    const all = scanOpportunities(pools, { topN: 10, minStableN: 1, universe: "all" });
    expect(all.map((o) => o.pool.address)).toContain("jup-usdc"); // la plus profonde par token

    const restricted = scanOpportunities(pools, { topN: 10, minStableN: 1, universe: "bluechip_sol" });
    expect(restricted.map((o) => o.pool.address)).toEqual(["jup-sol"]);
    expect(restricted[0]!.alternatives?.map((p) => p.address)).toEqual(["jup-sol-100"]); // pas JUP-USDC
  });
});
