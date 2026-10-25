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
import { markablePrices, positionValueUsd } from "./positionValue.js";
import { readWalletBalances, splitWallet } from "./walletBalance.js";
import { SOL_MINT, STABLE_MINTS } from "../data/priceOracle.js";
import { config } from "../config.js";
import { trackDailyLoss } from "../risk/dailyLoss.js";

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
  outOfRangeSinceSec: number | null;
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
  private readonly db: Database.Database;

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
    // Migration : ajoute out_of_range_since_sec si absent (SQLite idempotent via try/catch)
    try {
      this.db.exec(`ALTER TABLE live_positions ADD COLUMN out_of_range_since_sec INTEGER`);
    } catch { /* colonne déjà présente */ }

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
      outOfRangeSinceSec: (r.out_of_range_since_sec as number) ?? null,
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
        const usd = markablePrices(
          await this.oracle.getUsdPrices([rows[0]!.mintX, rows[0]!.mintY]),
          rows[0]!.mintX,
          rows[0]!.mintY
        );
        if (!usd) {
          console.warn(
            `  ⚠️  Prix USD manquant pour ${rows[0]!.poolName} — marquage reporté (dernière valeur conservée, aucun stop-loss sur donnée absente)`
          );
          continue;
        }

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
            priceXUsd: usd.priceXUsd,
            priceYUsd: usd.priceYUsd,
          });
          const nowSec = Math.floor(Date.now() / 1000);
          const inRange = activeBin.binId >= pd.lowerBinId && activeBin.binId <= pd.upperBinId;
          // out_of_range_since_sec : première seconde où la position sort du range (reset si retour)
          const outSince = inRange ? null : (row.outOfRangeSinceSec ?? nowSec);
          // Stocke valueUsd seul (sans fees) pour éviter le double-comptage dans closeAtThresholds
          // qui additionne row.valueUsd + row.feesUsd. markValueUsd = valueUsd + feesUsd.
          this.db
            .prepare(`UPDATE live_positions SET value_usd=?, fees_usd=?, ever_out=?, out_of_range_since_sec=? WHERE id=?`)
            .run(v.valueUsd, v.feesUsd, row.everOut || !inRange ? 1 : 0, outSince, row.id);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const firstLine = raw.split("\n")[0] ?? raw;
        console.warn(`  ⚠️  markAll échoué (${rows[0]?.poolName ?? poolAddress.slice(0, 8)}…): ${firstLine.slice(0, 120)}`);
      }
    }
  }

  /**
   * Rebalance les positions hors range depuis plus de `minOutMinutes` minutes :
   * ferme la position (fees incluses) et libère le capital. La RÉENTRÉE n'est
   * PAS faite ici : elle passe par le prochain scan, donc par l'agent de risque
   * (disjoncteurs, limite journalière, veto, plafonds). Rouvrir aussitôt
   * contournerait ces contrôles, typiquement sur une pool qui décroche.
   */
  async rebalanceOutOfRange(
    minOutMinutes: number,
    executor: RealExecutor,
    journal: TradeJournal
  ): Promise<number> {
    if (minOutMinutes <= 0) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const minOutSec = minOutMinutes * 60;
    let rebalanced = 0;

    for (const row of this.listOpenRows()) {
      if (row.outOfRangeSinceSec === null) continue;
      const outForSec = nowSec - row.outOfRangeSinceSec;
      if (outForSec < minOutSec) continue;

      const outMin = Math.round(outForSec / 60);

      // Gate de rentabilité : ne rebalancer que si les fees couvrent le coût du cycle.
      if (row.feesUsd < config.REBALANCE_MIN_FEES_USD) {
        const maxDeadSec = config.CLOSE_IF_OUT_OF_RANGE_H * 3600;

        // Deadlock guard : si hors range depuis trop longtemps et 0 fees qui s'accumulent,
        // fermer proprement SANS réouverture pour libérer le capital.
        if (maxDeadSec > 0 && outForSec > maxDeadSec) {
          const outH = (outForSec / 3600).toFixed(1);
          console.log(
            `  🚫 ${row.poolName} — hors range depuis ${outH}h, fees $${row.feesUsd.toFixed(2)} (position morte) → clôture pour libérer le capital`
          );
          const closeRes = await executor.closePosition(row.poolAddress, row.positionPubkey);
          if (closeRes.ok) {
            const totalRecovered = row.valueUsd + row.feesUsd;
            this.db.prepare(`UPDATE live_positions SET status='CLOSED' WHERE id=?`).run(row.id);
            this.setMeta("cash", this.meta("cash") + totalRecovered);
            if (row.journalId !== null) {
              journal.recordOutcome(row.journalId, {
                realizedPnlUsd: row.valueUsd - row.sizeUsd,
                feesCollectedUsd: row.feesUsd,
                wentOutOfRange: true,
                holdingDays: (nowSec - row.openedAtSec) / 86_400,
                notes: `clôture position morte: hors range ${outMin}min, fees $${row.feesUsd.toFixed(2)}`,
              });
            }
            console.log(`     ✅ Capital $${totalRecovered.toFixed(2)} libéré — prochain scan cherchera une meilleure pool`);
            rebalanced++;
          } else {
            console.log(`     ↳ Clôture échouée : ${closeRes.note}`);
          }
        } else {
          console.log(
            `  ⏭️  Rebalancing ${row.poolName} ignoré — fees $${row.feesUsd.toFixed(2)} < seuil $${config.REBALANCE_MIN_FEES_USD} (IL non compensé)`
          );
        }
        continue;
      }

      console.log(`  🔄 Rebalancing ${row.poolName} (hors range depuis ${outMin} min, fees $${row.feesUsd.toFixed(2)})`);


      // ── 1. Fermeture (fees claimées + tokens retournés au wallet) ──
      const closeRes = await executor.closePosition(row.poolAddress, row.positionPubkey);
      if (!closeRes.ok || closeRes.mode === "DRY_RUN") {
        console.log(`     ↳ Fermeture échouée : ${closeRes.note}`);
        continue;
      }

      const totalRecovered = row.valueUsd + row.feesUsd; // liquidité + fees
      const realizedPnlUsd = row.valueUsd - row.sizeUsd;
      this.db.prepare(`UPDATE live_positions SET status='REBALANCED' WHERE id=?`).run(row.id);
      this.setMeta("cash", this.meta("cash") + totalRecovered);
      if (row.journalId !== null) {
        journal.recordOutcome(row.journalId, {
          realizedPnlUsd,
          feesCollectedUsd: row.feesUsd,
          wentOutOfRange: true,
          holdingDays: (nowSec - row.openedAtSec) / 86_400,
          notes: `rebalancing (clôture) ${outMin}min hors range | tx ${closeRes.txHash ?? ""}`.trim(),
        });
      }

      // ── 2. Pas de réouverture ici : le prochain scan décide, via l'agent de risque ──
      console.log(
        `     ✅ Fermée — $${totalRecovered.toFixed(2)} récupérés ; réentrée éventuelle au prochain scan (agent de risque)`
      );
      rebalanced++;
    }

    return rebalanced;
  }

  /**
   * Clôture les positions qui ont atteint le seuil de take profit ou stop loss.
   * Le PnL total inclut la valorisation mark-to-market ET les fees accumulées.
   * Retourne le nombre de positions fermées.
   */
  async closeAtThresholds(
    takeProfitPct: number,
    stopLossPct: number,
    executor: RealExecutor,
    journal: TradeJournal
  ): Promise<number> {
    if (takeProfitPct <= 0 && stopLossPct <= 0) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    let closed = 0;

    for (const row of this.listOpenRows()) {
      const totalReturnPct = ((row.valueUsd + row.feesUsd - row.sizeUsd) / row.sizeUsd) * 100;

      let trigger: string | null = null;
      if (takeProfitPct > 0 && totalReturnPct >= takeProfitPct) {
        trigger = `TP +${totalReturnPct.toFixed(1)}% ≥ +${takeProfitPct}%`;
      } else if (stopLossPct > 0 && totalReturnPct <= -stopLossPct) {
        trigger = `SL ${totalReturnPct.toFixed(1)}% ≤ -${stopLossPct}%`;
      }
      if (!trigger) continue;

      console.log(`  🎯 ${trigger} → clôture ${row.poolName} ${row.positionPubkey.slice(0, 8)}…`);
      const res = await executor.closePosition(row.poolAddress, row.positionPubkey);
      if (!res.ok || res.mode === "DRY_RUN") continue;

      const realizedPnlUsd = row.valueUsd + row.feesUsd - row.sizeUsd;
      this.db.prepare(`UPDATE live_positions SET status='CLOSED' WHERE id=?`).run(row.id);
      this.setMeta("cash", this.meta("cash") + row.valueUsd + row.feesUsd);
      if (row.journalId !== null) {
        journal.recordOutcome(row.journalId, {
          realizedPnlUsd,
          feesCollectedUsd: row.feesUsd,
          wentOutOfRange: row.everOut,
          holdingDays: (nowSec - row.openedAtSec) / 86_400,
          notes: `${trigger} | tx ${res.txHash ?? ""}`.trim(),
        });
      }
      closed++;
    }
    return closed;
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

      const realizedPnlUsd = row.valueUsd + row.feesUsd - row.sizeUsd;
      this.db.prepare(`UPDATE live_positions SET status='CLOSED' WHERE id=?`).run(row.id);
      this.setMeta("cash", this.meta("cash") + row.valueUsd + row.feesUsd);
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

  /**
   * Réclame les fees accumulées de toutes les positions ouvertes dont le montant
   * dépasse `minClaimUsd`. Les fees vont directement dans le wallet ; le cash
   * interne est mis à jour en conséquence pour que le prochain scan puisse les
   * réinvestir. À appeler APRÈS markAll() pour avoir des valeurs à jour.
   */
  async claimAllFees(
    executor: RealExecutor,
    minClaimUsd = config.MIN_FEE_CLAIM_USD
  ): Promise<number> {
    let totalClaimed = 0;

    for (const row of this.listOpenRows()) {
      if (row.feesUsd < minClaimUsd) continue;

      try {
        const res = await executor.claimFees(row.poolAddress, row.positionPubkey);
        if (!res.ok) {
          console.log(`  ⚠️  Claim échoué ${row.poolName}: ${res.note}`);
          continue;
        }
        if (res.mode === "DRY_RUN") {
          console.log(`  💰 [DRY_RUN] Claim simulé ${row.poolName}: $${row.feesUsd.toFixed(2)}`);
          continue;
        }
        // Fees dans le wallet → ajouter au cash interne + remettre feesUsd à 0
        this.setMeta("cash", this.meta("cash") + row.feesUsd);
        this.db.prepare(`UPDATE live_positions SET fees_usd=0 WHERE id=?`).run(row.id);
        console.log(`  💰 Fees réclamées ${row.poolName}: +$${row.feesUsd.toFixed(2)} → cash`);
        totalClaimed += row.feesUsd;
      } catch (err) {
        const msg = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
        console.log(`  ⚠️  Claim ${row.poolName} échoué (${msg.slice(0, 60)})`);
      }
    }

    return totalClaimed;
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
      valueUsd: r.valueUsd + r.feesUsd, // tokens + fees = valeur totale récupérable
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
    const dailyLossPct = trackDailyLoss((k) => this.meta(k), (k, v) => this.setMeta(k, v), navUsd);
    return { navUsd, cashUsd, deployedUsd, peakNavUsd: peak, drawdownPct, dailyLossPct, positions, exposureByPool };
  }

  /**
   * Clôture une position spécifique à la demande manuelle (dashboard).
   * Met à jour le DB et le journal exactement comme closeDue.
   */
  async closeByRequest(
    poolAddress: string,
    positionPubkey: string,
    executor: RealExecutor,
    journal: TradeJournal
  ): Promise<{ ok: boolean; note: string; txHash?: string }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.listOpenRows().find((r) => r.positionPubkey === positionPubkey);

    const res = await executor.closePosition(poolAddress, positionPubkey);
    if (!res.ok) return { ok: false, note: res.note };
    if (res.mode === "DRY_RUN") return { ok: true, note: res.note };

    if (row) {
      const realizedPnlUsd = row.valueUsd - row.sizeUsd;
      this.db.prepare(`UPDATE live_positions SET status='CLOSED' WHERE id=?`).run(row.id);
      this.setMeta("cash", this.meta("cash") + row.valueUsd + row.feesUsd);
      if (row.journalId !== null) {
        journal.recordOutcome(row.journalId, {
          realizedPnlUsd,
          feesCollectedUsd: row.feesUsd,
          wentOutOfRange: row.everOut,
          holdingDays: (nowSec - row.openedAtSec) / 86_400,
          notes: `clôture manuelle | tx ${res.txHash ?? ""}`.trim(),
        });
      }
    }

    return {
      ok: true,
      note: `Position clôturée — ${positionPubkey.slice(0, 8)}…`,
      txHash: res.txHash,
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Photo RÉELLE, utilisée par l'agent de risque en live :
   *  - cash = SOL + stablecoins du wallet (capital déployable) ;
   *  - positions = positions DLMM (dernier mark) + INVENTAIRE : les autres tokens
   *    du wallet (restes de positions fermées) comptent comme exposition, pas
   *    comme cash — ils entrent dans les plafonds d'exposition.
   */
  async realSnapshot(): Promise<PortfolioSnapshot> {
    const open = this.listOpenRows();
    const positions: PortfolioPosition[] = open.map((r) => ({
      poolAddress: r.poolAddress,
      poolName: r.poolName,
      mintX: r.mintX,
      mintY: r.mintY,
      sizeUsd: r.sizeUsd,
      valueUsd: r.valueUsd + r.feesUsd, // tokens + fees = valeur totale récupérable
    }));
    const balances = await readWalletBalances(this.wallet.connection, this.wallet.keypair.publicKey);
    const prices = balances.length > 0 ? await this.oracle.getUsdPrices(balances.map((b) => b.mint)) : {};
    const wallet = splitWallet(balances, prices, (m) => m === SOL_MINT || STABLE_MINTS.has(m));
    for (const inv of wallet.inventory) {
      if (inv.usd <= 0) continue;
      positions.push({
        poolAddress: `inventory:${inv.mint}`,
        poolName: `Inventaire ${inv.mint.slice(0, 6)}…`,
        mintX: inv.mint,
        mintY: inv.mint,
        sizeUsd: inv.usd,
        valueUsd: inv.usd,
      });
    }
    const cashUsd = wallet.cashUsd;
    const deployedUsd = positions.reduce((s, p) => s + p.valueUsd, 0);
    const navUsd = cashUsd + deployedUsd;
    // Pic calibré UNE fois sur la première photo réelle (INITIAL_CASH_USD n'est
    // qu'une valeur par défaut), puis il ne fait que monter.
    if (!this.meta("peak_calibrated")) {
      this.setMeta("peak_nav", navUsd);
      this.setMeta("peak_calibrated", 1);
    }
    let peak = this.meta("peak_nav");
    if (navUsd > peak) {
      peak = navUsd;
      this.setMeta("peak_nav", peak);
    }
    const drawdownPct = peak > 0 ? ((peak - navUsd) / peak) * 100 : 0;
    const exposureByPool: Record<string, number> = {};
    for (const p of positions) exposureByPool[p.poolAddress] = (exposureByPool[p.poolAddress] ?? 0) + p.valueUsd;
    // Stocker la vraie NAV on-chain → le dashboard peut la lire pour détecter la dérive
    this.setMeta("real_nav_usd", navUsd);
    this.setMeta("real_cash_usd", cashUsd);

    // Recalibration du cash suivi quand aucune position n'est ouverte :
    // sans positions déployées, le cash déployable du wallet fait foi.
    if (open.length === 0) {
      // ── Cash ──
      const trackedCash = this.meta("cash");
      const drift = trackedCash - cashUsd;
      if (Math.abs(drift) > 0.50) {
        console.log(
          `  📊 Recalibration cash : $${trackedCash.toFixed(2)} → $${cashUsd.toFixed(2)} (écart ${drift > 0 ? "+" : ""}$${drift.toFixed(2)})`
        );
        this.setMeta("cash", cashUsd);
      }

      // ── Peak NAV ── jamais abaissé automatiquement : le ramener à la NAV courante
      // effacerait le drawdown et réarmerait le disjoncteur après une perte.
      // Si le pic est erroné, le corriger à la main (live_meta.peak_nav).
      if (drawdownPct >= config.MAX_DRAWDOWN_PCT) {
        console.log(
          `  ⚠️  Disjoncteur : pic $${peak.toFixed(2)} vs NAV $${navUsd.toFixed(2)} — entrées suspendues ` +
            `jusqu'à décision humaine (corriger live_meta.peak_nav si le pic est erroné)`
        );
      }
    }

    const dailyLossPct = trackDailyLoss((k) => this.meta(k), (k, v) => this.setMeta(k, v), navUsd);
    return { navUsd, cashUsd, deployedUsd, peakNavUsd: peak, drawdownPct, dailyLossPct, positions, exposureByPool };
  }
}
