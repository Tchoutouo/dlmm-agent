import { describe, it, expect } from "vitest";
import {
  markPaperPosition,
  paperCloseOutcome,
  isDue,
  type PaperPosition,
} from "../src/paper/paperPnl.js";

function pos(o: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: 1,
    journalId: 10,
    poolAddress: "addr",
    poolName: "SOL-USDC",
    mintX: "x",
    mintY: "y",
    sizeUsd: 1000,
    entryPrice: 100,
    rangeLow: 90,
    rangeHigh: 110,
    feeAprAnnual: 0.365, // ~0.1%/jour
    accruedFeesUsd: 0,
    everOutOfRange: false,
    openedAtSec: 1_700_000_000,
    lastMarkAtSec: 1_700_000_000,
    ...o,
  };
}

const DAY = 86_400;

describe("markPaperPosition", () => {
  it("accumule des fees in-range proportionnellement au temps", () => {
    const p = pos();
    const m = markPaperPosition(p, 100, p.lastMarkAtSec + DAY);
    // 1000 × 0.365 × (1/365) = 1.0
    expect(m.feeAccruedNow).toBeCloseTo(1.0, 6);
    expect(m.accruedFeesUsd).toBeCloseTo(1.0, 6);
    expect(m.inRange).toBe(true);
  });

  it("n'accumule aucun fee hors range", () => {
    const p = pos();
    const m = markPaperPosition(p, 120, p.lastMarkAtSec + DAY); // au-dessus du range
    expect(m.feeAccruedNow).toBe(0);
    expect(m.inRange).toBe(false);
  });

  it("cumule les fees déjà accumulés", () => {
    const p = pos({ accruedFeesUsd: 5 });
    const m = markPaperPosition(p, 100, p.lastMarkAtSec + DAY);
    expect(m.accruedFeesUsd).toBeCloseTo(6.0, 6);
  });

  it("la valeur LP baisse sous la mise si le prix baisse en range", () => {
    const m = markPaperPosition(pos(), 92, pos().lastMarkAtSec + DAY);
    expect(m.lpValueUsd).toBeLessThan(1000); // capital entamé par la baisse
    expect(m.markValueUsd).toBeGreaterThan(m.lpValueUsd); // fees ajoutés
  });
});

describe("paperCloseOutcome", () => {
  it("calcule PnL, fees et durée à la clôture", () => {
    const p = pos();
    const at = p.openedAtSec + 2 * DAY;
    const m = markPaperPosition(p, 100, at); // prix inchangé → seulement les fees
    const out = paperCloseOutcome(p, m, at);
    expect(out.holdingDays).toBeCloseTo(2, 6);
    expect(out.feesCollectedUsd).toBeGreaterThan(0);
    // prix inchangé : PnL ≈ fees gagnés
    expect(out.realizedPnlUsd).toBeCloseTo(out.feesCollectedUsd, 6);
    expect(out.wentOutOfRange).toBe(false);
  });

  it("marque la sortie de range", () => {
    const p = pos();
    const at = p.openedAtSec + DAY;
    const m = markPaperPosition(p, 130, at); // hors range
    const out = paperCloseOutcome(p, m, at);
    expect(out.wentOutOfRange).toBe(true);
  });
});

describe("isDue", () => {
  it("vrai une fois l'horizon atteint", () => {
    const p = pos();
    expect(isDue(p, p.openedAtSec + 0.5 * DAY, 1)).toBe(false);
    expect(isDue(p, p.openedAtSec + 1 * DAY, 1)).toBe(true);
  });
});
