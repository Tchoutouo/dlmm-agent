import { ComputeBudgetProgram, PublicKey, SystemProgram, type VersionedMessage } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Contrôles d'un swap Jupiter AVANT signature (fonctions pures, testées).
 *
 * La transaction est construite par une API distante puis signée par le wallet :
 * sans contrôle, une API compromise (ou un détournement DNS) pourrait y glisser
 * un virement vers un tiers. On vérifie donc le devis, puis chaque instruction.
 */

/** Programme d'agrégation Jupiter v6 (on-chain, immuable). */
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Seuls programmes appelables au premier niveau d'une transaction de swap. */
export const ALLOWED_SWAP_PROGRAMS = new Set([
  JUPITER_PROGRAM_ID,
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

/** Impact de prix maximal accepté (fraction : 0,01 = 1 %). */
export const MAX_PRICE_IMPACT = 0.01;

/** Index des instructions System qui déplacent des lamports : transfer, transferWithSeed. */
const SYSTEM_TRANSFER_IXS = new Set([2, 11]);

export interface QuoteExpectation {
  inputMint: string;
  outputMint: string;
  amount: number;
}

/** Le devis correspond-il à la demande ? Renvoie le motif du refus, ou null. */
export function checkQuote(quote: Record<string, unknown>, expected: QuoteExpectation): string | null {
  if (quote.inputMint !== expected.inputMint || quote.outputMint !== expected.outputMint) {
    return "devis Jupiter sur d'autres tokens que ceux demandés";
  }
  if (String(quote.inAmount) !== String(Math.round(expected.amount))) {
    return `devis Jupiter pour ${String(quote.inAmount)} unités au lieu de ${Math.round(expected.amount)}`;
  }
  if (!(Number(quote.otherAmountThreshold) > 0)) {
    return "devis Jupiter sans montant minimal de sortie (slippage non borné)";
  }
  const impact = Number(quote.priceImpactPct);
  if (!Number.isFinite(impact) || impact > MAX_PRICE_IMPACT) {
    return `impact de prix ${(impact * 100).toFixed(2)} % > ${MAX_PRICE_IMPACT * 100} %`;
  }
  return null;
}

/**
 * La transaction renvoyée par l'API ne fait-elle QUE le swap demandé ?
 *  - payeur des frais = notre wallet ;
 *  - instructions de premier niveau limitées aux programmes autorisés ;
 *  - virements de SOL uniquement vers notre wallet ou notre compte WSOL
 *    (enveloppement du SOL), jamais vers un compte tiers ni un compte chargé
 *    depuis une lookup table (destination non vérifiable).
 * Renvoie le motif du refus, ou null.
 */
export function checkSwapMessage(message: VersionedMessage, wallet: PublicKey): string | null {
  const keys = message.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) return "payeur des frais différent de notre wallet";

  const ownAccounts = new Set([
    wallet.toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, wallet, false, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, wallet, false, TOKEN_2022_PROGRAM_ID).toBase58(),
  ]);
  const system = SystemProgram.programId.toBase58();

  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex]?.toBase58();
    if (!program || !ALLOWED_SWAP_PROGRAMS.has(program)) {
      return `programme non autorisé dans la transaction : ${program ?? "inconnu"}`;
    }
    if (program === system && ix.data.length >= 4) {
      const kind = new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true);
      if (SYSTEM_TRANSFER_IXS.has(kind)) {
        const destIndex = ix.accountKeyIndexes[kind === 2 ? 1 : 2];
        const dest = destIndex !== undefined ? keys[destIndex]?.toBase58() : undefined;
        if (!dest || !ownAccounts.has(dest)) {
          return `virement de SOL vers un compte tiers : ${dest ?? "non vérifiable"}`;
        }
      }
    }
  }
  return null;
}
