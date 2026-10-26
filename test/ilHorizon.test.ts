import { describe, it, expect } from "vitest";
import { deepAnalyze } from "../src/analytics/deepAnalysis.js";
import { netAprAfterIl } from "../src/analytics/feeApr.js";
import { concentratedIl } from "../src/analytics/impermanentLoss.js";
import { planPosition } from "../src/analytics/positionPlan.js";
import { config } from "../src/config.js";
import type { Candle, Pool, ScoredOpportunity } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";

function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "p", name: "MEME-SOL", mintX: "meme", mintY: SOL, binStep: 100, baseFeePct: 0.2, liquidityUsd: 500_000,
    currentPrice: 1, apr: 0, volume24h: 800_000, fees24h: 2_000, feeTvl24h: 0.004, feeTvl1h: 0, isVerified: true,
    isBlacklisted: false, ...o,
  };
}
// Vol journalière ~5 % : alternance ±1 % par heure
const candles: Candle[] = Array.from({ length: 96 }, (_, i) => {
  const c = i % 2 === 0 ? 1 : 1.01;
  return { timestamp: 1_700_000_000 + i * 3600, open: c, high: c, low: c, close: c, volume: 30_000 };
});
const opp = (p: Pool): ScoredOpportunity => ({
  pool: p, score: 0.8, components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
  estimatedFeeApr: (p.fees24h / p.liquidityUsd) * 365, reasons: [],
});

describe("IL attendu : horizon de détention réel et position exécutable", () => {
  it(`horizon par défaut = PAPER_HOLDING_DAYS (${config.PAPER_HOLDING_DAYS} j), annualisé sur cet horizon`, () => {
    const a = deepAnalyze(opp(pool()), candles);
    expect(a.riskAdjustedNetApr).toBeCloseTo(netAprAfterIl(a.expectedFeeApr, a.ilAt1Sigma, config.PAPER_HOLDING_DAYS), 12);
    expect(a.rationale.join(" ")).toContain(`sur ${config.PAPER_HOLDING_DAYS} j`);
  });

  it("le scénario ±1σ s'élargit en √h : l'IL sur 4 j ≈ 4 × l'IL sur 1 j", () => {
    const d1 = deepAnalyze(opp(pool()), candles, { horizonDays: 1 });
    const d4 = deepAnalyze(opp(pool()), candles, { horizonDays: 4 });
    expect(d4.ilAt1Sigma).toBeLessThan(d1.ilAt1Sigma); // IL plus profond (valeurs négatives)
    // IL ∝ σ² en range : ×4 sur 4 j, donc traînée annualisée ≈ identique, jamais divisée par 4
    expect(d4.ilAt1Sigma / d1.ilAt1Sigma).toBeGreaterThan(3);
  });

  it("calcule l'IL sur le range exécutable (69 bins), pas sur le range suggéré", () => {
    const narrow = pool({ binStep: 5 }); // 69 bins × 5 pb ≈ ±18 % : plus étroit que le range à ±2σ
    const a = deepAnalyze(opp(narrow), candles);
    const plan = planPosition("spot", narrow, a.suggestedRange);
    expect(plan.rangeHigh).toBeLessThan(a.suggestedRange.priceHigh);
    const sigma = a.volatility.sigmaDaily;
    const up = concentratedIl({ entryPrice: 1, currentPrice: 1 + sigma, priceLow: plan.rangeLow, priceHigh: plan.rangeHigh }).ilPct;
    const down = concentratedIl({ entryPrice: 1, currentPrice: 1 - sigma, priceLow: plan.rangeLow, priceHigh: plan.rangeHigh }).ilPct;
    expect(a.ilAt1Sigma).toBeCloseTo((up + down) / 2, 12);
    // Range plus étroit → IL plus profond qu'avec un bin step qui couvre la volatilité
    expect(a.ilAt1Sigma).toBeLessThan(deepAnalyze(opp(pool({ binStep: 100 })), candles).ilAt1Sigma);
  });
});
