import type {
  Candle,
  JournalEntry,
  Pool,
  PortfolioSnapshot,
  RiskParams,
  ScoredOpportunity,
  Timeframe,
} from "../types.js";
import { TIMEFRAME_SECONDS } from "../data/dataApiClient.js";
import { feeAprProxy } from "../analytics/feeApr.js";
import { deepAnalyze } from "../analytics/deepAnalysis.js";
import { buildQuoteProfile } from "../analytics/quoteRisk.js";
import { assessRisk, riskParamsFromConfig } from "../risk/riskAgent.js";
import { simulatePosition } from "./positionSimulator.js";

export interface BacktestOptions {
  timeframe?: Timeframe;
  /** Bougies de l'historique utilisées pour estimer la volatilité à chaque pas. */
  lookbackCandles?: number;
  /** Durée de détention d'une position, en bougies (= pas de rééquilibrage). */
  windowCandles?: number;
  initialCashUsd?: number;
  params?: RiskParams;
  /** Prix USD du quote (1 si stable). */
  quoteUsdPrice?: number;
  /** Sortie anticipée à +X % de PnL (0/absent = détention jusqu'à la fin de la fenêtre). */
  takeProfitPct?: number;
  /** Sortie anticipée à −X % de PnL (0/absent = pas de stop). */
  stopLossPct?: number;
}

export interface BacktestSummary {
  steps: number;
  entered: number;
  skipped: number;
  halted: boolean;
  initialNavUsd: number;
  finalNavUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
}

export interface BacktestResult {
  entries: JournalEntry[];
  summary: BacktestSummary;
}

/**
 * Backtest walk-forward d'UNE pool sur son historique de bougies.
 *
 * À chaque pas : on estime la volatilité sur les bougies passées, on rejoue
 * l'analyse (Agent 1) et le risque (Agent 2) sur l'état courant, et si l'entrée
 * est approuvée on simule la position sur la fenêtre suivante. Le NAV évolue au
 * fil des trades (compounding), ce qui teste aussi le disjoncteur de drawdown.
 *
 * Les sorties sont des JournalEntry complètes (avec issues + features) :
 * elles s'analysent directement avec analyzeJournal() (Agent 5).
 */
export function runBacktest(pool: Pool, candles: Candle[], options: BacktestOptions = {}): BacktestResult {
  const timeframe = options.timeframe ?? "1h";
  const lookback = options.lookbackCandles ?? 48;
  const window = options.windowCandles ?? 24;
  const params = options.params ?? riskParamsFromConfig();
  const candleSeconds = TIMEFRAME_SECONDS[timeframe];
  const quoteUsdPrice = options.quoteUsdPrice ?? 1;

  const entries: JournalEntry[] = [];
  let nav = options.initialCashUsd ?? 1000;
  const initialNav = nav;
  let peak = nav;
  let maxDrawdown = 0;
  let entered = 0;
  let skipped = 0;
  let halted = false;
  let steps = 0;

  // Pas suivant : fin de la fenêtre, ou dès la sortie anticipée (TP/SL) pour ne pas
  // laisser le capital inactif jusqu'à la fin de la fenêtre.
  let advance = window;
  for (let i = lookback; i + window <= candles.length; i += advance) {
    advance = window;
    steps++;
    const trailing = candles.slice(i - lookback, i);
    const now = candles[i]!;
    const poolNow: Pool = { ...pool, currentPrice: now.close };

    const opportunity: ScoredOpportunity = {
      pool: poolNow,
      score: 0.5,
      components: { yieldScore: 0.5, sustainabilityScore: 0.5, depthScore: 0.5 },
      estimatedFeeApr: feeAprProxy(poolNow),
      reasons: [],
    };

    let analysis;
    try {
      analysis = deepAnalyze(opportunity, trailing, { timeframe });
    } catch {
      continue; // pas assez de bougies pour la volatilité
    }

    const quoteProfile = buildQuoteProfile(pool.mintY, quoteUsdPrice);

    if (nav > peak) peak = nav;
    const drawdownPct = peak > 0 ? ((peak - nav) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdownPct);

    const snapshot: PortfolioSnapshot = {
      navUsd: nav,
      cashUsd: nav,
      deployedUsd: 0,
      peakNavUsd: peak,
      drawdownPct,
      positions: [],
      exposureByPool: {},
    };

    const risk = assessRisk(opportunity, analysis, snapshot, params, quoteProfile);
    const ts = now.timestamp ? new Date(now.timestamp * 1000).toISOString() : new Date().toISOString();

    if (risk.verdict === "HALT") {
      halted = true;
      entries.push(baseEntry(poolNow, "HALT", opportunity, analysis, risk, ts));
      break; // disjoncteur : on stoppe le backtest
    }

    if (risk.verdict === "APPROVE" || risk.verdict === "APPROVE_REDUCED") {
      const forward = candles.slice(i, i + window);
      const sim = simulatePosition({
        entryPrice: now.close,
        sizeUsd: risk.recommendedSizeUsd,
        range: analysis.suggestedRange,
        feeAprAnnual: opportunity.estimatedFeeApr,
        forwardCandles: forward,
        candleSeconds,
        takeProfitPct: options.takeProfitPct,
        stopLossPct: options.stopLossPct,
      });
      nav += sim.realizedPnlUsd;
      entered++;
      advance = Math.max(1, Math.round((sim.holdingDays * 86_400) / candleSeconds));

      const e = baseEntry(poolNow, "ENTER", opportunity, analysis, risk, ts);
      e.sizeUsd = risk.recommendedSizeUsd;
      e.realizedPnlUsd = sim.realizedPnlUsd;
      e.feesCollectedUsd = sim.feesEarnedUsd;
      e.wentOutOfRange = sim.wentOutOfRange;
      e.holdingDays = sim.holdingDays;
      e.exitReason = sim.exitReason;
      entries.push(e);
    } else {
      skipped++;
      entries.push(baseEntry(poolNow, "SKIP", opportunity, analysis, risk, ts));
    }
  }

  if (nav > peak) peak = nav;
  maxDrawdown = Math.max(maxDrawdown, peak > 0 ? ((peak - nav) / peak) * 100 : 0);

  return {
    entries,
    summary: {
      steps,
      entered,
      skipped,
      halted,
      initialNavUsd: initialNav,
      finalNavUsd: nav,
      totalReturnPct: ((nav - initialNav) / initialNav) * 100,
      maxDrawdownPct: maxDrawdown,
    },
  };
}

function baseEntry(
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
      hedged: risk.hedge.recommended,
      expectedNetApr: analysis.riskAdjustedNetApr,
    },
    rationale: [...analysis.rationale, ...risk.reasons].join(" | "),
  };
}
