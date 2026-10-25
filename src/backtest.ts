import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, STABLE_MINTS } from "./data/priceOracle.js";
import { runBacktest } from "./backtest/backtester.js";
import { loadQuoteUsdHistory } from "./backtest/quoteHistory.js";
import { analyzeJournal, formatReport } from "./learning/learningAgent.js";

/**
 * Backtest d'une pool sur son historique récent, puis rapport d'apprentissage.
 *
 *   npm run backtest -- <adresse_pool>
 *
 * Rappel : un backtest favorable ne garantit PAS un profit réel (surapprentissage,
 * slippage, MEV, changement de régime, modèle de fees approximatif). C'est un
 * outil d'aide à la décision, pas une promesse de rendement.
 */
async function main() {
  const address = process.argv[2];
  if (!address) {
    console.log("Usage : npm run backtest -- <adresse_pool>");
    console.log("Adresses : voir les pools retenues par npm run scan, ou https://app.meteora.ag/dlmm");
    return;
  }

  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();

  console.log(`▶ Backtest de la pool ${address}\n`);
  const pool = await market.getPair(address);
  const candles = await data.getOhlcv(address, "1h", 720); // ~30 jours
  console.log(`${pool.name} — ${candles.length} bougies 1h récupérées\n`);

  const quoteUsdPrice = STABLE_MINTS.has(pool.mintY)
    ? 1
    : await oracle.getUsdPrice(pool.mintY);

  const quoteUsdAt = await loadQuoteUsdHistory(pool.mintY, await market.getAllPairs(), data, 720);
  if (!quoteUsdAt) console.log("ℹ️  Pas d'historique USD pour le quote : valorisation en unités de quote\n");

  const { entries, summary } = runBacktest(pool, candles, {
    timeframe: "1h",
    quoteUsdPrice,
    quoteUsdAt: quoteUsdAt ?? undefined,
  });

  console.log("── Résumé du backtest ──");
  console.log(`Pas : ${summary.steps} | entrées : ${summary.entered} | skips : ${summary.skipped}`);
  console.log(
    `NAV : $${summary.initialNavUsd.toFixed(0)} → $${summary.finalNavUsd.toFixed(0)} ` +
      `(${summary.totalReturnPct >= 0 ? "+" : ""}${summary.totalReturnPct.toFixed(1)}%)`
  );
  console.log(`Drawdown max : ${summary.maxDrawdownPct.toFixed(1)}%${summary.halted ? " | DISJONCTEUR déclenché" : ""}\n`);

  console.log(formatReport(analyzeJournal(entries)));
  console.log(
    "\n⚠ Un backtest favorable ne garantit pas un profit réel. Valider en paper trading avant tout capital."
  );
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
