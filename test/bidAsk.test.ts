import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  MAX_BINS_PER_POSITION,
  bidAskEffectiveLow,
  bidAskFeeMultiplier,
  bidAskLayout,
  bidAskValueRatio,
} from "../src/analytics/bidAsk.js";
import { planPosition } from "../src/analytics/positionPlan.js";
import { markPaperPosition, type PaperPosition } from "../src/paper/paperPnl.js";
import { simulatePosition } from "../src/backtest/positionSimulator.js";
import { PaperBroker } from "../src/paper/paperBroker.js";
import type { Candle, Pool } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";

describe("bidAskLayout", () => {
  const layout = bidAskLayout(80, 100, 100); // bin step 1 % → 23 bins

  it("répartit le dépôt sous le prix, plus chargé en profondeur", () => {
    expect(layout.prices[0]).toBe(100);
    expect(layout.prices.every((p) => p <= 100 && p > 79)).toBe(true);
    expect(layout.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 10);
    expect(layout.weights.at(-1)!).toBeGreaterThan(layout.weights[0]!);
  });

  it(`plafonne la position à ${MAX_BINS_PER_POSITION} bins (coût de création)`, () => {
    const wide = bidAskLayout(10, 100, 10); // 0,1 % : ~2300 bins sans plafond
    expect(wide.prices).toHaveLength(MAX_BINS_PER_POSITION);
    expect(bidAskEffectiveLow(wide)).toBeGreaterThan(10);
  });

  it("garde son nombre de bins quand on repart de la borne effective", () => {
    const again = bidAskLayout(bidAskEffectiveLow(layout), 100, 100);
    expect(again.prices).toHaveLength(layout.prices.length);
  });
});

describe("bidAskValueRatio", () => {
  const layout = bidAskLayout(80, 100, 100);

  it("vaut 1 au-dessus du range (100 % quote, pas d'IL)", () => {
    expect(bidAskValueRatio(100, layout)).toBeCloseTo(1, 10);
    expect(bidAskValueRatio(130, layout)).toBeCloseTo(1, 10);
  });

  it("perd de la valeur quand le prix traverse les bins vers le bas", () => {
    const mid = bidAskValueRatio(90, layout);
    const low = bidAskValueRatio(70, layout);
    expect(mid).toBeLessThan(1);
    expect(low).toBeLessThan(mid);
    expect(low).toBeGreaterThan(0.7); // achats échelonnés : mieux que tout acheter à 100
  });

  it("revient à 1 au rebond au-dessus du range (fonction du seul prix)", () => {
    expect(bidAskValueRatio(100, layout)).toBeCloseTo(1, 10);
  });
});

describe("bidAskFeeMultiplier", () => {
  const layout = bidAskLayout(80, 100, 100);

  it("aucun fee hors range, peu près de l'entrée, davantage en profondeur", () => {
    expect(bidAskFeeMultiplier(105, layout)).toBe(0);
    expect(bidAskFeeMultiplier(50, layout)).toBe(0);
    const near = bidAskFeeMultiplier(99.9, layout);
    const deep = bidAskFeeMultiplier(81, layout);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    expect(deep).toBeGreaterThan(1);
  });
});

function pool(o: Partial<Pool> = {}): Pool {
  return {
    address: "addr", name: "MEME-SOL", mintX: "meme", mintY: SOL, binStep: 100,
    baseFeePct: 1, liquidityUsd: 100_000, currentPrice: 100, apr: 0, volume24h: 200_000,
    fees24h: 2_000, feeTvl24h: 0.02, feeTvl1h: 0, isVerified: true, isBlacklisted: false, ...o,
  };
}

describe("planPosition", () => {
  const suggested = { priceLow: 80, priceHigh: 120 };

  it("spot : garde le range suggéré centré", () => {
    expect(planPosition("spot", pool(), suggested)).toEqual({ shape: "spot", rangeLow: 80, rangeHigh: 120 });
  });

  it("sol_bidask : range sous le prix courant quand le quote est SOL", () => {
    const plan = planPosition("sol_bidask", pool(), suggested);
    expect(plan.shape).toBe("sol_bidask");
    expect(plan.rangeHigh).toBe(100);
    expect(plan.rangeLow).toBeLessThan(100);
    expect(plan.rangeLow).toBeLessThanOrEqual(80.01);
  });

  it("sol_bidask : repli sur spot si le quote n'est ni SOL ni stable", () => {
    expect(planPosition("sol_bidask", pool({ mintY: "otherMeme" }), suggested).shape).toBe("spot");
  });
});

describe("markPaperPosition — bid-ask", () => {
  const plan = planPosition("sol_bidask", pool(), { priceLow: 80, priceHigh: 120 });
  const base: PaperPosition = {
    poolAddress: "addr", poolName: "MEME-SOL", mintX: "meme", mintY: SOL, sizeUsd: 1000,
    entryPrice: 100, rangeLow: plan.rangeLow, rangeHigh: plan.rangeHigh, feeAprAnnual: 0.365,
    accruedFeesUsd: 0, everOutOfRange: false, openedAtSec: 0, lastMarkAtSec: 0,
    shape: "sol_bidask", binStep: 100,
  };

  it("au-dessus du range : valeur intacte, aucun fee", () => {
    const m = markPaperPosition(base, 110, 86_400);
    expect(m.lpValueUsd).toBeCloseTo(1000, 6);
    expect(m.feeAccruedNow).toBe(0);
  });

  it("dans le range profond : fees supérieurs à une position spot équivalente", () => {
    const m = markPaperPosition(base, 82, 86_400);
    expect(m.feeAccruedNow).toBeGreaterThan(1000 * 0.365 / 365);
    expect(m.lpValueUsd).toBeLessThan(1000);
  });
});

describe("simulatePosition — bid-ask", () => {
  const candles = (closes: number[]): Candle[] =>
    closes.map((c, i) => ({ timestamp: i * 3600, open: c, high: c, low: c, close: c, volume: 1 }));
  const plan = planPosition("sol_bidask", pool(), { priceLow: 80, priceHigh: 120 });
  const input = {
    entryPrice: 100, sizeUsd: 1000, feeAprAnnual: 1, candleSeconds: 3600,
    range: { priceLow: plan.rangeLow, priceHigh: plan.rangeHigh }, shape: "sol_bidask" as const, binStep: 100,
  };

  it("ne gagne ni ne perd rien si le prix ne fait que monter", () => {
    const out = simulatePosition({ ...input, forwardCandles: candles([101, 105, 110]) });
    expect(out.realizedPnlUsd).toBeCloseTo(0, 10);
  });

  it("capte des fees sur une baisse suivie d'un rebond, sans perte de valeur", () => {
    const out = simulatePosition({ ...input, forwardCandles: candles([95, 88, 85, 90, 97, 101]) });
    expect(out.feesEarnedUsd).toBeGreaterThan(0);
    expect(out.valueChangeUsd).toBeCloseTo(0, 10);
  });
});

describe("PaperBroker — migration", () => {
  it("ajoute les colonnes shape/bin_step à une base existante et relit en spot", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dlmm-")), "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id INTEGER, pool_address TEXT NOT NULL,
      pool_name TEXT NOT NULL, mint_x TEXT NOT NULL, mint_y TEXT NOT NULL, size_usd REAL NOT NULL,
      value_usd REAL NOT NULL, entry_price REAL NOT NULL, range_low REAL NOT NULL, range_high REAL NOT NULL,
      fee_apr REAL NOT NULL, accrued_fees REAL NOT NULL DEFAULT 0, ever_out INTEGER NOT NULL DEFAULT 0,
      opened_at_sec INTEGER NOT NULL, last_mark_sec INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN');
      INSERT INTO paper_positions (pool_address,pool_name,mint_x,mint_y,size_usd,value_usd,entry_price,
        range_low,range_high,fee_apr,opened_at_sec,last_mark_sec)
      VALUES ('a','OLD-SOL','x','y',100,100,1,0.9,1.1,0.5,0,0);`);
    old.close();

    const broker = new PaperBroker(path, 1000);
    const [legacy] = broker.listOpen();
    expect(legacy!.shape).toBe("spot");
    broker.open({
      poolAddress: "b", poolName: "NEW-SOL", mintX: "x", mintY: SOL, sizeUsd: 50, entryPrice: 100,
      rangeLow: 80, rangeHigh: 100, feeAprAnnual: 0.5, nowSec: 0, shape: "sol_bidask", binStep: 100,
    });
    const fresh = broker.listOpen().find((p) => p.poolName === "NEW-SOL")!;
    expect(fresh.shape).toBe("sol_bidask");
    expect(fresh.binStep).toBe(100);
  });
});
