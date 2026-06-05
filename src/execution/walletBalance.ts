import { Connection, PublicKey } from "@solana/web3.js";
import type { PriceOracle } from "../data/priceOracle.js";
import { SOL_MINT } from "../data/priceOracle.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface TokenBalance {
  mint: string;
  amount: number; // unités UI
}

export interface WalletUsd {
  totalUsd: number;
  byMint: Record<string, number>;
}

/** Somme USD pure d'une liste de soldes, étant donné les prix. Testable. */
export function sumWalletUsd(balances: TokenBalance[], prices: Record<string, number>): WalletUsd {
  const byMint: Record<string, number> = {};
  let totalUsd = 0;
  for (const b of balances) {
    const usd = b.amount * (prices[b.mint] ?? 0);
    byMint[b.mint] = (byMint[b.mint] ?? 0) + usd;
    totalUsd += usd;
  }
  return { totalUsd, byMint };
}

/** Lit les soldes on-chain : SOL natif + tous les comptes SPL / Token-2022. */
export async function readWalletBalances(
  connection: Connection,
  owner: PublicKey
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];

  const lamports = await connection.getBalance(owner);
  if (lamports > 0) balances.push({ mint: SOL_MINT, amount: lamports / LAMPORTS_PER_SOL });

  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { account } of res.value) {
      const info = (account.data as { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } })
        .parsed.info;
      const amount = info.tokenAmount.uiAmount ?? 0;
      if (amount > 0) balances.push({ mint: info.mint, amount });
    }
  }
  return balances;
}

/** Valeur USD totale du wallet (cash réel disponible). */
export async function readWalletUsd(
  connection: Connection,
  owner: PublicKey,
  oracle: PriceOracle
): Promise<WalletUsd> {
  const balances = await readWalletBalances(connection, owner);
  if (balances.length === 0) return { totalUsd: 0, byMint: {} };
  const prices = await oracle.getUsdPrices(balances.map((b) => b.mint));
  return sumWalletUsd(balances, prices);
}
