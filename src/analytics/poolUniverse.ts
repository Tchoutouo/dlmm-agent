import type { Pool } from "../types.js";
import { SOL_MINT } from "../data/priceOracle.js";
import { config } from "../config.js";

export type PoolUniverse = "all" | "bluechip_sol";

/**
 * Blue chips Solana mainnet, par mint. Le symbole ne suffit pas : l'univers
 * Meteora contient un « BTC-SOL » non vérifié dont le mint finit par « pump ».
 */
export const BLUECHIP_MINTS: ReadonlyMap<string, string> = new Map([
  ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "JUP"],
  ["cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", "cbBTC"],
  ["3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", "WBTC (Wormhole)"],
  ["7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "ETH (Wormhole)"],
  ["A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "ZEC"],
  ["27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", "JLP"],
  ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JitoSOL"],
  ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "mSOL"],
  ["bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", "bSOL"],
  ["5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", "INF"],
]);

/** Mints blue chip : liste intégrée + BLUECHIP_EXTRA_MINTS. */
export function bluechipMints(extra: readonly string[] = config.BLUECHIP_EXTRA_MINTS): Set<string> {
  return new Set([...BLUECHIP_MINTS.keys(), ...extra]);
}

/**
 * La pool appartient-elle à l'univers de l'agent ?
 *  - all          : toutes ;
 *  - bluechip_sol : token X blue chip, quote Y = SOL (seule orientation où la
 *                   bid-ask d'un côté et la valorisation USD du quote s'appliquent).
 */
export function inUniverse(
  pool: Pool,
  universe: PoolUniverse = config.POOL_UNIVERSE,
  mints: ReadonlySet<string> = bluechipMints()
): boolean {
  if (universe === "all") return true;
  return pool.mintY === SOL_MINT && pool.mintX !== SOL_MINT && mints.has(pool.mintX);
}
