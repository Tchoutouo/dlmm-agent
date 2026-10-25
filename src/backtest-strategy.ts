import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, STABLE_MINTS } from "./data/priceOracle.js";
import { scanOpportunities } from "./analytics/opportunityScanner.js";
import { quoteIsSolOrStable, type PositionShape } from "./analytics/positionPlan.js";
import { runBacktest } from "./backtest/backtester.js";
import { loadQuoteUsdHistory, type QuoteUsdAt } from "./backtest/quoteHistory.js";
import { computeMetrics } from "./learning/performance.js";
import { config } from "./config.js";
import type { Candle, JournalEntry, Pool } from "./types.js";

/**
 * Compare la position spot (deux côtés, centrée) et la bid-ask d'un seul côté en
 * SOL/stable, sur les mêmes pools, le même historique et les mêmes décisions.
 *
 *   npm run backtest:strategy                      # 8 meilleures pools quotées SOL/stable
 *   npm run backtest:strategy -- <addr1> <addr2>   # pools choisies
 *
 * Valorisation en USD : pools TOKEN/SOL converties avec l'historique du prix de SOL.
 */

const STRATEGIES: PositionShape[] = ["spot", "sol_bidask"];
/** [stop-loss %, take-profit %] : détention simple, puis les seuils par défaut de l'agent. */
const EXITS: Array<[number, number]> = [
  [0, 0],
  [config.STOP_LOSS_PCT, config.TAKE_PROFIT_PCT],
];
const DEFAULT_POOLS = 8;

async function main() {
  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();

  const args = process.argv.slice(2);
  const universe = await market.getAllPairs();
  const pools: Pool[] = args.length > 0
    ? await Promise.all(args.map((a) => market.getPair(a)))
    : scanOpportunities(universe, { topN: 30, minStableN: 0 })
        .map((o) => o.pool)
        .filter(quoteIsSolOrStable) // la bid-ask d'un côté exige un quote SOL/stable
        .slice(0, DEFAULT_POOLS);

  console.log(`▶ Spot vs SOL bid-ask sur ${pools.length} pool(s), ~30 jours de bougies 1h, positions de 24h max\n`);

  const quotePrices = new Map<string, number>();
  // Historique USD des quotes (SOL via la pool SOL/stable la plus profonde) : un par mint
  const quoteHistories = new Map<string, QuoteUsdAt | null>();
  const histories: Array<{ pool: Pool; candles: Candle[]; quoteUsdPrice: number; quoteUsdAt: QuoteUsdAt | null }> = [];
  for (const pool of pools) {
    try {
      const candles = await data.getOhlcv(pool.address, "1h", 720);
      if (!STABLE_MINTS.has(pool.mintY) && !quotePrices.has(pool.mintY)) {
        quotePrices.set(pool.mintY, await oracle.getUsdPrice(pool.mintY));
      }
      const quoteUsdPrice = STABLE_MINTS.has(pool.mintY) ? 1 : quotePrices.get(pool.mintY)!;
      if (!quoteHistories.has(pool.mintY)) {
        quoteHistories.set(pool.mintY, await loadQuoteUsdHistory(pool.mintY, universe, data, 720));
      }
      histories.push({ pool, candles, quoteUsdPrice, quoteUsdAt: quoteHistories.get(pool.mintY)! });
      const usd = quoteHistories.get(pool.mintY) ? "valorisé en USD" : "en unités de quote";
      console.log(`  ${pool.name.padEnd(16)} ${candles.length} bougies, ${usd}, bin step ${pool.binStep}`);
    } catch (err) {
      console.log(`  ${pool.name.padEnd(16)} ignorée : ${(err as Error).message}`);
    }
  }

  const fmt = (v: number, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d);
  console.log("\nStratégie    Sortie      Trades  Réussite  Profit f.  PnL total   Fees      Rdt moyen/pool  DD max");
  for (const [sl, tp] of EXITS) {
    for (const strategy of STRATEGIES) {
      const entries: JournalEntry[] = [];
      const returns: number[] = [];
      let worstDrawdown = 0;
      for (const h of histories) {
        const res = runBacktest(h.pool, h.candles, {
          timeframe: "1h",
          quoteUsdPrice: h.quoteUsdPrice,
        quoteUsdAt: h.quoteUsdAt ?? undefined,
          stopLossPct: sl,
          takeProfitPct: tp,
          strategy,
        });
        entries.push(...res.entries);
        returns.push(res.summary.totalReturnPct);
        worstDrawdown = Math.max(worstDrawdown, res.summary.maxDrawdownPct);
      }
      const m = computeMetrics(entries);
      const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
      const exit = sl === 0 && tp === 0 ? "détention" : `−${sl}/+${tp}%`;
      console.log(
        strategy.padEnd(13) +
          exit.padEnd(12) +
          String(m.withOutcome).padEnd(8) +
          (m.winRate === null ? "—" : `${(m.winRate * 100).toFixed(0)}%`).padEnd(10) +
          (m.profitFactor === null ? "∞" : m.profitFactor.toFixed(2)).padEnd(11) +
          `$${fmt(m.totalPnlUsd, 2)}`.padEnd(12) +
          `$${m.totalFeesUsd.toFixed(2)}`.padEnd(10) +
          `${fmt(avgReturn, 2)}%`.padEnd(16) +
          `${worstDrawdown.toFixed(1)}%`
      );
    }
  }

  console.log(
    "\n⚠ Modèle de fees prudent, sans slippage ni frais de transaction : comparer les stratégies entre elles," +
      "\n  pas lire les chiffres comme des rendements attendus. Valider en paper trading (PAPER_STRATEGY)."
  );
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
