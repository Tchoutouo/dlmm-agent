import { describe, it, expect, vi } from "vitest";
import BN from "bn.js";
import { Keypair, type Connection } from "@solana/web3.js";
import { appliedFeeFactor, feeConcentrationFactor } from "../src/analytics/feeConcentration.js";
import { chooseCoveredPool, spotPositionBins, withFeeConcentration } from "../src/analytics/poolChoice.js";
import { simulatePosition } from "../src/backtest/positionSimulator.js";
import { buildOrchestrator } from "../src/orchestration/graph.js";
import type { OrchestratorDeps } from "../src/orchestration/deps.js";
import type { Candle, Pool, ScoredOpportunity } from "../src/types.js";

vi.mock("../src/dlmmSdk.js", () => ({
  default: {
    create: async () => ({
      tokenX: { mint: { decimals: 6 } },
      tokenY: { mint: { decimals: 9 } },
      getBinsAroundActiveBin: async () => ({
        activeBin: 10,
        bins: [
          { binId: 7, xAmount: new BN(0), yAmount: new BN(0), pricePerToken: "2" }, // hors rayon : ignoré
          { binId: 9, xAmount: new BN(0), yAmount: new BN(2e9), pricePerToken: "2" }, // 2 SOL
          { binId: 10, xAmount: new BN(1e6), yAmount: new BN(1e9), pricePerToken: "2" }, // 1 X × 2 + 1 SOL
          { binId: 11, xAmount: new BN(3e6), yAmount: new BN(0), pricePerToken: "2" }, // 3 X × 2
        ],
      }),
    }),
  },
}));
const { readNearActiveLiquidityUsd } = await import("../src/data/binLiquidity.js");

describe("feeConcentrationFactor", () => {
  it("part réelle dans les bins de la position vs part de TVL", () => {
    // 100 $ sur 50 bins = 2 $/bin ; bins voisins à 98 $ → part réelle 2 % ; part de TVL 100/10 000 = 1 % → k = 2
    expect(feeConcentrationFactor({ tvlUsd: 10_000, nearBinLiquidityUsd: [98, 98, 98], positionBins: 50, sizeUsd: 100 })).toBeCloseTo(2, 10);
  });
  it("< 1 quand des LP concurrents concentrent beaucoup de liquidité près du prix", () => {
    expect(feeConcentrationFactor({ tvlUsd: 10_000, nearBinLiquidityUsd: [998], positionBins: 50, sizeUsd: 100 })).toBeCloseTo(0.2, 10);
  });
  it("données absentes : facteur neutre", () => {
    expect(feeConcentrationFactor({ tvlUsd: 0, nearBinLiquidityUsd: [1], positionBins: 1, sizeUsd: 1 })).toBe(1);
    expect(feeConcentrationFactor({ tvlUsd: 1e4, nearBinLiquidityUsd: [], positionBins: 1, sizeUsd: 1 })).toBe(1);
  });
});

describe("appliedFeeFactor : plafond prudent", () => {
  it("plafonne, borne à 0,1, et 0 désactive le modèle", () => {
    expect(appliedFeeFactor(7.6, 2)).toBe(2);
    expect(appliedFeeFactor(0.35, 2)).toBe(0.35);
    expect(appliedFeeFactor(0.01, 2)).toBe(0.1);
    expect(appliedFeeFactor(7.6, 0)).toBe(1);
    expect(appliedFeeFactor(null, 2)).toBe(1);
  });
});

describe("readNearActiveLiquidityUsd (SDK simulé)", () => {
  it("valorise les bins actif ± 1 en USD (X au prix du bin, Y au prix du quote)", async () => {
    const usd = await readNearActiveLiquidityUsd(Keypair.generate().publicKey.toBase58(), 100, 1, {} as Connection);
    expect(usd).toEqual([200, 300, 600]); // (0 + 2) × 100, (2 + 1) × 100, (6 + 0) × 100
  });
});

const SOL = "So11111111111111111111111111111111111111112";
function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "p", name: "MEME-SOL", mintX: "meme", mintY: SOL, binStep: 100, baseFeePct: 0.2, liquidityUsd: 500_000,
    currentPrice: 1, apr: 0, volume24h: 800_000, fees24h: 400, feeTvl24h: 0.0008, feeTvl1h: 0, isVerified: true,
    isBlacklisted: false, ...o,
  };
}
const candles: Candle[] = Array.from({ length: 96 }, (_, i) => {
  const c = 1 + 0.004 * Math.sin(i);
  return { timestamp: 1_700_000_000 + i * 3600, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 30_000 };
});
const opp = (p: Pool): ScoredOpportunity => ({
  pool: p, score: 0.8, components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
  estimatedFeeApr: (p.fees24h / p.liquidityUsd) * 365, reasons: [],
});

describe("withFeeConcentration : APR attendu et verdict ajustés", () => {
  it("multiplie l'APR de fees par le facteur plafonné et refait l'analyse", () => {
    const base = chooseCoveredPool(opp(pool()), candles);
    const adjusted = withFeeConcentration(base, candles, 7.6); // plafonné à 2 par défaut
    expect(adjusted.opportunity.estimatedFeeApr).toBeCloseTo(base.opportunity.estimatedFeeApr * 2, 10);
    expect(adjusted.analysis.riskAdjustedNetApr).toBeGreaterThan(base.analysis.riskAdjustedNetApr);
    expect(adjusted.opportunity.reasons.at(-1)).toContain("×2.00");
  });
  it("facteur absent : rien ne change", () => {
    const base = chooseCoveredPool(opp(pool()), candles);
    expect(withFeeConcentration(base, candles, null)).toBe(base);
  });
  it("spotPositionBins compte les bins de la position exécutable", () => {
    const bins = spotPositionBins(chooseCoveredPool(opp(pool()), candles));
    expect(bins).toBeGreaterThan(0);
    expect(bins).toBeLessThanOrEqual(69);
  });
});

describe("orchestrateur : getFeeConcentration ajuste l'APR de la pool retenue", () => {
  it("l'APR attendu transmis à l'exécution intègre le facteur", async () => {
    let executedApr = 0;
    const deps: OrchestratorDeps = {
      scanMarket: async () => [opp(pool())],
      getCandles: async () => candles,
      getQuoteUsdPrice: async () => 100,
      getSnapshot: () => ({ navUsd: 1e5, cashUsd: 1e5, deployedUsd: 0, peakNavUsd: 1e5, drawdownPct: 0, positions: [], exposureByPool: {} }),
      recordDecision: () => 1,
      getFeeConcentration: async () => 1.5,
      executePosition: async (p) => ((executedApr = p.candidate.estimatedFeeApr), { ok: true, note: "", mode: "PAPER" }),
    };
    const out = await buildOrchestrator(deps).compile().invoke({ mode: "autonomous" });
    expect(out.decisions[0]!.decision).toBe("ENTER");
    expect(executedApr).toBeCloseTo(opp(pool()).estimatedFeeApr * 1.5, 10);
  });
});

describe("simulateur : facteur de fees et coût d'aller-retour", () => {
  const base = {
    entryPrice: 1, sizeUsd: 1000, range: { priceLow: 0.9, priceHigh: 1.1 }, feeAprAnnual: 0, candleSeconds: 3600,
    feeShareOfVolume: 1e-9, forwardCandles: candles.slice(0, 24),
  };
  it("les fees sont multipliées par le facteur de concentration", () => {
    const a = simulatePosition(base);
    const b = simulatePosition({ ...base, feeConcentration: 2 });
    expect(b.feesEarnedUsd).toBeCloseTo(a.feesEarnedUsd * 2, 10);
  });
  it("le coût d'aller-retour est déduit du PnL et pris en compte par le stop-loss", () => {
    const a = simulatePosition(base);
    const b = simulatePosition({ ...base, tradeCostPct: 0.2 });
    expect(b.tradeCostUsd).toBeCloseTo(2, 10);
    expect(b.realizedPnlUsd).toBeCloseTo(a.realizedPnlUsd - 2, 10);
    // coût de 10 % ≥ stop-loss de 8 % : sortie dès la première bougie
    const stopped = simulatePosition({ ...base, tradeCostPct: 10, stopLossPct: 8 });
    expect(stopped.exitReason).toBe("stop_loss");
    expect(stopped.holdingDays * 24).toBe(1);
  });
});
