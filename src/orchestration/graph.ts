import {
  StateGraph,
  Annotation,
  START,
  END,
  interrupt,
} from "@langchain/langgraph";
import type {
  DeepAnalysis,
  PortfolioSnapshot,
  QuoteProfile,
  RiskAssessment,
  ScoredOpportunity,
} from "../types.js";
import { deepAnalyze } from "../analytics/deepAnalysis.js";
import { buildQuoteProfile } from "../analytics/quoteRisk.js";
import { assessRisk } from "../risk/riskAgent.js";
import type { OrchestratorDeps, DecisionRecord } from "./deps.js";
import { config } from "../config.js";
import type { PositionPlan } from "../analytics/positionPlan.js";

export type OrchestratorMode = "autonomous" | "supervised";

/**
 * État partagé du graphe. Canaux en « remplacement » (dernière valeur) sauf
 * `decisions` qui s'accumule.
 */
const GraphState = Annotation.Root({
  mode: Annotation<OrchestratorMode>({ reducer: (_, r) => r, default: () => "autonomous" }),
  candidates: Annotation<ScoredOpportunity[]>({ reducer: (_, r) => r, default: () => [] }),
  cursor: Annotation<number>({ reducer: (_, r) => r, default: () => 0 }),
  snapshot: Annotation<PortfolioSnapshot | null>({ reducer: (_, r) => r, default: () => null }),
  analysis: Annotation<DeepAnalysis | null>({ reducer: (_, r) => r, default: () => null }),
  quoteProfile: Annotation<QuoteProfile | null>({ reducer: (_, r) => r, default: () => null }),
  risk: Annotation<RiskAssessment | null>({ reducer: (_, r) => r, default: () => null }),
  plan: Annotation<PositionPlan | null>({ reducer: (_, r) => r, default: () => null }),
  approved: Annotation<boolean>({ reducer: (_, r) => r, default: () => false }),
  halted: Annotation<boolean>({ reducer: (_, r) => r, default: () => false }),
  positionsOpened: Annotation<number>({ reducer: (_, r) => r, default: () => 0 }),
  decisions: Annotation<DecisionRecord[]>({
    reducer: (l, r) => l.concat(r),
    default: () => [],
  }),
});

type State = typeof GraphState.State;

/**
 * Construit et compile le graphe d'orchestration multi-agents.
 *
 *   scan → [analyze → risk → (halt | supervise → execute/skip | skip)] (boucle) → END
 *
 * Le superviseur (human-in-the-loop) interrompt le graphe en mode "supervised"
 * et le laisse passer en mode "autonomous". Le disjoncteur (verdict HALT de
 * l'agent de risque) coupe toute la boucle.
 */
export function buildOrchestrator(deps: OrchestratorDeps) {
  const current = (s: State) => s.candidates[s.cursor]!;

  // ── Nœuds ──

  const scan = async () => {
    const candidates = await deps.scanMarket();
    return { candidates, cursor: 0, snapshot: await deps.getSnapshot(), positionsOpened: 0 };
  };

  const analyze = async (s: State) => {
    const c = current(s);
    try {
      const candles = await deps.getCandles(c.pool.address);
      // Vol future prédite (ML), si la dépendance est branchée ; sinon undefined.
      const forwardDailyVol = deps.getForwardVol
        ? await deps.getForwardVol(c.pool.address, candles)
        : undefined;
      const analysis = deepAnalyze(c, candles, { forwardDailyVol: forwardDailyVol ?? undefined });
      const quoteUsd = await deps.getQuoteUsdPrice(c.pool.mintY);
      const quoteProfile = buildQuoteProfile(c.pool.mintY, quoteUsd);
      return { analysis, quoteProfile };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Analyse ${c.pool.name} échouée : ${msg}`);
      return { analysis: null, quoteProfile: null };
    }
  };

  const risk = (s: State) => {
    const c = current(s);
    const plan = deps.planPosition ? deps.planPosition(c, s.analysis!) : null;
    const assessment = assessRisk(
      c,
      s.analysis!,
      s.snapshot!,
      undefined,
      s.quoteProfile ?? undefined,
      plan ?? undefined
    );
    return { risk: assessment, plan };
  };

  const supervise = (s: State) => {
    const c = current(s);
    const r = s.risk!;
    if (s.mode === "supervised") {
      // Pause : la décision humaine est attendue. La reprise fournit un objet
      // { approved: boolean } (un objet, jamais un booléen nu, pour éviter que
      // `false` soit pris pour une entrée vide par LangGraph).
      const decision = interrupt({
        type: "approval_request",
        pool: c.pool.name,
        verdict: r.verdict,
        sizeUsd: r.recommendedSizeUsd,
        stressLossUsd: r.stressLossUsd,
        hedge: r.hedge.note,
        reasons: r.reasons,
      }) as { approved?: boolean } | boolean | undefined;
      const approved =
        typeof decision === "object" && decision !== null
          ? decision.approved === true
          : decision === true;
      return { approved };
    }
    return { approved: true }; // autonome : l'agent de risque a déjà filtré
  };

  const execute = async (s: State) => {
    const c = current(s);
    const r = s.risk!;
    const a = s.analysis!;
    const record: DecisionRecord = {
      poolName: c.pool.name,
      poolAddress: c.pool.address,
      decision: "ENTER",
      verdict: r.verdict,
      sizeUsd: r.recommendedSizeUsd,
      rationale: [...a.rationale, ...r.reasons].join(" | "),
      rangeLow: s.plan?.rangeLow ?? a.suggestedRange.priceLow,
      rangeHigh: s.plan?.rangeHigh ?? a.suggestedRange.priceHigh,
      estimatedIlPct: a.ilAt1Sigma,
      features: {
        shape: s.plan?.shape ?? "spot",
        feeRegime: a.feeRegime.label,
        volatilityAnnual: a.volatility.sigmaAnnual,
        binStep: c.pool.binStep,
        bindingCap: r.bindingCap,
        hedged: r.hedge.recommended,
        expectedNetApr: a.riskAdjustedNetApr,
      },
    };
    // Journaliser d'abord pour obtenir l'id, puis exécuter en le liant à l'issue.
    const journalId = deps.recordDecision(record);
    const res = await deps.executePosition(
      { candidate: c, analysis: a, risk: r, plan: s.plan ?? undefined },
      typeof journalId === "number" ? journalId : undefined
    );
    record.note = res.note; // pour le résumé en mémoire uniquement
    // Rafraîchir le snapshot + compteur pour que le prochain candidat voie
    // le capital réel et le nombre de positions déjà ouvertes ce cycle.
    const opened = res.ok ? 1 : 0;
    return {
      decisions: [record],
      snapshot: await deps.getSnapshot(),
      positionsOpened: s.positionsOpened + opened,
    };
  };

  const skip = (s: State) => {
    const c = current(s);
    const r = s.risk;
    const record: DecisionRecord = {
      poolName: c.pool.name,
      poolAddress: c.pool.address,
      decision: "SKIP",
      verdict: r?.verdict ?? null,
      sizeUsd: 0,
      rationale: r ? r.reasons.join(" | ") : "Analyse indisponible",
    };
    deps.recordDecision(record);
    return { decisions: [record] };
  };

  const halt = (s: State) => {
    const c = current(s);
    const r = s.risk!;
    const record: DecisionRecord = {
      poolName: c.pool.name,
      poolAddress: c.pool.address,
      decision: "HALT",
      verdict: r.verdict,
      sizeUsd: 0,
      rationale: r.reasons.join(" | "),
    };
    deps.recordDecision(record);
    return { halted: true, decisions: [record] };
  };

  const advance = (s: State) => ({ cursor: s.cursor + 1 });

  // ── Routeurs ──

  const afterScan = (s: State) => (s.candidates.length > 0 ? "analyze" : END);
  const afterAnalyze = (s: State) => (s.analysis ? "assess" : "skip");
  const afterRisk = (s: State) => {
    const v = s.risk!.verdict;
    if (v === "HALT") return "halt";
    if (v === "APPROVE" || v === "APPROVE_REDUCED") return "supervise";
    return "skip";
  };
  const afterSupervise = (s: State) => (s.approved ? "execute" : "skip");
  const afterAdvance = (s: State) => {
    if (s.positionsOpened >= config.MAX_POSITIONS_PER_SCAN) return END;
    return s.cursor < s.candidates.length ? "analyze" : END;
  };

  // ── Assemblage ──

  return new StateGraph(GraphState)
    .addNode("scan", scan)
    .addNode("analyze", analyze)
    .addNode("assess", risk)
    .addNode("supervise", supervise)
    .addNode("execute", execute)
    .addNode("skip", skip)
    .addNode("halt", halt)
    .addNode("advance", advance)
    .addEdge(START, "scan")
    .addConditionalEdges("scan", afterScan, ["analyze", END])
    .addConditionalEdges("analyze", afterAnalyze, ["assess", "skip"])
    .addConditionalEdges("assess", afterRisk, ["halt", "supervise", "skip"])
    .addConditionalEdges("supervise", afterSupervise, ["execute", "skip"])
    .addEdge("execute", "advance")
    .addEdge("skip", "advance")
    .addEdge("halt", END)
    .addConditionalEdges("advance", afterAdvance, ["analyze", END]);
}
