import { MeteoraClient } from "../data/meteoraClient.js";
import { DataApiClient } from "../data/dataApiClient.js";
import { PriceOracle } from "../data/priceOracle.js";
import { Portfolio } from "../portfolio/portfolio.js";
import { TradeJournal } from "../journal/journal.js";
import { scanOpportunities } from "../analytics/opportunityScanner.js";
import { predictForwardVol } from "../ml/volatilityClient.js";
import type { OrchestratorDeps } from "./deps.js";
import { dryRunExecute } from "./deps.js";

export interface ProductionClients {
  market: MeteoraClient;
  data: DataApiClient;
  oracle: PriceOracle;
  portfolio: Portfolio;
  journal: TradeJournal;
}

/** Construit les clients réels. */
export function createClients(): ProductionClients {
  return {
    market: new MeteoraClient(),
    data: new DataApiClient(),
    oracle: new PriceOracle(),
    portfolio: new Portfolio(),
    journal: new TradeJournal(),
  };
}

/** Adapte les clients réels à l'interface OrchestratorDeps. */
export function createProductionDeps(c: ProductionClients): OrchestratorDeps {
  return {
    scanMarket: async () => scanOpportunities(await c.market.getAllPairs(), { topN: 3 }),
    getCandles: (addr) => c.data.getOhlcv(addr, "1h", 168),
    getQuoteUsdPrice: (mint) => c.oracle.getUsdPrice(mint),
    getForwardVol: async (addr, candles) => (await predictForwardVol(candles, "1h", addr))?.dailyVol ?? null,
    getSnapshot: () => c.portfolio.snapshot(),
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
    executePosition: dryRunExecute, // Agent 3 (placeholder)
  };
}
