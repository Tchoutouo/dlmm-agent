import { describe, it, expect } from "vitest";
import { positionValueUsd } from "../src/execution/positionValue.js";

describe("positionValueUsd", () => {
  it("valorise correctement tokens + fees en USD", () => {
    // 2 X @ $50 (9 décimales), 100 Y @ $1 (6 décimales), fees 0.1 X + 5 Y
    const v = positionValueUsd({
      amountXRaw: 2 * 10 ** 9,
      amountYRaw: 100 * 10 ** 6,
      feeXRaw: 0.1 * 10 ** 9,
      feeYRaw: 5 * 10 ** 6,
      decimalsX: 9,
      decimalsY: 6,
      priceXUsd: 50,
      priceYUsd: 1,
    });
    expect(v.valueUsd).toBeCloseTo(200, 6); // 100 + 100
    expect(v.feesUsd).toBeCloseTo(10, 6); // 5 + 5
    expect(v.markValueUsd).toBeCloseTo(210, 6);
  });

  it("gère un quote non-stable (TOKEN/SOL)", () => {
    // 10 X @ $2, 3 SOL @ $150 ; pas de fees
    const v = positionValueUsd({
      amountXRaw: 10 * 10 ** 6,
      amountYRaw: 3 * 10 ** 9,
      feeXRaw: 0,
      feeYRaw: 0,
      decimalsX: 6,
      decimalsY: 9,
      priceXUsd: 2,
      priceYUsd: 150,
    });
    expect(v.valueUsd).toBeCloseTo(20 + 450, 4);
    expect(v.feesUsd).toBe(0);
  });

  it("renvoie zéro pour une position vide", () => {
    const v = positionValueUsd({
      amountXRaw: 0, amountYRaw: 0, feeXRaw: 0, feeYRaw: 0,
      decimalsX: 9, decimalsY: 6, priceXUsd: 50, priceYUsd: 1,
    });
    expect(v.markValueUsd).toBe(0);
  });
});
