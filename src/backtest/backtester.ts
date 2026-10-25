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
import { feeShareOfVolume, trailingFeeApr } from "../analytics/feeApr.js";
import { deepAnalyze } from "../analytics/deepAnalysis.js";
import { buildQuoteProfile } from "../analytics/quoteRisk.js";
import { assessRisk, riskParamsFromConfig } from "../risk/riskAgent.js";
import { simulatePosition } from "./positionSimulator.js";
import { config } from "../config.js";
import { planPosition, recentDropPct, type DipRule, type PositionShape } from "../analytics/positionPlan.js";
import type { QuoteUsdAt } from "./quoteHistory.js";

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
  /** Forme des positions simulées (défaut spot). */
  strategy?: PositionShape;
  /**
   * Facteur de concentration des fees de la pool (mesuré on-chain, plafonné par
   * appliedFeeFactor). 1 par défaut : modèle de base « part de TVL ».
   */
  feeConcentration?: number;
  /** Coût d'un aller-retour en % de la taille (défaut BACKTEST_TRADE_COST_PCT). */
  tradeCostPct?: number;
  /** Historique du prix USD du quote (valorisation USD des pools TOKEN/SOL). */
  quoteUsdAt?: QuoteUsdAt;
  /**
   * N'entrer qu'après une chute récente (avec strategy sol_bidask : jouer le
   * rebond). Sans chute suffisante, aucune position n'est ouverte à ce pas.
   */
  dipRule?: DipRule;
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

    // Règle de chute : on surveille chaque bougie et on n'analyse qu'après une
    // baisse suffisante (bougie courante incluse), sans rien journaliser sinon.
    if (options.dipRule) {
      const drop = recentDropPct([...trailing, now], options.dipRule.lookbackCandles + 1);
      if (drop < options.dipRule.minDropPct) {
        steps--;
        advance = 1;
        continue;
      }
    }

    const opportunity: ScoredOpportunity = {
      pool: poolNow,
      score: 0.5,
      components: { yieldScore: 0.5, sustainabilityScore: 0.5, depthScore: 0.5 },
      estimatedFeeApr: trailingFeeApr(poolNow, trailing, candleSeconds) * (options.feeConcentration ?? 1),
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

    const plan = planPosition(options.strategy ?? "spot", poolNow, analysis.suggestedRange);
    const risk = assessRisk(opportunity, analysis, snapshot, params, quoteProfile, plan);
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
        range: { priceLow: plan.rangeLow, priceHigh: plan.rangeHigh },
        shape: plan.shape,
        binStep: pool.binStep,
        quoteUsdEntry: options.quoteUsdAt?.(now.timestamp),
        quoteUsdPath: options.quoteUsdAt ? forward.map((c) => options.quoteUsdAt!(c.timestamp)) : undefined,
        feeAprAnnual: opportunity.estimatedFeeApr,
        feeShareOfVolume: feeShareOfVolume(pool),
        feeConcentration: options.feeConcentration,
        tradeCostPct: options.tradeCostPct ?? config.BACKTEST_TRADE_COST_PCT,
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
      e.hodlChangeUsd = sim.hodlChangeUsd;
      e.tradeCostUsd = sim.tradeCostUsd;
      e.rangeLow = plan.rangeLow;
      e.rangeHigh = plan.rangeHigh;
      entries.push(e);
    } else {
      skipped++;
      if (options.dipRule) advance = 1; // chute refusée par le risque : on reguette la suivante
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
      hedged: false, // la couverture n'est pas simulée
      hedgeRecommended: risk.hedge.recommended,
      expectedNetApr: analysis.riskAdjustedNetApr,
    },
    rationale: [...analysis.rationale, ...risk.reasons].join(" | "),
  };
}
