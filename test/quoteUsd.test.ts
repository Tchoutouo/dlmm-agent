import { describe, it, expect } from "vitest";
import { quoteUsdLookup, loadQuoteUsdHistory } from "../src/backtest/quoteHistory.js";
import { markPaperPosition, type PaperPosition } from "../src/paper/paperPnl.js";
import { simulatePosition } from "../src/backtest/positionSimulator.js";
import type { DataApiClient } from "../src/data/dataApiClient.js";
import type { Candle, Pool } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const candle = (timestamp: number, close: number): Candle =>
  ({ timestamp, open: close, high: close, low: close, close, volume: 1 });

describe("quoteUsdLookup", () => {
  const solUsd = quoteUsdLookup([candle(3600, 110), candle(0, 100), candle(7200, 90)]);

  it("renvoie la clôture de la dernière bougie commencée", () => {
    expect(solUsd(0)).toBe(100);
    expect(solUsd(5000)).toBe(110);
    expect(solUsd(99_999)).toBe(90);
  });

  it("renvoie la première bougie avant l'historique, inverse si demandé", () => {
    expect(solUsd(-10)).toBe(100);
    expect(quoteUsdLookup([candle(0, 0.01)], true)(0)).toBeCloseTo(100, 10);
  });
});

describe("loadQuoteUsdHistory", () => {
  const pool = (o: Partial<Pool>): Pool => ({
    address: "a", name: "P", mintX: "x", mintY: "y", binStep: 4, baseFeePct: 0.04, liquidityUsd: 1,
    currentPrice: 1, apr: 0, volume24h: 1, fees24h: 1, feeTvl24h: 0, feeTvl1h: 0,
    isVerified: true, isBlacklisted: false, ...o,
  });
  const data = { getOhlcv: async () => [candle(0, 150)] } as unknown as DataApiClient;

  it("stable → 1, token quelconque → null", async () => {
    expect((await loadQuoteUsdHistory(USDC, [], data, 10))!(0)).toBe(1);
    expect(await loadQuoteUsdHistory("memeMint", [], data, 10)).toBeNull();
  });

  it("SOL → bougies de la pool SOL/stable la plus profonde", async () => {
    const universe = [
      pool({ address: "thin", mintX: SOL, mintY: USDC, liquidityUsd: 1_000 }),
      pool({ address: "deep", mintX: SOL, mintY: USDC, liquidityUsd: 5_000_000 }),
    ];
    let used = "";
    const spy = { getOhlcv: async (addr: string) => ((used = addr), [candle(0, 150)]) } as unknown as DataApiClient;
    const solUsd = await loadQuoteUsdHistory(SOL, universe, spy, 10);
    expect(used).toBe("deep");
    expect(solUsd!(0)).toBe(150);
  });
});

describe("valorisation USD d'une pool TOKEN/SOL", () => {
  const pos: PaperPosition = {
    poolAddress: "a", poolName: "MEME-SOL", mintX: "meme", mintY: SOL, sizeUsd: 1000, entryPrice: 1,
    rangeLow: 0.9, rangeHigh: 1.1, feeAprAnnual: 0, accruedFeesUsd: 0, everOutOfRange: false,
    openedAtSec: 0, lastMarkAtSec: 0, quoteUsdEntry: 200,
  };

  it("paper : ratio MEME/SOL inchangé mais SOL −10 % → valeur USD −10 %", () => {
    expect(markPaperPosition(pos, 1, 3600, 180).lpValueUsd).toBeCloseTo(900, 6);
  });

  it("paper : sans prix du quote, valorisation inchangée (comportement historique)", () => {
    expect(markPaperPosition(pos, 1, 3600).lpValueUsd).toBeCloseTo(1000, 6);
    expect(markPaperPosition({ ...pos, quoteUsdEntry: undefined }, 1, 3600, 180).lpValueUsd).toBeCloseTo(1000, 6);
  });

  it("backtest : la baisse de SOL déclenche le stop-loss en USD", () => {
    const out = simulatePosition({
      entryPrice: 1, sizeUsd: 1000, range: { priceLow: 0.9, priceHigh: 1.1 }, feeAprAnnual: 0,
      candleSeconds: 3600, forwardCandles: [candle(0, 1), candle(3600, 1), candle(7200, 1)],
      quoteUsdEntry: 200, quoteUsdPath: [200, 190, 170], stopLossPct: 8,
    });
    expect(out.exitReason).toBe("stop_loss");
    expect(out.realizedPnlUsd).toBeCloseTo(-150, 6);
  });
});
