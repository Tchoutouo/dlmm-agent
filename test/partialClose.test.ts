import { describe, it, expect, vi } from "vitest";
import { Keypair, SystemProgram, Transaction, type Connection } from "@solana/web3.js";

// LIVE sur devnet pour ce fichier uniquement (aucun envoi réel : l'envoi est simulé)
process.env.DRY_RUN = "false";
process.env.NETWORK = "devnet";

const send = vi.fn();
vi.mock("@solana/web3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/web3.js")>()),
  sendAndConfirmTransaction: (...args: unknown[]) => send(...args),
}));

const wallet = Keypair.generate();
const position = Keypair.generate().publicKey;
const closeTx = () =>
  new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 }));

vi.mock("../src/dlmmSdk.js", () => ({
  default: {
    create: async () => ({
      getPositionsByUserAndLbPair: async () => ({
        userPositions: [{ publicKey: position, positionData: { positionBinData: [{ binId: -2 }, { binId: 2 }] } }],
      }),
      removeLiquidity: async () => [closeTx(), closeTx()],
    }),
  },
}));

const { RealExecutor } = await import("../src/execution/realExecutor.js");
const { GENESIS_HASHES } = await import("../src/execution/safetyGate.js");

function executor() {
  const connection = { getGenesisHash: async () => GENESIS_HASHES.devnet } as unknown as Connection;
  return new RealExecutor({ keypair: wallet, connection });
}
const pool = Keypair.generate().publicKey.toBase58();

describe("clôture en plusieurs transactions (faille M6)", () => {
  it("échec de la 2e transaction : clôture partielle signalée, sans exception", async () => {
    send.mockReset().mockResolvedValueOnce("sig-1").mockRejectedValueOnce(new Error("blockhash expiré"));
    const res = await executor().closePosition(pool, position.toBase58());
    expect(res.ok).toBe(false);
    expect(res.note).toContain("Clôture partielle : 1/2");
    expect(res.txHash).toBe("sig-1");
  });

  it("chaque transaction de clôture porte des frais de priorité", async () => {
    send.mockReset().mockResolvedValue("sig");
    const res = await executor().closePosition(pool, position.toBase58());
    expect(res.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [, tx] of send.mock.calls as Array<[unknown, Transaction]>) {
      expect(tx.instructions[0]!.data[0]).toBe(3); // SetComputeUnitPrice en tête
    }
  });

  it("échec dès la 1re transaction : clôture échouée, à réessayer", async () => {
    send.mockReset().mockRejectedValueOnce(new Error("RPC"));
    const res = await executor().closePosition(pool, position.toBase58());
    expect(res.ok).toBe(false);
    expect(res.note).toContain("Clôture échouée");
  });
});
