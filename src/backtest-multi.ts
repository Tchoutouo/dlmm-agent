import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, STABLE_MINTS } from "./data/priceOracle.js";
import { runMultiBacktest, type PoolSeries } from "./backtest/multiBacktester.js";
import { analyzeJournal, formatReport } from "./learning/learningAgent.js";

/**
 * Backtest multi-pools avec capital partagé.
 *
 *   npm run backtest:multi -- <addr1> <addr2> <addr3> ...
 *
 * Teste l'allocation entre pools concurrentes et le respect des plafonds
 * d'exposition/concentration au niveau du portefeuille.
 */
async function main() {
  const addresses = process.argv.slice(2);
  if (addresses.length === 0) {
    console.log("Usage : npm run backtest:multi -- <addr1> <addr2> ...");
    return;
  }

  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();

  console.log(`▶ Backtest multi-pools (${addresses.length})\n`);
  const series: PoolSeries[] = [];
  const quoteUsdPrices: Record<string, number> = {};

  for (const addr of addresses) {
    const pool = await market.getPair(addr);
    const candles = await data.getOhlcv(addr, "1h", 720);
    series.push({ pool, candles });
    if (!STABLE_MINTS.has(pool.mintY) && quoteUsdPrices[pool.mintY] === undefined) {
      quoteUsdPrices[pool.mintY] = await oracle.getUsdPrice(pool.mintY);
    }
    console.log(`  ${pool.name.padEnd(16)} ${candles.length} bougies`);
  }

  const { entries, summary } = runMultiBacktest(series, { timeframe: "1h", quoteUsdPrices });

  console.log("\n── Résumé ──");
  console.log(`Pools : ${summary.pools} | pas : ${summary.steps} | entrées : ${summary.entered} | skips : ${summary.skipped}`);
  console.log(`Positions concurrentes max : ${summary.maxConcurrentPositions}`);
  console.log(
    `NAV : $${summary.initialNavUsd.toFixed(0)} → $${summary.finalNavUsd.toFixed(0)} ` +
      `(${summary.totalReturnPct >= 0 ? "+" : ""}${summary.totalReturnPct.toFixed(1)}%)`
  );
  console.log(`Drawdown max : ${summary.maxDrawdownPct.toFixed(1)}%${summary.halted ? " | DISJONCTEUR" : ""}\n`);

  console.log(formatReport(analyzeJournal(entries)));
  console.log("\n⚠ Backtest = aide à la décision, pas une promesse de rendement. Paper trading avant tout capital.");
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
