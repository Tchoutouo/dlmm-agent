/**
 * Démon autonome — combine suivi de positions + scan de marché en un seul process.
 *
 * USAGE : npm run daemon
 *
 * Cycle :
 *   - toutes les 20 min : mark + claim des fees + rebalancing + TP/SL
 *   - toutes les  1 h   : scan du marché + ouverture de nouvelles positions
 *
 * Arrêt propre : Ctrl+C
 */

import "dotenv/config";
import { loadWallet } from "../src/execution/wallet.js";
import { PriceOracle } from "../src/data/priceOracle.js";
import { TradeJournal } from "../src/journal/journal.js";
import { RealExecutor } from "../src/execution/realExecutor.js";
import { LivePositionManager } from "../src/execution/livePositionManager.js";
import { createClients, createProductionDeps } from "../src/orchestration/productionDeps.js";
import { buildOrchestrator } from "../src/orchestration/graph.js";
import { config } from "../src/config.js";
import { JobLock } from "../src/lib/jobLock.js";
import { processCloseRequests, recoverStuckCloseRequests } from "../src/execution/closeRequests.js";

const MARK_INTERVAL_MS  = 20 * 60 * 1_000;  // 20 minutes
const SCAN_INTERVAL_MS  =  1 * 60 * 60 * 1_000;  // 1 heure
const CLOSE_CHECK_INTERVAL_MS = 2 * 60 * 1_000; // 2 minutes

function ts() {
  return new Date().toISOString();
}

async function markPositions(
  manager: LivePositionManager,
  executor: RealExecutor,
  journal: TradeJournal
) {
  console.log(`\n[${ts()}] ▶ Mark-to-market`);
  await manager.markAll();
  const snap = await manager.realSnapshot();
  console.log(
    `  NAV $${snap.navUsd.toFixed(0)} | cash $${snap.cashUsd.toFixed(0)} | ` +
    `positions ${snap.positions.length} | drawdown ${snap.drawdownPct.toFixed(1)}%`
  );
  // 1. Claim des fees avant rebalancing (les fees réclamées grossissent le cash)
  const claimed = await manager.claimAllFees(executor);
  if (claimed > 0) console.log(`  +$${claimed.toFixed(2)} fees réclamées → cash disponible`);

  const rebalanced = await manager.rebalanceOutOfRange(config.REBALANCE_OUT_OF_RANGE_MIN, executor, journal);
  if (rebalanced > 0) console.log(`  ${rebalanced} position(s) rebalancée(s)`);
  const closedTP = await manager.closeAtThresholds(config.TAKE_PROFIT_PCT, config.STOP_LOSS_PCT, executor, journal);
  if (closedTP > 0) console.log(`  ${closedTP} position(s) fermée(s) par TP/SL`);
  const closed = await manager.closeDue(config.PAPER_HOLDING_DAYS, executor, journal);
  if (closed > 0) console.log(`  ${closed} position(s) clôturée(s) à échéance`);
}

async function scanMarket(clients: ReturnType<typeof createClients>) {
  console.log(`\n[${ts()}] ▶ Scan du marché`);
  const deps = createProductionDeps(clients);
  const graph = buildOrchestrator(deps).compile();
  const result = await graph.invoke({ mode: "autonomous" }, { recursionLimit: 150 });
  for (const d of result.decisions) {
    const tag = d.decision === "ENTER" ? `ENTER $${d.sizeUsd.toFixed(0)}` : d.decision;
    console.log(`  • ${d.poolName.padEnd(16)} ${tag}${d.verdict ? `  [${d.verdict}]` : ""}`);
    if (d.note) console.log(`    ${d.note}`);
    // Log raison du VETO pour comprendre les rejets de l'agent de risque
    if (d.verdict === "VETO" && d.rationale) console.log(`    ↳ ${d.rationale.slice(0, 140)}`);
  }
  if (result.halted) console.log("  ⚠ Disjoncteur activé — entrées suspendues.");
}

async function main() {
  console.log(`\n🚀 Démon DLMM démarré — réseau=${config.NETWORK} dry_run=${config.DRY_RUN}`);
  console.log(`   Mark toutes les ${MARK_INTERVAL_MS / 60_000} min | Scan toutes les ${SCAN_INTERVAL_MS / 3_600_000} h`);
  console.log("   Ctrl+C pour arrêter proprement.\n");

  const wallet = loadWallet();
  if (!wallet) {
    console.error("❌  Aucun wallet (WALLET_SECRET_KEY absent).");
    process.exit(1);
  }

  const oracle  = new PriceOracle();
  const journal = new TradeJournal();
  const executor = new RealExecutor(wallet);
  const manager  = new LivePositionManager(wallet, oracle);
  // Clients créés UNE fois et réutilisés à chaque scan (connexions SQLite, suivi live)
  const clients  = createClients();
  clients.manager = manager;

  // Un seul job on-chain à la fois : marquage, scan et clôtures signent avec le même wallet
  const lock = new JobLock();
  const run = (name: string, job: () => Promise<unknown>) =>
    lock.runExclusive(name, async () => { await job(); }).catch((e) => console.error(`Erreur ${name}:`, e.message));

  const recovered = recoverStuckCloseRequests(config.JOURNAL_DB_PATH);
  if (recovered > 0) console.log(`  ↻ ${recovered} demande(s) de clôture interrompue(s) reprise(s)`);

  // Tick immédiat au démarrage — délai entre mark et scan pour éviter les 429 RPC
  await run("marquage", () => markPositions(manager, executor, journal));
  await new Promise((r) => setTimeout(r, 10_000));
  await run("scan", () => scanMarket(clients));

  // Suivi régulier
  const markTimer = setInterval(() => void run("marquage", () => markPositions(manager, executor, journal)), MARK_INTERVAL_MS);

  // Scan périodique
  const scanTimer = setInterval(() => void run("scan", () => scanMarket(clients)), SCAN_INTERVAL_MS);

  // Clôtures manuelles (demandes du dashboard) — vérifié toutes les 2 min
  const closeTimer = setInterval(
    () => void run("clôtures demandées", () => processCloseRequests(config.JOURNAL_DB_PATH, manager, executor, journal)),
    CLOSE_CHECK_INTERVAL_MS
  );

  // Arrêt propre
  const stop = () => {
    console.log("\n⏹  Arrêt du démon...");
    clearInterval(markTimer);
    clearInterval(scanTimer);
    clearInterval(closeTimer);
    manager.close();
    journal.close();
    clients.journal.close();
    clients.portfolio.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("Erreur fatale:", err.message);
  process.exit(1);
});
