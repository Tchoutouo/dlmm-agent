import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "../dlmmSdk.js";
import { config } from "../config.js";
import { feeConcentrationFactor } from "../analytics/feeConcentration.js";
import type { Pool } from "../types.js";

let readConnection: Connection | null = null;

/**
 * Connexion de LECTURE mainnet (MAINNET_READ_RPC_URL), distincte du RPC
 * d'exécution : l'analyse lit les pools mainnet même quand l'agent s'exécute
 * sur devnet. Aucune transaction n'est jamais envoyée par cette connexion.
 */
export function mainnetReadConnection(): Connection {
  readConnection ??= new Connection(config.MAINNET_READ_RPC_URL, "confirmed");
  return readConnection;
}

/**
 * Liquidité USD des bins autour du bin actif (actif ± rayon), lue on-chain.
 * `quoteUsd` = prix USD du token Y de la pool.
 */
export async function readNearActiveLiquidityUsd(
  poolAddress: string,
  quoteUsd: number,
  radius = 2,
  connection: Connection = mainnetReadConnection()
): Promise<number[]> {
  const dlmm = await DLMM.create(connection, new PublicKey(poolAddress), { cluster: "mainnet-beta" });
  const { activeBin, bins } = await dlmm.getBinsAroundActiveBin(radius, radius);
  const dx = dlmm.tokenX.mint.decimals;
  const dy = dlmm.tokenY.mint.decimals;
  return bins
    .filter((b) => Math.abs(b.binId - activeBin) <= radius)
    .map(
      (b) =>
        (Number(b.xAmount.toString()) / 10 ** dx * Number(b.pricePerToken) + Number(b.yAmount.toString()) / 10 ** dy) *
        quoteUsd
    );
}

/**
 * Facteur de concentration BRUT d'une pool pour une position de `positionBins`
 * bins (taille de référence : MAX_POSITION_USD). null si la lecture échoue — le
 * modèle de base s'applique alors.
 */
export async function measureFeeConcentration(
  pool: Pool,
  quoteUsd: number,
  positionBins: number
): Promise<number | null> {
  try {
    return feeConcentrationFactor({
      tvlUsd: pool.liquidityUsd,
      nearBinLiquidityUsd: await readNearActiveLiquidityUsd(pool.address, quoteUsd),
      positionBins,
      sizeUsd: config.MAX_POSITION_USD,
    });
  } catch {
    return null;
  }
}
