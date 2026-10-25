import type { Pool, ScoredOpportunity, ScoringWeights } from "../types.js";
import { feeAprProxy, capitalTurnover } from "./feeApr.js";
import { config } from "../config.js";

/** Poids par défaut du WSM (somme = 1). Ajustables par l'agent superviseur. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  yield: 0.5, // rendement (fees/TVL)
  sustainability: 0.3, // soutenabilité (rotation du capital)
  depth: 0.2, // profondeur/sécurité (liquidité absolue)
};

/** Stablecoins Solana mainnet connus — une paire stable/stable = 0 IL. */
export const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
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
  /** Volume 24h / TVL minimal (0 = désactivé). */
  minVolumeTvlRatio?: number;
  /** Market cap minimale du token de base, USD (0 = désactivé). */
  minMarketCapUsd?: number;
  /** Volume 4h extrapolé à 24h / volume 24h minimal (0 = désactivé). */
  minRecentVolumeRatio?: number;
  /** Ne garder qu'une pool par token de base : celle à la plus grosse TVL. */
  onePoolPerToken?: boolean;
  /** Bonus de score (0..1) des pools à fees versées en SOL/stable (0 = aucun). */
  quoteFeesBonus?: number;
  /** Écarter les copies : même symbole qu'un token à plus grosse market cap. */
  excludeTokenCopies?: boolean;
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
  minVolumeTvlRatio: config.MIN_VOLUME_TVL_RATIO,
  minMarketCapUsd: config.MIN_MARKET_CAP_USD,
  minRecentVolumeRatio: config.MIN_RECENT_VOLUME_RATIO,
  onePoolPerToken: true,
  quoteFeesBonus: config.QUOTE_FEES_SCORE_BONUS,
  excludeTokenCopies: config.EXCLUDE_TOKEN_COPIES,
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

  // Copies détectées sur tout l'univers fourni (avant les autres filtres, pour
  // reconnaître l'original même s'il est lui-même écarté ensuite)
  const copies = opts.excludeTokenCopies ? findTokenCopies(pools) : new Set<string>();

  // 1. Filtrage de sécurité (les champs absents = inconnus → filtre non appliqué)
  const filtered = pools.filter((p) => {
    if (p.isBlacklisted) return false;
    if (p.baseMint && copies.has(p.baseMint)) return false;
    if (opts.verifiedOnly && !p.isVerified) return false;
    if (p.liquidityUsd < opts.minLiquidityUsd) return false;
    if (p.volume24h < opts.minVolume24h) return false;
    if (capitalTurnover(p) < opts.minVolumeTvlRatio) return false;
    if (
      opts.minMarketCapUsd > 0 &&
      !isStablePool(p) &&
      p.baseMarketCapUsd !== undefined &&
      p.baseMarketCapUsd < opts.minMarketCapUsd
    ) return false;
    if (
      p.volume4h !== undefined &&
      p.volume24h > 0 &&
      (p.volume4h * 6) / p.volume24h < opts.minRecentVolumeRatio
    ) return false;
    return true;
  });
  const eligible = opts.onePoolPerToken ? keepDeepestPoolPerToken(filtered) : filtered;

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

    const wsm =
      weights.yield * yieldScore +
      weights.sustainability * sustainabilityScore +
      weights.depth * depthScore;
    // Bonus fees en quote, en restant dans [0,1] : score = (1−b)·WSM + b·[fees en quote]
    const b = opts.quoteFeesBonus;
    const score = (1 - b) * wsm + (m.pool.feesInQuote ? b : 0);

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

/**
 * Mints « copies » : tokens dont le symbole est aussi porté par un autre mint à
 * plus grosse market cap (l'original). Sans market cap connue, pas de verdict.
 */
export function findTokenCopies(pools: Pool[]): Set<string> {
  const original = new Map<string, { mint: string; mcap: number }>(); // symbole → mint dominant
  const mcapOf = new Map<string, number>();
  for (const p of pools) {
    if (!p.baseMint || !p.baseSymbol || p.baseMarketCapUsd === undefined || isStablePool(p)) continue;
    mcapOf.set(p.baseMint, p.baseMarketCapUsd);
    const key = p.baseSymbol.trim().toUpperCase();
    const cur = original.get(key);
    if (!cur || p.baseMarketCapUsd > cur.mcap) original.set(key, { mint: p.baseMint, mcap: p.baseMarketCapUsd });
  }
  const copies = new Set<string>();
  for (const p of pools) {
    if (!p.baseMint || !p.baseSymbol || !mcapOf.has(p.baseMint)) continue;
    const orig = original.get(p.baseSymbol.trim().toUpperCase());
    if (orig && orig.mint !== p.baseMint) copies.add(p.baseMint);
  }
  return copies;
}

/**
 * Une seule pool par token de base : celle à la plus grosse TVL (plus de volume,
 * donc plus de fees). Évite d'empiler plusieurs pools du même token.
 * Les stables et les pools sans token de base connu sont conservées telles quelles.
 */
function keepDeepestPoolPerToken(pools: Pool[]): Pool[] {
  const best = new Map<string, Pool>();
  const rest: Pool[] = [];
  for (const p of pools) {
    if (!p.baseMint || isStablePool(p)) {
      rest.push(p);
      continue;
    }
    const cur = best.get(p.baseMint);
    if (!cur || p.liquidityUsd > cur.liquidityUsd) best.set(p.baseMint, p);
  }
  return [...best.values(), ...rest];
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

  if (pool.feesInQuote) reasons.push("Fees versées en SOL/stable (ne suivent pas le memecoin)");
  reasons.push(`Bin step ${pool.binStep} (granularité du range)`);
  return reasons;
}
