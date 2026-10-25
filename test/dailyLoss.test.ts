import { describe, it, expect } from "vitest";
import { trackDailyLoss, utcDayKey } from "../src/risk/dailyLoss.js";

function memMeta() {
  const m = new Map<string, number>();
  return { get: (k: string) => m.get(k) ?? 0, set: (k: string, v: number) => void m.set(k, v) };
}

describe("trackDailyLoss", () => {
  const day1 = new Date("2026-10-25T08:00:00Z");
  const day1Later = new Date("2026-10-25T20:00:00Z");
  const day2 = new Date("2026-10-26T00:30:00Z");

  it("utcDayKey encode le jour UTC en AAAAMMJJ", () => {
    expect(utcDayKey(day1)).toBe(20261025);
  });

  it("mémorise la NAV d'ouverture puis mesure la baisse du jour", () => {
    const { get, set } = memMeta();
    expect(trackDailyLoss(get, set, 1000, day1)).toBe(0);
    expect(trackDailyLoss(get, set, 940, day1Later)).toBeCloseTo(6, 6);
  });

  it("renvoie 0 en cas de gain", () => {
    const { get, set } = memMeta();
    trackDailyLoss(get, set, 1000, day1);
    expect(trackDailyLoss(get, set, 1100, day1Later)).toBe(0);
  });

  it("repart de zéro au changement de jour UTC", () => {
    const { get, set } = memMeta();
    trackDailyLoss(get, set, 1000, day1);
    trackDailyLoss(get, set, 900, day1Later);
    expect(trackDailyLoss(get, set, 900, day2)).toBe(0);
    expect(get("day_open_nav")).toBe(900);
  });
});
