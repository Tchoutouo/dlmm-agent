import { describe, it, expect } from "vitest";
import { executionGate } from "../src/execution/safetyGate.js";
import { strategyForRegime } from "../src/execution/strategyMap.js";

describe("executionGate", () => {
  it("REFUSE sans wallet", () => {
    const r = executionGate({ network: "devnet", dryRun: true, walletLoaded: false, acknowledgeRealFunds: false });
    expect(r.mode).toBe("REFUSE");
  });

  it("DRY_RUN par défaut même avec wallet", () => {
    const r = executionGate({ network: "devnet", dryRun: true, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("DRY_RUN");
  });

  it("LIVE sur devnet quand DRY_RUN est désactivé", () => {
    const r = executionGate({ network: "devnet", dryRun: false, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("LIVE");
  });

  it("REFUSE le LIVE mainnet sans accusé de réception", () => {
    const r = executionGate({ network: "mainnet-beta", dryRun: false, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("REFUSE");
  });

  it("autorise le LIVE mainnet avec accusé de réception explicite", () => {
    const r = executionGate({ network: "mainnet-beta", dryRun: false, walletLoaded: true, acknowledgeRealFunds: true });
    expect(r.mode).toBe("LIVE");
  });

  it("DRY_RUN prime sur tout le reste (mainnet inclus)", () => {
    const r = executionGate({ network: "mainnet-beta", dryRun: true, walletLoaded: true, acknowledgeRealFunds: true });
    expect(r.mode).toBe("DRY_RUN");
  });
});

describe("strategyForRegime", () => {
  it("calm → Curve, active → Spot, volatile → BidAsk", () => {
    expect(strategyForRegime("calm")).toBe("Curve");
    expect(strategyForRegime("active")).toBe("Spot");
    expect(strategyForRegime("volatile")).toBe("BidAsk");
  });
});
