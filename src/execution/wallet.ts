import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";

/**
 * Le fichier qui contient la clé secrète est-il lisible par d'autres comptes que
 * son propriétaire ? Renvoie le problème, ou null (droits 600 / 400, ou Windows
 * où ces bits ne s'appliquent pas).
 */
export function envPermissionIssue(mode: number, platform: string = process.platform): string | null {
  if (platform === "win32") return null;
  if ((mode & 0o077) === 0) return null;
  return (
    `.env accessible à d'autres comptes (droits ${(mode & 0o777).toString(8)}) alors qu'il contient ` +
    `la clé du wallet — corriger avec : chmod 600 .env`
  );
}

export interface LoadedWallet {
  keypair: Keypair;
  connection: Connection;
}

/**
 * Charge le wallet depuis WALLET_SECRET_KEY (base58) et ouvre la connexion RPC.
 * Renvoie null si aucune clé n'est fournie — l'exécution restera alors refusée
 * par le garde-fou. NE JAMAIS committer de clé ; utiliser un wallet dédié.
 */
export function loadWallet(): LoadedWallet | null {
  const secret = config.WALLET_SECRET_KEY;
  if (!secret) return null;

  // Clé lisible par d'autres comptes : refus pour du capital réel, avertissement sinon
  const envPath = resolve(".env");
  const issue = existsSync(envPath) ? envPermissionIssue(statSync(envPath).mode) : null;
  if (issue) {
    if (config.NETWORK === "mainnet-beta" && !config.DRY_RUN) {
      throw new Error(`${issue} (refus de charger la clé pour du capital réel)`);
    }
    console.warn(`⚠️  ${issue}`);
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    throw new Error("WALLET_SECRET_KEY invalide (attendu : clé secrète base58)");
  }
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  return { keypair, connection };
}
