import DLMM, { StrategyType, autoFillYByStrategy } from "../dlmmSdk.js";
import {
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  type Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import type { FeeRegimeLabel } from "../types.js";
import type { LoadedWallet } from "./wallet.js";
import { executionGate, type ExecutionMode } from "./safetyGate.js";
import { strategyForRegime } from "./strategyMap.js";
import { config } from "../config.js";

export interface OpenInput {
  poolAddress: string;
  sizeUsd: number;
  currentPrice: number; // Y (quote) par X
  regime: FeeRegimeLabel;
}

export interface ExecResult {
  mode: ExecutionMode;
  ok: boolean;
  note: string;
  positionPubkey?: string;
  txHash?: string;
}

/**
 * Agent 3 — exécution réelle des transactions DLMM via le SDK officiel.
 *
 * Toujours protégé par `executionGate`. Par défaut (DRY_RUN, devnet), il
 * CONSTRUIT la transaction mais ne l'envoie pas. L'envoi réel exige
 * explicitement DRY_RUN=false (et, sur mainnet, ACKNOWLEDGE_REAL_FUNDS=true).
 *
 * AVERTISSEMENT : la conversion taille USD → montants de tokens suppose un quote
 * stable (Y ≈ USD) et doit être VALIDÉE sur devnet avant tout usage réel.
 */
export class RealExecutor {
  constructor(private readonly wallet: LoadedWallet) {}

  private gate() {
    return executionGate({
      network: config.NETWORK,
      dryRun: config.DRY_RUN,
      walletLoaded: true,
      acknowledgeRealFunds: config.ACKNOWLEDGE_REAL_FUNDS,
    });
  }

  /** Ouvre une position de liquidité. */
  async openPosition(input: OpenInput): Promise<ExecResult> {
    const gate = this.gate();
    if (gate.mode === "REFUSE") return { mode: gate.mode, ok: false, note: gate.reason };

    // DRY_RUN : on simule la décision sans aucun appel on-chain.
    // Les pools viennent de l'API mainnet — elles n'existent pas sur devnet.
    if (gate.mode === "DRY_RUN") {
      const rangeBins = config.DLMM_RANGE_BINS;
      const strategy = strategyForRegime(input.regime);
      const mockPositionPubkey = Keypair.generate().publicKey.toBase58();
      return {
        mode: "DRY_RUN",
        ok: true,
        note: `Simulation (NON envoyée) — ${input.poolAddress.slice(0, 8)}… bins ±${rangeBins}, stratégie ${strategy}, taille $${input.sizeUsd.toFixed(0)}`,
        positionPubkey: mockPositionPubkey,
      };
    }

    // LIVE : lectures on-chain + envoi de la transaction réelle.
    const { keypair, connection } = this.wallet;

    // Vérification préalable : SOL suffisant pour le gas (≥0.05 SOL)
    const solLamports = await connection.getBalance(keypair.publicKey);
    if (solLamports < 0.05 * 1e9) {
      return {
        mode: "LIVE",
        ok: false,
        note: `Solde SOL insuffisant pour le gas : ${(solLamports / 1e9).toFixed(4)} SOL (min 0.05)`,
      };
    }

    const pool = new PublicKey(input.poolAddress);
    const dlmmPool = await DLMM.create(connection, pool, { cluster: config.NETWORK });

    const activeBin = await dlmmPool.getActiveBin();
    const rangeBins = config.DLMM_RANGE_BINS;
    const minBinId = activeBin.binId - rangeBins;
    const maxBinId = activeBin.binId + rangeBins;
    const strategyType = StrategyType[strategyForRegime(input.regime)];

    const xDecimals = dlmmPool.tokenX.mint.decimals;
    const xTokens = input.currentPrice > 0 ? input.sizeUsd / 2 / input.currentPrice : 0;
    const totalXAmount = new BN(Math.max(0, Math.floor(xTokens * 10 ** xDecimals)));
    const totalYAmount = autoFillYByStrategy(
      activeBin.binId,
      dlmmPool.lbPair.binStep,
      totalXAmount,
      activeBin.xAmount,
      activeBin.yAmount,
      minBinId,
      maxBinId,
      strategyType
    );

    // Vérification des soldes de tokens avant d'envoyer
    const mintX = dlmmPool.tokenX.mint.address;
    const mintY = dlmmPool.tokenY.mint.address;
    await this.assertTokenBalance(connection, keypair.publicKey, mintX, totalXAmount, "tokenX");
    await this.assertTokenBalance(connection, keypair.publicKey, mintY, totalYAmount, "tokenY");

    const newPosition = Keypair.generate();
    const tx = (await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: keypair.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
    })) as Transaction;

    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair, newPosition]);
    return {
      mode: "LIVE",
      ok: true,
      note: `Position ouverte (${gate.reason}) — ${newPosition.publicKey.toBase58()}`,
      positionPubkey: newPosition.publicKey.toBase58(),
      txHash,
    };
  }

  /** Ferme une position : retire 100% de la liquidité, réclame les fees, ferme. */
  async closePosition(poolAddress: string, positionPubkey: string): Promise<ExecResult> {
    const gate = this.gate();
    if (gate.mode === "REFUSE") return { mode: gate.mode, ok: false, note: gate.reason };

    const { keypair, connection } = this.wallet;
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress), {
      cluster: config.NETWORK,
    });
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(keypair.publicKey);
    const target = userPositions.find((p) => p.publicKey.toBase58() === positionPubkey);
    if (!target) return { mode: gate.mode, ok: false, note: "Position introuvable on-chain" };

    const bins = target.positionData.positionBinData;
    const fromBinId = bins[0]!.binId;
    const toBinId = bins[bins.length - 1]!.binId;

    const tx = (await dlmmPool.removeLiquidity({
      position: target.publicKey,
      user: keypair.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(100 * 100), // 100,00 %
      shouldClaimAndClose: true,
    })) as Transaction | Transaction[];

    if (gate.mode === "DRY_RUN") {
      return { mode: "DRY_RUN", ok: true, note: `Clôture construite (NON envoyée) — ${positionPubkey}` };
    }

    const txs = Array.isArray(tx) ? tx : [tx];
    let last = "";
    for (const t of txs) last = await sendAndConfirmTransaction(connection, t, [keypair]);
    return { mode: "LIVE", ok: true, note: `Position fermée — ${positionPubkey}`, txHash: last };
  }

  /** Vérifie qu'un compte de token a un solde suffisant. Lance une erreur explicite sinon. */
  private async assertTokenBalance(
    connection: import("@solana/web3.js").Connection,
    owner: PublicKey,
    mint: PublicKey,
    required: BN,
    label: string
  ): Promise<void> {
    if (required.isZero()) return;
    // SOL natif : pas de compte SPL
    if (mint.toBase58() === "So11111111111111111111111111111111111111112") return;

    try {
      const ata = getAssociatedTokenAddressSync(mint, owner);
      const info = await connection.getTokenAccountBalance(ata);
      const balance = new BN(info.value.amount);
      if (balance.lt(required)) {
        const have = Number(info.value.amount) / 10 ** info.value.decimals;
        const need = required.toNumber() / 10 ** info.value.decimals;
        throw new Error(
          `Solde ${label} insuffisant : ${have.toFixed(4)} disponible, ${need.toFixed(4)} requis` +
          ` (mint ${mint.toBase58().slice(0, 8)}…)`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Solde")) throw err;
      throw new Error(
        `Compte token ${label} introuvable pour le mint ${mint.toBase58().slice(0, 8)}… — ` +
        `as-tu le bon token dans le wallet ?`
      );
    }
  }
}
