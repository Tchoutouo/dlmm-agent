import { ComputeBudgetProgram, type Transaction } from "@solana/web3.js";

/** Discriminant de l'instruction ComputeBudget « SetComputeUnitPrice ». */
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Ajoute des frais de priorité à une transaction (legacy) si elle n'en a pas.
 * Sans eux, une transaction peut ne jamais passer quand le réseau est chargé —
 * précisément quand un stop-loss doit s'exécuter. Une transaction qui fixe déjà
 * son prix n'est pas modifiée : deux SetComputeUnitPrice la feraient rejeter.
 */
export function withPriorityFee(tx: Transaction, microLamports: number): Transaction {
  if (!(microLamports > 0)) return tx;
  const computeBudget = ComputeBudgetProgram.programId;
  const hasPrice = tx.instructions.some(
    (ix) => ix.programId.equals(computeBudget) && ix.data[0] === SET_COMPUTE_UNIT_PRICE
  );
  if (!hasPrice) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(Math.round(microLamports)) }));
  }
  return tx;
}
