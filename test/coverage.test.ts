import { describe, it, expect } from "vitest";
import { rangeCoverage, assessRisk, riskParamsFromConfig } from "../src/risk/riskAgent.js";
import { chooseCoveredPool } from "../src/analytics/poolChoice.js";
import { deepAnalyze } from "../src/analytics/deepAnalysis.js";
import { planPosition } from "../src/analytics/positionPlan.js";
import { scanOpportunities } from "../src/analytics/opportunityScanner.js";
import { simulatePosition } from "../src/backtest/positionSimulator.js";
import { buildOrchestrator } from "../src/orchestration/graph.js";
import type { OrchestratorDeps } from "../src/orchestration/deps.js";
import type { Candle, Pool, ScoredOpportunity } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";

function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "deep", name: "MEME-SOL", mintX: "meme", mintY: SOL, binStep: 1, baseFeePct: 0.2,
    liquidityUsd: 2_000_000, currentPrice: 1, apr: 0, volume24h: 3_000_000, fees24h: 9_000, feeTvl24h: 0.0045,
    feeTvl1h: 0, isVerified: true, isBlacklisted: false, baseMint: "meme", baseMarketCapUsd: 5e6, ...o,
  };
}
/** Bougies oscillant de ±amp par heure : avec 1 bps, 69 bins ne couvrent que ±0,34 %. */
function volatileCandles(amp = 0.05): Candle[] {
  return Array.from({ length: 96 }, (_, i) => {
    const c = 1 * (1 + amp * Math.sin(i * 1.7));
    return { timestamp: 1_700_000_000 + i * 3600, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 100_000 };
  });
}
const opportunity = (p: Pool, alternatives?: Pool[]): ScoredOpportunity => ({
  pool: p, score: 0.8, components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
  estimatedFeeApr: (p.fees24h / p.liquidityUsd) * 365, reasons: [], ...(alternatives ? { alternatives } : {}),
});

describe("rangeCoverage", () => {
  it("1 quand le range exécutable couvre tout, fraction sinon (côté le plus faible)", () => {
    expect(rangeCoverage(100, { priceLow: 90, priceHigh: 110 }, { priceLow: 90, priceHigh: 110 })).toBe(1);
    expect(rangeCoverage(100, { priceLow: 80, priceHigh: 120 }, { priceLow: 95, priceHigh: 110 })).toBeCloseTo(0.25, 10);
  });
  it("bid-ask d'un côté : seul le côté bas compte", () => {
    expect(rangeCoverage(100, { priceLow: 80, priceHigh: 120 }, { priceLow: 80, priceHigh: 100 }, true)).toBe(1);
  });
});

describe("veto de couverture dans l'agent de risque", () => {
  it("VETO quand le bin step ne permet de couvrir qu'une petite part du mouvement attendu", () => {
    const p = pool();
    const a = deepAnalyze(opportunity(p), volatileCandles());
    const plan = planPosition("spot", p, a.suggestedRange); // 69 bins de 1 bps : ±0,34 %
    const params = { ...riskParamsFromConfig(), minRangeCoverage: 0.5, maxVolatilityAnnual: 1e9, minNetApr: -1 };
    const snap = { navUsd: 1e5, cashUsd: 1e5, deployedUsd: 0, peakNavUsd: 1e5, drawdownPct: 0, positions: [], exposureByPool: {} };
    const r = assessRisk(opportunity(p), a, snap, params, undefined, plan);
    expect(r.verdict).toBe("VETO");
    expect(r.checks.some((c) => c.name === "range_coverage" && !c.passed)).toBe(true);
  });
});

describe("chooseCoveredPool : la pool du token au bin step adapté", () => {
  it("préfère l'alternative dont le bin step couvre la volatilité", () => {
    const wide = pool({ address: "wide", name: "MEME-SOL", binStep: 100, liquidityUsd: 300_000, fees24h: 2_000 });
    const main = chooseCoveredPool(opportunity(pool()), volatileCandles());
    const c = chooseCoveredPool(opportunity(pool(), [wide]), volatileCandles());
    expect(c.opportunity.pool.address).toBe("wide");
    expect(c.coverage).toBeGreaterThan(main.coverage * 10);
    expect(c.opportunity.reasons.at(-1)).toContain("bin step 100");
  });

  it("ignore une alternative sans fees suffisantes si la pool principale en a", () => {
    const deadWide = pool({ address: "dead", binStep: 100, fees24h: 0, volume24h: 10_000 });
    const calm = volatileCandles(0.002); // la pool principale reste rentable (APR net ≥ minimum)
    expect(chooseCoveredPool(opportunity(pool()), calm).analysis.riskAdjustedNetApr).toBeGreaterThan(0.05);
    const c = chooseCoveredPool(opportunity(pool(), [deadWide]), calm);
    expect(c.opportunity.pool.address).toBe("deep");
  });

  it("sans alternative : la pool d'origine", () => {
    expect(chooseCoveredPool(opportunity(pool()), volatileCandles()).opportunity.pool.address).toBe("deep");
  });
});

describe("scanner : alternatives par token", () => {
  it("joint les autres pools sûres du même token, même moins actives", () => {
    const deep = pool({ address: "deep", binStep: 1, liquidityUsd: 2_000_000, volume24h: 3_000_000 });
    const quiet = pool({ address: "bs100", binStep: 100, liquidityUsd: 60_000, volume24h: 10_000 }); // volume < TVL
    const unsafe = pool({ address: "unverified", binStep: 50, isVerified: false });
    const [o] = scanOpportunities([deep, quiet, unsafe], { topN: 5, minStableN: 0 });
    expect(o!.pool.address).toBe("deep");
    expect(o!.alternatives?.map((p) => p.address)).toEqual(["bs100"]);
  });
});

describe("orchestrateur : la suite porte sur la pool choisie", () => {
  it("journalise et exécute l'alternative quand elle couvre mieux la volatilité", async () => {
    const wide = pool({ address: "wide", name: "MEME-SOL bs100", binStep: 100, liquidityUsd: 300_000, fees24h: 2_000 });
    const executed: string[] = [];
    const deps: OrchestratorDeps = {
      scanMarket: async () => [opportunity(pool(), [wide])],
      getCandles: async () => volatileCandles(),
      getQuoteUsdPrice: async () => 100,
      getSnapshot: () => ({ navUsd: 1e5, cashUsd: 1e5, deployedUsd: 0, peakNavUsd: 1e5, drawdownPct: 0, positions: [], exposureByPool: {} }),
      recordDecision: () => 1,
      executePosition: async (p) => (executed.push(p.candidate.pool.address), { ok: true, note: "", mode: "PAPER" }),
    };
    const out = await buildOrchestrator(deps).compile().invoke({ mode: "autonomous" });
    expect(out.decisions[0]!.poolAddress).toBe("wide");
    if (out.decisions[0]!.decision === "ENTER") expect(executed).toEqual(["wide"]);
  });
});

describe("simulateur : décomposition face à la simple détention", () => {
  const base = { entryPrice: 100, sizeUsd: 1000, range: { priceLow: 80, priceHigh: 120 }, feeAprAnnual: 0, candleSeconds: 3600 };
  const candle = (c: number): Candle => ({ timestamp: 0, open: c, high: c, low: c, close: c, volume: 0 });

  it("prix inchangé : ni marché ni IL", () => {
    const out = simulatePosition({ ...base, forwardCandles: [candle(100)] });
    expect(out.hodlChangeUsd).toBeCloseTo(0, 10);
    expect(out.valueChangeUsd).toBeCloseTo(0, 10);
  });

  it("baisse dans le range : la détention perd, le LP perd davantage (IL < 0)", () => {
    const out = simulatePosition({ ...base, forwardCandles: [candle(90)] });
    expect(out.hodlChangeUsd).toBeLessThan(0);
    expect(out.valueChangeUsd - out.hodlChangeUsd).toBeLessThan(0);
  });

  it("baisse du quote en USD : comptée dans le marché, pas dans l'IL", () => {
    const out = simulatePosition({ ...base, forwardCandles: [candle(100)], quoteUsdEntry: 100, quoteUsdPath: [90] });
    expect(out.hodlChangeUsd).toBeCloseTo(-100, 6);
    expect(out.valueChangeUsd - out.hodlChangeUsd).toBeCloseTo(0, 6);
  });
});
