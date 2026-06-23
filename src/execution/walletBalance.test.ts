import { describe, it, expect } from "vitest";
import { sumWalletUsd } from "./walletBalance.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("sumWalletUsd", () => {
  it("calcule la valeur totale USD du wallet", () => {
    const balances = [
      { mint: SOL, amount: 2 },     // 2 SOL × $150 = $300
      { mint: USDC, amount: 100 },  // 100 USDC × $1 = $100
    ];
    const prices = { [SOL]: 150, [USDC]: 1 };
    const r = sumWalletUsd(balances, prices);

    expect(r.totalUsd).toBeCloseTo(400, 8);
    expect(r.byMint[SOL]).toBeCloseTo(300, 8);
    expect(r.byMint[USDC]).toBeCloseTo(100, 8);
  });

  it("retourne 0 pour un token sans prix connu", () => {
    const balances = [{ mint: "UNKNOWN_TOKEN", amount: 999 }];
    const r = sumWalletUsd(balances, {});

    expect(r.totalUsd).toBe(0);
    expect(r.byMint["UNKNOWN_TOKEN"]).toBe(0);
  });

  it("retourne zéro pour un wallet vide", () => {
    const r = sumWalletUsd([], {});
    expect(r.totalUsd).toBe(0);
    expect(Object.keys(r.byMint)).toHaveLength(0);
  });

  it("accumule plusieurs entrées du même mint", () => {
    const balances = [
      { mint: USDC, amount: 30 },
      { mint: USDC, amount: 20 },
    ];
    const r = sumWalletUsd(balances, { [USDC]: 1 });

    expect(r.totalUsd).toBeCloseTo(50, 8);
    expect(r.byMint[USDC]).toBeCloseTo(50, 8);
  });

  it("totalUsd = somme de byMint (invariant)", () => {
    const balances = [
      { mint: SOL, amount: 1.5 },
      { mint: USDC, amount: 200 },
    ];
    const prices = { [SOL]: 68, [USDC]: 1 };
    const r = sumWalletUsd(balances, prices);
    const sumByMint = Object.values(r.byMint).reduce((a, b) => a + b, 0);

    expect(r.totalUsd).toBeCloseTo(sumByMint, 10);
  });

  it("n'inclut pas les tokens avec amount = 0 dans le total", () => {
    const balances = [
      { mint: SOL, amount: 0 },
      { mint: USDC, amount: 50 },
    ];
    const prices = { [SOL]: 150, [USDC]: 1 };
    const r = sumWalletUsd(balances, prices);

    expect(r.totalUsd).toBeCloseTo(50, 8);
    expect(r.byMint[SOL]).toBe(0);
  });
});
