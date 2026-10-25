import { describe, it, expect } from "vitest";
import {
  binRangeForPrices,
  depositValueUsd,
  priceDeviation,
  priceXUsd,
  tokenXForUsd,
} from "../src/execution/executionMath.js";
import { planPosition } from "../src/analytics/positionPlan.js";
import { MAX_BINS_PER_POSITION } from "../src/analytics/bidAsk.js";
import type { Pool } from "../src/types.js";

describe("montants en USD (faille C2)", () => {
  it("pool TOKEN/SOL : le prix USD de X = prix en SOL × prix du SOL", () => {
    expect(priceXUsd(0.85, 101)).toBeCloseTo(85.85, 10);
    // 50 $ de X : 0,582 X, et non 58,8 X comme avec l'ancien calcul (×101)
    expect(tokenXForUsd(50, 0.85, 101)).toBeCloseTo(50 / 85.85, 12);
  });

  it("pool TOKEN/USDC : identique à l'ancien calcul (quote = 1 $)", () => {
    expect(tokenXForUsd(50, 204.7, 1)).toBeCloseTo(50 / 204.7, 12);
  });

  it("refuse un prix nul, négatif ou non fini", () => {
    expect(() => tokenXForUsd(50, 0.85, 0)).toThrow();
    expect(() => tokenXForUsd(50, Number.NaN, 100)).toThrow();
  });

  it("valeur d'un dépôt : X valorisé via le quote, Y au prix du quote", () => {
    expect(depositValueUsd(0.5, 0.25, 2, 100)).toBeCloseTo(0.5 * 2 * 100 + 0.25 * 100, 10);
  });

  it("écart de prix relatif", () => {
    expect(priceDeviation(103, 100)).toBeCloseTo(0.03, 12);
    expect(priceDeviation(97, 100)).toBeCloseTo(0.03, 12);
  });
});

describe("range exécuté = range évalué (faille H1)", () => {
  it("convertit le range de prix en bins autour du bin actif", () => {
    const step = 1.01; // bin step 100 bps
    const r = binRangeForPrices(1000, 1, 1 / step ** 5, step ** 5, 100);
    expect(r).toEqual({ minBinId: 995, maxBinId: 1005 });
  });

  it("arrondit vers l'extérieur pour couvrir tout le range", () => {
    const r = binRangeForPrices(0, 1, 0.985, 1.015, 100); // ±1,5 % → ±2 bins de 1 %
    expect(r).toEqual({ minBinId: -2, maxBinId: 2 });
  });

  it(`plafonne à ${MAX_BINS_PER_POSITION} bins en réduisant d'abord le côté le plus long`, () => {
    // Côté bas seul trop long : il est raccourci, le côté haut (5 bins) est conservé
    const oneSided = binRangeForPrices(0, 1, 0.5, 1.0049, 10);
    expect(oneSided.maxBinId).toBe(5);
    expect(oneSided.maxBinId - oneSided.minBinId + 1).toBe(MAX_BINS_PER_POSITION);
    // Deux côtés trop longs : réduits tour à tour → range centré sur le bin actif
    const both = binRangeForPrices(0, 1, 0.5, 2, 10);
    expect(both).toEqual({ minBinId: -34, maxBinId: 34 });
  });

  it("planPosition (spot) borne le range à une seule position de 69 bins centrée", () => {
    const pool = { binStep: 1, currentPrice: 200 } as Pool;
    const plan = planPosition("spot", pool, { priceLow: 198, priceHigh: 202 }); // ±1 % demandé
    const reach = 1.0001 ** 34;
    expect(plan.rangeHigh).toBeCloseTo(200 * reach, 8); // ≈ +0,34 %
    expect(plan.rangeLow).toBeCloseTo(200 / reach, 8);
    const bins = binRangeForPrices(0, 200, plan.rangeLow, plan.rangeHigh, 1);
    expect(bins.maxBinId - bins.minBinId + 1).toBeLessThanOrEqual(MAX_BINS_PER_POSITION);
  });

  it("planPosition (spot) garde le range suggéré quand il tient dans une position", () => {
    const pool = { binStep: 100, currentPrice: 1 } as Pool;
    expect(planPosition("spot", pool, { priceLow: 0.9, priceHigh: 1.1 })).toEqual({
      shape: "spot",
      rangeLow: 0.9,
      rangeHigh: 1.1,
    });
  });
});
