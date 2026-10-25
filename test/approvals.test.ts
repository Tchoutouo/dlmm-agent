import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperBroker } from "../src/paper/paperBroker.js";
import { ApprovalQueue, type ApprovalRequest } from "../src/paper/approvalQueue.js";
import { openApprovedProposals } from "../src/paper/paperDeps.js";
import { TradeJournal } from "../src/journal/journal.js";
import { config } from "../src/config.js";
import type { ProductionClients } from "../src/orchestration/productionDeps.js";
import type { Candle, Pool } from "../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "pool-A", name: "SOL-USDC", mintX: "So11111111111111111111111111111111111111112", mintY: USDC,
    binStep: 20, baseFeePct: 0.2, liquidityUsd: 2_000_000, currentPrice: 100, apr: 0, volume24h: 800_000,
    fees24h: 4000, feeTvl24h: 0.002, feeTvl1h: 0, isVerified: true, isBlacklisted: false, ...o,
  };
}

function candles(): Candle[] {
  return Array.from({ length: 168 }, (_, i) => {
    const c = 100 + Math.sin(i / 5) * 0.2;
    return { timestamp: 1_700_000_000 + i * 3600, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 30_000 };
  });
}

function setup(pools: Record<string, Pool>) {
  const dir = mkdtempSync(join(tmpdir(), "dlmm-approvals-"));
  const db = join(dir, "j.db");
  const broker = new PaperBroker(db, 1000);
  const queue = new ApprovalQueue(db);
  const clients = {
    market: { getPair: async (addr: string) => pools[addr]! },
    data: { getOhlcv: async () => candles() },
    oracle: { getUsdPrice: async () => 1 },
    journal: new TradeJournal(db),
  } as unknown as ProductionClients;
  return { broker, queue, clients };
}

function request(p: Pool, o: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    poolAddress: p.address, poolName: p.name, mintX: p.mintX, mintY: p.mintY, entryPrice: p.currentPrice,
    rangeLow: p.currentPrice * 0.95, rangeHigh: p.currentPrice * 1.05, sizeUsd: 100, feeAprAnnual: 0.7,
    verdict: "APPROVE", volAnnual: 0.3, regime: "calm", expectedNetApr: 0.5, binStep: p.binStep, hedged: false,
    rationale: "test", ...o,
  };
}

const now = new Date("2026-10-26T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("approbations supervisées — revalidation avant ouverture (faille H2)", () => {
  it("ouvre une approbation fraîche au prix COURANT, revalidée par le risque", async () => {
    const p = pool();
    const { broker, queue, clients } = setup({ [p.address]: p });
    queue.decide(queue.enqueue(request(p), minutesAgo(10)), true);
    const res = await openApprovedProposals(broker, clients, queue, now);
    expect(res.opened).toBe(1);
    const [pos] = broker.listOpen();
    expect(pos!.entryPrice).toBe(100);
    expect(pos!.sizeUsd).toBeLessThanOrEqual(100);
    expect(queue.listByStatus("EXECUTED")).toHaveLength(1);
  });

  it(`expire une approbation de plus de APPROVAL_TTL_MIN (${config.APPROVAL_TTL_MIN} min)`, async () => {
    const p = pool();
    const { broker, queue, clients } = setup({ [p.address]: p });
    queue.decide(queue.enqueue(request(p), minutesAgo(config.APPROVAL_TTL_MIN + 1)), true);
    const res = await openApprovedProposals(broker, clients, queue, now);
    expect(res.opened).toBe(0);
    const [row] = queue.listByStatus("EXPIRED");
    expect(row!.note).toContain("expirée");
    expect(broker.listOpen()).toHaveLength(0);
  });

  it("abandonne si le prix a bougé de plus de 3 % depuis l'approbation", async () => {
    const p = pool(); // prix courant 100
    const { broker, queue, clients } = setup({ [p.address]: p });
    queue.decide(queue.enqueue(request(p, { entryPrice: 90 }), minutesAgo(5)), true);
    await openApprovedProposals(broker, clients, queue, now);
    expect(queue.listByStatus("EXPIRED")[0]!.note).toContain("prix");
    expect(broker.listOpen()).toHaveLength(0);
  });

  it("abandonne si le risque refuse désormais (ici : plus aucun fee → APR net insuffisant)", async () => {
    const dead = pool({ fees24h: 0, feeTvl24h: 0 });
    const { broker, queue, clients } = setup({ [dead.address]: dead });
    queue.decide(queue.enqueue(request(dead), minutesAgo(5)), true);
    await openApprovedProposals(broker, clients, queue, now);
    expect(queue.listByStatus("EXPIRED")[0]!.note).toContain("refusée à la revalidation");
    expect(broker.listOpen()).toHaveLength(0);
  });

  it("respecte MAX_POSITIONS_PER_SCAN : les approbations suivantes attendent", async () => {
    const pools = Object.fromEntries(
      ["A", "B", "C"].map((k) => [`pool-${k}`, pool({ address: `pool-${k}`, name: `${k}-USDC` })])
    );
    const { broker, queue, clients } = setup(pools);
    for (const p of Object.values(pools)) queue.decide(queue.enqueue(request(p), minutesAgo(5)), true);
    const res = await openApprovedProposals(broker, clients, queue, now);
    expect(res.opened).toBe(config.MAX_POSITIONS_PER_SCAN);
    expect(queue.listByStatus("APPROVED")).toHaveLength(3 - config.MAX_POSITIONS_PER_SCAN);
  });

  it("ne repropose pas une pool dont la proposition est encore en jeu", () => {
    const p = pool();
    const { queue } = setup({ [p.address]: p });
    expect(queue.hasOpenProposal(p.address)).toBe(false);
    const id = queue.enqueue(request(p));
    expect(queue.hasOpenProposal(p.address)).toBe(true);
    queue.markExpired(id, "test");
    expect(queue.hasOpenProposal(p.address)).toBe(false);
  });
});
