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
  // Paper trading : horizon de détention d'une position simulée (jours).
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
  // Horizon de détention supposé (jours). Définit la période sur laquelle l'IL est
  // rapporté avant annualisation. Un horizon plus long réduit l'IL annualisé apparent
  // pour un LP statique non rebalancé (IL₇j / 7 × 365, et non IL₁j × 365).
  HOLDING_HORIZON_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // Auto-swap Jupiter : échange automatique de tokens si solde insuffisant pour entrer une pool.
  AUTO_SWAP: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // Nombre maximum de nouvelles positions à ouvrir par cycle de scan.
  // Limite les swaps auto inutiles quand plusieurs candidats sont approuvés.
  MAX_POSITIONS_PER_SCAN: z.coerce.number().int().min(1).max(5).default(1),
  // Whale-tracking on-chain : seuil USD d'un swap « baleine » et profondeur de scan.
  WHALE_MIN_USD: z.coerce.number().positive().default(10_000),
  WHALE_LOOKBACK_TX: z.coerce.number().int().positive().max(100).default(50),
  // Niveau de log minimum (debug < info < warn < error). Défaut info en prod.
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = schema.parse(process.env);

export type AppConfig = typeof config;
