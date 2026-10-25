import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Keypair, type Connection } from "@solana/web3.js";
import { LivePositionManager } from "../src/execution/livePositionManager.js";
import type { RealExecutor } from "../src/execution/realExecutor.js";
import type { PriceOracle } from "../src/data/priceOracle.js";
import { TradeJournal } from "../src/journal/journal.js";
import { buildOrchestrator } from "../src/orchestration/graph.js";
import type { OrchestratorDeps } from "../src/orchestration/deps.js";
import { buildSuggestions } from "../src/learning/suggestions.js";
import { computeMetrics, calibrate } from "../src/learning/performance.js";
import type { Candle, ScoredOpportunity } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";
const tempDb = () => join(mkdtempSync(join(tmpdir(), "dlmm-journal-")), "j.db");

function liveSetup() {
  const db = tempDb();
  const wallet = { keypair: Keypair.generate(), connection: {} as Connection };
  const manager = new LivePositionManager(wallet, {} as PriceOracle, db);
  const journal = new TradeJournal(db);
  const jid = journal.record({
    timestamp: new Date().toISOString(), poolAddress: "pool", poolName: "MEME-SOL", decision: "ENTER",
    score: 0, estimatedFeeApr: 0, rationale: "test",
  });
  manager.register({ journalId: jid, poolAddress: "pool", poolName: "MEME-SOL", mintX: "meme", mintY: SOL, positionPubkey: "pos", sizeUsd: 100, openedAtSec: 0 });
  const set = (sql: string, ...args: unknown[]) => new Database(db).prepare(sql).run(...args);
  const outcome = () =>
    new Database(db).prepare(`SELECT decision, realized_pnl_usd p, fees_collected_usd f FROM journal WHERE id=?`).get(jid) as {
      decision: string; p: number; f: number;
    };
  const executor = {
    closePosition: vi.fn(async () => ({ mode: "LIVE", ok: true, note: "", txHash: "tx" })),
    claimFees: vi.fn(async () => ({ mode: "LIVE", ok: true, note: "" })),
  } as unknown as RealExecutor;
  return { manager, journal, executor, set, outcome };
}

describe("fees réclamées et PnL réalisé (faille M4)", () => {
  it("les fees réclamées comptent dans le take-profit et dans le PnL réalisé", async () => {
    const { manager, journal, executor, set, outcome } = liveSetup();
    set(`UPDATE live_positions SET value_usd=100, fees_usd=12`);
    await manager.claimAllFees(executor, 1); // 12 $ réclamés → fees_usd = 0
    // Avant : rendement vu = (100 + 0 − 100) = 0 % → pas de take-profit à +10 %
    expect(await manager.closeAtThresholds(10, 8, executor, journal)).toBe(1);
    expect(outcome().p).toBeCloseTo(12, 10);
    expect(outcome().f).toBeCloseTo(12, 10);
  });

  it("clôture manuelle : même PnL (fees incluses) que les autres chemins", async () => {
    const { manager, journal, executor, set, outcome } = liveSetup();
    set(`UPDATE live_positions SET value_usd=95, fees_usd=3, claimed_fees_usd=4`);
    const r = await manager.closeByRequest("pool", "pos", executor, journal);
    expect(r.ok).toBe(true);
    expect(outcome().p).toBeCloseTo(95 + 3 + 4 - 100, 10); // l'ancien calcul donnait −5
  });
});

describe("clôture manuelle limitée aux positions suivies (faille M1)", () => {
  it("refuse une position que l'agent ne suit pas, sans rien fermer", async () => {
    const { manager, journal, executor } = liveSetup();
    const r = await manager.closeByRequest("pool", "position-ouverte-a-la-main", executor, journal);
    expect(r.ok).toBe(false);
    expect(executor.closePosition).not.toHaveBeenCalled();
  });
});

describe("journal : une entrée simulée ou ratée n'est pas un ENTER (faille M4)", () => {
  const candidate: ScoredOpportunity = {
    pool: {
      address: "pool1", name: "SOL-USDC", mintX: SOL, mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", binStep: 20,
      baseFeePct: 0.2, liquidityUsd: 2_000_000, currentPrice: 100, apr: 0, volume24h: 800_000, fees24h: 2000,
      feeTvl24h: 0.001, feeTvl1h: 0, isVerified: true, isBlacklisted: false,
    },
    score: 0.8, components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 }, estimatedFeeApr: 0.6, reasons: [],
  };
  const candles: Candle[] = Array.from({ length: 12 }, (_, i) => {
    const c = 100 + Math.sin(i) * 0.2;
    return { timestamp: 1_700_000_000 + i * 3600, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 50_000 };
  });

  async function runWith(result: { ok: boolean; note: string; mode?: "LIVE" | "DRY_RUN" | "PAPER" }) {
    const amended: Array<[number, string]> = [];
    const deps: OrchestratorDeps = {
      scanMarket: async () => [candidate],
      getCandles: async () => candles,
      getQuoteUsdPrice: async () => 1,
      getSnapshot: () => ({ navUsd: 100_000, cashUsd: 100_000, deployedUsd: 0, peakNavUsd: 100_000, drawdownPct: 0, positions: [], exposureByPool: {} }),
      recordDecision: () => 42,
      executePosition: async () => result,
      amendDecision: (id, decision) => void amended.push([id, decision]),
    };
    const out = await buildOrchestrator(deps).compile().invoke({ mode: "autonomous" });
    return { decision: out.decisions[0]!.decision, amended, hedged: out.decisions[0]!.features };
  }

  it("ouverture réelle : ENTER, rien à corriger ; aucune couverture déclarée exécutée", async () => {
    const r = await runWith({ ok: true, note: "ok", mode: "PAPER" });
    expect(r.decision).toBe("ENTER");
    expect(r.amended).toEqual([]);
    expect(r.hedged?.hedged).toBe(false);
    expect(typeof r.hedged?.hedgeRecommended).toBe("boolean");
  });
  it("dry-run : DRY_RUN au journal", async () => {
    const r = await runWith({ ok: true, note: "simulé", mode: "DRY_RUN" });
    expect(r.decision).toBe("DRY_RUN");
    expect(r.amended).toEqual([[42, "DRY_RUN"]]);
  });
  it("échec d'exécution : FAILED au journal", async () => {
    const r = await runWith({ ok: false, note: "solde insuffisant" });
    expect(r.decision).toBe("FAILED");
    expect(r.amended).toEqual([[42, "FAILED"]]);
  });

  it("TradeJournal.amendDecision corrige l'entrée enregistrée", () => {
    const journal = new TradeJournal(tempDb());
    const id = journal.record({
      timestamp: new Date().toISOString(), poolAddress: "p", poolName: "P", decision: "ENTER",
      score: 0, estimatedFeeApr: 0, rationale: "t",
    });
    journal.amendDecision(id, "DRY_RUN", "simulé");
    expect(journal.allEntries().find((e) => e.id === id)?.decision).toBe("DRY_RUN");
  });
});

describe("apprentissage : couverture recommandée mais non exécutée", () => {
  it("suggère de réduire ou d'écarter ces positions", () => {
    const s = buildSuggestions({
      overall: computeMetrics([]),
      calibration: calibrate([]),
      byRegime: {},
      errors: [{ feature: "hedgeRecommended=yes", description: "perdant" } as never],
    });
    expect(s.some((x) => x.area.includes("couverture"))).toBe(true);
  });
});
