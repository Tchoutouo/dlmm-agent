import DLMM, { StrategyType, autoFillYByStrategy } from "../dlmmSdk.js";
import {
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  type Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import type { LoadedWallet } from "./wallet.js";
import { detectRpcNetwork, executionGate, type DetectedNetwork, type ExecutionMode } from "./safetyGate.js";
import { binRangeForPrices, depositValueUsd, priceDeviation, tokenXForUsd } from "./executionMath.js";
import { withPriorityFee } from "./priorityFee.js";
import { config } from "../config.js";

export interface OpenInput {
  poolAddress: string;
  sizeUsd: number;
  /** Prix d'un token X en token Y vu par l'analyse (API). Contrôlé contre le prix on-chain. */
  currentPrice: number;
  /**
   * Prix USD du token Y (quote). Indispensable : pour une pool TOKEN/SOL, le prix
   * est en SOL, pas en dollars — sans conversion, le dépôt serait ~100× trop gros.
   */
  quoteUsdPrice: number;
  /**
   * Range évalué par l'agent de risque (prix X en Y). C'est CE range qui est
   * ouvert (plafonné à 69 bins). Absent : ±DLMM_RANGE_BINS bins autour du prix.
   */
  rangeLow?: number;
  rangeHigh?: number;
}

export interface ExecResult {
  mode: ExecutionMode;
  ok: boolean;
  note: string;
  positionPubkey?: string;
  txHash?: string;
}

/** Écart maximal toléré entre le prix de l'analyse (API) et le prix on-chain. */
export const MAX_PRICE_DEVIATION = 0.03;
/** Valeur maximale du dépôt construit, en multiple de la taille approuvée. */
export const MAX_DEPOSIT_OVERSHOOT = 1.1;
/** SOL laissé de côté pour la rent des comptes Meteora et les frais. */
const SOL_RESERVE_LAMPORTS = 0.15 * 1e9;

/**
 * Agent 3 — exécution réelle des transactions DLMM via le SDK officiel.
 *
 * Toujours protégé par `executionGate`, qui vérifie aussi le réseau RÉEL du RPC.
 * Par défaut (DRY_RUN, devnet), rien n'est envoyé. L'envoi réel exige
 * explicitement DRY_RUN=false (et, sur mainnet, ACKNOWLEDGE_REAL_FUNDS=true).
 *
 * Verrous avant tout envoi : prix on-chain cohérent avec l'analyse, montants
 * convertis en USD avec le prix du quote, valeur totale du dépôt ≤ 110 % de la
 * taille approuvée, soldes suffisants (SOL natif compris).
 */
export class RealExecutor {
  private rpcNetwork: DetectedNetwork = "unknown";

  constructor(private readonly wallet: LoadedWallet) {}

  private async gate() {
    // Détecté une fois (lecture seule), re-tenté tant qu'il reste inconnu
    if (this.rpcNetwork === "unknown") this.rpcNetwork = await detectRpcNetwork(this.wallet.connection);
    return executionGate({
      network: config.NETWORK,
      rpcNetwork: this.rpcNetwork,
      dryRun: config.DRY_RUN,
      walletLoaded: true,
      acknowledgeRealFunds: config.ACKNOWLEDGE_REAL_FUNDS,
    });
  }

  /** Verdict du garde-fou, pour les actions hors exécuteur (auto-swap Jupiter). */
  async checkGate() {
    return this.gate();
  }

  /** Ouvre une position de liquidité (forme Spot, sur le range évalué). */
  async openPosition(input: OpenInput): Promise<ExecResult> {
    const gate = await this.gate();
    if (gate.mode === "REFUSE") return { mode: gate.mode, ok: false, note: gate.reason };

    const invalid = (note: string): ExecResult => ({ mode: gate.mode, ok: false, note });
    if (!(input.sizeUsd > 0) || !Number.isFinite(input.sizeUsd)) return invalid(`Taille invalide : ${input.sizeUsd}`);
    if (!(input.currentPrice > 0) || !Number.isFinite(input.currentPrice)) {
      return invalid(`Prix courant invalide : ${input.currentPrice} — abandon de l'ouverture`);
    }
    if (!(input.quoteUsdPrice > 0) || !Number.isFinite(input.quoteUsdPrice)) {
      return invalid(`Prix USD du quote invalide : ${input.quoteUsdPrice} — abandon de l'ouverture`);
    }

    // DRY_RUN sur un RPC mainnet : tout est construit à partir de la chaîne puis
    // SIMULÉ, jamais envoyé (voir plus bas). Sur devnet, les pools de l'API mainnet
    // n'existent pas : montants calculés hors chaîne, et la note le dit.
    const simulateOnly = gate.mode === "DRY_RUN";
    if (simulateOnly && this.rpcNetwork !== "mainnet-beta") {
      const xUi = tokenXForUsd(input.sizeUsd / 2, input.currentPrice, input.quoteUsdPrice);
      const range =
        input.rangeLow && input.rangeHigh
          ? `range [${input.rangeLow.toPrecision(5)}, ${input.rangeHigh.toPrecision(5)}]`
          : `±${config.DLMM_RANGE_BINS} bins`;
      return {
        mode: "DRY_RUN",
        ok: true,
        note:
          `Simulation hors chaîne (NON vérifiée on-chain : RPC ${this.rpcNetwork}) — ` +
          `${input.poolAddress.slice(0, 8)}… ${range}, Spot, ` +
          `taille $${input.sizeUsd.toFixed(0)} ≈ ${xUi.toPrecision(4)} X + l'équivalent en Y`,
        positionPubkey: Keypair.generate().publicKey.toBase58(),
      };
    }

    // LIVE (ou simulation mainnet) : lectures on-chain + construction de la transaction.
    const { keypair, connection } = this.wallet;
    // En simulation, un solde insuffisant est relevé mais n'arrête pas la construction :
    // le but est de valider prix, bins et montants même avec un wallet vide.
    const balanceWarnings: string[] = [];

    // Vérification préalable : SOL suffisant pour rent des comptes Meteora + gas (≥0.20 SOL)
    const solLamports = await connection.getBalance(keypair.publicKey);
    if (solLamports < 0.20 * 1e9) {
      const msg = `Solde SOL insuffisant : ${(solLamports / 1e9).toFixed(4)} SOL (min 0.20 — rent bin-arrays + dépôt pool)`;
      if (!simulateOnly) return invalid(msg);
      balanceWarnings.push(msg);
    }

    const pool = new PublicKey(input.poolAddress);
    const dlmmPool = await DLMM.create(connection, pool, { cluster: config.NETWORK });
    const activeBin = await dlmmPool.getActiveBin();
    const binStep = dlmmPool.lbPair.binStep;

    // Le prix on-chain fait foi ; trop loin de l'analyse → l'évaluation du risque est caduque
    const onChainPrice = Number(activeBin.pricePerToken);
    if (!(onChainPrice > 0)) return invalid(`Prix on-chain invalide : ${activeBin.pricePerToken}`);
    const deviation = priceDeviation(onChainPrice, input.currentPrice);
    if (deviation > MAX_PRICE_DEVIATION) {
      return invalid(
        `Prix on-chain ${onChainPrice.toPrecision(6)} à ${(deviation * 100).toFixed(1)} % du prix analysé ` +
          `${input.currentPrice.toPrecision(6)} (max ${MAX_PRICE_DEVIATION * 100} %) — abandon`
      );
    }

    // Range évalué par le risque, converti en bins (plafond 69) ; sinon ±DLMM_RANGE_BINS
    const { minBinId, maxBinId } =
      input.rangeLow && input.rangeHigh
        ? binRangeForPrices(activeBin.binId, onChainPrice, input.rangeLow, input.rangeHigh, binStep)
        : { minBinId: activeBin.binId - config.DLMM_RANGE_BINS, maxBinId: activeBin.binId + config.DLMM_RANGE_BINS };
    const strategyType = StrategyType.Spot;

    // Moitié de la taille en X, convertie avec le prix USD réel (prix X/Y × prix du quote)
    const xDecimals = dlmmPool.tokenX.mint.decimals;
    const yDecimals = dlmmPool.tokenY.mint.decimals;
    const xUi = tokenXForUsd(input.sizeUsd / 2, onChainPrice, input.quoteUsdPrice);
    const totalXAmount = new BN(Math.max(0, Math.floor(xUi * 10 ** xDecimals)).toString());
    const totalYAmount = autoFillYByStrategy(
      activeBin.binId,
      binStep,
      totalXAmount,
      activeBin.xAmount,
      activeBin.yAmount,
      minBinId,
      maxBinId,
      strategyType
    );

    // Verrou final : la valeur du dépôt construit ne dépasse jamais la taille approuvée (+10 %)
    const depositUsd = depositValueUsd(
      Number(totalXAmount.toString()) / 10 ** xDecimals,
      Number(totalYAmount.toString()) / 10 ** yDecimals,
      onChainPrice,
      input.quoteUsdPrice
    );
    if (depositUsd > input.sizeUsd * MAX_DEPOSIT_OVERSHOOT) {
      return invalid(
        `Dépôt construit $${depositUsd.toFixed(2)} > ${MAX_DEPOSIT_OVERSHOOT * 100} % de la taille ` +
          `approuvée $${input.sizeUsd.toFixed(2)} — abandon`
      );
    }

    // Vérification des soldes avant d'envoyer (SOL natif compris)
    const mintX = dlmmPool.tokenX.mint.address;
    const mintY = dlmmPool.tokenY.mint.address;
    try {
      await this.assertTokenBalance(connection, keypair.publicKey, mintX, totalXAmount, "tokenX");
      await this.assertTokenBalance(connection, keypair.publicKey, mintY, totalYAmount, "tokenY");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!simulateOnly) return { mode: "LIVE", ok: false, note: msg };
      balanceWarnings.push(msg);
    }

    const newPosition = Keypair.generate();
    const tx = withPriorityFee(
      (await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: keypair.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: { minBinId, maxBinId, strategyType },
      })) as Transaction,
      config.PRIORITY_FEE_MICROLAMPORTS
    );
    const summary = `bins [${minBinId}, ${maxBinId}], dépôt $${depositUsd.toFixed(2)}`;

    if (simulateOnly) {
      const sim = await connection.simulateTransaction(tx, [keypair, newPosition]);
      const warn = balanceWarnings.length > 0 ? ` | ${balanceWarnings.join(" | ")}` : "";
      return sim.value.err
        ? {
            mode: "DRY_RUN",
            ok: false,
            note: `Simulation on-chain en échec (NON envoyée) — ${summary} : ${JSON.stringify(sim.value.err).slice(0, 80)}${warn}`,
          }
        : { mode: "DRY_RUN", ok: true, note: `Simulation on-chain réussie (NON envoyée) — ${summary}${warn}` };
    }

    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair, newPosition]);
    return {
      mode: "LIVE",
      ok: true,
      note:
        `Position ouverte (${gate.reason}) — ${newPosition.publicKey.toBase58()} ${summary}`,
      positionPubkey: newPosition.publicKey.toBase58(),
      txHash,
    };
  }

  /** Ferme une position : retire 100% de la liquidité, réclame les fees, ferme. */
  async closePosition(poolAddress: string, positionPubkey: string): Promise<ExecResult> {
    const gate = await this.gate();
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

    // Une clôture peut nécessiter plusieurs transactions : si l'une échoue, la
    // position est partiellement retirée. On le signale sans lever d'exception ;
    // le tick suivant relit la position on-chain et termine la clôture.
    const txs = Array.isArray(tx) ? tx : [tx];
    let last = "";
    for (const [i, t] of txs.entries()) {
      try {
        last = await sendAndConfirmTransaction(connection, withPriorityFee(t, config.PRIORITY_FEE_MICROLAMPORTS), [keypair]);
      } catch (err) {
        const msg = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
        return {
          mode: "LIVE",
          ok: false,
          note:
            (i === 0 ? "Clôture échouée" : `Clôture partielle : ${i}/${txs.length} transactions confirmées`) +
            ` — nouvel essai au prochain tick (${msg.slice(0, 80)})`,
          txHash: last || undefined,
        };
      }
    }
    return { mode: "LIVE", ok: true, note: `Position fermée — ${positionPubkey}`, txHash: last };
  }

  /**
   * Réclame les swap fees accumulées d'une position sans la fermer.
   * Retourne ok=true si la tx est confirmée (ou en DRY_RUN simulé).
   */
  async claimFees(poolAddress: string, positionPubkey: string): Promise<ExecResult> {
    const gate = await this.gate();
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
    const txHash = await sendAndConfirmTransaction(connection, withPriorityFee(tx, config.PRIORITY_FEE_MICROLAMPORTS), [keypair]);
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
    // SOL natif : le SDK enveloppe les lamports du wallet → vérifier le solde natif + réserve
    if (mint.toBase58() === "So11111111111111111111111111111111111111112") {
      const lamports = await connection.getBalance(owner);
      const needed = BigInt(required.toString()) + BigInt(SOL_RESERVE_LAMPORTS);
      if (BigInt(lamports) < needed) {
        throw new Error(
          `Solde ${label} (SOL) insuffisant : ${(lamports / 1e9).toFixed(4)} disponible, ` +
            `${(Number(needed) / 1e9).toFixed(4)} requis (dépôt + réserve rent/frais)`
        );
      }
      return;
    }

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
