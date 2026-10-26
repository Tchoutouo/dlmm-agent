import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, STABLE_MINTS } from "./data/priceOracle.js";
import { scanOpportunities } from "./analytics/opportunityScanner.js";
import { quoteIsSolOrStable } from "./analytics/positionPlan.js";
import { chooseCoveredPool } from "./analytics/poolChoice.js";
import { runBacktest } from "./backtest/backtester.js";
import { loadQuoteUsdHistory, type QuoteUsdAt } from "./backtest/quoteHistory.js";
import { riskParamsFromConfig } from "./risk/riskAgent.js";
import type { Candle, JournalEntry, Pool } from "./types.js";

/**
 * Compare le choix de pool : la plus profonde (ancien comportement) contre celle
 * dont le bin step couvre le mieux la volatilité (chooseCoveredPool), avec ou
 * sans veto de couverture (MIN_RANGE_COVERAGE_PCT).
 *
 *   npm run backtest:pools            # 14 meilleurs tokens du scanner
 *   npm run backtest:pools -- 20      # nombre de tokens
 *
 * Décompose le PnL : fees, IL face à la simple détention (propre au LP),
 * mouvement du marché (ce que tout détenteur aurait subi). L'« avantage LP »
 * = fees + IL : positif, le LP bat la simple détention.
 *
 * Limite : la pool est choisie avec la volatilité d'aujourd'hui puis rejouée sur
 * 30 jours (léger biais d'anticipation) ; une seule période de marché.
 */
async function main() {
  const tokens = Number(process.argv[2] ?? 14);
  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();
  const universe = await market.getAllPairs();
  const scanned = scanOpportunities(universe, { topN: 60, minStableN: 0 })
    .filter((o) => quoteIsSolOrStable(o.pool))
    .slice(0, tokens);

  const candles = new Map<string, Candle[]>();
  const getCandles = async (addr: string) => {
    if (!candles.has(addr)) candles.set(addr, await data.getOhlcv(addr, "1h", 720));
    return candles.get(addr)!;
  };
  const quotePrice = new Map<string, number>();
  const quoteHistory = new Map<string, QuoteUsdAt | null>();
  const loadQuote = async (mint: string) => {
    if (!quotePrice.has(mint)) quotePrice.set(mint, STABLE_MINTS.has(mint) ? 1 : await oracle.getUsdPrice(mint));
    if (!quoteHistory.has(mint)) quoteHistory.set(mint, await loadQuoteUsdHistory(mint, universe, data, 720));
  };

  console.log(`▶ Choix de pool sur ${scanned.length} tokens, ~30 jours de bougies 1h\n`);
  console.log("Token             pool la plus profonde    → pool la mieux couverte");
  const pairs: Array<{ deep: Pool; best: Pool }> = [];
  for (const o of scanned) {
    try {
      const deepCandles = await getCandles(o.pool.address);
      const deepChoice = chooseCoveredPool({ ...o, alternatives: undefined }, deepCandles.slice(-96));
      const choice = chooseCoveredPool(o, deepCandles.slice(-96)); // vol du token, fees de chaque pool
      const best = choice.opportunity.pool;
      if (best.address !== o.pool.address) await getCandles(best.address);
      await loadQuote(o.pool.mintY);
      await loadQuote(best.mintY);
      pairs.push({ deep: o.pool, best });
      console.log(
        o.pool.name.padEnd(18) +
          `bs${o.pool.binStep} couv ${deepChoice.coverage.toFixed(2)}`.padEnd(25) +
          "→ " +
          (best.address === o.pool.address
            ? "(identique)"
            : `${best.name} bs${best.binStep} couv ${choice.coverage.toFixed(2)} tvl ${(best.liquidityUsd / 1e3).toFixed(0)}k`)
      );
    } catch (err) {
      console.log(`${o.pool.name.padEnd(18)}ignoré : ${(err as Error).message.slice(0, 60)}`);
    }
  }

  const scenario = (label: string, pick: (x: { deep: Pool; best: Pool }) => Pool, minCoverage: number) => {
    const params = { ...riskParamsFromConfig(), minRangeCoverage: minCoverage };
    const entries: JournalEntry[] = [];
    const returns: number[] = [];
    for (const x of pairs) {
      const p = pick(x);
      const res = runBacktest(p, candles.get(p.address)!, {
        timeframe: "1h",
        params,
        quoteUsdPrice: quotePrice.get(p.mintY),
        quoteUsdAt: quoteHistory.get(p.mintY) ?? undefined,
      });
      entries.push(...res.entries.filter((e) => e.decision === "ENTER"));
      returns.push(res.summary.totalReturnPct);
    }
    const sum = (f: (e: JournalEntry) => number) => entries.reduce((s, e) => s + f(e), 0);
    const fees = sum((e) => e.feesCollectedUsd ?? 0);
    const pnl = sum((e) => e.realizedPnlUsd ?? 0);
    const marketMove = sum((e) => e.hodlChangeUsd ?? 0);
    const il = pnl - fees - marketMove;
    const avg = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const n = (v: number) => v.toFixed(1).padStart(9);
    console.log(
      label.padEnd(42) + String(entries.length).padStart(6) + n(fees) + n(il) + n(marketMove) + n(pnl) + n(fees + il) +
        `${avg.toFixed(2)} %`.padStart(10)
    );
  };

  console.log("\nScénario                                  trades     fees  IL/hold   marché      PnL avant.LP  rdt/pool");
  scenario("pool la plus profonde, sans veto (ancien)", (x) => x.deep, 0);
  scenario("pool la plus profonde, veto couv < 50 %", (x) => x.deep, 0.5);
  scenario("pool la mieux couverte, sans veto", (x) => x.best, 0);
  scenario("pool la mieux couverte, veto < 50 % (défaut)", (x) => x.best, 0.5);
  scenario("pool la mieux couverte, veto < 80 %", (x) => x.best, 0.8);

  console.log(
    "\nAvantage LP = fees + IL face à la détention : ce que le LP apporte au-delà du marché." +
      "\n⚠ Fees modélisées sans boost de concentration ; une seule période ; aucun slippage ni frais de transaction."
  );
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
