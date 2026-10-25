import type {
  Candle,
  DeepAnalysis,
  DecisionType,
  DecisionFeatures,
  PortfolioSnapshot,
  RiskAssessment,
  RiskVerdict,
  ScoredOpportunity,
} from "../types.js";
import type { PositionPlan } from "../analytics/positionPlan.js";

/** Proposition complète passée à l'exécution / au superviseur. */
export interface Proposal {
  candidate: ScoredOpportunity;
  analysis: DeepAnalysis;
  /** Forme et range évalués par le risque (absent = spot sur le range suggéré). */
  plan?: PositionPlan;
  risk: RiskAssessment;
}

/** Décision finale tracée pour le résumé de run et le journal. */
export interface DecisionRecord {
  poolName: string;
  poolAddress: string;
  decision: DecisionType;
  verdict: RiskVerdict | null;
  sizeUsd: number;
  rationale: string;
  note?: string;
  rangeLow?: number;
  rangeHigh?: number;
  estimatedIlPct?: number;
  features?: DecisionFeatures;
}

/**
 * Dépendances de l'orchestrateur, injectées pour découpler le graphe des I/O.
 * En production : MeteoraClient, DataApiClient, PriceOracle, Portfolio, Journal.
 * En test : des stubs en mémoire (ni réseau ni SQLite).
 */
export interface OrchestratorDeps {
  scanMarket(): Promise<ScoredOpportunity[]>;
  getCandles(poolAddress: string): Promise<Candle[]>;
  getQuoteUsdPrice(mint: string): Promise<number>;
  getSnapshot(): PortfolioSnapshot;
  /**
   * Optionnel : forme et range de la position qui sera ouverte (ex. bid-ask d'un
   * côté). Absent = spot sur le range suggéré par l'analyse.
   */
  planPosition?(candidate: ScoredOpportunity, analysis: DeepAnalysis): PositionPlan;
  /** Optionnel (couche ML) : vol journalière future prédite pour dimensionner le range. */
  getForwardVol?(poolAddress: string, candles: Candle[]): Promise<number | null>;
  /** Persiste la décision ; renvoie l'id du journal si applicable. */
  recordDecision(record: DecisionRecord): number | void;
  /** Agent 3 (exécution). `journalId` permet de lier l'issue à la décision. */
  executePosition(proposal: Proposal, journalId?: number): Promise<{ ok: boolean; note: string }>;
}

/**
 * Exécution factice (dry-run) : ne signe AUCUNE transaction. Sert de point
 * d'extension pour l'agent d'exécution réel (SDK @meteora-ag/dlmm) en Phase 2.
 */
export async function dryRunExecute(
  proposal: Proposal,
  _journalId?: number
): Promise<{ ok: boolean; note: string }> {
  const { candidate, risk, analysis } = proposal;
  const note =
    `DRY_RUN : ouverture simulée de $${risk.recommendedSizeUsd.toFixed(0)} ` +
    `dans ${candidate.pool.name} ` +
    `range [${analysis.suggestedRange.priceLow.toFixed(4)}, ${analysis.suggestedRange.priceHigh.toFixed(4)}]`;
  return { ok: true, note };
}
