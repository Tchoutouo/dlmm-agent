import { describe, it, expect } from "vitest";
import { positionValueUsd } from "./positionValue.js";

describe("positionValueUsd", () => {
  it("calcule la valeur SOL/USDC (9 + 6 decimales)", () => {
    const r = positionValueUsd({
      amountXRaw: 1_000_000_000, // 1 SOL (9 decimals)
      amountYRaw: 100_000_000,   // 100 USDC (6 decimals)
      feeXRaw: 0,
      feeYRaw: 0,
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 150,
      priceYUsd: 1,
    });
    expect(r.valueUsd).toBeCloseTo(250, 8);      // 1×150 + 100×1
    expect(r.feesUsd).toBe(0);
    expect(r.markValueUsd).toBeCloseTo(250, 8);
  });

  it("sépare correctement valueUsd et feesUsd (fees ≠ 0)", () => {
    const r = positionValueUsd({
      amountXRaw: 2_000_000_000, // 2 SOL
      amountYRaw: 50_000_000,    // 50 USDC
      feeXRaw: 10_000_000,       // 0.01 SOL de fees
      feeYRaw: 2_000_000,        // 2 USDC de fees
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 100,
      priceYUsd: 1,
    });
    expect(r.valueUsd).toBeCloseTo(250, 8);      // 2×100 + 50×1
    expect(r.feesUsd).toBeCloseTo(3, 8);         // 0.01×100 + 2×1
    expect(r.markValueUsd).toBeCloseTo(253, 8);  // valueUsd + feesUsd
  });

  it("retourne tout zéro pour une position vide", () => {
    const r = positionValueUsd({
      amountXRaw: 0,
      amountYRaw: 0,
      feeXRaw: 0,
      feeYRaw: 0,
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 150,
      priceYUsd: 1,
    });
    expect(r.valueUsd).toBe(0);
    expect(r.feesUsd).toBe(0);
    expect(r.markValueUsd).toBe(0);
  });

  it("markValueUsd = valueUsd + feesUsd (invariant)", () => {
    const r = positionValueUsd({
      amountXRaw: 500_000_000,
      amountYRaw: 75_000_000,
      feeXRaw: 5_000_000,
      feeYRaw: 1_000_000,
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 68,
      priceYUsd: 1,
    });
    expect(r.markValueUsd).toBeCloseTo(r.valueUsd + r.feesUsd, 10);
  });

  it("gère les decimales 6 → 6 (deux stablecoins)", () => {
    const r = positionValueUsd({
      amountXRaw: 1_000_000,  // 1 USDC
      amountYRaw: 1_000_000,  // 1 USDT
      feeXRaw: 0,
      feeYRaw: 0,
      decimalsX: 6,
      decimalsY: 6,
      priceXUsd: 1,
      priceYUsd: 1,
    });
    expect(r.valueUsd).toBeCloseTo(2, 8);
  });

  it("gère un prix SOL très élevé sans overflow", () => {
    const r = positionValueUsd({
      amountXRaw: 1_000_000_000, // 1 SOL
      amountYRaw: 0,
      feeXRaw: 0,
      feeYRaw: 0,
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 10_000, // hypothèse SOL = $10k
      priceYUsd: 1,
    });
    expect(r.valueUsd).toBeCloseTo(10_000, 4);
    expect(Number.isFinite(r.valueUsd)).toBe(true);
  });
});
