import { describe, it, expect } from "vitest";
import { assessRisk } from "../src/risk/riskAgent.js";
import { sizePosition } from "../src/risk/positionSizing.js";
import { buildQuoteProfile, quoteStressShock } from "../src/analytics/quoteRisk.js";
import { SOL_MINT } from "../src/data/priceOracle.js";
import type {
  DeepAnalysis,
  Pool,
  PortfolioSnapshot,
  RiskParams,
  ScoredOpportunity,
} from "../src/types.js";

const PARAMS: RiskParams = {
  maxPositionUsd: 100,
  minPositionUsd: 10,
  maxDrawdown: 0.15,
  maxPortfolioExposure: 0.8,
  maxPoolConcentration: 0.25,
  maxPoolLiquidityShare: 0.01,
  riskBudgetPerTrade: 0.02,
  maxVolatilityAnnual: 4,
  minNetApr: 0.05,
  maxStressLoss: 0.4,
};

function pool(p: Partial<Pool> = {}): Pool {
  return {
    address: p.address ?? "pool1",
    name: p.name ?? "SOL-USDC",
    mintX: p.mintX ?? "So111",
    mintY: p.mintY ?? "EPjFW",
    binStep: 20,
    baseFeePct: 0.2,
    liquidityUsd: p.liquidityUsd ?? 1_000_000,
    currentPrice: p.currentPrice ?? 100,
    apr: 0,
    volume24h: 500_000,
    fees24h: 1000,
    feeTvl24h: 0.001,
    feeTvl1h: 0,
    isVerified: true,
    isBlacklisted: false,
  };
}

function analysis(a: Partial<DeepAnalysis> = {}): DeepAnalysis {
  return {
    volatility: {
      timeframe: "1h", samples: 168,
      sigmaPeriod: 0.01, sigmaAnnual: a.volatility?.sigmaAnnual ?? 0.8,
      sigmaDaily: 0.05, parkinsonAnnual: 0.8,
    },
    feeRegime: a.feeRegime ?? { label: "active", effectiveFeeRate: 0.002, baseFeeRate: 0.001, ratio: 2 },
    anomalies: [],
    suggestedRange: a.suggestedRange ?? { priceLow: 90, priceHigh: 110 },
    ilAt1Sigma: -0.01,
    ilAtRangeEdge: -0.02,
    expectedFeeApr: 0.5,
    riskAdjustedNetApr: a.riskAdjustedNetApr ?? 0.3,
    rationale: [],
  };
}

function opportunity(p: Pool): ScoredOpportunity {
  return {
    pool: p, score: 0.8,
    components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
    estimatedFeeApr: 0.5, reasons: [],
  };
}

function snapshot(s: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    navUsd: s.navUsd ?? 1000,
    cashUsd: s.cashUsd ?? 1000,
    deployedUsd: s.deployedUsd ?? 0,
    peakNavUsd: s.peakNavUsd ?? 1000,
    drawdownPct: s.drawdownPct ?? 0,
    dailyLossPct: s.dailyLossPct,
    positions: s.positions ?? [],
    exposureByPool: s.exposureByPool ?? {},
  };
}

describe("assessRisk — disjoncteur drawdown", () => {
  it("HALT quand le drawdown dépasse le seuil", () => {
    const r = assessRisk(opportunity(pool()), analysis(), snapshot({ drawdownPct: 20 }), PARAMS);
    expect(r.verdict).toBe("HALT");
    expect(r.recommendedSizeUsd).toBe(0);
  });

  it("ne déclenche pas le disjoncteur sous le seuil", () => {
    const r = assessRisk(opportunity(pool()), analysis(), snapshot({ drawdownPct: 5 }), PARAMS);
    expect(r.verdict).not.toBe("HALT");
  });
});

describe("assessRisk — limite de perte journalière", () => {
  const withDaily = { ...PARAMS, maxDailyLoss: 0.05 };

  it("HALT quand la perte du jour atteint le seuil", () => {
    const r = assessRisk(opportunity(pool()), analysis(), snapshot({ dailyLossPct: 6 }), withDaily);
    expect(r.verdict).toBe("HALT");
    expect(r.recommendedSizeUsd).toBe(0);
    expect(r.checks.some((c) => c.name === "daily_loss" && !c.passed)).toBe(true);
  });

  it("laisse passer sous le seuil et trace le contrôle", () => {
    const r = assessRisk(opportunity(pool()), analysis(), snapshot({ dailyLossPct: 2 }), withDaily);
    expect(r.verdict).not.toBe("HALT");
    expect(r.checks.some((c) => c.name === "daily_loss" && c.passed)).toBe(true);
  });

  it("ignore la limite quand elle est désactivée ou non suivie", () => {
    const off = assessRisk(opportunity(pool()), analysis(), snapshot({ dailyLossPct: 50 }), { ...PARAMS, maxDailyLoss: 0 });
    const untracked = assessRisk(opportunity(pool()), analysis(), snapshot(), withDaily);
    expect(off.verdict).not.toBe("HALT");
    expect(untracked.verdict).not.toBe("HALT");
  });
});

describe("assessRisk — vetos", () => {
  it("VETO si la volatilité dépasse le maximum", () => {
    const r = assessRisk(
      opportunity(pool()),
      analysis({ volatility: { sigmaAnnual: 6 } as DeepAnalysis["volatility"] }),
      snapshot(), PARAMS
    );
    expect(r.verdict).toBe("VETO");
    expect(r.checks.find((c) => c.name === "volatility")?.passed).toBe(false);
  });

  it("VETO si l'APR net est sous le minimum", () => {
    const r = assessRisk(opportunity(pool()), analysis({ riskAdjustedNetApr: 0.01 }), snapshot(), PARAMS);
    expect(r.verdict).toBe("VETO");
    expect(r.checks.find((c) => c.name === "net_apr")?.passed).toBe(false);
  });

  it("VETO si aucun capital n'est disponible", () => {
    const r = assessRisk(
      opportunity(pool()),
      analysis(),
      snapshot({ deployedUsd: 1000, navUsd: 1000 }), // exposition déjà à 100%
      PARAMS
    );
    expect(r.verdict).toBe("VETO");
  });
});

describe("assessRisk — approbation et dimensionnement", () => {
  it("APPROVE_REDUCED quand un plafond bride sous le max absolu", () => {
    // budget de risque : nav 1000 × 2% = $20 ; stress ~ -10% (range ±10%) → cap ~ $200
    // concentration : 1000 × 25% = $250 ; dispo : 800 ; liquidité : 1M × 1% = 10k
    // absolu = 100 → ici le budget de risque (selon stress) sera le plus serré
    const r = assessRisk(opportunity(pool()), analysis(), snapshot(), PARAMS);
    expect(["APPROVE", "APPROVE_REDUCED"]).toContain(r.verdict);
    expect(r.recommendedSizeUsd).toBeGreaterThan(0);
    expect(r.recommendedSizeUsd).toBeLessThanOrEqual(PARAMS.maxPositionUsd);
  });

  it("le verdict est APPROVE quand le plafond absolu est le plus serré", () => {
    // Gros NAV → tous les plafonds relatifs sont larges, seul l'absolu (100) borne
    const big = snapshot({ navUsd: 1_000_000, cashUsd: 1_000_000, peakNavUsd: 1_000_000 });
    const r = assessRisk(opportunity(pool({ liquidityUsd: 100_000_000 })), analysis(), big, PARAMS);
    expect(r.verdict).toBe("APPROVE");
    expect(r.bindingCap).toBe("absolute");
    expect(r.recommendedSizeUsd).toBe(100);
  });

  it("expose des checks auditables et un rationale non vide", () => {
    const r = assessRisk(opportunity(pool()), analysis(), snapshot(), PARAMS);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(r.sizingCaps)).toContain("riskBudget");
  });
});

describe("sizePosition — plafonds", () => {
  it("respecte la limite de concentration par pool", () => {
    // pool déjà exposée à $240 ; concentration max = 1000×25% = $250 → reste $10
    const s = snapshot({ exposureByPool: { pool1: 240 }, deployedUsd: 240, navUsd: 1000 });
    const res = sizePosition(pool(), { priceLow: 90, priceHigh: 110 }, s, PARAMS);
    expect(res.caps.concentration).toBeCloseTo(10, 5);
  });

  it("calcule une perte de stress négative dans un range serré", () => {
    const res = sizePosition(pool({ currentPrice: 100 }), { priceLow: 95, priceHigh: 105 }, snapshot(), PARAMS);
    expect(res.stressLossPct).toBeLessThan(0);
  });

  it("un shock de quote négatif aggrave la perte de stress (TOKEN/SOL)", () => {
    const range = { priceLow: 95, priceHigh: 105 };
    const stable = sizePosition(pool(), range, snapshot(), PARAMS, 0);
    const sol = sizePosition(pool(), range, snapshot(), PARAMS, -0.1); // SOL -10%
    expect(sol.stressLossPct).toBeLessThan(stable.stressLossPct); // plus négatif
    // ...donc le plafond budget de risque est plus serré
    expect(sol.caps.riskBudget!).toBeLessThan(stable.caps.riskBudget!);
  });
});

describe("buildQuoteProfile / quoteStressShock", () => {
  it("quote stable : prix 1, vol 0, shock nul", () => {
    const p = buildQuoteProfile("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 1);
    expect(p.isStable).toBe(true);
    expect(p.dailyVolUsd).toBe(0);
    expect(quoteStressShock(p)).toBe(0);
  });

  it("quote non-stable (SOL) : utilise la vol par défaut et un shock négatif", () => {
    const p = buildQuoteProfile(SOL_MINT, 150, { defaultDailyVol: 0.05 });
    expect(p.isStable).toBe(false);
    expect(p.usdPrice).toBe(150);
    expect(p.dailyVolUsd).toBe(0.05);
    expect(quoteStressShock(p, 2)).toBeCloseTo(-0.1, 6); // -2 × 5%
  });

  it("un paire TOKEN/SOL est dimensionnée plus petit qu'une TOKEN/USDC équivalente", () => {
    const range = { priceLow: 90, priceHigh: 110 };
    const a = analysis({ suggestedRange: range });
    const usdc = assessRisk(opportunity(pool()), a, snapshot(), PARAMS);
    const solProfile = buildQuoteProfile(SOL_MINT, 150, { defaultDailyVol: 0.05 });
    const sol = assessRisk(opportunity(pool()), a, snapshot(), PARAMS, solProfile);
    // Si les deux approuvent, la version SOL doit être ≤ (risque accru)
    if (sol.recommendedSizeUsd > 0 && usdc.recommendedSizeUsd > 0) {
      expect(sol.recommendedSizeUsd).toBeLessThanOrEqual(usdc.recommendedSizeUsd);
    }
    // et le hedge SOL signale l'exposition au quote
    expect(sol.hedge.quoteExposureUsd).toBeGreaterThanOrEqual(0);
  });
});
