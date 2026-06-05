import { MeteoraClient } from "./data/meteoraClient.js";
import { PriceOracle } from "./data/priceOracle.js";
import { classifyFeeRegime } from "./analytics/dlmmFees.js";
import { loadWallet } from "./execution/wallet.js";
import { RealExecutor } from "./execution/realExecutor.js";
import { LivePositionManager } from "./execution/livePositionManager.js";
import { config } from "./config.js";

/**
 * Exécution réelle DLMM — DÉLIBÉRÉE et unitaire (jamais dans une boucle auto).
 *
 *   npm run execute -- open <adresse_pool> <taille_usd>
 *   npm run execute -- close <adresse_pool> <position_pubkey>
 *
 * Sécurisé par défaut : devnet + DRY_RUN (construit la tx, ne l'envoie pas).
 * Envoi réel : DRY_RUN=false (+ ACKNOWLEDGE_REAL_FUNDS=true sur mainnet).
 *
 * NE PAS pointer vers du capital réel tant que le paper trading n'a pas confirmé
 * un avantage. Commencer impérativement sur devnet.
 */
async function main() {
  const [action, address, arg] = process.argv.slice(2);

  console.log(`▶ Exécution — réseau=${config.NETWORK} dry_run=${config.DRY_RUN} ack=${config.ACKNOWLEDGE_REAL_FUNDS}\n`);

  const wallet = loadWallet();
  if (!wallet) {
    console.log("Aucun wallet chargé. Pour tester sur devnet :");
    console.log("  1. Génère un wallet dédié (jamais ton principal)");
    console.log("  2. solana airdrop 2 <adresse> --url devnet");
    console.log("  3. Mets sa clé base58 dans WALLET_SECRET_KEY (.env, non committé)");
    return;
  }
  console.log(`Wallet : ${wallet.keypair.publicKey.toBase58()}`);

  const exec = new RealExecutor(wallet);

  if (action === "open" && address && arg) {
    const pool = await new MeteoraClient().getPair(address);
    const regime = classifyFeeRegime(pool).label;
    const res = await exec.openPosition({
      poolAddress: address,
      sizeUsd: Number(arg),
      currentPrice: pool.currentPrice,
      regime,
    });
    console.log(`\n[${res.mode}] ${res.ok ? "OK" : "REFUS"} — ${res.note}`);
    if (res.txHash) console.log(`tx: ${res.txHash}`);

    // Suivi du cycle de vie uniquement pour une position RÉELLEMENT ouverte
    if (res.mode === "LIVE" && res.ok && res.positionPubkey) {
      const manager = new LivePositionManager(wallet, new PriceOracle());
      manager.register({
        poolAddress: address,
        poolName: pool.name,
        mintX: pool.mintX,
        mintY: pool.mintY,
        positionPubkey: res.positionPubkey,
        sizeUsd: Number(arg),
        openedAtSec: Math.floor(Date.now() / 1000),
      });
      manager.close();
      console.log("Position enregistrée dans le suivi de cycle de vie.");
    }
  } else if (action === "close" && address && arg) {
    const res = await exec.closePosition(address, arg);
    console.log(`\n[${res.mode}] ${res.ok ? "OK" : "REFUS"} — ${res.note}`);
    if (res.txHash) console.log(`tx: ${res.txHash}`);
  } else {
    console.log("Usage :");
    console.log("  npm run execute -- open <adresse_pool> <taille_usd>");
    console.log("  npm run execute -- close <adresse_pool> <position_pubkey>");
  }
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
