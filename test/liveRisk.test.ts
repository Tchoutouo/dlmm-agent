import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Keypair, type Connection } from "@solana/web3.js";
import { splitWallet } from "../src/execution/walletBalance.js";
import { LivePositionManager } from "../src/execution/livePositionManager.js";
import type { RealExecutor } from "../src/execution/realExecutor.js";
import type { PriceOracle } from "../src/data/priceOracle.js";
import { TradeJournal } from "../src/journal/journal.js";
import { config } from "../src/config.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "MemeMint1111111111111111111111111111111111";
const isCash = (m: string) => m === SOL || m === USDC;

describe("splitWallet : cash déployable vs inventaire (faille H3)", () => {
  it("SOL et stables = cash ; les autres tokens = inventaire", () => {
    const r = splitWallet(
      [{ mint: SOL, amount: 2 }, { mint: USDC, amount: 300 }, { mint: MEME, amount: 1_000_000 }],
      { [SOL]: 100, [USDC]: 1, [MEME]: 0.0002 },
      isCash
    );
    expect(r.cashUsd).toBeCloseTo(500, 10);
    expect(r.inventory).toEqual([{ mint: MEME, usd: 200 }]);
  });
});

/** Wallet on-chain simulé dont on peut changer les soldes entre deux photos. */
function fakeChain() {
  const state = { lamports: 2e9, usdc: 300, meme: 1_000_000 };
  const token = (mint: string, ui: number) => ({
    account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount: ui } } } } },
  });
  const connection = {
    getBalance: async () => state.lamports,
    getParsedTokenAccountsByOwner: async (_o: unknown, { programId }: { programId: { toBase58(): string } }) => ({
      value: programId.toBase58().startsWith("Tokenkeg") ? [token(USDC, state.usdc), token(MEME, state.meme)] : [],
    }),
  } as unknown as Connection;
  const oracle = {
    getUsdPrices: async () => ({ [SOL]: 100, [USDC]: 1, [MEME]: 0.0002 }),
  } as unknown as PriceOracle;
  return { state, wallet: { keypair: Keypair.generate(), connection }, oracle };
}

function tempDb() {
  return join(mkdtempSync(join(tmpdir(), "dlmm-live-")), "j.db");
}

describe("realSnapshot : la photo utilisée par le risque en live", () => {
  it("l'inventaire est une exposition, pas du cash déployable", async () => {
    const { wallet, oracle } = fakeChain();
    const snap = await new LivePositionManager(wallet, oracle, tempDb()).realSnapshot();
    expect(snap.cashUsd).toBeCloseTo(500, 6); // 2 SOL × 100 + 300 USDC
    expect(snap.deployedUsd).toBeCloseTo(200, 6); // 1 M MEME × 0,0002
    expect(snap.navUsd).toBeCloseTo(700, 6);
    expect(snap.exposureByPool[`inventory:${MEME}`]).toBeCloseTo(200, 6);
  });

  it("le pic est calibré sur la première photo réelle, pas sur INITIAL_CASH_USD", async () => {
    const { wallet, oracle } = fakeChain();
    const snap = await new LivePositionManager(wallet, oracle, tempDb()).realSnapshot();
    expect(snap.peakNavUsd).toBeCloseTo(700, 6); // wallet réel, et non 1 000 $ par défaut
    expect(snap.drawdownPct).toBeCloseTo(0, 10);
  });

  it("le pic de NAV n'est jamais abaissé : le disjoncteur ne se réarme pas tout seul", async () => {
    const { state, wallet, oracle } = fakeChain();
    const manager = new LivePositionManager(wallet, oracle, tempDb());
    await manager.realSnapshot(); // NAV 700 $
    state.usdc = 0; // perte de 300 $, aucune position ouverte
    const after = await manager.realSnapshot();
    const again = await manager.realSnapshot();
    expect(after.peakNavUsd).toBeCloseTo(700, 6);
    expect(after.drawdownPct).toBeCloseTo((300 / 700) * 100, 6);
    expect(again.drawdownPct).toBeGreaterThan(config.MAX_DRAWDOWN_PCT); // toujours armé
  });
});

describe("rebalanceOutOfRange : clôture sans réouverture hors risque", () => {
  it("ferme la position hors range et ne rouvre RIEN (la réentrée passe par le scan)", async () => {
    const { wallet, oracle } = fakeChain();
    const db = tempDb();
    const manager = new LivePositionManager(wallet, oracle, db);
    manager.register({
      poolAddress: "pool", poolName: "MEME-SOL", mintX: MEME, mintY: SOL,
      positionPubkey: "pos", sizeUsd: 100, openedAtSec: 0,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    new Database(db)
      .prepare(`UPDATE live_positions SET value_usd=90, fees_usd=?, out_of_range_since_sec=?`)
      .run(config.REBALANCE_MIN_FEES_USD + 1, nowSec - 24 * 3600);
    const executor = {
      closePosition: vi.fn(async () => ({ mode: "LIVE", ok: true, note: "fermée", txHash: "tx" })),
      openPosition: vi.fn(),
    } as unknown as RealExecutor;

    const n = await manager.rebalanceOutOfRange(1, executor, new TradeJournal(db));

    expect(n).toBe(1);
    expect(executor.closePosition).toHaveBeenCalledOnce();
    expect(executor.openPosition).not.toHaveBeenCalled();
    const row = new Database(db).prepare(`SELECT status FROM live_positions`).get() as { status: string };
    expect(row.status).toBe("REBALANCED");
  });
});
