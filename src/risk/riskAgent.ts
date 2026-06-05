import type {
  DeepAnalysis,
  PortfolioSnapshot,
  RiskAssessment,
  RiskCheck,
  RiskParams,
  RiskVerdict,
  ScoredOpportunity,
  QuoteProfile,
} from "../types.js";
import { sizePosition } from "./positionSizing.js";
import { recommendHedge } from "./hedging.js";
import { quoteStressShock } from "../analytics/quoteRisk.js";
import { config } from "../config.js";

/** Convertit les pourcentages de la config en fractions internes. */
export function riskParamsFromConfig(): RiskParams {
  return {
    maxPositionUsd: config.MAX_POSITION_USD,
    minPositionUsd: config.MIN_POSITION_USD,
    maxDrawdown: config.MAX_DRAWDOWN_PCT / 100,
    maxPortfolioExposure: config.MAX_PORTFOLIO_EXPOSURE_PCT / 100,
    maxPoolConcentration: config.MAX_POOL_CONCENTRATION_PCT / 100,
    maxPoolLiquidityShare: config.MAX_POOL_LIQUIDITY_SHARE_PCT / 100,
    riskBudgetPerTrade: config.RISK_BUDGET_PER_TRADE_PCT / 100,
    maxVolatilityAnnual: config.MAX_VOLATILITY_ANNUAL_PCT / 100,
    minNetApr: config.MIN_NET_APR_PCT / 100,
    maxStressLoss: config.MAX_STRESS_LOSS_PCT / 100,
  };
}

/**
 * Évalue le risque d'entrer dans une opportunité analysée par l'Agent 1.
 *
 * Fonction PURE (pas d'I/O) : prend une photo du portefeuille et rend un verdict
 * traçable. Ordre de décision :
 *   1. Disjoncteur drawdown  → HALT (bloque toute entrée)
 *   2. Checks de veto durs   → VETO si l'un échoue
 *   3. Dimensionnement        → VETO si taille < minimum viable
 *   4. APPROVE / APPROVE_REDUCED selon le plafond contraignant
 */
export function assessRisk(
  opportunity: ScoredOpportunity,
  analysis: DeepAnalysis,
  snapshot: PortfolioSnapshot,
  params: RiskParams = riskParamsFromConfig(),
  quoteProfile?: QuoteProfile
): RiskAssessment {
  const pool = opportunity.pool;
  const checks: RiskCheck[] = [];

  // Shock du quote en USD (0 si stable/absent) — couvre le risque SOL/USD
  const quoteShock = quoteProfile ? quoteStressShock(quoteProfile) : 0;

  // Dimensionnement (calculé tôt pour alimenter les checks et le hedge)
  const sizing = sizePosition(pool, analysis.suggestedRange, snapshot, params, quoteShock);
  const stressLossUsd = sizing.recommendedSizeUsd * sizing.stressLossPct;

  const hedge = recommendHedge(
    pool,
    analysis.suggestedRange,
    sizing.recommendedSizeUsd,
    analysis.feeRegime,
    quoteProfile
  );

  // ── 1. Disjoncteur drawdown ──
  const drawdownFrac = snapshot.drawdownPct / 100;
  if (drawdownFrac >= params.maxDrawdown) {
    return finalize(
      "HALT",
      0,
      sizing,
      stressLossUsd,
      hedge,
      [
        {
          name: "circuit_breaker",
          passed: false,
          detail: `Drawdown ${snapshot.drawdownPct.toFixed(1)}% ≥ seuil ${(
            params.maxDrawdown * 100
          ).toFixed(0)}% — entrées suspendues`,
        },
      ],
      ["DISJONCTEUR : drawdown maximal atteint, protection du capital activée"]
    );
  }
  checks.push({
    name: "circuit_breaker",
    passed: true,
    detail: `Drawdown ${snapshot.drawdownPct.toFixed(1)}% < ${(
      params.maxDrawdown * 100
    ).toFixed(0)}%`,
  });

  // ── 2. Checks de veto durs ──
  checks.push(check(
    "volatility",
    analysis.volatility.sigmaAnnual <= params.maxVolatilityAnnual,
    `Vol. annualisée ${(analysis.volatility.sigmaAnnual * 100).toFixed(0)}% vs max ${(
      params.maxVolatilityAnnual * 100
    ).toFixed(0)}%`
  ));

  checks.push(check(
    "net_apr",
    analysis.riskAdjustedNetApr >= params.minNetApr,
    `APR net ${(analysis.riskAdjustedNetApr * 100).toFixed(1)}% vs min ${(
      params.minNetApr * 100
    ).toFixed(1)}%`
  ));

  checks.push(check(
    "stress_loss",
    Math.abs(sizing.stressLossPct) <= params.maxStressLoss,
    `Perte de stress ${(sizing.stressLossPct * 100).toFixed(1)}% vs max ${(
      params.maxStressLoss * 100
    ).toFixed(0)}%`
  ));

  checks.push(check(
    "capital_available",
    sizing.caps.availableCapital! >= params.minPositionUsd,
    `Capital déployable $${sizing.caps.availableCapital!.toFixed(0)} vs min $${params.minPositionUsd}`
  ));

  checks.push(check(
    "pool_liquidity",
    sizing.caps.poolLiquidity! >= params.minPositionUsd,
    `Part de TVL autorisée $${sizing.caps.poolLiquidity!.toFixed(0)} vs min $${params.minPositionUsd}`
  ));

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return finalize(
      "VETO",
      0,
      sizing,
      stressLossUsd,
      hedge,
      checks,
      [`VETO : ${failed.map((c) => c.name).join(", ")}`, ...failed.map((c) => c.detail)]
    );
  }

  // ── 3. Taille minimale viable ──
  if (sizing.recommendedSizeUsd < params.minPositionUsd) {
    checks.push({
      name: "min_size",
      passed: false,
      detail: `Taille recommandée $${sizing.recommendedSizeUsd.toFixed(
        0
      )} < min $${params.minPositionUsd} (bridé par ${sizing.bindingCap})`,
    });
    return finalize("VETO", 0, sizing, stressLossUsd, hedge, checks, [
      `VETO : position trop petite pour être viable (plafond ${sizing.bindingCap})`,
    ]);
  }

  // ── 4. APPROVE / APPROVE_REDUCED ──
  const reduced = sizing.bindingCap !== "absolute";
  const verdict: RiskVerdict = reduced ? "APPROVE_REDUCED" : "APPROVE";
  const reasons = [
    `${verdict} : taille $${sizing.recommendedSizeUsd.toFixed(0)} (plafond ${sizing.bindingCap})`,
    `Perte de stress estimée $${stressLossUsd.toFixed(0)} (${(
      sizing.stressLossPct * 100
    ).toFixed(1)}%)`,
  ];
  if (hedge.recommended) reasons.push(hedge.note);

  return finalize(verdict, sizing.recommendedSizeUsd, sizing, stressLossUsd, hedge, checks, reasons);
}

function check(name: string, passed: boolean, detail: string): RiskCheck {
  return { name, passed, detail };
}

function finalize(
  verdict: RiskVerdict,
  size: number,
  sizing: { caps: Record<string, number>; bindingCap: string; stressLossPct: number },
  stressLossUsd: number,
  hedge: RiskAssessment["hedge"],
  checks: RiskCheck[],
  reasons: string[]
): RiskAssessment {
  return {
    verdict,
    recommendedSizeUsd: size,
    stressLossUsd: verdict === "APPROVE" || verdict === "APPROVE_REDUCED" ? stressLossUsd : 0,
    stressLossPct: sizing.stressLossPct,
    hedge,
    checks,
    sizingCaps: sizing.caps,
    bindingCap: sizing.bindingCap,
    reasons,
  };
}
