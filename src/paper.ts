import { createClients } from "./orchestration/productionDeps.js";
import { PaperBroker } from "./paper/paperBroker.js";
import { ApprovalQueue } from "./paper/approvalQueue.js";
import { paperTick, paperTickSupervised } from "./paper/paperDeps.js";

/**
 * Paper trading sur prix réels (mainnet), exécution simulée.
 *
 *   npm run paper                  # un tick autonome
 *   npm run paper -- --loop        # tick autonome toutes les heures
 *   npm run paper -- --supervised  # enfile les propositions ; le dashboard décide
 *
 * Aucune transaction réelle. Dernier filtre avant tout capital : mêmes décisions
 * qu'en réel, marquage au marché en direct, issues bouclées dans le journal.
 */
async function main() {
  const loop = process.argv.includes("--loop");
  const supervised = process.argv.includes("--supervised");
  const clients = createClients();
  const broker = new PaperBroker();
  const queue = supervised ? new ApprovalQueue() : null;

  const runOnce = async () => {
    console.log(`\n▶ Tick paper${supervised ? " (supervisé)" : ""} — ${new Date().toISOString()}`);
    const snap = broker.snapshot();
    console.log(
      `Portefeuille papier : NAV $${snap.navUsd.toFixed(0)} | ` +
        `cash $${snap.cashUsd.toFixed(0)} | positions ${snap.positions.length} | ` +
        `drawdown ${snap.drawdownPct.toFixed(1)}%`
    );
    if (queue) await paperTickSupervised(broker, clients, queue);
    else await paperTick(broker, clients);
  };

  await runOnce();

  if (loop) {
    const HOUR = 3600_000;
    console.log("\n⏳ Mode boucle : un tick par heure. Ctrl+C pour arrêter.");
    setInterval(() => runOnce().catch((e) => console.error("Erreur tick:", e.message)), HOUR);
  } else {
    clients.journal.close();
    clients.portfolio.close();
    broker.close();
    queue?.close();
  }
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
