import { z } from "zod";
import "dotenv/config";

/**
 * Configuration validée au démarrage. Par défaut tout est en lecture seule :
 * - réseau devnet
 * - mode DRY_RUN actif (aucune transaction réelle)
 * On force le passage explicite en mainnet + écriture pour engager du capital.
 */
const schema = z.object({
  // Unique point d'entrée de l'API Meteora depuis juin 2026.
  // L'ancien dlmm-api.meteora.ag est hors service — pools + OHLCV sur le même domaine.
  METEORA_DATA_API_BASE: z.string().url().default("https://dlmm.datapi.meteora.ag"),
  // Source de prix USD des tokens (Jupiter Price API V3).
  JUPITER_PRICE_API: z.string().url().default("https://lite-api.jup.ag/price/v3"),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  DRY_RUN: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  JOURNAL_DB_PATH: z.string().default("./data/journal.db"),
  // Garde-fous de risque (Agent 2)
  MAX_POSITION_USD: z.coerce.number().positive().default(100),
  MIN_POSITION_USD: z.coerce.number().positive().default(10),
  MAX_DRAWDOWN_PCT: z.coerce.number().min(0).max(100).default(15),
  MAX_PORTFOLIO_EXPOSURE_PCT: z.coerce.number().min(0).max(100).default(80),
  MAX_POOL_CONCENTRATION_PCT: z.coerce.number().min(0).max(100).default(25),
  MAX_POOL_LIQUIDITY_SHARE_PCT: z.coerce.number().min(0).max(100).default(1),
  RISK_BUDGET_PER_TRADE_PCT: z.coerce.number().min(0).max(100).default(2),
  MAX_VOLATILITY_ANNUAL_PCT: z.coerce.number().positive().default(400),
  MIN_NET_APR_PCT: z.coerce.number().default(5),
  MAX_STRESS_LOSS_PCT: z.coerce.number().min(0).max(100).default(40),
  // Vol. journalière USD supposée du quote non-stable (ex. SOL) si pas de série de réf.
  QUOTE_DAILY_VOL_PCT: z.coerce.number().min(0).default(5),
  INITIAL_CASH_USD: z.coerce.number().positive().default(1000),
  // Durée de détention d'une position (jours) : clôture paper/live à l'échéance, et
  // horizon du scénario d'IL de l'analyse (IL à ±1σ√h, annualisé sur h jours).
  PAPER_HOLDING_DAYS: z.coerce.number().positive().default(1),
  // Exécution réelle (Agent 3) — désactivée par défaut, devnet only sans ACK explicite.
  WALLET_SECRET_KEY: z.string().optional(), // base58 ; NE JAMAIS committer
  ACKNOWLEDGE_REAL_FUNDS: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  DLMM_RANGE_BINS: z.coerce.number().int().positive().default(10),
  // Couche ML (prédiction de volatilité) — optionnelle, désactivée par défaut.
  ML_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  ML_SERVICE_URL: z.string().default("http://localhost:8000"),
  // Sorties automatiques de positions (0 = désactivé)
  TAKE_PROFIT_PCT: z.coerce.number().min(0).default(15),
  STOP_LOSS_PCT: z.coerce.number().min(0).default(8),
  // Rebalancing : ferme + rouvre au prix courant si hors range depuis N minutes (0 = désactivé)
  REBALANCE_OUT_OF_RANGE_MIN: z.coerce.number().min(0).default(90),
  // Fees minimum accumulées avant d'autoriser un rebalancing (doit couvrir coût du cycle)
  REBALANCE_MIN_FEES_USD: z.coerce.number().min(0).default(2.0),
  // Ferme SANS réouverture si hors range depuis N heures ET fees < seuil (0 = désactivé)
  // Évite le deadlock : position morte hors range qui n'accumulera jamais assez de fees.
  CLOSE_IF_OUT_OF_RANGE_H: z.coerce.number().min(0).default(6),
  // Fees minimum accumulées avant de déclencher un claim (limite les transactions de claim inutiles)
  MIN_FEE_CLAIM_USD: z.coerce.number().min(0).default(2.0),
  // Auto-swap Jupiter : échange automatique de tokens si solde insuffisant pour entrer une pool.
  AUTO_SWAP: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // Nombre maximum de nouvelles positions à ouvrir par cycle de scan.
  // Limite les swaps auto inutiles quand plusieurs candidats sont approuvés.
  MAX_POSITIONS_PER_SCAN: z.coerce.number().int().min(1).max(5).default(1),
  // Filtres de sélection des pools (scanner). 0 = filtre désactivé.
  // Volume 24h / TVL minimal : sous 1, la liquidité tourne trop peu pour générer des fees.
  MIN_VOLUME_TVL_RATIO: z.coerce.number().min(0).default(1),
  // Market cap minimale du token de base : en dessous, volatilité trop forte à gérer.
  MIN_MARKET_CAP_USD: z.coerce.number().min(0).default(1_000_000),
  // Volume des 4 dernières heures (extrapolé à 24h) / volume 24h : écarte les pools
  // dont l'activité s'effondre (le volume 24h reflète un pic passé).
  MIN_RECENT_VOLUME_RATIO: z.coerce.number().min(0).default(0.5),
  // Bonus de score (0..1) pour les pools qui versent leurs fees en SOL/stable :
  // les fees ne perdent pas de valeur avec le memecoin. 0 = désactivé.
  QUOTE_FEES_SCORE_BONUS: z.coerce.number().min(0).max(1).default(0.1),
  // Écarte les copies de tokens : même symbole qu'un autre token mais market cap
  // plus faible (souvent une réplique récente qui imite l'original).
  EXCLUDE_TOKEN_COPIES: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  // Forme des positions PAPER : "spot" (deux côtés, centré) ou "sol_bidask"
  // (un seul côté en SOL/stable, bins sous le prix). Pas encore utilisé en live.
  PAPER_STRATEGY: z.enum(["spot", "sol_bidask"]).default("spot"),
  // Frais de priorité des transactions DLMM (micro-lamports par unité de calcul).
  // 20 000 × ~400 000 CU ≈ 0,000008 SOL : négligeable, mais évite qu'un stop-loss
  // reste bloqué quand le réseau est chargé. 0 = désactivé.
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().min(0).default(20_000),
  // Couverture minimale (%) : part du range dicté par la volatilité que la position
  // exécutable (69 bins) couvre réellement. Sous ce seuil, le bin step est trop
  // petit pour la volatilité : la position sort du range et l'IL dépasse les fees.
  // 0 = contrôle désactivé.
  MIN_RANGE_COVERAGE_PCT: z.coerce.number().min(0).max(100).default(50),
  // Modèle de fees calibré on-chain : une position touche les fees de SES bins,
  // pas sa part de TVL. Le facteur mesuré (liquidité près du prix) est plafonné
  // à MAX_FEE_CONCENTRATION par prudence. 0 = modèle de base (part de TVL).
  MAX_FEE_CONCENTRATION: z.coerce.number().min(0).default(2),
  // RPC mainnet de LECTURE (liquidité des bins), distinct du RPC d'exécution.
  MAINNET_READ_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  // Backtest : coût d'un aller-retour (swaps pour entrer/sortir de la pool, frais
  // réseau), en % de la taille, prélevé sur chaque position simulée.
  BACKTEST_TRADE_COST_PCT: z.coerce.number().min(0).default(0.2),
  // Univers de pools de l'agent : "all" (toutes catégories) ou "bluechip_sol"
  // (token blue chip coté en SOL : JUP-SOL, cbBTC-SOL…). Les blue chips sont
  // identifiés par MINT, jamais par symbole (un memecoin peut s'appeler « BTC »).
  POOL_UNIVERSE: z.enum(["all", "bluechip_sol"]).default("all"),
  // Mints blue chip supplémentaires (séparés par des virgules) en plus de la liste
  // intégrée (src/analytics/poolUniverse.ts).
  BLUECHIP_EXTRA_MINTS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((m) => m.trim()).filter(Boolean))
    .refine((ms) => ms.every((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)), "BLUECHIP_EXTRA_MINTS : mint base58 invalide"),
  // Durée de vie d'une proposition du mode supervisé (minutes) : au-delà, elle expire
  // même approuvée. Avant toute ouverture, l'agent la revalide (prix, risque).
  APPROVAL_TTL_MIN: z.coerce.number().positive().default(120),
  // Perte journalière maximale (% de la NAV d'ouverture du jour UTC) → HALT. 0 = désactivé.
  MAX_DAILY_LOSS_PCT: z.coerce.number().min(0).default(5),
  // Whale-tracking on-chain : seuil USD d'un swap « baleine » et profondeur de scan.
  WHALE_MIN_USD: z.coerce.number().positive().default(10_000),
  WHALE_LOOKBACK_TX: z.coerce.number().int().positive().max(100).default(50),
  // Niveau de log minimum (debug < info < warn < error). Défaut info en prod.
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = schema.parse(process.env);

export type AppConfig = typeof config;
