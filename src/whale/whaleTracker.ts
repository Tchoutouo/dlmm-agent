import DLMM from "@meteora-ag/dlmm";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
  type TokenBalance,
} from "@solana/web3.js";
import type { PriceOracle } from "../data/priceOracle.js";
import { swapMagnitudeUsd } from "./swapValue.js";
import { config } from "../config.js";

export interface WhaleSwap {
  signature: string;
  amountUsd: number;
  side: "buyX" | "sellX" | "none";
  blockTime: number | null;
}

export interface WhaleActivity {
  poolAddress: string;
  scanned: number;
  whales: WhaleSwap[];
  totalWhaleUsd: number;
  netDirection: "accumulation" | "distribution" | "neutral";
}

/** Variation (post − pre) du solde d'un compte token donné, en unités UI. */
function balanceDelta(
  pre: TokenBalance[] | null | undefined,
  post: TokenBalance[] | null | undefined,
  accountIndex: number
): number {
  if (accountIndex < 0) return 0;
  const p = pre?.find((b) => b.accountIndex === accountIndex)?.uiTokenAmount.uiAmount ?? 0;
  const q = post?.find((b) => b.accountIndex === accountIndex)?.uiTokenAmount.uiAmount ?? 0;
  return (q ?? 0) - (p ?? 0);
}

/**
 * Suivi on-chain des « baleines » : lit les dernières transactions touchant la
 * pool et mesure le mouvement dans ses coffres (reserveX/reserveY) pour estimer
 * la taille USD de chaque swap. Utilise uniquement des primitives RPC standard
 * (getSignaturesForAddress, getParsedTransactions) — pas de parsing d'instructions.
 */
export class WhaleTracker {
  constructor(
    private readonly connection: Connection,
    private readonly oracle: PriceOracle
  ) {}

  async recentActivity(poolAddress: string): Promise<WhaleActivity> {
    const poolPk = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(this.connection, poolPk, { cluster: config.NETWORK });
    const reserveX = dlmmPool.lbPair.reserveX.toBase58();
    const reserveY = dlmmPool.lbPair.reserveY.toBase58();
    const mintX = dlmmPool.lbPair.tokenXMint.toBase58();
    const mintY = dlmmPool.lbPair.tokenYMint.toBase58();
    const prices = await this.oracle.getUsdPrices([mintX, mintY]);

    const sigs = await this.connection.getSignaturesForAddress(poolPk, {
      limit: config.WHALE_LOOKBACK_TX,
    });
    const txs = await this.connection.getParsedTransactions(
      sigs.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    const whales: WhaleSwap[] = [];
    let netX = 0;
    for (const tx of txs) {
      if (!tx || !tx.meta) continue;
      const w = this.evaluateTx(tx, reserveX, reserveY, mintX, mintY, prices);
      if (w && w.amountUsd >= config.WHALE_MIN_USD) {
        whales.push(w);
        if (w.side === "buyX") netX += w.amountUsd;
        else if (w.side === "sellX") netX -= w.amountUsd;
      }
    }

    const totalWhaleUsd = whales.reduce((s, w) => s + w.amountUsd, 0);
    const netDirection =
      netX > totalWhaleUsd * 0.2
        ? "accumulation"
        : netX < -totalWhaleUsd * 0.2
          ? "distribution"
          : "neutral";

    return { poolAddress, scanned: txs.length, whales, totalWhaleUsd, netDirection };
  }

  private evaluateTx(
    tx: ParsedTransactionWithMeta,
    reserveX: string,
    reserveY: string,
    mintX: string,
    mintY: string,
    prices: Record<string, number>
  ): WhaleSwap | null {
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const xIdx = keys.indexOf(reserveX);
    const yIdx = keys.indexOf(reserveY);
    if (xIdx < 0 && yIdx < 0) return null;

    const deltaXTokens = balanceDelta(tx.meta!.preTokenBalances, tx.meta!.postTokenBalances, xIdx);
    const deltaYTokens = balanceDelta(tx.meta!.preTokenBalances, tx.meta!.postTokenBalances, yIdx);
    if (deltaXTokens === 0 && deltaYTokens === 0) return null;

    const { amountUsd, side } = swapMagnitudeUsd({
      deltaXTokens,
      deltaYTokens,
      priceXUsd: prices[mintX] ?? 0,
      priceYUsd: prices[mintY] ?? 0,
    });
    return { signature: tx.transaction.signatures[0] ?? "", amountUsd, side, blockTime: tx.blockTime ?? null };
  }
}
