import { describe, it, expect } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { buildOrchestrator } from "../src/orchestration/graph.js";
import type { OrchestratorDeps, DecisionRecord, Proposal } from "../src/orchestration/deps.js";
import type { Candle, Pool, ScoredOpportunity } from "../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function pool(name: string, overrides: Partial<Pool> = {}): Pool {
  return {
    address: `addr-${name}`,
    name,
    mintX: "So11111111111111111111111111111111111111112",
    mintY: USDC, // quote stable → simplifie le test
    binStep: 20,
    baseFeePct: 0.2,
    liquidityUsd: 2_000_000,
    currentPrice: 100,
    apr: 0,
    volume24h: 800_000,
    fees24h: 2000,
    feeTvl24h: 0.001,
    feeTvl1h: 0,
    isVerified: true,
    isBlacklisted: false,
    ...overrides,
  };
}

function candidate(name: string, feeApr: number, p: Partial<Pool> = {}): ScoredOpportunity {
  return {
    pool: pool(name, p),
    score: 0.8,
    components: { yieldScore: 0.8, sustainabilityScore: 0.7, depthScore: 0.6 },
    estimatedFeeApr: feeApr,
    reasons: [`fee APR ${feeApr}`],
  };
}

/** Bougies calmes autour de 100 → IL négligeable, fee APR domine. */
function candles(): Candle[] {
  const closes = [100, 100.2, 99.9, 100.1, 100.3, 100.0, 100.15, 99.95, 100.1, 100.2, 100.05, 100.1];
  return closes.map((c, i) => ({
    timestamp: 1_700_000_000 + i * 3600,
    open: i > 0 ? closes[i - 1]! : c,
    high: c * 1.002,
    low: c * 0.998,
    close: c,
    volume: 50_000,
  }));
}

interface StubOpts {
  candidates: ScoredOpportunity[];
  drawdownPct?: number;
  navUsd?: number;
}

function makeDeps(opts: StubOpts): { deps: OrchestratorDeps; recorded: DecisionRecord[]; executed: Proposal[] } {
  const recorded: DecisionRecord[] = [];
  const executed: Proposal[] = [];
  const nav = opts.navUsd ?? 100_000;
  const deps: OrchestratorDeps = {
    scanMarket: async () => opts.candidates,
    getCandles: async () => candles(),
    getQuoteUsdPrice: async () => 1,
    getSnapshot: () => ({
      navUsd: nav,
      cashUsd: nav,
      deployedUsd: 0,
      peakNavUsd: nav,
      drawdownPct: opts.drawdownPct ?? 0,
      positions: [],
      exposureByPool: {},
    }),
    recordDecision: (r) => recorded.push(r),
    executePosition: async (p) => {
      executed.push(p);
      return { ok: true, note: "stub-exec" };
    },
  };
  return { deps, recorded, executed };
}

describe("orchestrateur — mode autonome", () => {
  it("approuve et exécute une bonne opportunité", async () => {
    const { deps, executed } = makeDeps({ candidates: [candidate("SOL-USDC", 0.6)] });
    const graph = buildOrchestrator(deps).compile();
    const out = await graph.invoke({ mode: "autonomous" });
    const enters = out.decisions.filter((d) => d.decision === "ENTER");
    expect(enters.length).toBe(1);
    expect(executed.length).toBe(1);
    expect(enters[0]!.sizeUsd).toBeGreaterThan(0);
  });

  it("VETO une opportunité à APR net insuffisant (pas d'exécution)", async () => {
    const { deps, executed } = makeDeps({ candidates: [candidate("LOW-USDC", 0.0)] });
    const graph = buildOrchestrator(deps).compile();
    const out = await graph.invoke({ mode: "autonomous" });
    expect(out.decisions.some((d) => d.decision === "SKIP")).toBe(true);
    expect(executed.length).toBe(0);
  });

  it("HALT au disjoncteur de drawdown et stoppe la boucle", async () => {
    const { deps, executed } = makeDeps({
      candidates: [candidate("A", 0.6), candidate("B", 0.6)],
      drawdownPct: 25,
    });
    const graph = buildOrchestrator(deps).compile();
    const out = await graph.invoke({ mode: "autonomous" });
    expect(out.halted).toBe(true);
    expect(out.decisions.some((d) => d.decision === "HALT")).toBe(true);
    // La boucle s'arrête : pas d'exécution, une seule décision (HALT sur A)
    expect(executed.length).toBe(0);
    expect(out.decisions.filter((d) => d.decision === "ENTER")).toHaveLength(0);
  });

  it("traite plusieurs candidates à la suite", async () => {
    const { deps } = makeDeps({
      candidates: [candidate("A", 0.6), candidate("B", 0.6), candidate("C", 0.0)],
    });
    const graph = buildOrchestrator(deps).compile();
    const out = await graph.invoke({ mode: "autonomous" });
    expect(out.decisions.length).toBe(3); // A, B, C tous traités
  });
});

describe("orchestrateur — mode supervisé (human-in-the-loop)", () => {
  it("s'interrompt en attente d'approbation puis exécute à la reprise", async () => {
    const { deps, executed } = makeDeps({ candidates: [candidate("SOL-USDC", 0.6)] });
    const graph = buildOrchestrator(deps).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t1" } };

    // 1er invoke : le graphe se met en pause sur la demande d'approbation
    const paused = await graph.invoke({ mode: "supervised" }, config);
    expect((paused as Record<string, unknown>).__interrupt__).toBeDefined();
    expect(executed.length).toBe(0);

    // Reprise avec approbation humaine
    const resumed = await graph.invoke(new Command({ resume: { approved: true } }), config);
    expect(resumed.decisions.some((d) => d.decision === "ENTER")).toBe(true);
    expect(executed.length).toBe(1);
  });

  it("respecte un rejet humain (SKIP, pas d'exécution)", async () => {
    const { deps, executed } = makeDeps({ candidates: [candidate("SOL-USDC", 0.6)] });
    const graph = buildOrchestrator(deps).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "t2" } };

    await graph.invoke({ mode: "supervised" }, config);
    const resumed = await graph.invoke(new Command({ resume: { approved: false } }), config);
    expect(resumed.decisions.some((d) => d.decision === "SKIP")).toBe(true);
    expect(executed.length).toBe(0);
  });
});
