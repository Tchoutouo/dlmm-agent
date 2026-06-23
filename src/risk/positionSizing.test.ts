import { describe, it, expect } from "vitest";
import { sizePosition } from "./positionSizing.js";
import type { Pool, PortfolioSnapshot, RiskParams } from "../types.js";

const params: RiskParams = {
  maxPositionUsd: 40,
  minPositionUsd: 10,
  maxDrawdown: 0.15,
  maxPortfolioExposure: 0.90,
  maxPoolConcentration: 0.50,
  maxPoolLiquidityShare: 0.01,
  riskBudgetPerTrade: 0.02,
  maxVolatilityAnnual: 4.0,
  minNetApr: 0.15,
  maxStressLoss: 0.40,
};

const pool: Pool = {
  address: "pool1",
  name: "SOL-USDC",
  mintX: "So11111111111111111111111111111111111111112",
  mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  binStep: 25,
  baseFeePct: 0.25,
  liquidityUsd: 1_000_000,
  currentPrice: 100,
  apr: 50,
  volume24h: 500_000,
  fees24h: 1_500,
  feeTvl24h: 0.0015,
  feeTvl1h: 0.00006,
  isVerified: true,
  isBlacklisted: false,
};

const emptySnapshot: PortfolioSnapshot = {
  navUsd: 100,
  cashUsd: 100,
  deployedUsd: 0,
  peakNavUsd: 100,
  drawdownPct: 0,
  positions: [],
  exposureByPool: {},
};

const range = { priceLow: 80, priceHigh: 120 };

describe("sizePosition", () => {
  it("est bridé par le plafond absolu (maxPositionUsd=40)", () => {
    // riskBudgetPerTrade élevé pour neutraliser le riskBudget cap
    const looseRisk = { ...params, riskBudgetPerTrade: 1.0 };
    const r = sizePosition(pool, range, emptySnapshot, looseRisk);
    // NAV=$100, exposure cap=90 > 40 → plafond absolu
    expect(r.recommendedSizeUsd).toBeLessThanOrEqual(40);
    expect(r.bindingCap).toBe("absolute");
  });

  it("est bridé par poolLiquidity (1% TVL) sur une petite pool", () => {
    const smallPool = { ...pool, liquidityUsd: 500 }; // 1% × $500 = $5
    const r = sizePosition(smallPool, range, emptySnapshot, params);
    expect(r.recommendedSizeUsd).toBeCloseTo(5, 4);
    expect(r.bindingCap).toBe("poolLiquidity");
  });

  it("est bridé par le capital disponible (90% NAV - deployed)", () => {
    // deployed=$87 → disponible = 100×0.90 - 87 = 3 USD
    const heavySnap: PortfolioSnapshot = {
      ...emptySnapshot,
      deployedUsd: 87,
      cashUsd: 13,
    };
    const r = sizePosition(pool, range, heavySnap, params);
    expect(r.recommendedSizeUsd).toBeLessThanOrEqual(3.01);
    expect(r.bindingCap).toBe("availableCapital");
  });

  it("est bridé par la concentration par pool", () => {
    // concentration max = 50% × $100 = $50, mais déjà $45 dans ce pool → max $5
    // riskBudget neutralisé pour que concentration soit le seul cap contraignant
    const looseRisk = { ...params, riskBudgetPerTrade: 1.0 };
    const concentratedSnap: PortfolioSnapshot = {
      ...emptySnapshot,
      deployedUsd: 45,
      cashUsd: 55,
      exposureByPool: { pool1: 45 },
    };
    const r = sizePosition(pool, range, concentratedSnap, looseRisk);
    expect(r.recommendedSizeUsd).toBeLessThanOrEqual(5.01);
    expect(r.bindingCap).toBe("concentration");
  });

  it("stressLossPct est toujours ≤ 0", () => {
    const r = sizePosition(pool, range, emptySnapshot, params);
    expect(r.stressLossPct).toBeLessThanOrEqual(0);
  });

  it("retourne 0 si tout le capital est déjà déployé (90% atteint)", () => {
    const fullSnap: PortfolioSnapshot = {
      ...emptySnapshot,
      deployedUsd: 90,
      cashUsd: 10,
    };
    const r = sizePosition(pool, range, fullSnap, params);
    expect(r.recommendedSizeUsd).toBe(0);
  });

  it("quoteShock négatif réduit la taille recommandée", () => {
    const noShock  = sizePosition(pool, range, emptySnapshot, params, 0);
    const withShock = sizePosition(pool, range, emptySnapshot, params, -0.10);
    // Plus de risque sur le quote → taille réduite via riskBudget
    expect(withShock.recommendedSizeUsd).toBeLessThanOrEqual(noShock.recommendedSizeUsd);
  });

  it("tous les caps dans le résultat sont des nombres finis positifs", () => {
    const r = sizePosition(pool, range, emptySnapshot, params);
    for (const [name, value] of Object.entries(r.caps)) {
      if (name === "riskBudget") continue; // peut être Infinity si stress=0
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
