import { Connection } from "@solana/web3.js";
import { PriceOracle } from "./data/priceOracle.js";
import { WhaleTracker } from "./whale/whaleTracker.js";
import { config } from "./config.js";

/**
 * Suivi on-chain des baleines pour une pool.
 *   npm run whales -- <adresse_pool>
 *
 * Lecture seule (aucune transaction). Utile pour jauger l'activité des gros
 * acteurs avant d'entrer / sortir d'une position.
 */
async function main() {
  const address = process.argv[2];
  if (!address) {
    console.log("Usage : npm run whales -- <adresse_pool>");
    return;
  }
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const tracker = new WhaleTracker(connection, new PriceOracle());

  console.log(`▶ Baleines — pool ${address} (seuil $${config.WHALE_MIN_USD})\n`);
  const a = await tracker.recentActivity(address);
  console.log(`${a.scanned} tx scannées · ${a.whales.length} baleine(s) · direction nette : ${a.netDirection}`);
  console.log(`Volume baleine total : $${a.totalWhaleUsd.toFixed(0)}\n`);
  for (const w of a.whales.slice(0, 15)) {
    const when = w.blockTime ? new Date(w.blockTime * 1000).toISOString() : "?";
    console.log(`  ${w.side.padEnd(6)} $${w.amountUsd.toFixed(0).padStart(8)}  ${when}  ${w.signature.slice(0, 12)}…`);
  }
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
