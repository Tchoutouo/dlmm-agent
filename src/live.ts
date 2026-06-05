import { TradeJournal } from "./journal/journal.js";
import { PriceOracle } from "./data/priceOracle.js";
import { loadWallet } from "./execution/wallet.js";
import { RealExecutor } from "./execution/realExecutor.js";
import { LivePositionManager } from "./execution/livePositionManager.js";
import { config } from "./config.js";

/**
 * Tick de cycle de vie des positions RÉELLES (on-chain) :
 *   1. marque chaque position ouverte d'après son état on-chain ;
 *   2. clôture (via l'exécuteur réel, donc le garde-fou) celles à échéance, et
 *      boucle l'issue réelle dans le journal → Agent 5.
 *
 *   npm run live           # un tick
 *   npm run live -- --loop # tick toutes les heures
 *
 * Le marquage est en lecture seule (sûr même en DRY_RUN). La clôture respecte le
 * garde-fou : en DRY_RUN elle est seulement construite, donc le suivi reste ouvert.
 */
async function main() {
  const loop = process.argv.includes("--loop");
  const wallet = loadWallet();
  if (!wallet) {
    console.log("Aucun wallet (WALLET_SECRET_KEY absent) — rien à gérer.");
    return;
  }
  const oracle = new PriceOracle();
  const journal = new TradeJournal();
  const executor = new RealExecutor(wallet);
  const manager = new LivePositionManager(wallet, oracle);

  const runOnce = async () => {
    console.log(`\n▶ Cycle de vie — ${new Date().toISOString()} (réseau=${config.NETWORK})`);
    await manager.markAll();
    const snap = await manager.realSnapshot();
    console.log(
      `NAV réel $${snap.navUsd.toFixed(0)} (cash on-chain $${snap.cashUsd.toFixed(0)}) | positions ${snap.positions.length} | drawdown ${snap.drawdownPct.toFixed(1)}%`
    );
    const closed = await manager.closeDue(config.PAPER_HOLDING_DAYS, executor, journal);
    if (closed > 0) console.log(`${closed} position(s) clôturée(s)`);
  };

  await runOnce();

  if (loop) {
    console.log("\n⏳ Mode boucle : un tick par heure. Ctrl+C pour arrêter.");
    setInterval(() => runOnce().catch((e) => console.error("Erreur tick:", e.message)), 3600_000);
  } else {
    manager.close();
    journal.close();
  }
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
