import { describe, it, expect } from "vitest";
import { concentratedIl, suggestRange } from "../src/analytics/impermanentLoss.js";
import { scanOpportunities, DEFAULT_WEIGHTS } from "../src/analytics/opportunityScanner.js";
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
    mintX: "x",
    mintY: "y",
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
      mockPool({ name: "GOOD", liquidityUsd: 500_000, volume24h: 200_000, feeTvl24h: 0.002 }),
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
