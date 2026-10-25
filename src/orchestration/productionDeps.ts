import { MeteoraClient } from "../data/meteoraClient.js";
import { DataApiClient } from "../data/dataApiClient.js";
import { PriceOracle } from "../data/priceOracle.js";
import { Portfolio } from "../portfolio/portfolio.js";
import { TradeJournal } from "../journal/journal.js";
import { scanOpportunities, isStablePool, STABLE_MINTS } from "../analytics/opportunityScanner.js";
import { planPosition } from "../analytics/positionPlan.js";
import { predictForwardVol } from "../ml/volatilityClient.js";
import { loadWallet } from "../execution/wallet.js";
import { RealExecutor } from "../execution/realExecutor.js";
import { LivePositionManager } from "../execution/livePositionManager.js";
import { jupiterSwap, SOL_MINT, USDC_MINT } from "../execution/jupiterSwap.js";
import type { OrchestratorDeps } from "./deps.js";
import { dryRunExecute } from "./deps.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "productionDeps" });

/** Les paires stables ont peu de volume par nature (prix fixe) : filtres d'activité levés. */
const STABLE_SCAN_RELAX = { minVolumeTvlRatio: 0, minRecentVolumeRatio: 0 };

export interface ProductionClients {
  market: MeteoraClient;
  data: DataApiClient;
  oracle: PriceOracle;
  portfolio: Portfolio;
  journal: TradeJournal;
  manager?: LivePositionManager;
}

/** Construit les clients réels. */
export function createClients(): ProductionClients {
  return {
    market: new MeteoraClient(),
    data: new DataApiClient(),
    oracle: new PriceOracle(),
    portfolio: new Portfolio(),
    journal: new TradeJournal(),
  };
}

/** Adapte les clients réels à l'interface OrchestratorDeps. */
export function createProductionDeps(c: ProductionClients): OrchestratorDeps {
  const wallet = loadWallet();
  const executor = wallet ? new RealExecutor(wallet) : null;
  const manager = wallet ? new LivePositionManager(wallet, c.oracle) : null;
  if (manager) c.manager = manager;

  return {
    scanMarket: async () => {
      let allPairs: import("../types.js").Pool[];
      try {
        allPairs = await c.market.getAllPairs();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Scan de marché impossible — API Meteora indisponible", { reason: msg });
        return [];
      }

      // Sélection intelligente : si AUTO_SWAP désactivé et SOL insuffisant,
      // limiter le scan aux pools stables (USDC-USDT, etc.) qui ne nécessitent
      // pas de SOL côté dépôt — évite des tentatives vouées à l'échec.
      if (!config.AUTO_SWAP && wallet) {
        const solLamports = await wallet.connection.getBalance(wallet.keypair.publicKey);
        if (solLamports < 0.15 * 1e9) {
          const stablePairs = allPairs.filter((p) => isStablePool(p));
          if (stablePairs.length >= 2) {
            console.log(
              `  ℹ️  SOL faible (${(solLamports / 1e9).toFixed(3)} SOL) — scan limité aux pools stables`
            );
            return scanOpportunities(stablePairs, { topN: 10, minStableN: 10, ...STABLE_SCAN_RELAX });
          }
        }
      }

      // Scan principal : 15 meilleurs pools toutes catégories (volatile + mixed)
      const mainCandidates = scanOpportunities(allPairs, { topN: 15, minStableN: 0 });

      // Scan stable dédié avec seuils assouplis :
      // Les pools USDC-USDT ont un volume24h faible (prix stable → peu d'arbitrage)
      // et peuvent ne pas être "verified" dans l'API Meteora → on abaisse les seuils.
      const stablePools = allPairs.filter((p) => isStablePool(p));
      console.log(`  ℹ️  ${stablePools.length} pool(s) stable/stable dans l'univers Meteora`);
      const stableCandidates = scanOpportunities(stablePools, {
        topN: 3,
        minStableN: 3,
        minLiquidityUsd: 5_000,
        minVolume24h: 200,
        verifiedOnly: false,
        ...STABLE_SCAN_RELAX,
      });
      if (stableCandidates.length > 0) {
        console.log(`  ℹ️  ${stableCandidates.length} pool(s) stable(s) trouvée(s) (USDC-USDT/USDS…)`);
      }

      // Fusion sans doublons (une pool stable pourrait déjà être dans mainCandidates)
      const seenAddresses = new Set(mainCandidates.map((c) => c.pool.address));
      const candidates = [
        ...mainCandidates,
        ...stableCandidates.filter((c) => !seenAddresses.has(c.pool.address)),
      ];

      // Filtre dynamique : ne garder que les pools dont le wallet possède
      // les comptes ATA pour les deux tokens. Évite les tentatives vouées
      // à l'échec sur des tokens exotiques (USD1, KALSHI, etc.).
      if (wallet) {
        return await filterByWalletTokens(wallet, candidates);
      }
      return candidates;
    },
    getCandles: (addr) => c.data.getOhlcv(addr, "1h", 96),
    getQuoteUsdPrice: (mint) => c.oracle.getUsdPrice(mint),
    getForwardVol: async (addr, candles) => (await predictForwardVol(candles, "1h", addr))?.dailyVol ?? null,
    // Live : photo on-chain (cash déployable = SOL + stables ; autres tokens = inventaire
    // exposé). Si elle est indisponible, le scan échoue plutôt que de trader à l'aveugle.
    getSnapshot: () => (manager ? manager.realSnapshot() : c.portfolio.snapshot()),
    // Le risque évalue la position que l'exécuteur ouvrira réellement (spot, ≤ 69 bins)
    planPosition: (cand, analysis) => planPosition("spot", cand.pool, analysis.suggestedRange),
    recordDecision: (d) =>
      c.journal.record({
        timestamp: new Date().toISOString(),
        poolAddress: d.poolAddress,
        poolName: d.poolName,
        decision: d.decision,
        score: 0,
        estimatedFeeApr: d.features?.expectedNetApr ?? 0,
        sizeUsd: d.sizeUsd,
        rangeLow: d.rangeLow,
        rangeHigh: d.rangeHigh,
        estimatedIlPct: d.estimatedIlPct,
        features: d.features,
        rationale: d.rationale,
      }),
    executePosition: async (proposal, journalId) => {
      if (!executor || !wallet) return dryRunExecute(proposal, journalId);

      const { candidate, analysis, risk } = proposal;
      const plan = proposal.plan ?? planPosition("spot", candidate.pool, analysis.suggestedRange);

      // Garde-fou AVANT tout envoi, swaps compris (réseau réel du RPC, DRY_RUN, ACK)
      const gate = await executor.checkGate();
      if (gate.mode === "REFUSE") return { ok: false, note: gate.reason };

      // Prix USD réels : quote de la pool (conversion des montants) et SOL (auto-swap)
      let quoteUsd: number;
      let solUsd: number;
      try {
        [quoteUsd, solUsd] = await Promise.all([
          c.oracle.getUsdPrice(candidate.pool.mintY),
          c.oracle.getUsdPrice(SOL_MINT),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, note: `Prix USD indisponible — position annulée (${msg.slice(0, 80)})` };
      }

      // Auto-swap : si la pool contient du SOL et que le solde est insuffisant,
      // on achète le SOL manquant en USDC via Jupiter avant d'ouvrir la position.
      if (config.AUTO_SWAP) {
        const swapOk = await ensureSolForPool(
          wallet,
          candidate.pool.mintX,
          candidate.pool.mintY,
          risk.recommendedSizeUsd,
          solUsd,
          gate.mode === "DRY_RUN"
        );
        if (!swapOk) return { ok: false, note: "Auto-swap échoué — position annulée" };
      }

      let res;
      try {
        res = await executor.openPosition({
          poolAddress: candidate.pool.address,
          sizeUsd: risk.recommendedSizeUsd,
          currentPrice: candidate.pool.currentPrice,
          quoteUsdPrice: quoteUsd,
          rangeLow: plan.rangeLow,
          rangeHigh: plan.rangeHigh,
        });
      } catch (err) {
        const msg = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
        return { ok: false, note: msg.slice(0, 120) };
      }

      if (res.mode === "LIVE" && res.ok && res.positionPubkey && manager) {
        manager.register({
          journalId: typeof journalId === "number" ? journalId : undefined,
          poolAddress: candidate.pool.address,
          poolName: candidate.pool.name,
          mintX: candidate.pool.mintX,
          mintY: candidate.pool.mintY,
          positionPubkey: res.positionPubkey,
          sizeUsd: risk.recommendedSizeUsd,
          openedAtSec: Math.floor(Date.now() / 1000),
        });
      }

      return { ok: res.ok, note: res.note };
    },
  };
}

// ─── Helper : filtre les pools par tokens disponibles dans le wallet ──────────

/**
 * Ne conserve que les pools dont le wallet possède les ATAs pour les deux
 * tokens (hors SOL natif et USDC toujours présents). Effectue des lectures
 * RPC légères (getTokenAccountBalance) — pas de transaction.
 */
async function filterByWalletTokens(
  wallet: LoadedWallet,
  candidates: import("../types.js").ScoredOpportunity[]
): Promise<import("../types.js").ScoredOpportunity[]> {
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const { PublicKey } = await import("@solana/web3.js");

  const supported: typeof candidates = [];
  for (const opp of candidates) {
    const mints = [opp.pool.mintX, opp.pool.mintY].filter(
      (m) => m !== SOL_MINT && m !== USDC_MINT
    );
    let ok = true;
    for (const mint of mints) {
      // Les stablecoins peuvent être obtenus via auto-swap USDC→stable → ne pas filtrer
      if (STABLE_MINTS.has(mint)) continue;
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.keypair.publicKey);
        await wallet.connection.getTokenAccountBalance(ata);
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) supported.push(opp);
    else console.log(`  ⏭️  Pool filtrée (token exotique absent) : ${opp.pool.name}`);
  }
  return supported;
}

// ─── Helper : auto-swap USDC → SOL si la pool nécessite du SOL ────────────────

type LoadedWallet = NonNullable<ReturnType<typeof loadWallet>>;

/**
 * S'assure que le wallet a les tokens nécessaires pour entrer dans une pool.
 *
 * Cas gérés (AUTO_SWAP=true) :
 *  1. mintX = SOL → swap USDC→SOL si solde insuffisant.
 *  2. mintX ou mintY est un stablecoin (≠ USDC) → swap USDC→stable pour
 *     financer ce côté de la position (ex. USDC-USDT : achète des USDT).
 *
 * Les tokens exotiques (TRUMP, YZY…) ne déclenchent PAS de swap.
 */
async function ensureSolForPool(
  wallet: LoadedWallet,
  mintX: string,
  mintY: string,
  sizeUsd: number,
  solUsd: number, // prix USD du SOL (oracle) — pas le prix de la pool, qui peut être en SOL
  dryRun: boolean
): Promise<boolean> {
  const { connection, keypair } = wallet;
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const { PublicKey } = await import("@solana/web3.js");

  // ── 1. SOL (mintX) insuffisant ──────────────────────────────────────────
  if (mintX === SOL_MINT && solUsd > 0) {
    // Vérifier d'abord que tokenY est accessible (sinon le swap SOL est inutile)
    if (mintY !== SOL_MINT && mintY !== USDC_MINT && !STABLE_MINTS.has(mintY)) {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mintY), keypair.publicKey);
        await connection.getTokenAccountBalance(ata);
      } catch {
        console.log(`  ⏭️  Pool ignorée : pas de compte ${mintY.slice(0, 8)}… dans le wallet`);
        return false;
      }
    }

    const solLamports = await connection.getBalance(keypair.publicKey);
    const solHave = solLamports / 1e9;
    // Buffer 0.08 SOL couvre la rent des nouveaux bin-array accounts Meteora (~0.05 SOL chacun).
    // Minimum 0.25 SOL garantit qu'il reste assez après la création des comptes on-chain.
    const solNeeded = Math.max(sizeUsd / 2 / solUsd + 0.08, 0.25);

    if (solHave < solNeeded) {
      const deficit    = solNeeded - solHave;
      const deficitUsd = deficit * solUsd * 1.1;
      const usdcUnits  = Math.round(deficitUsd * 1e6);
      console.log(`  💱 Auto-swap : ${deficitUsd.toFixed(2)} USDC → SOL (wallet ${solHave.toFixed(3)} / besoin ${solNeeded.toFixed(3)} SOL)`);
      const r = await jupiterSwap(connection, keypair, USDC_MINT, SOL_MINT, usdcUnits, dryRun);
      console.log(`  ${r.ok ? "✅" : "⚠️ "} ${r.note}`);
      if (!r.ok) { console.log(`  ⏭️  Position annulée (swap SOL échoué)`); return false; }
    }
  }

  // ── 2. Token stable (≠ USDC) — swap USDC → stable si ATA manquant ──────
  for (const mint of [mintX, mintY]) {
    if (mint === SOL_MINT || mint === USDC_MINT || !STABLE_MINTS.has(mint)) continue;

    // Vérifier si le wallet a déjà assez de ce stable
    let haveEnough = false;
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), keypair.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      const haveUsd = Number(info.value.uiAmount ?? 0);
      haveEnough = haveUsd >= sizeUsd / 2 * 0.95; // 5 % de tolérance
    } catch { /* ATA absent → haveEnough = false */ }

    if (!haveEnough) {
      const neededUsd  = sizeUsd / 2;
      const usdcUnits  = Math.round(neededUsd * 1.05 * 1e6); // +5 % buffer
      console.log(`  💱 Auto-swap : ${neededUsd.toFixed(2)} USDC → ${mint.slice(0, 8)}… (stable)`);
      const r = await jupiterSwap(connection, keypair, USDC_MINT, mint, usdcUnits, dryRun);
      console.log(`  ${r.ok ? "✅" : "⚠️ "} ${r.note}`);
      if (!r.ok) { console.log(`  ⏭️  Position annulée (swap stable échoué)`); return false; }
    }
  }

  // ── 3. USDC (mintY) insuffisant alors que le wallet a du SOL → swap SOL→USDC ──
  // Cas typique : wallet chargé en SOL mais peu de USDC (fees reçues en SOL, ou funding SOL-only).
  if (mintY === USDC_MINT && solUsd > 0) {
    // Meteora peut avoir besoin jusqu'à ~80 % de la position en USDC si le prix est proche
    // du haut du range. On cible 85 % pour couvrir ce cas sans trop sur-swapper.
    const neededUsdc = sizeUsd * 0.85;
    let haveUsdc = 0;
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), keypair.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      haveUsdc = Number(info.value.uiAmount ?? 0);
    } catch { /* pas d'ATA USDC → haveUsdc = 0 */ }

    if (haveUsdc < neededUsdc) {
      const deficitUsdc = neededUsdc - haveUsdc;
      // SOL à vendre = déficit en USDC / prix USD du SOL (pas le prix de la pool)
      const solToSell = (deficitUsdc / solUsd) * 1.1; // +10 % slippage

      // Garde-fou : vérifier que vendre solToSell ne descend pas sous le minimum SOL
      // requis par realExecutor (0.20 SOL pour rent + création de comptes Meteora).
      const MIN_SOL_RESIDUAL = 0.20;
      const solNow = (await connection.getBalance(keypair.publicKey)) / 1e9;
      if (solNow - solToSell < MIN_SOL_RESIDUAL) {
        console.log(
          `  ⏭️  Swap SOL→USDC annulé — résiduel prévu ${(solNow - solToSell).toFixed(3)} SOL` +
          ` < min ${MIN_SOL_RESIDUAL} SOL → position annulée`
        );
        return false;
      }

      const lamports = Math.round(solToSell * 1e9);
      console.log(
        `  💱 Auto-swap : ${solToSell.toFixed(4)} SOL → ~${deficitUsdc.toFixed(2)} USDC` +
        ` (wallet ${haveUsdc.toFixed(2)} / besoin ${neededUsdc.toFixed(2)} USDC)`
      );
      const r = await jupiterSwap(connection, keypair, SOL_MINT, USDC_MINT, lamports, dryRun);
      console.log(`  ${r.ok ? "✅" : "⚠️ "} ${r.note}`);
      if (!r.ok) { console.log(`  ⏭️  Position annulée (swap USDC échoué)`); return false; }
    }
  }

  return true;
}
