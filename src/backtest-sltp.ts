import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, STABLE_MINTS } from "./data/priceOracle.js";
import { scanOpportunities } from "./analytics/opportunityScanner.js";
import { runBacktest } from "./backtest/backtester.js";
import { computeMetrics } from "./learning/performance.js";
import type { Candle, JournalEntry, Pool } from "./types.js";

/**
 * Compare des couples stop-loss / take-profit sur les mêmes pools et le même historique.
 *
 *   npm run backtest:sltp                      # 8 meilleures pools du scanner
 *   npm run backtest:sltp -- <addr1> <addr2>   # pools choisies
 *
 * Chaque couple rejoue exactement les mêmes décisions d'entrée (Agent 1 + 2) ;
 * seule la règle de sortie change. TP/SL sont évalués sur les clôtures 1h
 * (un vrai stop peut glisser au-delà en intra-bougie).
 */

/** [stop-loss %, take-profit %] ; 0 = désactivé. Inclut le −4 % / +5 % de la vidéo. */
const GRID: Array<[number, number]> = [
  [0, 0],
  [4, 5],
  [4, 10],
  [8, 15], // défaut actuel de l'agent
  [8, 0],
  [0, 15],
  [15, 30],
];

const DEFAULT_POOLS = 8;

async function main() {
  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();

  const args = process.argv.slice(2);
  const pools: Pool[] = args.length > 0
    ? await Promise.all(args.map((a) => market.getPair(a)))
    : scanOpportunities(await market.getAllPairs(), { topN: DEFAULT_POOLS, minStableN: 0 }).map((o) => o.pool);

  console.log(`▶ Comparaison SL/TP sur ${pools.length} pool(s), ~30 jours de bougies 1h, positions de 24h max\n`);

  const quotePrices = new Map<string, number>(); // évite de re-solliciter Jupiter (rate limit)
  const histories: Array<{ pool: Pool; candles: Candle[]; quoteUsdPrice: number }> = [];
  for (const pool of pools) {
    try {
      const candles = await data.getOhlcv(pool.address, "1h", 720);
      if (!STABLE_MINTS.has(pool.mintY) && !quotePrices.has(pool.mintY)) {
        quotePrices.set(pool.mintY, await oracle.getUsdPrice(pool.mintY));
      }
      const quoteUsdPrice = STABLE_MINTS.has(pool.mintY) ? 1 : quotePrices.get(pool.mintY)!;
      histories.push({ pool, candles, quoteUsdPrice });
      console.log(`  ${pool.name.padEnd(16)} ${candles.length} bougies`);
    } catch (err) {
      console.log(`  ${pool.name.padEnd(16)} ignorée : ${(err as Error).message}`);
    }
  }

  const rows = GRID.map(([sl, tp]) => {
    const entries: JournalEntry[] = [];
    const returns: number[] = [];
    let worstDrawdown = 0;
    const exits = { take_profit: 0, stop_loss: 0, horizon: 0 };
    for (const h of histories) {
      const res = runBacktest(h.pool, h.candles, {
        timeframe: "1h",
        quoteUsdPrice: h.quoteUsdPrice,
        stopLossPct: sl,
        takeProfitPct: tp,
      });
      entries.push(...res.entries);
      returns.push(res.summary.totalReturnPct);
      worstDrawdown = Math.max(worstDrawdown, res.summary.maxDrawdownPct);
      for (const e of res.entries) if (e.exitReason) exits[e.exitReason]++;
    }
    const m = computeMetrics(entries);
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    return { sl, tp, m, avgReturn, worstDrawdown, exits };
  });

  const fmt = (v: number, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d);
  console.log(
    "\nSL     TP     Trades  Réussite  Profit f.  PnL total   Rdt moyen/pool  DD max   Sorties TP/SL/fin"
  );
  for (const r of rows) {
    const label = (v: number, sign: string) => (v === 0 ? "—" : `${sign}${v}%`).padEnd(7);
    console.log(
      label(r.sl, "−") +
        label(r.tp, "+") +
        String(r.m.withOutcome).padEnd(8) +
        (r.m.winRate === null ? "—" : `${(r.m.winRate * 100).toFixed(0)}%`).padEnd(10) +
        (r.m.profitFactor === null ? "∞" : r.m.profitFactor.toFixed(2)).padEnd(11) +
        `$${fmt(r.m.totalPnlUsd, 2)}`.padEnd(12) +
        `${fmt(r.avgReturn, 2)}%`.padEnd(16) +
        `${r.worstDrawdown.toFixed(1)}%`.padEnd(9) +
        `${r.exits.take_profit}/${r.exits.stop_loss}/${r.exits.horizon}`
    );
  }

  console.log(
    "\n⚠ Modèle de fees prudent, sans slippage ni frais de transaction : comparer les couples entre eux," +
      "\n  pas lire les chiffres comme des rendements attendus. Valider en paper trading."
  );
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
