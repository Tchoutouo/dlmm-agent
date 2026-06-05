/**
 * Vérifie l'état du wallet devnet et demande un airdrop si le solde est insuffisant.
 *
 * USAGE : npx tsx scripts/devnet-check.ts
 *
 * Prérequis : WALLET_SECRET_KEY défini dans .env, NETWORK=devnet (défaut).
 */

import "dotenv/config";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadWallet } from "../src/execution/wallet.js";
import { config } from "../src/config.js";

const MIN_SOL = 0.5; // SOL minimum recommandé pour les tests

async function main() {
  if (config.NETWORK !== "devnet") {
    console.error("❌  Ce script est réservé au devnet. Vérifie NETWORK=devnet dans ton .env.");
    process.exit(1);
  }

  const wallet = loadWallet();
  if (!wallet) {
    console.error("❌  Aucun wallet trouvé. Définis WALLET_SECRET_KEY dans ton .env.");
    console.error("    Lance d'abord : npx tsx scripts/generate-wallet.ts");
    process.exit(1);
  }

  const { keypair, connection } = wallet;
  const address = keypair.publicKey.toBase58();

  console.log(`\n🔑  Wallet     : ${address}`);
  console.log(`🌐  Réseau     : ${config.NETWORK}`);
  console.log(`🔗  RPC        : ${config.SOLANA_RPC_URL}\n`);

  // Solde actuel
  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;
  console.log(`💰  Solde      : ${sol.toFixed(4)} SOL`);

  if (sol >= MIN_SOL) {
    console.log(`✅  Solde suffisant pour les tests (≥ ${MIN_SOL} SOL).`);
    return;
  }

  // Airdrop si insuffisant
  const needed = Math.ceil((MIN_SOL - sol) * 10) / 10;
  console.log(`⚠️  Solde insuffisant. Demande d'airdrop de ${needed} SOL...`);

  try {
    const sig = await connection.requestAirdrop(
      keypair.publicKey,
      needed * LAMPORTS_PER_SOL
    );
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, "confirmed");

    const newLamports = await connection.getBalance(keypair.publicKey);
    const newSol = newLamports / LAMPORTS_PER_SOL;
    console.log(`✅  Airdrop confirmé. Nouveau solde : ${newSol.toFixed(4)} SOL`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌  Airdrop échoué : ${msg}`);
    console.error(
      "\n    Si le faucet est saturé, essaie manuellement :\n" +
      `    https://faucet.solana.com  (adresse : ${address})`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
