import { describe, it, expect, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";

process.env.DRY_RUN = "true";
process.env.NETWORK = "devnet";

const create = vi.fn();
vi.mock("../src/dlmmSdk.js", () => ({ StrategyType: { Spot: 0 }, autoFillYByStrategy: vi.fn(), default: { create } }));

const { RealExecutor } = await import("../src/execution/realExecutor.js");
const { GENESIS_HASHES } = await import("../src/execution/safetyGate.js");

describe("dry-run devnet : hors chaîne, et dit explicitement (faille M3)", () => {
  it("ne lit pas la chaîne et précise que rien n'est vérifié on-chain", async () => {
    const connection = { getGenesisHash: async () => GENESIS_HASHES.devnet } as unknown as Connection;
    const res = await new RealExecutor({ keypair: Keypair.generate(), connection }).openPosition({
      poolAddress: Keypair.generate().publicKey.toBase58(), sizeUsd: 100, currentPrice: 0.85, quoteUsdPrice: 100,
    });
    expect(res.mode).toBe("DRY_RUN");
    expect(res.note).toContain("NON vérifiée on-chain");
    expect(create).not.toHaveBeenCalled();
  });
});
