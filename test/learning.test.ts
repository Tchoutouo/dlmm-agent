import { describe, it, expect } from "vitest";
import { computeMetrics, calibrate } from "../src/learning/performance.js";
import { detectRecurringErrors } from "../src/learning/recurringErrors.js";
import { analyzeJournal } from "../src/learning/learningAgent.js";
import type { JournalEntry, FeeRegimeLabel } from "../src/types.js";

let nextId = 1;
function entry(o: Partial<JournalEntry> & { decision?: JournalEntry["decision"] } = {}): JournalEntry {
  return {
    id: nextId++,
    timestamp: new Date().toISOString(),
    poolAddress: o.poolAddress ?? "addr",
    poolName: o.poolName ?? "SOL-USDC",
    decision: o.decision ?? "ENTER",
    score: o.score ?? 0.7,
    estimatedFeeApr: o.estimatedFeeApr ?? 0.5,
    sizeUsd: o.sizeUsd,
    rangeLow: o.rangeLow,
    rangeHigh: o.rangeHigh,
    estimatedIlPct: o.estimatedIlPct,
    features: o.features,
    rationale: o.rationale ?? "test",
    realizedPnlUsd: o.realizedPnlUsd,
    feesCollectedUsd: o.feesCollectedUsd,
    wentOutOfRange: o.wentOutOfRange,
    holdingDays: o.holdingDays,
  };
}

function enterWithOutcome(regime: FeeRegimeLabel, pnl: number, opts: Partial<JournalEntry> = {}): JournalEntry {
  return entry({
    decision: "ENTER",
    sizeUsd: 100,
    realizedPnlUsd: pnl,
    feesCollectedUsd: Math.max(0, pnl) + 5,
    holdingDays: 2,
    features: { feeRegime: regime, binStep: 20, hedged: false, expectedNetApr: 0.4 },
    ...opts,
  });
}

describe("computeMetrics", () => {
  it("calcule win rate et PnL sur les ENTER avec issue", () => {
    const m = computeMetrics([
      enterWithOutcome("calm", 10),
      enterWithOutcome("calm", -4),
      enterWithOutcome("calm", 6),
      entry({ decision: "SKIP" }),
    ]);
    expect(m.entered).toBe(3);
    expect(m.withOutcome).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3, 5);
    expect(m.totalPnlUsd).toBeCloseTo(12, 5);
    expect(m.profitFactor).toBeCloseTo(16 / 4, 5); // gains bruts 16 / pertes brutes 4
  });

  it("profit factor null quand il n'y a aucune perte", () => {
    const m = computeMetrics([enterWithOutcome("calm", 10), enterWithOutcome("calm", 3)]);
    expect(m.profitFactor).toBeNull();
  });

  it("renvoie winRate null sans issue", () => {
    const m = computeMetrics([entry({ decision: "ENTER" }), entry({ decision: "SKIP" })]);
    expect(m.winRate).toBeNull();
  });
});

describe("calibrate", () => {
  it("mesure une corrélation positive quand le réalisé suit le prédit", () => {
    const entries = [
      enterWithOutcome("calm", 8, { features: { expectedNetApr: 0.8, feeRegime: "calm" } }),
      enterWithOutcome("calm", 4, { features: { expectedNetApr: 0.4, feeRegime: "calm" } }),
      enterWithOutcome("calm", 1, { features: { expectedNetApr: 0.1, feeRegime: "calm" } }),
    ];
    const c = calibrate(entries);
    expect(c.samples).toBe(3);
    expect(c.correlation).toBeGreaterThan(0.9);
  });
});

describe("detectRecurringErrors", () => {
  it("flagge un régime systématiquement perdant", () => {
    const entries = [
      enterWithOutcome("volatile", -10),
      enterWithOutcome("volatile", -8),
      enterWithOutcome("volatile", -12),
      enterWithOutcome("calm", 5),
      enterWithOutcome("calm", 7),
      enterWithOutcome("calm", 4),
    ];
    const patterns = detectRecurringErrors(entries, { minSamples: 3 });
    const vol = patterns.find((p) => p.feature === "regime=volatile");
    expect(vol).toBeDefined();
    expect(vol!.avgPnlUsd).toBeLessThan(0);
    // le régime calme (gagnant) ne doit PAS être flaggé
    expect(patterns.find((p) => p.feature === "regime=calm")).toBeUndefined();
  });

  it("flagge les sorties de range perdantes", () => {
    const entries = [
      enterWithOutcome("active", -6, { wentOutOfRange: true }),
      enterWithOutcome("active", -9, { wentOutOfRange: true }),
      enterWithOutcome("active", -5, { wentOutOfRange: true }),
    ];
    const patterns = detectRecurringErrors(entries, { minSamples: 3 });
    expect(patterns.find((p) => p.feature === "outOfRange=yes")).toBeDefined();
  });

  it("ne flagge rien sous le seuil d'échantillons", () => {
    const patterns = detectRecurringErrors([enterWithOutcome("volatile", -10)], { minSamples: 3 });
    expect(patterns).toHaveLength(0);
  });
});

describe("analyzeJournal", () => {
  it("produit un rapport complet avec suggestions", () => {
    const entries = [
      enterWithOutcome("volatile", -10),
      enterWithOutcome("volatile", -8),
      enterWithOutcome("volatile", -12),
      enterWithOutcome("calm", 6),
      enterWithOutcome("calm", 5),
      entry({ decision: "SKIP", features: { feeRegime: "volatile" } }),
    ];
    const report = analyzeJournal(entries);
    expect(report.overall.entered).toBe(5);
    expect(report.byRegime.volatile).toBeDefined();
    expect(report.recurringErrors.length).toBeGreaterThan(0);
    expect(report.suggestions.length).toBeGreaterThan(0);
    // une suggestion doit cibler le régime volatil
    expect(report.suggestions.some((s) => s.area.includes("VOLATILITY") || s.area.includes("MIN_NET_APR"))).toBe(true);
  });

  it("suggère d'accumuler des données si peu d'issues", () => {
    const report = analyzeJournal([entry({ decision: "SKIP" })]);
    expect(report.suggestions.some((s) => s.area === "données")).toBe(true);
  });
});
