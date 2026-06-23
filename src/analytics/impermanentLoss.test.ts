import { describe, it, expect } from "vitest";
import {
  positionAmounts,
  concentratedIl,
  positionValueRatio,
  suggestRange,
  directionalExposure,
} from "./impermanentLoss.js";

describe("positionAmounts", () => {
  const pa = 80, pb = 120;

  it("retourne 100% X (token volatil) quand price < priceLow", () => {
    const { x, y } = positionAmounts(50, pa, pb);
    expect(y).toBe(0);
    expect(x).toBeGreaterThan(0);
  });

  it("retourne 100% Y (quote) quand price > priceHigh", () => {
    const { x, y } = positionAmounts(200, pa, pb);
    expect(x).toBe(0);
    expect(y).toBeGreaterThan(0);
  });

  it("retourne un mélange X+Y dans le range", () => {
    const { x, y } = positionAmounts(100, pa, pb); // prix au milieu
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it("respecte la continuité aux bornes", () => {
    const atLow = positionAmounts(pa, pa, pb);
    const belowLow = positionAmounts(pa - 0.001, pa, pb);
    expect(atLow.x).toBeCloseTo(belowLow.x, 3);
    expect(atLow.y).toBeCloseTo(0, 8);
  });

  it("L=2 double les montants par rapport à L=1", () => {
    const l1 = positionAmounts(100, pa, pb, 1);
    const l2 = positionAmounts(100, pa, pb, 2);
    expect(l2.x).toBeCloseTo(l1.x * 2, 10);
    expect(l2.y).toBeCloseTo(l1.y * 2, 10);
  });
});

describe("concentratedIl", () => {
  const base = { priceLow: 80, priceHigh: 120 };

  it("IL nul quand le prix ne bouge pas", () => {
    const r = concentratedIl({ entryPrice: 100, currentPrice: 100, ...base });
    expect(r.ilPct).toBeCloseTo(0, 8);
    expect(r.outOfRange).toBe(false);
  });

  it("IL négatif quand le prix baisse dans le range", () => {
    const r = concentratedIl({ entryPrice: 100, currentPrice: 90, ...base });
    expect(r.ilPct).toBeLessThan(0);
    expect(r.outOfRange).toBe(false);
  });

  it("détecte la sortie de range vers le bas", () => {
    const r = concentratedIl({ entryPrice: 100, currentPrice: 70, ...base });
    expect(r.outOfRange).toBe(true);
    expect(r.ilPct).toBeLessThan(0);
  });

  it("détecte la sortie de range vers le haut", () => {
    const r = concentratedIl({ entryPrice: 100, currentPrice: 150, ...base });
    expect(r.outOfRange).toBe(true);
  });

  it("IL plus sévère pour un range étroit (même mouvement de prix)", () => {
    const narrow = concentratedIl({ entryPrice: 100, currentPrice: 90, priceLow: 95, priceHigh: 105 });
    const wide   = concentratedIl({ entryPrice: 100, currentPrice: 90, priceLow: 60, priceHigh: 140 });
    expect(narrow.ilPct).toBeLessThan(wide.ilPct);
  });

  it("lève une erreur pour un range invalide (priceLow >= priceHigh)", () => {
    expect(() =>
      concentratedIl({ entryPrice: 100, currentPrice: 100, priceLow: 120, priceHigh: 80 })
    ).toThrow("Range invalide");
  });

  it("lève une erreur pour un prix d'entrée négatif", () => {
    expect(() =>
      concentratedIl({ entryPrice: -10, currentPrice: 100, priceLow: 80, priceHigh: 120 })
    ).toThrow("strictement positifs");
  });
});

describe("positionValueRatio", () => {
  it("ratio = 1 quand target = entry (pas de mouvement)", () => {
    const r = positionValueRatio(100, 100, 80, 120);
    expect(r).toBeCloseTo(1, 8);
  });

  it("ratio < 1 quand le prix baisse (perte de valeur)", () => {
    const r = positionValueRatio(100, 80, 80, 120);
    expect(r).toBeLessThan(1);
  });

  it("ratio > 0 toujours (jamais de valeur négative)", () => {
    const r = positionValueRatio(100, 10, 80, 120);
    expect(r).toBeGreaterThan(0);
  });
});

describe("suggestRange", () => {
  it("range symétrique autour du prix courant (volatilité 10%, k=2)", () => {
    const { priceLow, priceHigh } = suggestRange(100, 0.1, 2);
    expect(priceLow).toBeCloseTo(80, 1);   // 100 × (1 - 0.2)
    expect(priceHigh).toBeCloseTo(120, 1); // 100 × (1 + 0.2)
  });

  it("clamp à 90% de demi-largeur pour une volatilité extrême", () => {
    const { priceLow, priceHigh } = suggestRange(100, 2.0, 2); // halfWidth = min(0.9, 4.0) = 0.9
    expect(priceLow).toBeCloseTo(10, 1);
    expect(priceHigh).toBeCloseTo(190, 1);
  });

  it("priceLow toujours < priceHigh", () => {
    const { priceLow, priceHigh } = suggestRange(50, 0.05);
    expect(priceLow).toBeLessThan(priceHigh);
  });
});

describe("directionalExposure", () => {
  it("exposition = 1 (100% X) quand price < priceLow", () => {
    const e = directionalExposure(50, 80, 120);
    expect(e).toBeCloseTo(1, 8);
  });

  it("exposition = 0 (100% Y) quand price > priceHigh", () => {
    const e = directionalExposure(200, 80, 120);
    expect(e).toBeCloseTo(0, 8);
  });

  it("exposition entre 0 et 1 dans le range", () => {
    const e = directionalExposure(100, 80, 120);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1);
  });
});
