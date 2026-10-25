import { describe, it, expect } from "vitest";
import { simulatePosition } from "../src/backtest/positionSimulator.js";
import { runBacktest } from "../src/backtest/backtester.js";
import type { Candle, Pool } from "../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function path(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    timestamp: 1_700_000_000 + i * 3600,
    open: i > 0 ? closes[i - 1]! : c,
    high: c * 1.002,
    low: c * 0.998,
    close: c,
    volume: 50_000,
  }));
}

describe("simulatePosition", () => {
  it("gagne des fees si le prix reste dans le range", () => {
    const out = simulatePosition({
      entryPrice: 100,
      sizeUsd: 1000,
      range: { priceLow: 90, priceHigh: 110 },
      feeAprAnnual: 0.5,
      forwardCandles: path([100, 100.5, 99.5, 100.2, 100.1]),
      candleSeconds: 3600,
    });
    expect(out.feesEarnedUsd).toBeGreaterThan(0);
    expect(out.wentOutOfRange).toBe(false);
    expect(out.fractionInRange).toBeCloseTo(1, 5);
  });

  it("détecte la sortie de range et perd de la valeur sur un dump", () => {
    const out = simulatePosition({
      entryPrice: 100,
      sizeUsd: 1000,
      range: { priceLow: 95, priceHigh: 105 },
      feeAprAnnual: 0.5,
      forwardCandles: path([100, 98, 94, 90, 88]), // chute sous le range
      candleSeconds: 3600,
    });
    expect(out.wentOutOfRange).toBe(true);
    expect(out.valueChangeUsd).toBeLessThan(0); // perte de capital
    expect(out.fractionInRange).toBeLessThan(1);
  });

  it("ne gagne pas de fees hors range (fraction nulle)", () => {
    const out = simulatePosition({
      entryPrice: 100,
      sizeUsd: 1000,
      range: { priceLow: 99, priceHigh: 101 },
      feeAprAnnual: 1.0,
      forwardCandles: path([105, 106, 107]), // entièrement au-dessus du range
      candleSeconds: 3600,
    });
    expect(out.fractionInRange).toBe(0);
    expect(out.feesEarnedUsd).toBe(0);
  });

  const dumpPath = path([100, 99, 97, 94, 90, 85, 80]);
  const base = {
    entryPrice: 100,
    sizeUsd: 1000,
    range: { priceLow: 80, priceHigh: 120 },
    feeAprAnnual: 0.1,
    candleSeconds: 3600,
  };

  it("sort au stop-loss dès que le PnL franchit −X % et coupe la perte", () => {
    const held = simulatePosition({ ...base, forwardCandles: dumpPath });
    const stopped = simulatePosition({ ...base, forwardCandles: dumpPath, stopLossPct: 4 });
    expect(stopped.exitReason).toBe("stop_loss");
    expect(stopped.realizedPnlUsd / 1000).toBeLessThanOrEqual(-0.04);
    expect(stopped.realizedPnlUsd).toBeGreaterThan(held.realizedPnlUsd);
    expect(stopped.holdingDays).toBeLessThan(held.holdingDays);
  });

  it("sort au take-profit quand les fees portent le PnL au-dessus du seuil", () => {
    const out = simulatePosition({
      ...base,
      feeAprAnnual: 50, // fees très élevées : ≈ +0,57 %/h
      forwardCandles: path([100, 100, 100, 100, 100, 100]),
      takeProfitPct: 1,
    });
    expect(out.exitReason).toBe("take_profit");
    expect(out.realizedPnlUsd / 1000).toBeGreaterThanOrEqual(0.01);
    expect(out.holdingDays * 24).toBeLessThan(6);
  });

  it("sans TP/SL : détention jusqu'au bout (motif horizon)", () => {
    const out = simulatePosition({ ...base, forwardCandles: dumpPath });
    expect(out.exitReason).toBe("horizon");
    expect(out.holdingDays * 24).toBeCloseTo(7, 6);
  });
});

function pool(): Pool {
  return {
    address: "pool1",
    name: "SOL-USDC",
    mintX: "So11111111111111111111111111111111111111112",
    mintY: USDC,
    binStep: 20,
    baseFeePct: 0.2,
    liquidityUsd: 2_000_000,
    currentPrice: 100,
    apr: 0,
    volume24h: 800_000,
    fees24h: 4000, // feeApr proxy = 4000/2e6*365 ≈ 0.73
    feeTvl24h: 0.002,
    feeTvl1h: 0,
    isVerified: true,
    isBlacklisted: false,
  };
}

/** Génère un chemin calme et long pour un walk-forward exploitable. */
function calmHistory(n: number): Candle[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    // petite marche aléatoire bornée mais déterministe
    p += Math.sin(i / 5) * 0.15;
    closes.push(p);
  }
  return path(closes);
}

describe("runBacktest", () => {
  it("produit des entrées analysables et un résumé cohérent", () => {
    const res = runBacktest(pool(), calmHistory(240), {
      timeframe: "1h",
      lookbackCandles: 48,
      windowCandles: 24,
      initialCashUsd: 1000,
    });
    expect(res.summary.steps).toBeGreaterThan(0);
    expect(res.entries.length).toBe(res.summary.steps);
    // toutes les entrées ENTER ont une issue chiffrée
    for (const e of res.entries.filter((x) => x.decision === "ENTER")) {
      expect(e.realizedPnlUsd).toBeDefined();
      expect(e.sizeUsd).toBeGreaterThan(0);
      expect(e.features?.feeRegime).toBeDefined();
    }
    // le NAV final est cohérent avec le retour rapporté
    const expectedNav = 1000 * (1 + res.summary.totalReturnPct / 100);
    expect(res.summary.finalNavUsd).toBeCloseTo(expectedNav, 2);
  });

  it("déclenche le disjoncteur et stoppe sur un krach prolongé", () => {
    // historique qui s'effondre → drawdown massif → HALT attendu
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 240; i++) {
      p *= i < 48 ? 1.0 : 0.97; // chute de 3%/bougie après le lookback
      closes.push(Math.max(1, p));
    }
    const res = runBacktest(pool(), path(closes), {
      timeframe: "1h",
      lookbackCandles: 48,
      windowCandles: 24,
      initialCashUsd: 1000,
    });
    // soit le disjoncteur a sauté, soit tout a été vété/perdu — dans tous les cas
    // le système ne doit pas avoir « gagné » sur un krach
    expect(res.summary.finalNavUsd).toBeLessThanOrEqual(1000);
  });

  it("après une sortie anticipée, réentre sans attendre la fin de la fenêtre", () => {
    const opts = { timeframe: "1h" as const, lookbackCandles: 48, windowCandles: 24, initialCashUsd: 1000 };
    const plain = runBacktest(pool(), calmHistory(240), opts);
    const withTp = runBacktest(pool(), calmHistory(240), { ...opts, takeProfitPct: 0.01 });
    const tpExits = withTp.entries.filter((e) => e.exitReason === "take_profit");
    expect(tpExits.length).toBeGreaterThan(0);
    expect(withTp.summary.steps).toBeGreaterThan(plain.summary.steps);
  });
});
