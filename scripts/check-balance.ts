/**
 * Vérifie le solde SOL + tokens SPL du wallet sur n'importe quel réseau.
 *
 * USAGE : npm run check
 * Fonctionne sur devnet ET mainnet-beta selon NETWORK dans .env.
 */

import "dotenv/config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadWallet } from "../src/execution/wallet.js";
import { config } from "../src/config.js";

async function main() {
  const wallet = loadWallet();
  if (!wallet) {
    console.error("❌  Aucun wallet. Définis WALLET_SECRET_KEY dans .env");
    process.exit(1);
  }

  const { keypair, connection } = wallet;
  const address = keypair.publicKey.toBase58();
  const network = config.NETWORK;

  console.log(`\n🔑  Wallet  : ${address}`);
  console.log(`🌐  Réseau  : ${network}`);
  console.log(`🔗  RPC     : ${config.SOLANA_RPC_URL}\n`);

  // Solde SOL
  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;
  const solOk = sol >= 0.05;
  console.log(`${solOk ? "✅" : "⚠️ "} SOL     : ${sol.toFixed(4)} SOL${!solOk ? "  ← insuffisant pour le gas (min 0.05)" : ""}`);

  // Tokens SPL (USDC, USDT, etc.)
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, {
    programId: new (await import("@solana/web3.js")).PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    ),
  });

  const KNOWN: Record<string, string> = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzWqFdTx2jPvQTjTAhMcEoP1eZFSBdmrVWV3p4: "USDT",
  };

  if (tokenAccounts.value.length === 0) {
    console.log("ℹ️   Aucun compte de token SPL trouvé.");
  } else {
    for (const acc of tokenAccounts.value) {
      const info = acc.account.data.parsed.info;
      const mint: string = info.mint;
      const amount: string = info.tokenAmount.uiAmountString ?? "0";
      const symbol = KNOWN[mint] ?? `${mint.slice(0, 8)}…`;
      const isEmpty = Number(info.tokenAmount.amount) === 0;
      if (!isEmpty) {
        console.log(`✅  ${symbol.padEnd(8)}: ${amount}`);
      }
    }
  }

  console.log();
  if (network === "mainnet-beta") {
    console.log("💡  Pour exécuter l'agent : npm run devnet:run:live");
  } else {
    console.log("💡  Pour tester : npm run devnet:run");
    console.log("    Pour passer en mainnet : change NETWORK=mainnet-beta dans .env");
  }
}

main().catch((err) => {
  console.error("Erreur :", err instanceof Error ? err.message : err);
  process.exit(1);
});
