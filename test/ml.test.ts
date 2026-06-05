import { describe, it, expect, vi, afterEach } from "vitest";
import { deepAnalyze } from "../src/analytics/deepAnalysis.js";
import type { Candle, ScoredOpportunity } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function pool(): ScoredOpportunity {
  return {
    pool: {
      address: "p", name: "SOL-USDC",
      mintX: "So11111111111111111111111111111111111111112",
      mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      binStep: 20, baseFeePct: 0.2, liquidityUsd: 2_000_000, currentPrice: 100,
      apr: 0, volume24h: 800_000, fees24h: 4000, feeTvl24h: 0.002, feeTvl1h: 0,
      isVerified: true, isBlacklisted: false,
    },
    score: 0.5,
    components: { yieldScore: 0.5, sustainabilityScore: 0.5, depthScore: 0.5 },
    estimatedFeeApr: 0.5,
    reasons: [],
  };
}

function candles(): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 60; i++) {
    p += Math.sin(i / 4) * 0.2;
    out.push({ timestamp: 1_700_000_000 + i * 3600, open: p, high: p * 1.003, low: p * 0.997, close: p, volume: 50_000 });
  }
  return out;
}

describe("deepAnalyze avec forwardDailyVol", () => {
  it("élargit le range quand la vol prédite est plus grande", () => {
    const base = deepAnalyze(pool(), candles());
    const wide = deepAnalyze(pool(), candles(), { forwardDailyVol: 0.2 }); // 20%/j, très volatil
    const baseWidth = base.suggestedRange.priceHigh - base.suggestedRange.priceLow;
    const wideWidth = wide.suggestedRange.priceHigh - wide.suggestedRange.priceLow;
    expect(wideWidth).toBeGreaterThan(baseWidth);
  });

  it("ignore une vol prédite nulle ou négative (repli sur le réalisé)", () => {
    const base = deepAnalyze(pool(), candles());
    const zero = deepAnalyze(pool(), candles(), { forwardDailyVol: 0 });
    expect(zero.suggestedRange.priceHigh).toBeCloseTo(base.suggestedRange.priceHigh, 6);
  });
});

describe("predictForwardVol (client)", () => {
  it("renvoie null si le ML est désactivé", async () => {
    // ML_ENABLED défaut = false → pas d'appel réseau
    const { predictForwardVol } = await import("../src/ml/volatilityClient.js");
    const res = await predictForwardVol(candles(), "1h");
    expect(res).toBeNull();
  });
});
