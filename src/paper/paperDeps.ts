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
      const plan = planPosition(config.PAPER_STRATEGY, candidate.pool, analysis.suggestedRange);
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
 * Un tick de paper trading SUPERVISÉ (human-in-the-loop via la file) :
 *   1. ouvre les approbations résolues APPROVED du tick précédent ;
 *   2. gère les positions vivantes ;
 *   3. analyse le marché et ENFILE les entrées approuvées par le risque, sans
 *      les ouvrir — le dashboard décide. Les rejets sont simplement classés.
 */
export async function paperTickSupervised(
  broker: PaperBroker,
  c: ProductionClients,
  queue: ApprovalQueue
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Ouvrir les approbations validées par l'humain
  let opened = 0;
  for (const a of queue.listByStatus("APPROVED")) {
    const jid = c.journal.record({
      timestamp: new Date().toISOString(),
      poolAddress: a.poolAddress,
      poolName: a.poolName,
      decision: "ENTER",
      score: 0,
      estimatedFeeApr: a.expectedNetApr,
      sizeUsd: a.sizeUsd,
      rangeLow: a.rangeLow,
      rangeHigh: a.rangeHigh,
      features: {
        feeRegime: a.regime as never,
        volatilityAnnual: a.volAnnual,
        binStep: a.binStep,
        hedged: a.hedged,
        expectedNetApr: a.expectedNetApr,
      },
      rationale: `[approuvé] ${a.rationale}`,
    });
    broker.open({
      journalId: jid,
      poolAddress: a.poolAddress,
      poolName: a.poolName,
      mintX: a.mintX,
      mintY: a.mintY,
      sizeUsd: a.sizeUsd,
      entryPrice: a.entryPrice,
      rangeLow: a.rangeLow,
      rangeHigh: a.rangeHigh,
      feeAprAnnual: a.feeAprAnnual,
      nowSec,
      // La file ne stocke pas la forme : un range qui s'arrête au prix d'entrée est une bid-ask d'un côté
      shape: a.rangeHigh <= a.entryPrice ? "sol_bidask" : "spot",
      binStep: a.binStep,
      quoteUsdEntry: await c.oracle.getUsdPrice(a.mintY).catch(() => undefined),
    });
    queue.markExecuted(a.id);
    opened++;
  }
  for (const a of queue.listByStatus("REJECTED")) queue.markExecuted(a.id);
  if (opened > 0) console.log(`${opened} approbation(s) ouverte(s)`);

  // 2. Gérer les positions vivantes
  await manageLivePositions(broker, c);

  // 3. Analyser et enfiler (sans ouvrir)
  const pools = await c.market.getAllPairs();
  const candidates = scanOpportunities(pools, { topN: 5 });
  const snapshot = broker.snapshot();
  let queued = 0;
  for (const cand of candidates) {
    try {
      const candles = await c.data.getOhlcv(cand.pool.address, "1h", 168);
      const analysis = deepAnalyze(cand, candles);
      const quoteProfile = buildQuoteProfile(cand.pool.mintY, await c.oracle.getUsdPrice(cand.pool.mintY));
      const risk = assessRisk(cand, analysis, snapshot, undefined, quoteProfile);
      if (risk.verdict === "APPROVE" || risk.verdict === "APPROVE_REDUCED") {
        const plan = planPosition(config.PAPER_STRATEGY, cand.pool, analysis.suggestedRange);
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
