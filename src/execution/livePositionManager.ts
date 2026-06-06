import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DLMM from "../dlmmSdk.js";
import { PublicKey } from "@solana/web3.js";
import type { PortfolioSnapshot, PortfolioPosition } from "../types.js";
import type { TradeJournal } from "../journal/journal.js";
import type { PriceOracle } from "../data/priceOracle.js";
import type { LoadedWallet } from "./wallet.js";
import type { RealExecutor } from "./realExecutor.js";
import { positionValueUsd } from "./positionValue.js";
import { readWalletUsd } from "./walletBalance.js";
import { config } from "../config.js";

interface LiveRow {
  id: number;
  journalId: number | null;
  poolAddress: string;
  poolName: string;
  mintX: string;
  mintY: string;
  positionPubkey: string;
  sizeUsd: number;
  valueUsd: number;
  feesUsd: number;
  openedAtSec: number;
  everOut: boolean;
}

/**
 * Cycle de vie des positions RÉELLES (on-chain). Équivalent du broker papier,
 * mais le marquage lit l'état on-chain via le SDK et la clôture passe par
 * l'exécuteur réel (donc par le garde-fou de sécurité).
 *
 * La « caisse » (cash) est un suivi interne amorcé par INITIAL_CASH_USD pour le
 * dimensionnement du risque (ratios d'exposition) ; la vraie trésorerie est
 * on-chain. Lire les soldes réels du wallet est un raffinement ultérieur.
 */
export class LivePositionManager {
  private db: Database.Database;

  constructor(
    private readonly wallet: LoadedWallet,
    private readonly oracle: PriceOracle,
    dbPath: string = config.JOURNAL_DB_PATH
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        journal_id INTEGER,
        pool_address TEXT NOT NULL, pool_name TEXT NOT NULL,
        mint_x TEXT NOT NULL, mint_y TEXT NOT NULL,
        position_pubkey TEXT NOT NULL,
        size_usd REAL NOT NULL, value_usd REAL NOT NULL, fees_usd REAL NOT NULL DEFAULT 0,
        opened_at_sec INTEGER NOT NULL, ever_out INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN'
      );
      CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, value REAL NOT NULL);
    `);
    if (!this.db.prepare(`SELECT 1 FROM live_meta WHERE key='cash'`).get()) {
      const set = this.db.prepare(`INSERT INTO live_meta(key,value) VALUES(?,?)`);
      set.run("cash", config.INITIAL_CASH_USD);
      set.run("peak_nav", config.INITIAL_CASH_USD);
    }
  }

  private meta(k: string): number {
    const r = this.db.prepare(`SELECT value FROM live_meta WHERE key=?`).get(k) as { value: number } | undefined;
    return r?.value ?? 0;
  }
  private setMeta(k: string, v: number): void {
    this.db.prepare(`INSERT INTO live_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
  }

  /** Enregistre une position réelle ouverte (appelé après un open LIVE réussi). */
  register(p: {
    journalId?: number;
    poolAddress: string;
    poolName: string;
    mintX: string;
    mintY: string;
    positionPubkey: string;
    sizeUsd: number;
    openedAtSec: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO live_positions
         (journal_id,pool_address,pool_name,mint_x,mint_y,position_pubkey,size_usd,value_usd,opened_at_sec)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(p.journalId ?? null, p.poolAddress, p.poolName, p.mintX, p.mintY, p.positionPubkey, p.sizeUsd, p.sizeUsd, p.openedAtSec);
    this.setMeta("cash", this.meta("cash") - p.sizeUsd);
  }

  private listOpenRows(): LiveRow[] {
    const rows = this.db.prepare(`SELECT * FROM live_positions WHERE status='OPEN'`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      journalId: (r.journal_id as number) ?? null,
      poolAddress: r.pool_address as string,
      poolName: r.pool_name as string,
      mintX: r.mint_x as string,
      mintY: r.mint_y as string,
      positionPubkey: r.position_pubkey as string,
      sizeUsd: r.size_usd as number,
      valueUsd: r.value_usd as number,
      feesUsd: r.fees_usd as number,
      openedAtSec: r.opened_at_sec as number,
      everOut: Boolean(r.ever_out),
    }));
  }

  /** Marque toutes les positions ouvertes en lisant leur état on-chain. */
  async markAll(): Promise<void> {
    const open = this.listOpenRows();
    const byPool = new Map<string, LiveRow[]>();
    for (const r of open) (byPool.get(r.poolAddress) ?? byPool.set(r.poolAddress, []).get(r.poolAddress)!).push(r);

    for (const [poolAddress, rows] of byPool) {
      try {
        const dlmmPool = await DLMM.create(this.wallet.connection, new PublicKey(poolAddress), { cluster: config.NETWORK });
        const activeBin = await dlmmPool.getActiveBin();
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.keypair.publicKey);
        const decX = dlmmPool.tokenX.mint.decimals;
        const decY = dlmmPool.tokenY.mint.decimals;
        const prices = await this.oracle.getUsdPrices([rows[0]!.mintX, rows[0]!.mintY]);

        for (const row of rows) {
          const lp = userPositions.find((p) => p.publicKey.toBase58() === row.positionPubkey);
          if (!lp) continue;
          const pd = lp.positionData;
          const v = positionValueUsd({
            amountXRaw: Number(pd.totalXAmount),
            amountYRaw: Number(pd.totalYAmount),
            feeXRaw: Number(pd.feeX?.toString() ?? 0),
            feeYRaw: Number(pd.feeY?.toString() ?? 0),
            decimalsX: decX,
            decimalsY: decY,
            priceXUsd: prices[row.mintX] ?? 0,
            priceYUsd: prices[row.mintY] ?? 0,
          });
          const inRange = activeBin.binId >= pd.lowerBinId && activeBin.binId <= pd.upperBinId;
          this.db
            .prepare(`UPDATE live_positions SET value_usd=?, fees_usd=?, ever_out=? WHERE id=?`)
            .run(v.markValueUsd, v.feesUsd, row.everOut || !inRange ? 1 : 0, row.id);
        }
      } catch {
        /* lecture on-chain indisponible : on saute ce pool */
      }
    }
  }

  /** Clôture les positions ayant atteint l'horizon, via l'exécuteur réel. */
  async closeDue(holdingDays: number, executor: RealExecutor, journal: TradeJournal): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    let closed = 0;
    for (const row of this.listOpenRows()) {
      if ((nowSec - row.openedAtSec) / 86_400 < holdingDays) continue;
      const res = await executor.closePosition(row.poolAddress, row.positionPubkey);
      if (!res.ok) continue; // refus (garde-fou) ou erreur : on réessaiera au prochain tick

      // En DRY_RUN, la position n'est pas réellement fermée : on ne clôture pas le suivi.
      if (res.mode === "DRY_RUN") continue;

      const realizedPnlUsd = row.valueUsd - row.sizeUsd; // dernier mark - mise
      this.db.prepare(`UPDATE live_positions SET status='CLOSED' WHERE id=?`).run(row.id);
      this.setMeta("cash", this.meta("cash") + row.valueUsd);
      if (row.journalId !== null) {
        journal.recordOutcome(row.journalId, {
          realizedPnlUsd,
          feesCollectedUsd: row.feesUsd,
          wentOutOfRange: row.everOut,
          holdingDays: (nowSec - row.openedAtSec) / 86_400,
          notes: `live ${res.txHash ?? ""}`.trim(),
        });
      }
      closed++;
    }
    return closed;
  }

  /** Photo du portefeuille réel pour l'agent de risque. */
  snapshot(): PortfolioSnapshot {
    const open = this.listOpenRows();
    const positions: PortfolioPosition[] = open.map((r) => ({
      poolAddress: r.poolAddress,
      poolName: r.poolName,
      mintX: r.mintX,
      mintY: r.mintY,
      sizeUsd: r.sizeUsd,
      valueUsd: r.valueUsd,
    }));
    const cashUsd = this.meta("cash");
    const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
    const navUsd = cashUsd + deployedUsd;
    let peak = this.meta("peak_nav");
    if (navUsd > peak) {
      peak = navUsd;
      this.setMeta("peak_nav", peak);
    }
    const drawdownPct = peak > 0 ? ((peak - navUsd) / peak) * 100 : 0;
    const exposureByPool: Record<string, number> = {};
    for (const p of positions) exposureByPool[p.poolAddress] = (exposureByPool[p.poolAddress] ?? 0) + p.valueUsd;
    return { navUsd, cashUsd, deployedUsd, peakNavUsd: peak, drawdownPct, positions, exposureByPool };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Photo RÉELLE : cash = solde on-chain du wallet (SOL + tokens valorisés),
   * positions = valeur on-chain (dernier mark). NAV reflète l'état réel, à
   * utiliser de préférence à snapshot() pour le dimensionnement du risque en réel.
   */
  async realSnapshot(): Promise<PortfolioSnapshot> {
    const open = this.listOpenRows();
    const positions: PortfolioPosition[] = open.map((r) => ({
      poolAddress: r.poolAddress,
      poolName: r.poolName,
      mintX: r.mintX,
      mintY: r.mintY,
      sizeUsd: r.sizeUsd,
      valueUsd: r.valueUsd,
    }));
    const wallet = await readWalletUsd(this.wallet.connection, this.wallet.keypair.publicKey, this.oracle);
    const cashUsd = wallet.totalUsd;
    const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
    const navUsd = cashUsd + deployedUsd;
    let peak = this.meta("peak_nav");
    if (navUsd > peak) {
      peak = navUsd;
      this.setMeta("peak_nav", peak);
    }
    const drawdownPct = peak > 0 ? ((peak - navUsd) / peak) * 100 : 0;
    const exposureByPool: Record<string, number> = {};
    for (const p of positions) exposureByPool[p.poolAddress] = (exposureByPool[p.poolAddress] ?? 0) + p.valueUsd;
    return { navUsd, cashUsd, deployedUsd, peakNavUsd: peak, drawdownPct, positions, exposureByPool };
  }
}
