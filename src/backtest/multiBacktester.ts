import type {
  Candle,
  JournalEntry,
  Pool,
  PortfolioPosition,
  PortfolioSnapshot,
  RiskParams,
  ScoredOpportunity,
  Timeframe,
} from "../types.js";
import { TIMEFRAME_SECONDS } from "../data/dataApiClient.js";
import { feeShareOfVolume, trailingFeeApr } from "../analytics/feeApr.js";
import { deepAnalyze } from "../analytics/deepAnalysis.js";
import { buildQuoteProfile } from "../analytics/quoteRisk.js";
import { assessRisk, riskParamsFromConfig } from "../risk/riskAgent.js";
import { simulatePosition } from "./positionSimulator.js";
import { config } from "../config.js";

export interface PoolSeries {
  pool: Pool;
  candles: Candle[];
}

export interface MultiBacktestOptions {
  timeframe?: Timeframe;
  lookbackCandles?: number;
  windowCandles?: number;
  initialCashUsd?: number;
  params?: RiskParams;
  /** Prix USD par mint de quote (défaut 1 = stable). */
  quoteUsdPrices?: Record<string, number>;
}

export interface MultiBacktestSummary {
  pools: number;
  steps: number;
  entered: number;
  skipped: number;
  halted: boolean;
  initialNavUsd: number;
  finalNavUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  maxConcurrentPositions: number;
}

export interface MultiBacktestResult {
  entries: JournalEntry[];
  summary: MultiBacktestSummary;
}

/**
 * Backtest walk-forward sur PLUSIEURS pools avec un PORTEFEUILLE PARTAGÉ.
 *
 * À chaque pas de rééquilibrage :
 *  1. on calcule le NAV et le drawdown (positions du pas précédent réalisées) ;
 *  2. le disjoncteur peut stopper l'ouverture (HALT) ;
 *  3. on analyse toutes les pools (Agent 1), on classe par APR net ajusté ;
 *  4. on alloue séquentiellement (Agent 2) : chaque ouverture réduit le capital
 *     disponible vu par les pools suivantes → les plafonds d'exposition et de
 *     concentration s'appliquent VRAIMENT entre pools.
 *
 * Les positions s'ouvrent au pas t et se réalisent au pas t+window ; leur PnL
 * revient au cash pour le pas suivant (compounding).
 */
export function runMultiBacktest(
  series: PoolSeries[],
  options: MultiBacktestOptions = {}
): MultiBacktestResult {
  const timeframe = options.timeframe ?? "1h";
  const lookback = options.lookbackCandles ?? 48;
  const window = options.windowCandles ?? 24;
  const params = options.params ?? riskParamsFromConfig();
  const candleSeconds = TIMEFRAME_SECONDS[timeframe];
  const quotePrices = options.quoteUsdPrices ?? {};

  // Aligne les pools sur les timestamps communs
  const { timeline, aligned } = alignSeries(series);

  const entries: JournalEntry[] = [];
  let cash = options.initialCashUsd ?? 1000;
  const initialNav = cash;
  let peak = cash;
  let maxDrawdown = 0;
  let entered = 0;
  let skipped = 0;
  let halted = false;
  let steps = 0;
  let maxConcurrent = 0;

  for (let i = lookback; i + window < timeline.length; i += window) {
    steps++;
    const nav = cash; // début de pas : tout est liquide
    if (nav > peak) peak = nav;
    const drawdownPct = peak > 0 ? ((peak - nav) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdownPct);

    // 1. Disjoncteur
    if (drawdownPct / 100 >= params.maxDrawdown) {
      halted = true;
      const ts = isoAt(timeline[i]);
      entries.push({
        timestamp: ts,
        poolAddress: "portfolio",
        poolName: "PORTFOLIO",
        decision: "HALT",
        score: 0,
        estimatedFeeApr: 0,
        rationale: `Disjoncteur : drawdown ${drawdownPct.toFixed(1)}% ≥ seuil`,
      });
      break;
    }

    // 2. Analyse de toutes les pools à ce pas
    const analyzed: Array<{
      idx: number;
      poolNow: Pool;
      opportunity: ScoredOpportunity;
      analysis: ReturnType<typeof deepAnalyze>;
    }> = [];
    for (let p = 0; p < aligned.length; p++) {
      const candles = aligned[p]!;
      const trailing = candles.slice(i - lookback, i);
      const now = candles[i]!;
      const poolNow: Pool = { ...series[p]!.pool, currentPrice: now.close };
      const opportunity: ScoredOpportunity = {
        pool: poolNow,
        score: 0.5,
        components: { yieldScore: 0.5, sustainabilityScore: 0.5, depthScore: 0.5 },
        estimatedFeeApr: trailingFeeApr(poolNow, trailing, candleSeconds),
        reasons: [],
      };
      try {
        const analysis = deepAnalyze(opportunity, trailing, { timeframe });
        analyzed.push({ idx: p, poolNow, opportunity, analysis });
      } catch {
        /* pas assez de bougies */
      }
    }

    // 3. Classement par APR net ajusté (les meilleurs servis en premier)
    analyzed.sort((a, b) => b.analysis.riskAdjustedNetApr - a.analysis.riskAdjustedNetApr);

    // 4. Allocation séquentielle avec portefeuille partagé mutable
    let deployed = 0;
    const exposureByPool: Record<string, number> = {};
    const openPositions: PortfolioPosition[] = [];
    let stepPnl = 0;
    let concurrent = 0;

    for (const a of analyzed) {
      const snapshot: PortfolioSnapshot = {
        navUsd: nav,
        cashUsd: nav - deployed,
        deployedUsd: deployed,
        peakNavUsd: peak,
        drawdownPct,
        positions: openPositions,
        exposureByPool,
      };
      const quoteProfile = buildQuoteProfile(a.poolNow.mintY, quotePrices[a.poolNow.mintY] ?? 1);
      const risk = assessRisk(a.opportunity, a.analysis, snapshot, params, quoteProfile);
      const ts = isoAt(timeline[i]);

      if (risk.verdict === "APPROVE" || risk.verdict === "APPROVE_REDUCED") {
        const forward = aligned[a.idx]!.slice(i, i + window);
        const sim = simulatePosition({
          entryPrice: a.poolNow.currentPrice,
          sizeUsd: risk.recommendedSizeUsd,
          range: a.analysis.suggestedRange,
          feeAprAnnual: a.opportunity.estimatedFeeApr,
          feeShareOfVolume: feeShareOfVolume(a.poolNow),
          tradeCostPct: config.BACKTEST_TRADE_COST_PCT,
          forwardCandles: forward,
          candleSeconds,
        });
        deployed += risk.recommendedSizeUsd;
        exposureByPool[a.poolNow.address] = (exposureByPool[a.poolNow.address] ?? 0) + risk.recommendedSizeUsd;
        openPositions.push({
          poolAddress: a.poolNow.address,
          poolName: a.poolNow.name,
          mintX: a.poolNow.mintX,
          mintY: a.poolNow.mintY,
          sizeUsd: risk.recommendedSizeUsd,
          valueUsd: risk.recommendedSizeUsd,
        });
        stepPnl += sim.realizedPnlUsd;
        concurrent++;
        entered++;

        const e = makeEntry(a.poolNow, "ENTER", a.opportunity, a.analysis, risk, ts);
        e.sizeUsd = risk.recommendedSizeUsd;
        e.realizedPnlUsd = sim.realizedPnlUsd;
        e.feesCollectedUsd = sim.feesEarnedUsd;
        e.wentOutOfRange = sim.wentOutOfRange;
        e.holdingDays = sim.holdingDays;
        entries.push(e);
      } else {
        skipped++;
        entries.push(makeEntry(a.poolNow, "SKIP", a.opportunity, a.analysis, risk, ts));
      }
    }

    maxConcurrent = Math.max(maxConcurrent, concurrent);
    cash = nav + stepPnl; // PnL réalisé revient au cash pour le pas suivant
  }

  if (cash > peak) peak = cash;
  maxDrawdown = Math.max(maxDrawdown, peak > 0 ? ((peak - cash) / peak) * 100 : 0);

  return {
    entries,
    summary: {
      pools: series.length,
      steps,
      entered,
      skipped,
      halted,
      initialNavUsd: initialNav,
      finalNavUsd: cash,
      totalReturnPct: ((cash - initialNav) / initialNav) * 100,
      maxDrawdownPct: maxDrawdown,
      maxConcurrentPositions: maxConcurrent,
    },
  };
}

/** Aligne plusieurs séries de bougies sur leurs timestamps communs. */
function alignSeries(series: PoolSeries[]): { timeline: number[]; aligned: Candle[][] } {
  if (series.length === 0) return { timeline: [], aligned: [] };
  const maps = series.map((s) => {
    const m = new Map<number, Candle>();
    for (const c of s.candles) m.set(c.timestamp, c);
    return m;
  });
  // Timestamps présents dans TOUTES les pools
  const common = [...maps[0]!.keys()]
    .filter((ts) => maps.every((m) => m.has(ts)))
    .sort((a, b) => a - b);
  const aligned = maps.map((m) => common.map((ts) => m.get(ts)!));
  return { timeline: common, aligned };
}

function isoAt(ts?: number): string {
  return ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();
}

function makeEntry(
  pool: Pool,
  decision: JournalEntry["decision"],
  opp: ScoredOpportunity,
  analysis: ReturnType<typeof deepAnalyze>,
  risk: ReturnType<typeof assessRisk>,
  timestamp: string
): JournalEntry {
  return {
    timestamp,
    poolAddress: pool.address,
    poolName: pool.name,
    decision,
    score: opp.score,
    estimatedFeeApr: opp.estimatedFeeApr,
    rangeLow: analysis.suggestedRange.priceLow,
    rangeHigh: analysis.suggestedRange.priceHigh,
    estimatedIlPct: analysis.ilAt1Sigma,
    features: {
      feeRegime: analysis.feeRegime.label,
      volatilityAnnual: analysis.volatility.sigmaAnnual,
      binStep: pool.binStep,
      bindingCap: risk.bindingCap,
      hedged: false, // la couverture n'est pas simulée
      hedgeRecommended: risk.hedge.recommended,
      expectedNetApr: analysis.riskAdjustedNetApr,
    },
    rationale: [...analysis.rationale, ...risk.reasons].join(" | "),
  };
}
