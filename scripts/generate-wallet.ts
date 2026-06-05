/**
 * Génère un nouveau keypair Solana dédié aux tests devnet.
 *
 * USAGE : npx tsx scripts/generate-wallet.ts
 *
 * Ce script affiche :
 *   - l'adresse publique (à approvisionner en SOL devnet)
 *   - la clé secrète en base58 (à coller dans WALLET_SECRET_KEY du .env)
 *
 * ⚠️  NE JAMAIS utiliser ce wallet pour des fonds réels.
 * ⚠️  NE JAMAIS committer le .env contenant la clé.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
const secret = bs58.encode(kp.secretKey);

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               WALLET DEVNET — USAGE EXCLUSIF TESTS            ║
╚═══════════════════════════════════════════════════════════════╝

  Adresse publique  : ${kp.publicKey.toBase58()}
  Clé secrète (b58) : ${secret}

  1. Copie la clé secrète dans ton .env :
       WALLET_SECRET_KEY=${secret}

  2. Approvisionne le wallet en SOL devnet :
       npx tsx scripts/devnet-check.ts
     (le script demandera automatiquement un airdrop si le solde est nul)

  ⚠️  Ce wallet est UNIQUEMENT pour devnet.
  ⚠️  Ne le réutilise pas avec de vrais fonds.
  ⚠️  Ne committe JAMAIS ton .env.
`);
