import { describe, it, expect } from "vitest";
import {
  computeVolatility,
  detectVolumeAnomalies,
} from "../src/analytics/volatility.js";
import { classifyFeeRegime } from "../src/analytics/dlmmFees.js";
import { deepAnalyze } from "../src/analytics/deepAnalysis.js";
import type { Candle, Pool, ScoredOpportunity } from "../src/types.js";

/** Génère des bougies à volatilité contrôlée autour d'un prix de base. */
function makeCandles(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: 1_700_000_000 + i * 3600,
    open: i > 0 ? closes[i - 1]! : close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: volumes?.[i] ?? 10_000,
  }));
}

describe("computeVolatility", () => {
  it("détecte une volatilité plus élevée pour une série plus agitée", () => {
    const calm = makeCandles([100, 100.1, 99.9, 100.05, 100, 99.95, 100.02]);
    const wild = makeCandles([100, 105, 96, 108, 94, 110, 92]);
    const volCalm = computeVolatility(calm, "1h");
    const volWild = computeVolatility(wild, "1h");
    expect(volWild.sigmaAnnual).toBeGreaterThan(volCalm.sigmaAnnual);
  });

  it("annualise correctement (cohérence period → daily → annual)", () => {
    const v = computeVolatility(makeCandles([100, 101, 100, 101, 100, 101, 100]), "1h");
    // sigmaDaily = sigmaPeriod * sqrt(24), sigmaAnnual = sigmaPeriod * sqrt(8760)
    expect(v.sigmaDaily / v.sigmaPeriod).toBeCloseTo(Math.sqrt(24), 4);
    expect(v.sigmaAnnual / v.sigmaPeriod).toBeCloseTo(Math.sqrt(8760), 4);
  });

  it("rejette une série trop courte", () => {
    expect(() => computeVolatility(makeCandles([100, 101]), "1h")).toThrow();
  });

  it("produit un estimateur de Parkinson positif", () => {
    const v = computeVolatility(makeCandles([100, 102, 98, 103, 97]), "1h");
    expect(v.parkinsonAnnual).toBeGreaterThan(0);
  });
});

describe("detectVolumeAnomalies", () => {
  it("repère un pic de volume isolé", () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const volumes = Array.from({ length: 20 }, (_, i) => (i === 10 ? 500_000 : 10_000));
    const anomalies = detectVolumeAnomalies(makeCandles(closes, volumes));
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0]!.volume).toBe(500_000);
  });

  it("ne signale rien quand le volume est homogène", () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const volumes = Array.from({ length: 20 }, () => 10_000);
    expect(detectVolumeAnomalies(makeCandles(closes, volumes))).toHaveLength(0);
  });
});

function mockPool(p: Partial<Pool>): Pool {
  return {
    address: "addr",
    name: "X-Y",
    mintX: "x",
    mintY: "y",
    binStep: 20,
    baseFeePct: p.baseFeePct ?? 0.2,
    liquidityUsd: p.liquidityUsd ?? 100_000,
    currentPrice: p.currentPrice ?? 100,
    apr: 0,
    volume24h: p.volume24h ?? 50_000,
    fees24h: p.fees24h ?? 100,
    feeTvl24h: p.feeTvl24h ?? 0.001,
    feeTvl1h: 0,
    isVerified: true,
    isBlacklisted: false,
  };
}

describe("classifyFeeRegime", () => {
  it("classe 'calm' quand le fee effectif ≈ fee de base", () => {
    // base 0.2% ; effectif = 100/50000 = 0.2% → ratio ≈ 1
    const r = classifyFeeRegime(mockPool({ fees24h: 100, volume24h: 50_000, baseFeePct: 0.2 }));
    expect(r.label).toBe("calm");
  });

  it("classe 'volatile' quand le fee effectif >> fee de base", () => {
    // base 0.1% ; effectif = 1500/50000 = 3% → ratio = 30
    const r = classifyFeeRegime(mockPool({ fees24h: 1500, volume24h: 50_000, baseFeePct: 0.1 }));
    expect(r.label).toBe("volatile");
  });
});

describe("deepAnalyze", () => {
  function opportunity(pool: Pool, feeApr: number): ScoredOpportunity {
    return {
      pool,
      score: 0.8,
      components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
      estimatedFeeApr: feeApr,
      reasons: ["test"],
    };
  }

  it("produit une analyse complète avec range et IL cohérents", () => {
    const pool = mockPool({ currentPrice: 100 });
    const candles = makeCandles([100, 101, 99, 102, 98, 101, 100, 103, 97, 100]);
    const a = deepAnalyze(opportunity(pool, 0.4), candles, { timeframe: "1h" });

    expect(a.suggestedRange.priceLow).toBeLessThan(100);
    expect(a.suggestedRange.priceHigh).toBeGreaterThan(100);
    expect(a.ilAt1Sigma).toBeLessThanOrEqual(0); // l'IL est une perte (≤ 0)
    expect(a.rationale.length).toBeGreaterThan(0);
  });

  it("un fee APR élevé donne un APR net ajusté supérieur à un fee APR faible", () => {
    const pool = mockPool({ currentPrice: 100 });
    const candles = makeCandles([100, 101, 99, 102, 98, 101, 100, 103, 97, 100]);
    const high = deepAnalyze(opportunity(pool, 0.8), candles);
    const low = deepAnalyze(opportunity(pool, 0.1), candles);
    expect(high.riskAdjustedNetApr).toBeGreaterThan(low.riskAdjustedNetApr);
  });
});
