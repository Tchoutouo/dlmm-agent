import { describe, it, expect } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { withPriorityFee } from "../src/execution/priorityFee.js";

const payer = Keypair.generate().publicKey;
const transfer = () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });

describe("frais de priorité (faille M6)", () => {
  it("ajoute un SetComputeUnitPrice en tête quand il manque", () => {
    const tx = withPriorityFee(new Transaction().add(transfer()), 20_000);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(tx.instructions[0]!.data[0]).toBe(3);
  });

  it("ne double pas un prix déjà fixé par le SDK (sinon rejet)", () => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }), transfer());
    expect(withPriorityFee(tx, 20_000).instructions).toHaveLength(2);
  });

  it("garde une limite de calcul existante et ajoute le prix à côté", () => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), transfer());
    expect(withPriorityFee(tx, 20_000).instructions).toHaveLength(3);
  });

  it("0 = désactivé", () => {
    expect(withPriorityFee(new Transaction().add(transfer()), 0).instructions).toHaveLength(1);
  });
});
