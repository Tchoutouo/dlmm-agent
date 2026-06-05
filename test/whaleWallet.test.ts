import { describe, it, expect } from "vitest";
import { swapMagnitudeUsd } from "../src/whale/swapValue.js";
import { sumWalletUsd } from "../src/execution/walletBalance.js";

describe("swapMagnitudeUsd", () => {
  it("prend la plus grande jambe et classe l'achat de X", () => {
    // 10 X sortent du coffre (achat de X) @ $50 ; 500 Y entrent @ $1
    const r = swapMagnitudeUsd({ deltaXTokens: -10, deltaYTokens: 500, priceXUsd: 50, priceYUsd: 1 });
    expect(r.amountUsd).toBeCloseTo(500, 6); // max(500, 500)
    expect(r.side).toBe("buyX");
  });

  it("classe la vente de X", () => {
    const r = swapMagnitudeUsd({ deltaXTokens: 4, deltaYTokens: -200, priceXUsd: 50, priceYUsd: 1 });
    expect(r.amountUsd).toBeCloseTo(200, 6);
    expect(r.side).toBe("sellX");
  });

  it("renvoie none sans mouvement de X", () => {
    const r = swapMagnitudeUsd({ deltaXTokens: 0, deltaYTokens: 0, priceXUsd: 50, priceYUsd: 1 });
    expect(r.side).toBe("none");
    expect(r.amountUsd).toBe(0);
  });
});

describe("sumWalletUsd", () => {
  it("valorise SOL + tokens", () => {
    const r = sumWalletUsd(
      [
        { mint: "So11111111111111111111111111111111111111112", amount: 2 },
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: 300 },
      ],
      {
        So11111111111111111111111111111111111111112: 150,
        EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1,
      }
    );
    expect(r.totalUsd).toBeCloseTo(600, 6); // 300 + 300
  });

  it("ignore les prix manquants (0)", () => {
    const r = sumWalletUsd([{ mint: "inconnu", amount: 1000 }], {});
    expect(r.totalUsd).toBe(0);
  });
});
