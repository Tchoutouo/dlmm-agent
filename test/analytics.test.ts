import { describe, it, expect } from "vitest";
import { concentratedIl, suggestRange } from "../src/analytics/impermanentLoss.js";
import { scanOpportunities, DEFAULT_WEIGHTS, isStablePool } from "../src/analytics/opportunityScanner.js";
import { feeAprProxy } from "../src/analytics/feeApr.js";
import type { Pool } from "../src/types.js";

describe("concentratedIl", () => {
  it("renvoie un IL nul quand le prix ne bouge pas", () => {
    const r = concentratedIl({
      entryPrice: 100,
      currentPrice: 100,
      priceLow: 80,
      priceHigh: 120,
    });
    expect(r.ilPct).toBeCloseTo(0, 6);
    expect(r.outOfRange).toBe(false);
  });

  it("produit une perte (IL négatif) quand le prix bouge dans le range", () => {
    const r = concentratedIl({
      entryPrice: 100,
      currentPrice: 110,
      priceLow: 80,
      priceHigh: 120,
    });
    expect(r.ilPct).toBeLessThan(0);
  });

  it("l'IL concentré est plus sévère que l'IL pleine échelle", () => {
    const wide = concentratedIl({
      entryPrice: 100,
      currentPrice: 110,
      priceLow: 1,
      priceHigh: 100_000,
    });
    const tight = concentratedIl({
      entryPrice: 100,
      currentPrice: 110,
      priceLow: 90,
      priceHigh: 110,
    });
    expect(tight.ilPct).toBeLessThan(wide.ilPct); // plus négatif
  });

  it("se réduit à la formule AMM pleine échelle 2√r/(1+r)-1 pour un range très large", () => {
    const entry = 100;
    const current = 150;
    const r = current / entry;
    const expected = (2 * Math.sqrt(r)) / (1 + r) - 1;
    const got = concentratedIl({
      entryPrice: entry,
      currentPrice: current,
      priceLow: 1e-6,
      priceHigh: 1e9,
    });
    expect(got.ilPct).toBeCloseTo(expected, 4);
  });

  it("détecte la sortie de range", () => {
    const r = concentratedIl({
      entryPrice: 100,
      currentPrice: 130,
      priceLow: 80,
      priceHigh: 120,
    });
    expect(r.outOfRange).toBe(true);
  });

  it("rejette un range invalide", () => {
    expect(() =>
      concentratedIl({ entryPrice: 100, currentPrice: 100, priceLow: 120, priceHigh: 80 })
    ).toThrow();
  });
});

describe("suggestRange", () => {
  it("élargit le range avec la volatilité", () => {
    const calm = suggestRange(100, 0.02);
    const wild = suggestRange(100, 0.2);
    const calmWidth = calm.priceHigh - calm.priceLow;
    const wildWidth = wild.priceHigh - wild.priceLow;
    expect(wildWidth).toBeGreaterThan(calmWidth);
  });
});

function mockPool(p: Partial<Pool>): Pool {
  return {
    address: p.address ?? "addr",
    name: p.name ?? "X-Y",
    mintX: p.mintX ?? "x",
    mintY: p.mintY ?? "y",
    binStep: 20,
    baseFeePct: 0.2,
    liquidityUsd: p.liquidityUsd ?? 100_000,
    currentPrice: 1,
    apr: 0,
    volume24h: p.volume24h ?? 50_000,
    fees24h: p.fees24h ?? 100,
    feeTvl24h: p.feeTvl24h ?? 0.001,
    feeTvl1h: 0,
    isVerified: p.isVerified ?? true,
    isBlacklisted: p.isBlacklisted ?? false,
    baseMint: p.baseMint,
    baseMarketCapUsd: p.baseMarketCapUsd,
    volume4h: p.volume4h,
    feesInQuote: p.feesInQuote,
  };
}

describe("feeAprProxy", () => {
  it("annualise correctement les fees 24h", () => {
    const pool = mockPool({ fees24h: 100, liquidityUsd: 100_000 });
    // (100 / 100000) * 365 = 0.365
    expect(feeAprProxy(pool)).toBeCloseTo(0.365, 6);
  });

  it("renvoie 0 si liquidité nulle", () => {
    expect(feeAprProxy(mockPool({ liquidityUsd: 0 }))).toBe(0);
  });
});

describe("scanOpportunities", () => {
  it("filtre les pools blacklistées et illiquides", () => {
    const pools = [
      mockPool({ name: "GOOD", liquidityUsd: 500_000, volume24h: 600_000, feeTvl24h: 0.002 }),
      mockPool({ name: "BLACKLISTED", isBlacklisted: true }),
      mockPool({ name: "ILLIQUID", liquidityUsd: 100 }),
      mockPool({ name: "DEAD", volume24h: 0 }),
    ];
    const res = scanOpportunities(pools, { topN: 10 });
    const names = res.map((o) => o.pool.name);
    expect(names).toContain("GOOD");
    expect(names).not.toContain("BLACKLISTED");
    expect(names).not.toContain("ILLIQUID");
    expect(names).not.toContain("DEAD");
  });

  it("classe la pool au meilleur rendement/volume en tête", () => {
    const pools = [
      mockPool({ name: "MEH", liquidityUsd: 100_000, volume24h: 20_000, feeTvl24h: 0.0005 }),
      mockPool({ name: "STAR", liquidityUsd: 100_000, volume24h: 300_000, feeTvl24h: 0.003 }),
    ];
    const res = scanOpportunities(pools, { topN: 2, weights: DEFAULT_WEIGHTS });
    expect(res[0]?.pool.name).toBe("STAR");
  });

  it("produit des scores dans [0,1] et des explications non vides", () => {
    const pools = [
      mockPool({ name: "A", volume24h: 100_000, feeTvl24h: 0.002 }),
      mockPool({ name: "B", volume24h: 80_000, feeTvl24h: 0.0015 }),
      mockPool({ name: "C", volume24h: 60_000, feeTvl24h: 0.001 }),
    ];
    const res = scanOpportunities(pools);
    for (const o of res) {
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(1);
      expect(o.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("scanOpportunities — filtres de sélection DLMM", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const names = (pools: Pool[], opts = {}) =>
    scanOpportunities(pools, { topN: 10, minStableN: 0, ...opts }).map((o) => o.pool.name);

  it("écarte les pools où le volume 24h est inférieur à la TVL", () => {
    const pools = [
      mockPool({ name: "ACTIVE", liquidityUsd: 100_000, volume24h: 250_000 }),
      mockPool({ name: "SLEEPY", liquidityUsd: 100_000, volume24h: 60_000 }),
    ];
    expect(names(pools, { minVolumeTvlRatio: 1 })).toEqual(["ACTIVE"]);
  });

  it("écarte les tokens sous la market cap minimale (inconnue = conservée)", () => {
    const pools = [
      mockPool({ name: "BIG", volume24h: 200_000, baseMarketCapUsd: 5_000_000 }),
      mockPool({ name: "TINY", volume24h: 200_000, baseMarketCapUsd: 108_000 }),
      mockPool({ name: "UNKNOWN", volume24h: 200_000 }),
    ];
    const res = names(pools, { minMarketCapUsd: 1_000_000 });
    expect(res).toContain("BIG");
    expect(res).toContain("UNKNOWN");
    expect(res).not.toContain("TINY");
  });

  it("écarte les pools dont le volume récent s'effondre", () => {
    const pools = [
      // 4h × 6 = 120k vs 120k sur 24h → activité stable
      mockPool({ name: "STEADY", volume24h: 120_000, volume4h: 20_000 }),
      // cas réel BOYCOTT : 8k sur 4h × 6 = 48k vs 117k → ratio 0,41
      mockPool({ name: "FADING", volume24h: 117_000, volume4h: 8_000 }),
    ];
    expect(names(pools, { minRecentVolumeRatio: 0.5 })).toEqual(["STEADY"]);
  });

  it("ne garde qu'une pool par token : celle à la plus grosse TVL", () => {
    const pools = [
      mockPool({ name: "MEME-SOL bin80", baseMint: "meme", liquidityUsd: 15_000, volume24h: 210_000 }),
      mockPool({ name: "MEME-SOL bin125", baseMint: "meme", liquidityUsd: 84, volume24h: 10_000 }),
      mockPool({ name: "OTHER-SOL", baseMint: "other", liquidityUsd: 50_000, volume24h: 100_000 }),
    ];
    const res = names(pools, { minLiquidityUsd: 0, minVolume24h: 0, onePoolPerToken: true });
    expect(res).toContain("MEME-SOL bin80");
    expect(res).not.toContain("MEME-SOL bin125");
    expect(res).toContain("OTHER-SOL");
  });

  it("reconnaît USDC-USDT comme paire stable (mint USDT officiel)", () => {
    expect(isStablePool(mockPool({ mintX: USDC, mintY: USDT }))).toBe(true);
  });

  it("n'applique pas la market cap aux paires stables", () => {
    const pools = [mockPool({ name: "USDC-USDT", mintX: USDC, mintY: USDT, volume24h: 200_000, baseMarketCapUsd: 0 })];
    expect(names(pools, { minMarketCapUsd: 1_000_000 })).toEqual(["USDC-USDT"]);
  });
});

describe("scanOpportunities — fees versées en quote", () => {
  it("à métriques égales, classe en tête la pool qui verse ses fees en SOL/stable", () => {
    const pools = [
      mockPool({ name: "MIXED-FEES", volume24h: 200_000 }),
      mockPool({ name: "QUOTE-FEES", volume24h: 200_000, feesInQuote: true }),
    ];
    const res = scanOpportunities(pools, { topN: 2, minStableN: 0, quoteFeesBonus: 0.1 });
    expect(res[0]!.pool.name).toBe("QUOTE-FEES");
    expect(res[0]!.score).toBeLessThanOrEqual(1);
    expect(res[0]!.reasons.some((r) => r.includes("SOL/stable"))).toBe(true);
  });

  it("sans bonus, l'ordre ne dépend pas du mode de fees", () => {
    const pools = [
      mockPool({ name: "A", volume24h: 200_000 }),
      mockPool({ name: "B", volume24h: 200_000, feesInQuote: true }),
    ];
    const res = scanOpportunities(pools, { topN: 2, minStableN: 0, quoteFeesBonus: 0 });
    expect(res[0]!.score).toBe(res[1]!.score);
  });
});
