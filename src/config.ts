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
  // Whale-tracking on-chain : seuil USD d'un swap « baleine » et profondeur de scan.
  WHALE_MIN_USD: z.coerce.number().positive().default(10_000),
  WHALE_LOOKBACK_TX: z.coerce.number().int().positive().max(100).default(50),
});

export const config = schema.parse(process.env);

export type AppConfig = typeof config;
