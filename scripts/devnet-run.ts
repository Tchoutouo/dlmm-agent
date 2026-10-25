/**
 * Test bout-en-bout sur devnet.
 *
 * Ce script valide l'ensemble du pipeline (Agent 1 → Agent 2 → Agent 3) sur
 * le réseau devnet, sans capital réel.
 *
 * USAGE :
 *   npx tsx scripts/devnet-run.ts            # Scan + dry-run uniquement
 *   npx tsx scripts/devnet-run.ts --live     # Scan + exécution réelle devnet
 *                                             #   (requiert DRY_RUN=false dans .env)
 *
 * PRÉREQUIS :
 *   1. WALLET_SECRET_KEY dans .env (npx tsx scripts/generate-wallet.ts)
 *   2. SOL devnet disponible (npx tsx scripts/devnet-check.ts)
 *   3. NETWORK=devnet (défaut)
 *
 * ÉTAPES COUVERTES :
 *   ① Scan du marché (Agent 1 — lecture seule, toujours)
 *   ② Analyse de risque (Agent 2 — sur les candidats retenus)
 *   ③ Dry-run : construction de la transaction (jamais envoyée avec DRY_RUN=true)
 *   ④ Exécution réelle devnet (avec --live et DRY_RUN=false)
 *   ⑤ Vérification on-chain que la position a bien été créée
 */

import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { loadWallet } from "../src/execution/wallet.js";
import { MeteoraClient } from "../src/data/meteoraClient.js";
import { DataApiClient } from "../src/data/dataApiClient.js";
import { PriceOracle } from "../src/data/priceOracle.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { TradeJournal } from "../src/journal/journal.js";
import { RealExecutor } from "../src/execution/realExecutor.js";
import { LivePositionManager } from "../src/execution/livePositionManager.js";
import { planPosition } from "../src/analytics/positionPlan.js";
import { scanOpportunities } from "../src/analytics/opportunityScanner.js";
import { deepAnalyze } from "../src/analytics/deepAnalysis.js";
import { assessRisk } from "../src/risk/riskAgent.js";
import { buildQuoteProfile } from "../src/analytics/quoteRisk.js";
import { config } from "../src/config.js";
import DLMM from "../src/dlmmSdk.js";
import { PublicKey } from "@solana/web3.js";

const LIVE = process.argv.includes("--live");
const TOP_N = 3; // candidates analysées

const sep = (title?: string) =>
  title
    ? console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`)
    : console.log("─".repeat(60));

async function main() {
  // ── Préconditions ──

  if (config.NETWORK !== "devnet") {
    console.error("❌  Ce script est réservé au devnet. Vérifie NETWORK=devnet dans .env.");
    process.exit(1);
  }

  sep("① Vérification du wallet");

  const wallet = loadWallet();
  if (!wallet) {
    console.error("❌  Aucun wallet trouvé. Lance d'abord :");
    console.error("    npx tsx scripts/generate-wallet.ts");
    process.exit(1);
  }
  const { keypair, connection } = wallet;
  console.log(`✓  Wallet   : ${keypair.publicKey.toBase58()}`);
  console.log(`✓  Réseau   : ${config.NETWORK} | RPC : ${config.SOLANA_RPC_URL}`);
  console.log(`✓  Mode     : ${LIVE && !config.DRY_RUN ? "LIVE devnet" : "DRY_RUN"}`);

  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / 1e9;
  console.log(`✓  Solde    : ${sol.toFixed(4)} SOL`);
  if (sol < 0.1) {
    console.error("❌  Solde insuffisant. Lance : npx tsx scripts/devnet-check.ts");
    process.exit(1);
  }

  if (LIVE && config.DRY_RUN) {
    console.warn("\n⚠️  --live passé mais DRY_RUN=true dans .env.");
    console.warn("   Pour exécuter réellement sur devnet, mets DRY_RUN=false dans .env.");
    console.warn("   Le script continuera en dry-run.\n");
  }

  // ── ① Scan du marché ──

  sep("② Scan du marché (Agent 1 — étage 1)");

  const market = new MeteoraClient();
  const pairs = await market.getAllPairs();
  console.log(`✓  ${pairs.length} pools récupérées`);

  const candidates = scanOpportunities(pairs, { topN: TOP_N });
  if (candidates.length === 0) {
    console.log("⚠️  Aucun candidat retenu après filtrage. Arrêt.");
    return;
  }
  console.log(`✓  ${candidates.length} candidat(s) retenu(s) :`);
  for (const c of candidates) {
    console.log(
      `   • ${c.pool.name.padEnd(20)} score=${c.score.toFixed(2)}  liq=$${(c.pool.liquidityUsd / 1000).toFixed(0)}k  apr=${c.pool.apr.toFixed(1)}%`
    );
  }

  // ── ② Analyse approfondie + risque ──

  sep("③ Analyse approfondie + Agent 2 (risque)");

  const data = new DataApiClient();
  const oracle = new PriceOracle();
  const portfolio = new Portfolio();
  const snapshot = portfolio.snapshot();

  const approvedList: {
    pool: (typeof candidates)[0]["pool"];
    sizeUsd: number;
    quoteUsd: number;
    plan: ReturnType<typeof planPosition>;
  }[] = [];

  for (const c of candidates) {
    console.log(`\n  → ${c.pool.name}`);
    try {
      const candles = await data.getOhlcv(c.pool.address, "1h", 96);
      const analysis = deepAnalyze(c, candles);
      const quoteUsd = await oracle.getUsdPrice(c.pool.mintY);
      const quoteProfile = buildQuoteProfile(c.pool.mintY, quoteUsd);
      const plan = planPosition("spot", c.pool, analysis.suggestedRange);
      const risk = assessRisk(c, analysis, snapshot, undefined, quoteProfile, plan);

      console.log(`     APR net   : ${analysis.riskAdjustedNetApr.toFixed(1)}%`);
      console.log(`     Vol annu. : ${(analysis.volatility.sigmaAnnual * 100).toFixed(0)}%`);
      console.log(`     Régime    : ${analysis.feeRegime.label}`);
      console.log(`     Verdict   : ${risk.verdict}  taille=$${risk.recommendedSizeUsd.toFixed(0)}`);
      console.log(`     Raisons   : ${risk.reasons.join(" | ")}`);

      if (risk.verdict === "APPROVE" || risk.verdict === "APPROVE_REDUCED") {
        approvedList.push({ pool: c.pool, sizeUsd: risk.recommendedSizeUsd, quoteUsd, plan });
      }
    } catch (err) {
      console.log(`     ⚠️  Erreur d'analyse : ${err instanceof Error ? err.message : err}`);
    }
  }

  if (approvedList.length === 0) {
    console.log("\n⚠️  Aucun candidat approuvé par Agent 2. Fin du test.");
    portfolio.close();
    return;
  }

  // ── ③ Exécution (dry-run ou live) ──

  sep("④ Exécution (Agent 3)");

  const executor = new RealExecutor(wallet);
  const journal = new TradeJournal();
  const manager = new LivePositionManager(wallet, oracle);

  for (const { pool, sizeUsd, quoteUsd, plan } of approvedList) {
    console.log(`\n  → ${pool.name}  $${sizeUsd.toFixed(0)}`);

    const res = await executor.openPosition({
      poolAddress: pool.address,
      sizeUsd,
      currentPrice: pool.currentPrice,
      quoteUsdPrice: quoteUsd,
      rangeLow: plan.rangeLow,
      rangeHigh: plan.rangeHigh,
    });

    console.log(`     [${res.mode}] ${res.ok ? "OK" : "REFUS"} — ${res.note}`);
    if (res.txHash) {
      console.log(`     tx : https://explorer.solana.com/tx/${res.txHash}?cluster=devnet`);
    }

    if (res.mode === "LIVE" && res.ok && res.positionPubkey) {
      manager.register({
        poolAddress: pool.address,
        poolName: pool.name,
        mintX: pool.mintX,
        mintY: pool.mintY,
        positionPubkey: res.positionPubkey,
        sizeUsd,
        openedAtSec: Math.floor(Date.now() / 1000),
      });

      // ── ⑤ Vérification on-chain ──
      console.log(`\n     Vérification on-chain de la position...`);
      await verifyPositionOnChain(connection, pool.address, res.positionPubkey);
    }
  }

  // ── Bilan ──

  sep("⑤ Bilan");

  if (LIVE && !config.DRY_RUN) {
    console.log("✅  Test LIVE devnet terminé.");
    console.log("    Prochaines étapes :");
    console.log("      npm run live        # marquer les positions (mark-to-market)");
    console.log("      npm run live --loop # tick automatique toutes les heures");
    console.log("      npm run learn       # rapport d'apprentissage Agent 5");
  } else {
    console.log("✅  Test DRY_RUN terminé (aucune transaction envoyée).");
    console.log("    Pour passer en exécution réelle devnet :");
    console.log("      1. Mets DRY_RUN=false dans ton .env");
    console.log("      2. Relance : npx tsx scripts/devnet-run.ts --live");
  }

  portfolio.close();
  journal.close();
  manager.close();
}

/**
 * Vérifie que la position créée est bien visible on-chain via le SDK.
 */
async function verifyPositionOnChain(
  connection: Connection,
  poolAddress: string,
  positionPubkey: string
): Promise<void> {
  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress), {
      cluster: "devnet",
    });
    const wallet = loadWallet()!;
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.keypair.publicKey);
    const found = userPositions.find((p) => p.publicKey.toBase58() === positionPubkey);
    if (found) {
      const bins = found.positionData.positionBinData;
      console.log(
        `     ✅  Position confirmée on-chain : bins [${bins[0]?.binId ?? "?"}–${bins[bins.length - 1]?.binId ?? "?"}]`
      );
    } else {
      console.log("     ⚠️  Position non trouvée on-chain (l'indexer peut avoir du retard).");
    }
  } catch (err) {
    console.log(
      `     ⚠️  Vérification on-chain échouée : ${err instanceof Error ? err.message : err}`
    );
  }
}

main().catch((err) => {
  console.error("\n❌  Erreur fatale :", err.message ?? err);
  process.exit(1);
});
