import { describe, it, expect, vi } from "vitest";
import BN from "bn.js";
import { Keypair, SystemProgram, Transaction, type Connection } from "@solana/web3.js";

// DRY_RUN avec un RPC mainnet : construction complète + simulation, aucun envoi
process.env.DRY_RUN = "true";
process.env.NETWORK = "mainnet-beta";

const send = vi.fn();
vi.mock("@solana/web3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/web3.js")>()),
  sendAndConfirmTransaction: (...args: unknown[]) => send(...args),
}));

const wallet = Keypair.generate();
const mintX = Keypair.generate().publicKey;
const SOL = "So11111111111111111111111111111111111111112";
const create = vi.fn();
vi.mock("../src/dlmmSdk.js", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
    autoFillYByStrategy: () => new BN("500000000"), // 0,5 SOL
    default: {
      create: (...a: unknown[]) => {
        create(...a);
        return {
          tokenX: { mint: { decimals: 6, address: mintX } },
          tokenY: { mint: { decimals: 9, address: new PublicKey(SOL) } },
          lbPair: { binStep: 100 },
          getActiveBin: async () => ({ binId: 1000, pricePerToken: "0.85", xAmount: new BN(0), yAmount: new BN(0) }),
          initializePositionAndAddLiquidityByStrategy: async () =>
            new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 })),
        };
      },
    },
  };
});

const { RealExecutor } = await import("../src/execution/realExecutor.js");
const { GENESIS_HASHES } = await import("../src/execution/safetyGate.js");

function executor(genesis: string, simErr: unknown = null) {
  const connection = {
    getGenesisHash: async () => genesis,
    getBalance: async () => 0, // wallet vide
    getTokenAccountBalance: async () => { throw new Error("compte absent"); },
    simulateTransaction: vi.fn(async () => ({ value: { err: simErr, logs: [] } })),
  };
  return { exec: new RealExecutor({ keypair: wallet, connection: connection as unknown as Connection }), connection };
}
const input = {
  poolAddress: Keypair.generate().publicKey.toBase58(),
  sizeUsd: 100,
  currentPrice: 0.85,
  quoteUsdPrice: 100,
  rangeLow: 0.8,
  rangeHigh: 0.9,
};

describe("dry-run mainnet : transaction construite et simulée on-chain (faille M3)", () => {
  it("simule sans envoyer, et relève les soldes insuffisants sans s'arrêter", async () => {
    const { exec, connection } = executor(GENESIS_HASHES["mainnet-beta"]);
    const res = await exec.openPosition(input);
    expect(res.mode).toBe("DRY_RUN");
    expect(res.ok).toBe(true);
    expect(res.note).toContain("Simulation on-chain réussie");
    expect(res.note).toContain("Solde SOL insuffisant");
    expect(res.note).toContain("dépôt $100.00"); // 0,588 X × 85 $ + 0,5 SOL × 100 $
    expect(connection.simulateTransaction).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("simulation en échec : rapportée (ok = false), toujours rien d'envoyé", async () => {
    const { exec } = executor(GENESIS_HASHES["mainnet-beta"], { InstructionError: [1, { Custom: 1 }] });
    const res = await exec.openPosition(input);
    expect(res.ok).toBe(false);
    expect(res.note).toContain("Simulation on-chain en échec");
    expect(send).not.toHaveBeenCalled();
  });
});
