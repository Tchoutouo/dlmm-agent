import { scanOpportunities } from "../analytics/opportunityScanner.js";
import { feeAprProxy } from "../analytics/feeApr.js";
import { deepAnalyze } from "../analytics/deepAnalysis.js";
import { buildQuoteProfile } from "../analytics/quoteRisk.js";
import { assessRisk } from "../risk/riskAgent.js";
import { buildOrchestrator } from "../orchestration/graph.js";
import type { OrchestratorDeps } from "../orchestration/deps.js";
import type { ProductionClients } from "../orchestration/productionDeps.js";
import { PaperBroker } from "./paperBroker.js";
import { ApprovalQueue } from "./approvalQueue.js";
import { predictForwardVol } from "../ml/volatilityClient.js";
import { config } from "../config.js";
import { planPosition } from "../analytics/positionPlan.js";
import { chooseCoveredPool } from "../analytics/poolChoice.js";
import { MAX_PRICE_DEVIATION } from "../execution/realExecutor.js";
import { priceDeviation } from "../execution/executionMath.js";
import type { DeepAnalysis, ScoredOpportunity } from "../types.js";

/**
 * Deps de l'orchestrateur en mode PAPER : le snapshot et l'exécution viennent du
 * broker papier. `executePosition` ouvre une position simulée liée à l'entrée du
 * journal (via journalId) pour que l'issue y soit bouclée à la clôture.
 */
export function createPaperDeps(broker: PaperBroker, c: ProductionClients): OrchestratorDeps {
  return {
    scanMarket: async () => scanOpportunities(await c.market.getAllPairs(), { topN: 5 }),
    getCandles: (addr) => c.data.getOhlcv(addr, "1h", 168),
    getQuoteUsdPrice: (mint) => c.oracle.getUsdPrice(mint),
    getForwardVol: async (addr, candles) => (await predictForwardVol(candles, "1h", addr))?.dailyVol ?? null,
    getSnapshot: () => broker.snapshot(),
    amendDecision: (id, decision, note) => c.journal.amendDecision(id, decision, note),
    planPosition: (cand, analysis) => planPosition(config.PAPER_STRATEGY, cand.pool, analysis.suggestedRange),
    recordDecision: (d) =>
      c.journal.record({
        timestamp: new Date().toISOString(),
        poolAddress: d.poolAddress,
        poolName: d.poolName,
        decision: d.decision,
        score: 0,
        estimatedFeeApr: d.features?.expectedNetApr ?? 0,
        sizeUsd: d.sizeUsd,
        rangeLow: d.rangeLow,
        rangeHigh: d.rangeHigh,
        estimatedIlPct: d.estimatedIlPct,
        features: d.features,
        rationale: d.rationale,
      }),
    executePosition: async (proposal, journalId) => {
      const { candidate, analysis, risk } = proposal;
      const plan = proposal.plan ?? planPosition(config.PAPER_STRATEGY, candidate.pool, analysis.suggestedRange);
      const quoteUsdEntry = await c.oracle.getUsdPrice(candidate.pool.mintY).catch(() => undefined);
      broker.open({
        journalId,
        poolAddress: candidate.pool.address,
        poolName: candidate.pool.name,
        mintX: candidate.pool.mintX,
        mintY: candidate.pool.mintY,
        sizeUsd: risk.recommendedSizeUsd,
        entryPrice: candidate.pool.currentPrice,
        rangeLow: plan.rangeLow,
        rangeHigh: plan.rangeHigh,
        feeAprAnnual: feeAprProxy(candidate.pool),
        nowSec: Math.floor(Date.now() / 1000),
        shape: plan.shape,
        binStep: candidate.pool.binStep,
        quoteUsdEntry,
      });
      return {
        ok: true,
        note: `PAPER : position simulée ouverte ($${risk.recommendedSizeUsd.toFixed(0)}, ${plan.shape})`,
        mode: "PAPER",
      };
    },
  };
}

/**
 * Marque les positions vivantes au prix courant et clôture celles à échéance.
 * Partagé par les ticks autonome et supervisé.
 */
export async function manageLivePositions(broker: PaperBroker, c: ProductionClients): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const open = broker.listOpen();
  if (open.length === 0) return;

  const priceByAddr: Record<string, number> = {};
  for (const pos of open) {
    if (priceByAddr[pos.poolAddress] !== undefined) continue;
    try {
      const pool = await c.market.getPair(pos.poolAddress);
      priceByAddr[pos.poolAddress] = pool.currentPrice;
    } catch {
      /* prix indisponible */
    }
  }
  const priceOf = (addr: string) => priceByAddr[addr];
  // Prix USD des quotes (un seul appel groupé) : valorisation USD des pools TOKEN/SOL
  const quoteUsd = await c.oracle.getUsdPrices([...new Set(open.map((p) => p.mintY))]).catch(() => ({}));
  const quoteUsdOf = (mint: string) => (quoteUsd as Record<string, number>)[mint];
  broker.markAll(priceOf, nowSec, quoteUsdOf);
  const closed = broker.closeDue(priceOf, nowSec, config.PAPER_HOLDING_DAYS, c.journal, quoteUsdOf);
  console.log(`Positions vivantes : ${open.length} marquées, ${closed} clôturées`);
}

/**
 * Un tick de paper trading AUTONOME :
 *   1. gère les positions vivantes (marquage + clôture des échues) ;
 *   2. exécute le graphe de décision pour ouvrir d'éventuelles nouvelles positions.
 */
export async function paperTick(broker: PaperBroker, c: ProductionClients): Promise<void> {
  await manageLivePositions(broker, c);
  const deps = createPaperDeps(broker, c);
  const graph = buildOrchestrator(deps).compile();
  const result = await graph.invoke({ mode: "autonomous" });
  const enters = result.decisions.filter((d) => d.decision === "ENTER").length;
  console.log(`Décisions : ${result.decisions.length} (${enters} nouvelles entrées papier)`);
}

/**
 * Ouvre les propositions APPROUVÉES par l'humain, après revalidation complète.
 *
 * Une approbation porte sur un prix et un portefeuille datés. Avant d'ouvrir :
 *  - expirée (> APPROVAL_TTL_MIN depuis sa création) → abandonnée ;
 *  - prix actuel à plus de 3 % du prix approuvé → abandonnée (l'humain a validé
 *    une autre situation) ;
 *  - nouvelle analyse + agent de risque sur le portefeuille COURANT (disjoncteurs,
 *    plafonds cumulés avec les ouvertures de ce tick) → abandonnée si refusée ;
 *  - au plus MAX_POSITIONS_PER_SCAN ouvertures par tick (les suivantes attendent).
 * La taille ouverte = min(taille approuvée, taille revalidée), au prix courant.
 */
export async function openApprovedProposals(
  broker: PaperBroker,
  c: ProductionClients,
  queue: ApprovalQueue,
  now: Date = new Date()
): Promise<{ opened: number; expired: number }> {
  const nowSec = Math.floor(now.getTime() / 1000);
  let opened = 0;
  let expired = queue.expireStale(config.APPROVAL_TTL_MIN, now);

  const approved = queue.listByStatus("APPROVED").sort((a, b) => a.id - b.id);
  for (const a of approved) {
    if (opened >= config.MAX_POSITIONS_PER_SCAN) break; // les suivantes attendent le prochain tick

    let candidate: ScoredOpportunity;
    let analysis: DeepAnalysis;
    let quoteUsd: number;
    try {
      const fresh = await c.market.getPair(a.poolAddress);
      candidate = {
        pool: fresh,
        score: 0,
        components: { yieldScore: 0, sustainabilityScore: 0, depthScore: 0 },
        estimatedFeeApr: feeAprProxy(fresh),
        reasons: [],
      };
      analysis = deepAnalyze(candidate, await c.data.getOhlcv(fresh.address, "1h", 168));
      quoteUsd = await c.oracle.getUsdPrice(fresh.mintY);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⏭️  ${a.poolName} : revalidation impossible (${msg.slice(0, 60)}) — nouvel essai au prochain tick`);
      continue;
    }

    const pool = candidate.pool;
    const drift = priceDeviation(pool.currentPrice, a.entryPrice);
    if (drift > MAX_PRICE_DEVIATION) {
      queue.markExpired(a.id, `prix ${(drift * 100).toFixed(1)} % loin du prix approuvé — à revalider`);
      expired++;
      continue;
    }

    const plan = planPosition(config.PAPER_STRATEGY, pool, analysis.suggestedRange);
    const risk = assessRisk(candidate, analysis, broker.snapshot(), undefined, buildQuoteProfile(pool.mintY, quoteUsd), plan);
    if (risk.verdict !== "APPROVE" && risk.verdict !== "APPROVE_REDUCED") {
      queue.markExpired(a.id, `refusée à la revalidation : ${risk.verdict} — ${risk.reasons.join(" | ").slice(0, 160)}`);
      expired++;
      continue;
    }

    const sizeUsd = Math.min(a.sizeUsd, risk.recommendedSizeUsd);
    const jid = c.journal.record({
      timestamp: now.toISOString(),
      poolAddress: pool.address,
      poolName: pool.name,
      decision: "ENTER",
      score: 0,
      estimatedFeeApr: analysis.riskAdjustedNetApr,
      sizeUsd,
      rangeLow: plan.rangeLow,
      rangeHigh: plan.rangeHigh,
      estimatedIlPct: analysis.ilAt1Sigma,
      features: {
        feeRegime: analysis.feeRegime.label,
        volatilityAnnual: analysis.volatility.sigmaAnnual,
        binStep: pool.binStep,
        bindingCap: risk.bindingCap,
        hedged: false, // aucune couverture n'est exécutée
        hedgeRecommended: risk.hedge.recommended,
        expectedNetApr: analysis.riskAdjustedNetApr,
        shape: plan.shape,
      },
      rationale: `[approuvé, revalidé] ${[...analysis.rationale, ...risk.reasons].join(" | ")}`,
    });
    broker.open({
      journalId: jid,
      poolAddress: pool.address,
      poolName: pool.name,
      mintX: pool.mintX,
      mintY: pool.mintY,
      sizeUsd,
      entryPrice: pool.currentPrice,
      rangeLow: plan.rangeLow,
      rangeHigh: plan.rangeHigh,
      feeAprAnnual: feeAprProxy(pool),
      nowSec,
      shape: plan.shape,
      binStep: pool.binStep,
      quoteUsdEntry: quoteUsd,
    });
    queue.markExecuted(a.id, `ouverte $${sizeUsd.toFixed(2)} au prix ${pool.currentPrice.toPrecision(6)}`);
    opened++;
  }
  for (const r of queue.listByStatus("REJECTED")) queue.markExecuted(r.id, "rejetée par l'humain");
  return { opened, expired };
}

/**
 * Un tick de paper trading SUPERVISÉ (human-in-the-loop via la file) :
 *   1. ouvre les approbations APPROUVÉES, après revalidation (openApprovedProposals) ;
 *   2. gère les positions vivantes ;
 *   3. analyse le marché et ENFILE les entrées approuvées par le risque, sans
 *      les ouvrir — le dashboard décide. Une pool déjà proposée n'est pas
 *      reproposée tant que sa proposition est en jeu.
 */
export async function paperTickSupervised(
  broker: PaperBroker,
  c: ProductionClients,
  queue: ApprovalQueue
): Promise<void> {
  // 1. Ouvrir les approbations validées par l'humain, revalidées
  const { opened, expired } = await openApprovedProposals(broker, c, queue);
  if (opened > 0) console.log(`${opened} approbation(s) ouverte(s)`);
  if (expired > 0) console.log(`${expired} proposition(s) expirée(s) ou refusée(s) à la revalidation`);

  // 2. Gérer les positions vivantes
  await manageLivePositions(broker, c);

  // 3. Analyser et enfiler (sans ouvrir)
  const pools = await c.market.getAllPairs();
  const candidates = scanOpportunities(pools, { topN: 5 });
  const snapshot = broker.snapshot();
  let queued = 0;
  for (const scanned of candidates) {
    try {
      const candles = await c.data.getOhlcv(scanned.pool.address, "1h", 168);
      // Pool du token dont le bin step couvre le mieux la volatilité
      const { opportunity: cand, analysis } = chooseCoveredPool(scanned, candles);
      if (queue.hasOpenProposal(cand.pool.address)) continue; // déjà proposée, en attente
      const quoteProfile = buildQuoteProfile(cand.pool.mintY, await c.oracle.getUsdPrice(cand.pool.mintY));
      const plan = planPosition(config.PAPER_STRATEGY, cand.pool, analysis.suggestedRange);
      const risk = assessRisk(cand, analysis, snapshot, undefined, quoteProfile, plan);
      if (risk.verdict === "APPROVE" || risk.verdict === "APPROVE_REDUCED") {
        queue.enqueue({
          poolAddress: cand.pool.address,
          poolName: cand.pool.name,
          mintX: cand.pool.mintX,
          mintY: cand.pool.mintY,
          entryPrice: cand.pool.currentPrice,
          rangeLow: plan.rangeLow,
          rangeHigh: plan.rangeHigh,
          sizeUsd: risk.recommendedSizeUsd,
          feeAprAnnual: feeAprProxy(cand.pool),
          verdict: risk.verdict,
          volAnnual: analysis.volatility.sigmaAnnual,
          regime: analysis.feeRegime.label,
          expectedNetApr: analysis.riskAdjustedNetApr,
          binStep: cand.pool.binStep,
          hedged: risk.hedge.recommended,
          rationale: [...analysis.rationale, ...risk.reasons].join(" | "),
        });
        c.journal.record({
          timestamp: new Date().toISOString(),
          poolAddress: cand.pool.address,
          poolName: cand.pool.name,
          decision: "HOLD",
          score: cand.score,
          estimatedFeeApr: analysis.riskAdjustedNetApr,
          rationale: "[en attente d'approbation]",
        });
        queued++;
      }
    } catch {
      /* OHLCV indisponible */
    }
  }
  console.log(`${queued} proposition(s) en attente d'approbation`);
}
