import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Keypair, type Connection } from "@solana/web3.js";
import { markablePrices } from "../src/execution/positionValue.js";
import type { PriceOracle } from "../src/data/priceOracle.js";
import type { RealExecutor } from "../src/execution/realExecutor.js";
import { TradeJournal } from "../src/journal/journal.js";

const SOL = "So11111111111111111111111111111111111111112";
const MEME = "MemeMint1111111111111111111111111111111111";
const POOL = Keypair.generate().publicKey.toBase58(); // adresse valide : markAll va jusqu'à la valorisation

// SDK DLMM simulé : une position de 50 MEME (6 déc.) + 0,5 SOL (9 déc.), en range
vi.mock("../src/dlmmSdk.js", () => ({
  default: {
    create: async () => ({
      tokenX: { mint: { decimals: 6 } },
      tokenY: { mint: { decimals: 9 } },
      getActiveBin: async () => ({ binId: 0 }),
      getPositionsByUserAndLbPair: async () => ({
        userPositions: [
          {
            publicKey: { toBase58: () => "pos" },
            positionData: { totalXAmount: "50000000", totalYAmount: "500000000", feeX: 0, feeY: 0, lowerBinId: -5, upperBinId: 5 },
          },
        ],
      }),
    }),
  },
}));
const { LivePositionManager } = await import("../src/execution/livePositionManager.js");

describe("markablePrices (faille H4)", () => {
  it("exige les deux prix, positifs", () => {
    expect(markablePrices({ [MEME]: 1, [SOL]: 100 }, MEME, SOL)).toEqual({ priceXUsd: 1, priceYUsd: 100 });
    expect(markablePrices({ [SOL]: 100 }, MEME, SOL)).toBeNull();
    expect(markablePrices({ [MEME]: 0, [SOL]: 100 }, MEME, SOL)).toBeNull();
  });
});

describe("markAll : un prix manquant ne déclenche plus de faux stop-loss (faille H4)", () => {
  function setup(prices: Record<string, number>) {
    const db = join(mkdtempSync(join(tmpdir(), "dlmm-mark-")), "j.db");
    const wallet = { keypair: Keypair.generate(), connection: {} as Connection };
    const oracle = { getUsdPrices: async () => prices } as unknown as PriceOracle;
    const manager = new LivePositionManager(wallet, oracle, db);
    manager.register({ poolAddress: POOL, poolName: "MEME-SOL", mintX: MEME, mintY: SOL, positionPubkey: "pos", sizeUsd: 100, openedAtSec: 0 });
    const executor = { closePosition: vi.fn(async () => ({ mode: "LIVE", ok: true, note: "" })) } as unknown as RealExecutor;
    const value = () => (new Database(db).prepare(`SELECT value_usd v FROM live_positions`).get() as { v: number }).v;
    return { manager, executor, value, journal: new TradeJournal(db) };
  }

  it("prix du token absent : valeur conservée, aucune clôture", async () => {
    const { manager, executor, value, journal } = setup({ [SOL]: 100 }); // MEME sans prix
    await manager.markAll();
    expect(value()).toBe(100); // pas 50 $ (MEME valorisé à 0)
    expect(await manager.closeAtThresholds(15, 8, executor, journal)).toBe(0);
    expect(executor.closePosition).not.toHaveBeenCalled();
  });

  it("prix connus : marquage normal (50 MEME × 2 $ + 0,5 SOL × 100 $ = 150 $)", async () => {
    const { manager, value } = setup({ [MEME]: 2, [SOL]: 100 });
    await manager.markAll();
    expect(value()).toBeCloseTo(150, 6);
  });
});
