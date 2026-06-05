import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";

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
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    throw new Error("WALLET_SECRET_KEY invalide (attendu : clé secrète base58)");
  }
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  return { keypair, connection };
}
