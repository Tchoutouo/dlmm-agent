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

/**
 * Range de bins selon le régime de marché.
 * Marché calme → range étroit → liquidité plus concentrée → ~3× plus de fees/dollar.
 * Marché volatile → range large → position reste en range plus longtemps.
 */
function rangeBinsForRegime(regime: FeeRegimeLabel, defaultBins: number): number {
  switch (regime) {
    case "calm":     return Math.max(3, Math.round(defaultBins * 0.5));  // moitié → très concentré
    case "volatile": return Math.min(50, Math.round(defaultBins * 2));   // double → large coussin
    default:         return defaultBins;                                  // active → valeur config
  }
}

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

    // Vérification préalable : SOL suffisant pour rent des comptes Meteora + gas (≥0.20 SOL)
    // Meteora DLMM crée des bin-array accounts (rent ~0.05-0.08 SOL chacun) + compte position
    // + dépôt SOL de la position. ensureSolForPool cible 0.25 SOL ; cette garde est un filet.
    const solLamports = await connection.getBalance(keypair.publicKey);
    if (solLamports < 0.20 * 1e9) {
      return {
        mode: "LIVE",
        ok: false,
        note: `Solde SOL insuffisant : ${(solLamports / 1e9).toFixed(4)} SOL (min 0.20 — rent bin-arrays + dépôt pool)`,
      };
    }

    if (!(input.currentPrice > 0) || !Number.isFinite(input.currentPrice)) {
      return {
        mode: "LIVE",
        ok: false,
        note: `Prix courant invalide : ${input.currentPrice} — abandon de l'ouverture`,
      };
    }

    const pool = new PublicKey(input.poolAddress);
    const dlmmPool = await DLMM.create(connection, pool, { cluster: config.NETWORK });

    const activeBin = await dlmmPool.getActiveBin();
    // Range dynamique : étroit en marché calme (3× plus de fees/dollar),
    // large en marché volatile (moins de rebalancing, position reste en range).
    const rangeBins = rangeBinsForRegime(input.regime, config.DLMM_RANGE_BINS);
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
    try {
      await this.assertTokenBalance(connection, keypair.publicKey, mintX, totalXAmount, "tokenX");
      await this.assertTokenBalance(connection, keypair.publicKey, mintY, totalYAmount, "tokenY");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { mode: "LIVE", ok: false, note: msg };
    }

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

  /**
   * Réclame les swap fees accumulées d'une position sans la fermer.
   * Retourne ok=true si la tx est confirmée (ou en DRY_RUN simulé).
   */
  async claimFees(poolAddress: string, positionPubkey: string): Promise<ExecResult> {
    const gate = this.gate();
    if (gate.mode === "REFUSE") return { mode: gate.mode, ok: false, note: gate.reason };

    const { keypair, connection } = this.wallet;
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress), {
      cluster: config.NETWORK,
    });
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(keypair.publicKey);
    const target = userPositions.find((p) => p.publicKey.toBase58() === positionPubkey);
    if (!target) return { mode: gate.mode, ok: false, note: "Position introuvable on-chain (claim)" };

    if (gate.mode === "DRY_RUN") {
      const fX = Number(target.positionData.feeX?.toString() ?? 0);
      const fY = Number(target.positionData.feeY?.toString() ?? 0);
      return { mode: "DRY_RUN", ok: true, note: `[DRY_RUN] Claim simulé feeX=${fX} feeY=${fY}` };
    }

    const raw = await dlmmPool.claimSwapFee({
      owner: keypair.publicKey,
      position: target,
    });
    // Le SDK peut retourner une Transaction ou Transaction[]
    const tx = (Array.isArray(raw) ? raw[0] : raw) as import("@solana/web3.js").Transaction;
    if (!tx) return { mode: "LIVE", ok: false, note: "Aucune fee à réclamer" };
    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair]);
    return { mode: "LIVE", ok: true, note: `Fees réclamées`, txHash };
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
