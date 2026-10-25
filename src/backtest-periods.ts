import { MeteoraClient } from "./data/meteoraClient.js";
import { DataApiClient } from "./data/dataApiClient.js";
import { PriceOracle, SOL_MINT, STABLE_MINTS } from "./data/priceOracle.js";
import { measureFeeConcentration } from "./data/binLiquidity.js";
import { scanOpportunities, isStablePool } from "./analytics/opportunityScanner.js";
import { quoteIsSolOrStable } from "./analytics/positionPlan.js";
import { chooseCoveredPool, spotPositionBins } from "./analytics/poolChoice.js";
import { appliedFeeFactor } from "./analytics/feeConcentration.js";
import { runBacktest } from "./backtest/backtester.js";
import { quoteUsdLookup, type QuoteUsdAt } from "./backtest/quoteHistory.js";
import { config } from "./config.js";
import type { Candle, JournalEntry, Pool, ScoredOpportunity } from "./types.js";

/**
 * Mesure de référence de la stratégie : plusieurs fenêtres de 30 jours, sans
 * anticipation (la pool de chaque token est choisie avec la volatilité mesurée
 * juste AVANT la fenêtre), décomposée en fees / IL face à la détention / marché /
 * coûts, et comparée selon le modèle de fees, les coûts et la durée de détention.
 *
 *   npm run backtest:periods             # 180 jours, 30 tokens
 *   npm run backtest:periods -- 120 20   # jours, tokens
 *
 * Le facteur de concentration est mesuré on-chain AUJOURD'HUI pour chaque pool
 * (lecture seule) puis appliqué à tout l'historique : c'est la principale limite.
 * Autres limites : pools sélectionnées aujourd'hui (biais de survie), taux de
 * fees et TVL actuels, pas de slippage modélisé au-delà du coût d'aller-retour.
 */

const WINDOW_DAYS = 30;
const BLUECHIP = /^(SOL|W?ETH|[A-Z]*BTC|ZEC|XMR|JUP|JITOSOL|MSOL|BSOL|INF|JLP)$/i;

function category(p: Pool): string {
  if (isStablePool(p)) return "stable/stable";
  const kind = BLUECHIP.test(p.baseSymbol ?? "") ? "blue chip" : "altcoin";
  return kind + (STABLE_MINTS.has(p.mintY) || STABLE_MINTS.has(p.mintX) ? "/stable" : "/SOL");
}

interface Trade {
  window: string;
  solMove: number;
  category: string;
  pool: string;
  entry: JournalEntry;
}

async function main() {
  const days = Number(process.argv[2] ?? 180);
  const tokens = Number(process.argv[3] ?? 30);
  const market = new MeteoraClient();
  const data = new DataApiClient();
  const oracle = new PriceOracle();
  const universe = await market.getAllPairs();
  const scanned: ScoredOpportunity[] = [
    ...scanOpportunities(universe, { topN: 200, minStableN: 0 }).filter((o) => quoteIsSolOrStable(o.pool)).slice(0, tokens),
    ...scanOpportunities(universe.filter(isStablePool), {
      topN: 4, minStableN: 4, minVolumeTvlRatio: 0, minRecentVolumeRatio: 0,
      verifiedOnly: false, minLiquidityUsd: 5_000, minVolume24h: 200,
    }),
  ];

  // Historique horaire (fenêtres + 96 h de chauffe pour la volatilité)
  const hours = days * 24 + 96;
  const candles = new Map<string, Candle[]>();
  const load = async (addr: string) => {
    if (!candles.has(addr)) candles.set(addr, await data.getOhlcv(addr, "1h", hours).catch(() => []));
    return candles.get(addr)!;
  };
  console.log(`▶ ${scanned.length} tokens, ${days} jours : chargement de l'historique…`);
  for (const o of scanned) {
    await load(o.pool.address);
    for (const a of o.alternatives ?? []) await load(a.address);
  }
  const solPool = universe
    .filter((p) => p.mintX === SOL_MINT && STABLE_MINTS.has(p.mintY))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]!;
  const solUsd = quoteUsdLookup(await load(solPool.address));
  const quoteAt = (mint: string): QuoteUsdAt | undefined =>
    STABLE_MINTS.has(mint) ? () => 1 : mint === SOL_MINT ? solUsd : undefined;

  // Pool choisie par token et par fenêtre (volatilité mesurée avant la fenêtre)
  const end = Math.floor(Date.now() / 1000);
  const windows = Array.from({ length: Math.floor(days / WINDOW_DAYS) }, (_, k) => ({
    start: end - (days - k * WINDOW_DAYS) * 86_400,
    end: end - (days - (k + 1) * WINDOW_DAYS) * 86_400,
  }));
  const plans: Array<{ window: (typeof windows)[number]; pool: Pool }> = [];
  for (const w of windows) {
    for (const o of scanned) {
      const before = candles.get(o.pool.address)!.filter((c) => c.timestamp < w.start).slice(-96);
      if (before.length < 48) continue; // pool trop jeune pour cette fenêtre
      try {
        plans.push({ window: w, pool: chooseCoveredPool(o, before).opportunity.pool });
      } catch {
        /* analyse impossible */
      }
    }
  }

  // Facteur de concentration mesuré on-chain (aujourd'hui) pour chaque pool retenue
  const solNow = await oracle.getUsdPrice(SOL_MINT);
  const rawFactor = new Map<string, number | null>();
  for (const p of new Map(plans.map((x) => [x.pool.address, x.pool])).values()) {
    const quoteUsd = STABLE_MINTS.has(p.mintY) ? 1 : p.mintY === SOL_MINT ? solNow : NaN;
    const recent = candles.get(p.address)!.slice(-96);
    let raw: number | null = null;
    try {
      const choice = chooseCoveredPool({ pool: p, score: 0, components: { yieldScore: 0, sustainabilityScore: 0, depthScore: 0 }, estimatedFeeApr: 0, reasons: [] }, recent);
      raw = Number.isFinite(quoteUsd) ? await measureFeeConcentration(p, quoteUsd, spotPositionBins(choice)) : null;
    } catch {
      raw = null;
    }
    rawFactor.set(p.address, raw);
    await new Promise((r) => setTimeout(r, 500)); // RPC public : rester sous la limite
  }
  const measured = [...rawFactor.values()].filter((k): k is number => k !== null).sort((a, b) => a - b);
  console.log(
    `Facteur de concentration mesuré sur ${measured.length}/${rawFactor.size} pools : médiane ` +
      `${(measured[Math.floor(measured.length / 2)] ?? 1).toFixed(2)}, plafond appliqué ${config.MAX_FEE_CONCENTRATION}\n`
  );

  const simulate = (calibrated: boolean, costPct: number, holdDays: number): Trade[] => {
    const trades: Trade[] = [];
    for (const { window: w, pool } of plans) {
      const cs = candles.get(pool.address)!.filter((c) => c.timestamp >= w.start - 48 * 3600 && c.timestamp < w.end);
      if (cs.length < 72) continue;
      const res = runBacktest(pool, cs, {
        timeframe: "1h",
        windowCandles: holdDays * 24,
        quoteUsdPrice: STABLE_MINTS.has(pool.mintY) ? 1 : solUsd(w.start) ?? 1,
        quoteUsdAt: quoteAt(pool.mintY),
        feeConcentration: calibrated ? appliedFeeFactor(rawFactor.get(pool.address)) : 1,
        tradeCostPct: costPct,
      });
      const s0 = solUsd(w.start);
      const s1 = solUsd(w.end);
      for (const entry of res.entries.filter((e) => e.decision === "ENTER")) {
        trades.push({
          window: new Date(w.start * 1000).toISOString().slice(0, 10),
          solMove: s0 && s1 ? s1 / s0 - 1 : 0,
          category: category(pool),
          pool: pool.name,
          entry,
        });
      }
    }
    return trades;
  };

  const sum = (ts: Trade[]) => {
    const total = (f: (e: JournalEntry) => number) => ts.reduce((s, t) => s + f(t.entry), 0);
    const fees = total((e) => e.feesCollectedUsd ?? 0);
    const cost = total((e) => e.tradeCostUsd ?? 0);
    const marketMove = total((e) => e.hodlChangeUsd ?? 0);
    const pnl = total((e) => e.realizedPnlUsd ?? 0);
    const size = total((e) => e.sizeUsd ?? 0);
    const il = pnl + cost - fees - marketMove;
    return { n: ts.length, fees, il, marketMove, cost, pnl, edge: fees + il - cost, size };
  };
  const usd = (v: number) => v.toFixed(0).padStart(7);
  const pct = (v: number, base: number) => `${((100 * v) / Math.max(1, base)).toFixed(2)} %`.padStart(9);

  console.log("Variante (modèle de fees, coût aller-retour, détention)   trades   fees     IL  marché  coûts    PnL  avantage net  /trade  fenêtres +");
  const variants: Array<[string, boolean, number, number]> = [
    ["base, sans coût, 1 j (ancienne mesure)", false, 0, 1],
    ["calibré, sans coût, 1 j", true, 0, 1],
    [`calibré, coût ${config.BACKTEST_TRADE_COST_PCT} %, 1 j (défaut)`, true, config.BACKTEST_TRADE_COST_PCT, 1],
    [`calibré, coût ${config.BACKTEST_TRADE_COST_PCT} %, 3 j`, true, config.BACKTEST_TRADE_COST_PCT, 3],
    [`calibré, coût ${config.BACKTEST_TRADE_COST_PCT * 2} %, 1 j`, true, config.BACKTEST_TRADE_COST_PCT * 2, 1],
    [`calibré, coût ${config.BACKTEST_TRADE_COST_PCT * 2} %, 3 j`, true, config.BACKTEST_TRADE_COST_PCT * 2, 3],
  ];
  let reference: Trade[] = [];
  for (const [label, calibrated, cost, hold] of variants) {
    const ts = simulate(calibrated, cost, hold);
    if (label.includes("(défaut)")) reference = ts;
    const a = sum(ts);
    const positiveWindows = [...new Set(ts.map((t) => t.window))].filter((w) => sum(ts.filter((t) => t.window === w)).edge > 0).length;
    const windowsCount = new Set(ts.map((t) => t.window)).size;
    console.log(
      label.padEnd(56) + String(a.n).padStart(7) + usd(a.fees) + usd(a.il) + usd(a.marketMove) + usd(a.cost) + usd(a.pnl) +
        usd(a.edge).padStart(14) + pct(a.edge, a.size) + `   ${positiveWindows}/${windowsCount}`
    );
  }

  console.log("\nVariante par défaut, par fenêtre");
  console.log("Début        SOL   trades   fees     IL  marché  coûts    PnL  avantage net  /trade");
  for (const w of [...new Set(reference.map((t) => t.window))]) {
    const ts = reference.filter((t) => t.window === w);
    const a = sum(ts);
    console.log(
      w + `${(ts[0]!.solMove * 100).toFixed(0)} %`.padStart(7) + String(a.n).padStart(8) + usd(a.fees) + usd(a.il) +
        usd(a.marketMove) + usd(a.cost) + usd(a.pnl) + usd(a.edge).padStart(14) + pct(a.edge, a.size)
    );
  }
  console.log("\nVariante par défaut, par catégorie");
  console.log("Catégorie           trades   fees     IL  marché  coûts    PnL  avantage net  /trade");
  for (const c of [...new Set(reference.map((t) => t.category))].sort()) {
    const a = sum(reference.filter((t) => t.category === c));
    console.log(
      c.padEnd(18) + String(a.n).padStart(8) + usd(a.fees) + usd(a.il) + usd(a.marketMove) + usd(a.cost) + usd(a.pnl) +
        usd(a.edge).padStart(14) + pct(a.edge, a.size)
    );
  }
  console.log(
    "\nAvantage net = fees + IL face à la détention − coûts : ce que le LP rapporte au-delà du marché." +
      "\n⚠ Facteur de concentration mesuré aujourd'hui et appliqué au passé ; pools sélectionnées aujourd'hui."
  );
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
