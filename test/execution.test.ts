import { describe, it, expect } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import {
  executionGate,
  networkFromGenesis,
  detectRpcNetwork,
  GENESIS_HASHES,
} from "../src/execution/safetyGate.js";
import { RealExecutor } from "../src/execution/realExecutor.js";
import { config } from "../src/config.js";
import { strategyForRegime } from "../src/execution/strategyMap.js";

describe("executionGate", () => {
  it("REFUSE sans wallet", () => {
    const r = executionGate({ network: "devnet", rpcNetwork: "devnet", dryRun: true, walletLoaded: false, acknowledgeRealFunds: false });
    expect(r.mode).toBe("REFUSE");
  });

  it("DRY_RUN par défaut même avec wallet", () => {
    const r = executionGate({ network: "devnet", rpcNetwork: "devnet", dryRun: true, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("DRY_RUN");
  });

  it("LIVE sur devnet quand DRY_RUN est désactivé", () => {
    const r = executionGate({ network: "devnet", rpcNetwork: "devnet", dryRun: false, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("LIVE");
  });

  it("REFUSE le LIVE mainnet sans accusé de réception", () => {
    const r = executionGate({ network: "mainnet-beta", rpcNetwork: "mainnet-beta", dryRun: false, walletLoaded: true, acknowledgeRealFunds: false });
    expect(r.mode).toBe("REFUSE");
  });

  it("autorise le LIVE mainnet avec accusé de réception explicite", () => {
    const r = executionGate({ network: "mainnet-beta", rpcNetwork: "mainnet-beta", dryRun: false, walletLoaded: true, acknowledgeRealFunds: true });
    expect(r.mode).toBe("LIVE");
  });

  it("DRY_RUN prime sur tout le reste (mainnet inclus)", () => {
    const r = executionGate({ network: "mainnet-beta", rpcNetwork: "mainnet-beta", dryRun: true, walletLoaded: true, acknowledgeRealFunds: true });
    expect(r.mode).toBe("DRY_RUN");
  });
});

describe("executionGate — réseau réel du RPC (faille C1)", () => {
  const base = { dryRun: false, walletLoaded: true, acknowledgeRealFunds: false } as const;

  it("REFUSE un RPC mainnet déclaré devnet (contournement de l'accusé de réception)", () => {
    const r = executionGate({ ...base, network: "devnet", rpcNetwork: "mainnet-beta" });
    expect(r.mode).toBe("REFUSE");
    expect(r.reason).toContain("mainnet-beta");
  });

  it("REFUSE l'incohérence même en DRY_RUN (config à corriger avant tout)", () => {
    const r = executionGate({ ...base, dryRun: true, network: "devnet", rpcNetwork: "mainnet-beta" });
    expect(r.mode).toBe("REFUSE");
  });

  it("réseau du RPC inconnu : jamais LIVE, DRY_RUN toléré", () => {
    expect(executionGate({ ...base, network: "devnet", rpcNetwork: "unknown" }).mode).toBe("REFUSE");
    expect(executionGate({ ...base, dryRun: true, network: "devnet", rpcNetwork: "unknown" }).mode).toBe("DRY_RUN");
  });

  it("networkFromGenesis reconnaît les clusters, le reste est inconnu", () => {
    expect(networkFromGenesis(GENESIS_HASHES["mainnet-beta"])).toBe("mainnet-beta");
    expect(networkFromGenesis(GENESIS_HASHES.devnet)).toBe("devnet");
    expect(networkFromGenesis("localnet-xyz")).toBe("unknown");
  });

  it("detectRpcNetwork : une erreur RPC donne « unknown »", async () => {
    expect(await detectRpcNetwork({ getGenesisHash: async () => GENESIS_HASHES.devnet })).toBe("devnet");
    expect(await detectRpcNetwork({ getGenesisHash: async () => { throw new Error("down"); } })).toBe("unknown");
  });
});

describe("RealExecutor — garde-fou intégré (aucun appel on-chain)", () => {
  const executorOn = (genesis: () => Promise<string>) =>
    new RealExecutor({
      keypair: Keypair.generate(),
      connection: { getGenesisHash: genesis } as unknown as Connection,
    });
  const input = { poolAddress: "G6eJgyVdupYx23TD3auEr9PFtv2q98jk3pbg5nP58rdh", sizeUsd: 100, currentPrice: 0.85, quoteUsdPrice: 100 };

  it("refuse d'ouvrir quand le RPC sert un autre réseau que NETWORK", async () => {
    const other = config.NETWORK === "devnet" ? GENESIS_HASHES["mainnet-beta"] : GENESIS_HASHES.devnet;
    const res = await executorOn(async () => other).openPosition(input);
    expect(res.mode).toBe("REFUSE");
    expect(res.ok).toBe(false);
  });

  it.runIf(config.DRY_RUN)("DRY_RUN : montants convertis avec le prix USD du quote (faille C2)", async () => {
    const res = await executorOn(async () => GENESIS_HASHES[config.NETWORK]).openPosition(input);
    expect(res.mode).toBe("DRY_RUN");
    // 50 $ côté X ÷ (0,85 SOL × 100 $) = 0,5882 X — et non 50 / 0,85 = 58,8 X (×100)
    expect(res.note).toContain("0.5882 X");
  });

  it("refuse un prix USD du quote absent ou nul", async () => {
    const res = await executorOn(async () => GENESIS_HASHES[config.NETWORK]).openPosition({ ...input, quoteUsdPrice: 0 });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("quote");
  });
});

describe("strategyForRegime", () => {
  it("calm → Curve, active → Spot, volatile → BidAsk", () => {
    expect(strategyForRegime("calm")).toBe("Curve");
    expect(strategyForRegime("active")).toBe("Spot");
    expect(strategyForRegime("volatile")).toBe("BidAsk");
  });
});
