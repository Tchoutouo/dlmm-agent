import type { Pool, ScoredOpportunity, ScoringWeights } from "../types.js";
import { feeAprProxy, capitalTurnover } from "./feeApr.js";

/** Poids par défaut du WSM (somme = 1). Ajustables par l'agent superviseur. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  yield: 0.5, // rendement (fees/TVL)
  sustainability: 0.3, // soutenabilité (rotation du capital)
  depth: 0.2, // profondeur/sécurité (liquidité absolue)
};

/** Stablecoins Solana mainnet connus — une paire stable/stable = 0 IL. */
export const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzWqFdTx2jPvQTjTAhMcEoP1eZFSBdmrVWV3p4", // USDT
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",   // USDS
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",  // PYUSD
  "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o",  // DAI
]);

/** Vrai si les deux tokens sont des stablecoins (IL ≈ 0, range très étroit). */
export function isStablePool(pool: Pool): boolean {
  return STABLE_MINTS.has(pool.mintX) && STABLE_MINTS.has(pool.mintY);
}

export interface ScanOptions {
  weights?: ScoringWeights;
  /** Liquidité minimale pour écarter les pools illiquides/risquées (USD). */
  minLiquidityUsd?: number;
  /** Volume 24h minimal (USD) pour garantir une activité réelle. */
  minVolume24h?: number;
  /** Exiger les pools vérifiées uniquement. */
  verifiedOnly?: boolean;
  /** Nombre total d'opportunités à renvoyer. */
  topN?: number;
  /**
   * Minimum de pools stables (USDC-USDT etc.) dans le résultat.
   * Garantit une diversification : une partie du capital va en zone 0-IL.
   */
  minStableN?: number;
}

const DEFAULTS: Required<Omit<ScanOptions, "weights">> = {
  minLiquidityUsd: 10_000,
  minVolume24h: 5_000,
  verifiedOnly: true,
  topN: 10,
  minStableN: 1,
};

/**
 * Filtre puis classe les pools.
 *
 * Étapes :
 *  1. Filtrage de sécurité (blacklist, liquidité, volume, vérification).
 *  2. Calcul des métriques brutes (fee/TVL, rotation, profondeur).
 *  3. Normalisation min-max sur l'univers filtré (chaque critère -> [0,1]).
 *  4. Score pondéré (WSM) + génération d'explications lisibles.
 */
export function scanOpportunities(
  pools: Pool[],
  options: ScanOptions = {}
): ScoredOpportunity[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const opts = { ...DEFAULTS, ...options };

  // 1. Filtrage de sécurité
  const eligible = pools.filter((p) => {
    if (p.isBlacklisted) return false;
    if (opts.verifiedOnly && !p.isVerified) return false;
    if (p.liquidityUsd < opts.minLiquidityUsd) return false;
    if (p.volume24h < opts.minVolume24h) return false;
    return true;
  });

  if (eligible.length === 0) return [];

  // 2. Métriques brutes
  const metrics = eligible.map((pool) => ({
    pool,
    yieldRaw: pool.feeTvl24h > 0 ? pool.feeTvl24h : feeAprProxy(pool) / 365,
    sustainabilityRaw: capitalTurnover(pool),
    depthRaw: Math.log10(pool.liquidityUsd + 1), // log : la profondeur a un rendement décroissant
    feeApr: feeAprProxy(pool),
  }));

  // 3. Normalisation min-max par critère
  const norm = makeNormalizer(metrics);

  // 4. Scoring pondéré + explications
  const scored: ScoredOpportunity[] = metrics.map((m) => {
    const yieldScore = norm("yieldRaw", m.yieldRaw);
    const sustainabilityScore = norm("sustainabilityRaw", m.sustainabilityRaw);
    const depthScore = norm("depthRaw", m.depthRaw);

    const score =
      weights.yield * yieldScore +
      weights.sustainability * sustainabilityScore +
      weights.depth * depthScore;

    return {
      pool: m.pool,
      score,
      components: { yieldScore, sustainabilityScore, depthScore },
      estimatedFeeApr: m.feeApr,
      reasons: explain(m.pool, m.feeApr, {
        yieldScore,
        sustainabilityScore,
        depthScore,
      }),
    };
  });

  const sorted = scored.sort((a, b) => b.score - a.score);

  // Garantie de diversification stable/volatile
  if (opts.minStableN > 0) {
    const stables   = sorted.filter((s) => isStablePool(s.pool));
    const volatiles = sorted.filter((s) => !isStablePool(s.pool));
    const nStable   = Math.min(opts.minStableN, stables.length);
    const nVolatile = Math.min(opts.topN - nStable, volatiles.length);
    // Volatiles en tête, stables garantis en queue — l'agent de risque filtre ensuite
    return [...volatiles.slice(0, nVolatile), ...stables.slice(0, nStable)];
  }

  return sorted.slice(0, opts.topN);
}

type MetricKey = "yieldRaw" | "sustainabilityRaw" | "depthRaw";

/** Construit une fonction de normalisation min-max sur l'univers analysé. */
function makeNormalizer(metrics: Array<Record<MetricKey, number>>) {
  const bounds: Record<MetricKey, { min: number; max: number }> = {
    yieldRaw: minMax(metrics.map((m) => m.yieldRaw)),
    sustainabilityRaw: minMax(metrics.map((m) => m.sustainabilityRaw)),
    depthRaw: minMax(metrics.map((m) => m.depthRaw)),
  };
  return (key: MetricKey, value: number): number => {
    const { min, max } = bounds[key];
    if (max - min === 0) return 0.5; // univers homogène : score neutre
    return (value - min) / (max - min);
  };
}

function minMax(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Génère des explications lisibles — alimentent le rationale du journal. */
function explain(
  pool: Pool,
  feeApr: number,
  c: { yieldScore: number; sustainabilityScore: number; depthScore: number }
): string[] {
  const reasons: string[] = [];
  reasons.push(`Fee APR estimé ≈ ${(feeApr * 100).toFixed(1)}% (fees 24h / TVL × 365)`);

  if (c.yieldScore > 0.7) reasons.push("Rendement fees/TVL dans le haut du panier");
  else if (c.yieldScore < 0.3) reasons.push("Rendement fees/TVL faible relativement");

  if (c.sustainabilityScore > 0.7)
    reasons.push("Forte rotation du capital — fees soutenables");
  else if (c.sustainabilityScore < 0.3)
    reasons.push("Volume faible vs liquidité — fees possiblement éphémères");

  if (c.depthScore > 0.7) reasons.push("Liquidité profonde — moindre slippage/risque");
  else if (c.depthScore < 0.3) reasons.push("Liquidité fine — prudence sur la taille");

  reasons.push(`Bin step ${pool.binStep} (granularité du range)`);
  return reasons;
}
