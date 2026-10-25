/**
 * Types partagés du système DLMM Agent.
 *
 * `MeteoraPair` reflète la réponse de l'endpoint
 * GET https://dlmm.datapi.meteora.ag/pools
 * (les nombres arrivent parfois en string dans l'API — on normalise au parsing).
 */

/** Fenêtres temporelles renvoyées par l'API Meteora (clés avec chiffres → bracket notation). */
export interface TimeWindowed {
  "30m"?: number;
  "1h"?: number;
  "2h"?: number;
  "4h"?: number;
  "12h"?: number;
  "24h"?: number;
}

/**
 * Pool DLMM brute telle que renvoyée par le nouveau endpoint
 * GET https://dlmm.datapi.meteora.ag/pools (structure depuis juin 2026).
 * L'ancien domaine dlmm-api.meteora.ag/pair/all est hors service.
 */
export interface MeteoraPair {
  address: string;
  name: string;
  is_blacklisted: boolean;
  tags: string[];
  token_x: {
    address: string;
    symbol: string;
    decimals: number;
    is_verified: boolean;
    price: number;
    market_cap?: number;
  };
  token_y: {
    address: string;
    symbol: string;
    decimals: number;
    is_verified: boolean;
    price: number;
    market_cap?: number;
  };
  pool_config: {
    bin_step: number;
    base_fee_pct: number;
    max_fee_pct: number;
    protocol_fee_pct: number;
    /** 0 = InputOnly (fees dans le token d'entrée du swap), 1 = OnlyY (fees en token Y). */
    collect_fee_mode?: number;
  };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  apr: number;
  apy: number;
  farm_apr: number;
  farm_apy: number;
  has_farm: boolean;
  volume: TimeWindowed;
  fees: TimeWindowed;
  protocol_fees: TimeWindowed;
  fee_tvl_ratio: TimeWindowed;
  cumulative_metrics: {
    volume: number;
    fees: number;
  };
}

/** Version normalisée (nombres garantis) utilisée par l'analytique. */
export interface Pool {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  baseFeePct: number;
  liquidityUsd: number;
  currentPrice: number;
  apr: number;
  volume24h: number;
  fees24h: number;
  feeTvl24h: number; // ratio fees/TVL sur 24h
  feeTvl1h: number;
  isVerified: boolean;
  isBlacklisted: boolean;
  /** Mint du token de base (le côté non-quote : ni SOL ni stablecoin). Absent = inconnu. */
  baseMint?: string;
  /** Symbole du token de base (détection des copies : même symbole, autre mint). */
  baseSymbol?: string;
  /** Market cap du token de base (USD). Absent = inconnu, le filtre ne s'applique pas. */
  baseMarketCapUsd?: number;
  /** Volume des 4 dernières heures (USD). Absent = inconnu, le filtre ne s'applique pas. */
  volume4h?: number;
  /** Fees versées uniquement en quote SOL/stable (mode OnlyY avec Y = SOL ou stable). */
  feesInQuote?: boolean;
}

/** Poids du modèle de score multi-critères (Weighted Scoring Model). */
export interface ScoringWeights {
  /** Rendement : poids du ratio fees/TVL. */
  yield: number;
  /** Soutenabilité : poids du volume relatif à la liquidité. */
  sustainability: number;
  /** Profondeur/sécurité : poids de la liquidité absolue. */
  depth: number;
}

/** Pool évalué et classé par l'agent d'analyse. */
export interface ScoredOpportunity {
  pool: Pool;
  score: number; // 0..1
  components: {
    yieldScore: number;
    sustainabilityScore: number;
    depthScore: number;
  };
  estimatedFeeApr: number; // APR proxy annualisé à partir des fees 24h
  reasons: string[]; // explications lisibles, alimentent le journal
}

/** Décision d'entrée/sortie/rééquilibrage tracée dans le journal. */
/**
 * ENTER = position réellement ouverte (paper ou live). DRY_RUN = entrée simulée,
 * rien d'ouvert. FAILED = entrée approuvée mais dont l'exécution a échoué.
 */
export type DecisionType = "ENTER" | "EXIT" | "REBALANCE" | "HOLD" | "SKIP" | "HALT" | "DRY_RUN" | "FAILED";

/** Bougie OHLCV renvoyée par dlmm.datapi.meteora.ag. */
export interface Candle {
  timestamp: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Intervalles supportés par l'endpoint OHLCV. */
export type Timeframe = "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

/** Profil de volatilité dérivé des bougies. */
export interface VolatilityProfile {
  timeframe: Timeframe;
  samples: number;
  /** Écart-type des log-returns close-to-close, par période. */
  sigmaPeriod: number;
  /** Volatilité annualisée (close-to-close). */
  sigmaAnnual: number;
  /** Volatilité journalière (utile pour dimensionner un range). */
  sigmaDaily: number;
  /** Estimateur de Parkinson (high/low), annualisé — plus efficace. */
  parkinsonAnnual: number;
}

/** Régime de frais déduit du rapport fee effectif / fee de base. */
export type FeeRegimeLabel = "calm" | "active" | "volatile";

export interface FeeRegime {
  label: FeeRegimeLabel;
  effectiveFeeRate: number; // fees24h / volume24h
  baseFeeRate: number; // base_fee_percentage / 100
  ratio: number; // effectif / base
}

/** Événement de volume anormal (proxy d'activité « whale »). */
export interface VolumeAnomaly {
  timestamp: number;
  volume: number;
  zScore: number;
}

/** Résultat de l'analyse approfondie (étage 2 d'Agent 1). */
export interface DeepAnalysis {
  volatility: VolatilityProfile;
  feeRegime: FeeRegime;
  anomalies: VolumeAnomaly[];
  suggestedRange: { priceLow: number; priceHigh: number };
  /** IL estimé si le prix bouge de ±1σ journalier dans le range. */
  ilAt1Sigma: number;
  /** IL estimé aux bornes du range (±2σ par construction). */
  ilAtRangeEdge: number;
  expectedFeeApr: number;
  /** APR net estimé = fees − traînée d'IL annualisée (aide à la décision). */
  riskAdjustedNetApr: number;
  rationale: string[];
}

/** Caractéristiques structurées d'une décision, pour l'analyse d'apprentissage. */
export interface DecisionFeatures {
  feeRegime?: FeeRegimeLabel;
  volatilityAnnual?: number;
  binStep?: number;
  bindingCap?: string;
  /** Couverture réellement exécutée (aucune ne l'est aujourd'hui). */
  hedged?: boolean;
  /** Couverture recommandée par l'agent de risque (non exécutée). */
  hedgeRecommended?: boolean;
  expectedNetApr?: number;
  /** Forme de la position ouverte : spot (deux côtés) ou sol_bidask (un côté). */
  shape?: "spot" | "sol_bidask";
}

export interface JournalEntry {
  id?: number;
  timestamp: string; // ISO
  poolAddress: string;
  poolName: string;
  decision: DecisionType;
  score: number;
  estimatedFeeApr: number;
  /** Capital engagé (USD), pour calculer le rendement réalisé. */
  sizeUsd?: number;
  /** Bornes du range envisagé (prix), si applicable. */
  rangeLow?: number;
  rangeHigh?: number;
  /** IL estimé au moment de la décision pour le scénario testé. */
  estimatedIlPct?: number;
  /** Caractéristiques structurées (régime, vol, etc.) pour le slicing. */
  features?: DecisionFeatures;
  /** Le « pourquoi » de la décision — moteur d'apprentissage. */
  rationale: string;
  /** Rempli a posteriori : PnL réalisé, fees récoltées, etc. */
  realizedPnlUsd?: number;
  feesCollectedUsd?: number;
  /** La position est-elle sortie de son range pendant la détention ? */
  wentOutOfRange?: boolean;
  /** Durée de détention en jours (issue). */
  holdingDays?: number;
  /** Motif de sortie (backtest) : fin de fenêtre, take-profit ou stop-loss. */
  exitReason?: "horizon" | "take_profit" | "stop_loss";
  outcomeNotes?: string;
}

// ─────────────────────────────  AGENT 2 — RISQUE  ─────────────────────────────

/** Position ouverte dans le portefeuille. */
export interface PortfolioPosition {
  poolAddress: string;
  poolName: string;
  mintX: string;
  mintY: string;
  /** Capital engagé à l'entrée (USD). */
  sizeUsd: number;
  /** Valeur courante mark-to-market (USD). */
  valueUsd: number;
}

/** Photographie de l'état du portefeuille consommée par l'agent de risque. */
export interface PortfolioSnapshot {
  navUsd: number; // valeur nette = cash + positions
  cashUsd: number;
  deployedUsd: number; // capital en positions
  peakNavUsd: number;
  drawdownPct: number; // (peak - nav) / peak × 100
  /** Perte depuis l'ouverture du jour UTC (% de la NAV d'ouverture, ≥ 0). Absent = non suivi. */
  dailyLossPct?: number;
  positions: PortfolioPosition[];
  exposureByPool: Record<string, number>; // adresse -> USD
}

/** Paramètres de risque (fractions internes, dérivés de la config en %). */
export interface RiskParams {
  maxPositionUsd: number;
  minPositionUsd: number;
  maxDrawdown: number; // fraction
  /** Perte journalière max (fraction). Absent ou 0 = désactivé. */
  maxDailyLoss?: number;
  maxPortfolioExposure: number;
  maxPoolConcentration: number;
  maxPoolLiquidityShare: number;
  riskBudgetPerTrade: number;
  maxVolatilityAnnual: number;
  minNetApr: number;
  maxStressLoss: number; // fraction (valeur positive du max toléré)
}

/** Un contrôle de risque individuel, traçable pour l'audit. */
export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Recommandation de couverture (delta hedge). */
export interface HedgeRecommendation {
  recommended: boolean;
  hedgeRatio: number; // part directionnelle ∈ [0,1]
  notionalUsd: number; // notionnel à shorter sur le token volatil
  /** Exposition au token de quote en USD (0 si quote stable). */
  quoteExposureUsd: number;
  note: string;
}

/**
 * Profil du token de quote (Y) pour la valorisation et le stress en USD.
 * Pour une paire TOKEN/USDC, isStable=true, usdPrice≈1, dailyVolUsd=0.
 * Pour une paire TOKEN/SOL, le quote (SOL) bouge en USD → on en tient compte.
 */
export interface QuoteProfile {
  mint: string;
  usdPrice: number;
  isStable: boolean;
  /** Volatilité journalière du quote en USD (fraction). 0 si stable. */
  dailyVolUsd: number;
}

export type RiskVerdict = "APPROVE" | "APPROVE_REDUCED" | "VETO" | "HALT";

/** Verdict complet et auditable de l'agent de risque. */
export interface RiskAssessment {
  verdict: RiskVerdict;
  recommendedSizeUsd: number;
  /** Perte de capital estimée au scénario de stress (USD, ≤ 0). */
  stressLossUsd: number;
  /** Perte de stress en fraction (≤ 0). */
  stressLossPct: number;
  hedge: HedgeRecommendation;
  checks: RiskCheck[];
  /** Détail des plafonds de dimensionnement (USD). */
  sizingCaps: Record<string, number>;
  bindingCap: string;
  reasons: string[];
}

// ────────────────────────  AGENT 5 — APPRENTISSAGE  ────────────────────────

/** Métriques de performance pour un groupe d'entrées de journal. */
export interface PerformanceMetrics {
  decisions: number; // décisions dans le groupe
  entered: number; // décisions ENTER
  withOutcome: number; // entrées dont l'issue est connue
  wins: number;
  winRate: number | null; // null si aucune issue
  totalPnlUsd: number;
  avgPnlUsd: number | null;
  totalFeesUsd: number;
  avgRealizedReturn: number | null; // PnL / taille, moyen
  /** Gains bruts / pertes brutes. null si aucune perte (non défini). */
  profitFactor: number | null;
}

/** Qualité de prédiction : APR net prédit vs rendement réalisé. */
export interface CalibrationResult {
  samples: number;
  avgPredictedNetApr: number | null;
  avgRealizedReturnAnnualized: number | null;
  /** Corrélation de Pearson entre prédiction et réalisé (−1..1). */
  correlation: number | null;
}

/** Erreur récurrente détectée (groupe perdant systématiquement). */
export interface ErrorPattern {
  feature: string; // ex. "regime=volatile"
  samples: number;
  winRate: number;
  avgPnlUsd: number;
  severity: "high" | "medium" | "low";
  description: string;
}

/** Suggestion d'amélioration concrète (souvent un paramètre). */
export interface Suggestion {
  area: string;
  recommendation: string;
  rationale: string;
}

/** Rapport complet produit par l'agent d'apprentissage. */
export interface LearningReport {
  overall: PerformanceMetrics;
  byRegime: Record<string, PerformanceMetrics>;
  byPool: Record<string, PerformanceMetrics>;
  byVerdict: Record<string, PerformanceMetrics>;
  calibration: CalibrationResult;
  recurringErrors: ErrorPattern[];
  suggestions: Suggestion[];
}
