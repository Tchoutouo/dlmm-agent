import { describe, it, expect } from "vitest";
import { runMultiBacktest, type PoolSeries } from "../src/backtest/multiBacktester.js";
import type { Candle, Pool, RiskParams } from "../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const PARAMS: RiskParams = {
  maxPositionUsd: 100_000, // grand : ne bride pas, on teste les plafonds relatifs
  minPositionUsd: 10,
  maxDrawdown: 0.15,
  maxPortfolioExposure: 0.8,
  maxPoolConcentration: 0.25,
  maxPoolLiquidityShare: 0.1,
  riskBudgetPerTrade: 0.5, // large pour ne pas brider via le stress
  maxVolatilityAnnual: 10,
  minNetApr: -10, // on n'écarte pas sur l'APR ici, on teste l'allocation
  maxStressLoss: 0.95,
};

function pool(name: string, addr: string): Pool {
  return {
    address: addr,
    name,
    mintX: "So11111111111111111111111111111111111111112",
    mintY: USDC,
    binStep: 20,
    baseFeePct: 0.2,
    liquidityUsd: 5_000_000,
    currentPrice: 100,
    apr: 0,
    volume24h: 1_000_000,
    fees24h: 5000,
    feeTvl24h: 0.001,
    feeTvl1h: 0,
    isVerified: true,
    isBlacklisted: false,
  };
}

function calmHistory(n: number, seed = 0): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin((i + seed) / 6) * 0.12;
    out.push({
      timestamp: 1_700_000_000 + i * 3600,
      open: p,
      high: p * 1.002,
      low: p * 0.998,
      close: p,
      volume: 50_000,
    });
  }
  return out;
}

function makeSeries(count: number): PoolSeries[] {
  return Array.from({ length: count }, (_, k) => ({
    pool: pool(`P${k}-USDC`, `addr${k}`),
    candles: calmHistory(240, k * 3),
  }));
}

describe("runMultiBacktest", () => {
  it("aligne les pools et produit un résumé cohérent", () => {
    const res = runMultiBacktest(makeSeries(3), {
      timeframe: "1h",
      lookbackCandles: 48,
      windowCandles: 24,
      initialCashUsd: 1000,
      params: PARAMS,
    });
    expect(res.summary.pools).toBe(3);
    expect(res.summary.steps).toBeGreaterThan(0);
    expect(res.entries.length).toBeGreaterThan(0);
    const expectedNav = 1000 * (1 + res.summary.totalReturnPct / 100);
    expect(res.summary.finalNavUsd).toBeCloseTo(expectedNav, 2);
  });

  it("respecte le plafond d'exposition global entre pools", () => {
    // 6 pools attractives, capital limité : un plafond d'exposition serré doit
    // réduire le nombre total d'entrées vs un plafond large.
    const tight = runMultiBacktest(makeSeries(6), {
      lookbackCandles: 48,
      windowCandles: 24,
      initialCashUsd: 1000,
      params: { ...PARAMS, maxPortfolioExposure: 0.2, maxPoolConcentration: 0.1 },
    });
    const loose = runMultiBacktest(makeSeries(6), {
      lookbackCandles: 48,
      windowCandles: 24,
      initialCashUsd: 1000,
      params: { ...PARAMS, maxPortfolioExposure: 0.8, maxPoolConcentration: 0.5 },
    });
    expect(tight.summary.entered).toBeLessThanOrEqual(loose.summary.entered);
    expect(tight.summary.maxConcurrentPositions).toBeLessThanOrEqual(
      loose.summary.maxConcurrentPositions
    );
  });

  it("ne gagne pas sur un krach synchronisé et peut déclencher le disjoncteur", () => {
    const crash = (seed: number): Candle[] => {
      const out: Candle[] = [];
      let p = 100;
      for (let i = 0; i < 240; i++) {
        p *= i < 48 ? 1.0 : 0.96;
        out.push({
          timestamp: 1_700_000_000 + i * 3600,
          open: p, high: p * 1.001, low: p * 0.999, close: Math.max(1, p),
          volume: 50_000,
        });
      }
      return out;
    };
    const series: PoolSeries[] = [
      { pool: pool("A-USDC", "a"), candles: crash(0) },
      { pool: pool("B-USDC", "b"), candles: crash(1) },
    ];
    const res = runMultiBacktest(series, {
      lookbackCandles: 48, windowCandles: 24, initialCashUsd: 1000, params: PARAMS,
    });
    expect(res.summary.finalNavUsd).toBeLessThanOrEqual(1000);
  });
});
