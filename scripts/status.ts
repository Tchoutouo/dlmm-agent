/**
 * Tableau de bord terminal — état instantané du système.
 *
 * USAGE : npm run status
 *
 * Affiche (sans réseau, lecture seule SQLite) :
 *   • Portefeuille papier : NAV, cash, drawdown, positions ouvertes
 *   • Journal : dernières décisions, performance par pool
 *   • Agent 5 (apprentissage) : win rate, erreurs récurrentes, suggestions
 */

import "dotenv/config";
import { existsSync } from "fs";
import { TradeJournal } from "../src/journal/journal.js";
import { Portfolio } from "../src/portfolio/portfolio.js";
import { analyzeJournal } from "../src/learning/learningAgent.js";
import { config } from "../src/config.js";

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const bar = (title: string) =>
  console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`);

function main() {
  if (!existsSync(config.JOURNAL_DB_PATH)) {
    console.log(`
  ℹ️   Aucun journal trouvé (${config.JOURNAL_DB_PATH}).

  Lance au moins un scan pour créer des données :
    npm run paper                  # paper trading (un tick)
    npm run scan                   # scan lecture seule

  Ou installe le projet si ce n'est pas fait :
    npm run setup
`);
    return;
  }

  const journal = new TradeJournal();
  const portfolio = new Portfolio();
  const snap = portfolio.snapshot();
  const entries = journal.allEntries(500);
  const report = analyzeJournal(entries);
  const recent = journal.recent(10);
  const perf = journal.performanceByPool();

  // ── Portefeuille ──

  bar("💼  Portefeuille");

  const navColor = snap.navUsd >= (config.INITIAL_CASH_USD ?? 1000) ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  console.log(`  NAV           : ${navColor}${usd(snap.navUsd)}${reset}`);
  console.log(`  Cash          : ${usd(snap.cashUsd)}`);
  console.log(`  Positions     : ${snap.positions.length} ouverte(s)`);
  console.log(`  Drawdown      : ${snap.drawdownPct > 0 ? "\x1b[31m" : ""}${snap.drawdownPct.toFixed(1)}%${reset}`);

  if (snap.positions.length > 0) {
    console.log(`\n  Positions ouvertes :`);
    for (const p of snap.positions) {
      const diff = ((p.valueUsd - p.sizeUsd) / p.sizeUsd) * 100;
      const color = diff >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `    • ${p.poolName.padEnd(20)} ${usd(p.sizeUsd).padStart(8)} → ${color}${usd(p.valueUsd)}${reset} (${pct(diff)})`
      );
    }
  }

  // ── Journal ──

  bar("📋  Journal — 10 dernières décisions");

  if (recent.length === 0) {
    console.log("  Aucune décision enregistrée.");
  } else {
    for (const e of recent) {
      const tag = e.decision === "ENTER" ? `\x1b[32mENTER\x1b[0m` : e.decision === "SKIP" ? "SKIP " : "\x1b[33mHALT \x1b[0m";
      const size = e.sizeUsd ? usd(e.sizeUsd).padStart(7) : "      ";
      const pnl =
        e.realizedPnlUsd !== undefined
          ? `  pnl=${e.realizedPnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m"}${pct(0) === "+0.0%" ? "" : ""}$${e.realizedPnlUsd.toFixed(1)}\x1b[0m`
          : "";
      const ts = e.timestamp.slice(0, 16).replace("T", " ");
      console.log(`  ${ts}  ${tag}  ${e.poolName.padEnd(18)}${size}${pnl}`);
    }
  }

  // ── Performance par pool ──

  if (perf.length > 0) {
    bar("📊  Performance par pool");
    for (const p of perf.slice(0, 8)) {
      const wr =
        p.winRate !== null ? `win=${Math.round(p.winRate * 100)}%` : "win=—  ";
      const pnl =
        p.avgRealizedPnl !== null
          ? `pnl=${p.avgRealizedPnl >= 0 ? "\x1b[32m" : "\x1b[31m"}$${p.avgRealizedPnl.toFixed(1)}\x1b[0m`
          : "pnl=—";
      console.log(
        `  ${p.poolName.padEnd(22)} x${p.decisions}  ${wr}  ${pnl}`
      );
    }
  }

  // ── Apprentissage (Agent 5) ──

  bar("🧠  Agent 5 — Apprentissage");

  const ov = report.overall;
  console.log(`  Total décisions : ${ov.decisions}  (avec issue : ${ov.withOutcome})`);
  if (ov.winRate !== null) {
    const color = ov.winRate >= 0.5 ? "\x1b[32m" : "\x1b[31m";
    console.log(`  Win rate global  : ${color}${(ov.winRate * 100).toFixed(0)}%\x1b[0m`);
    console.log(`  PnL moyen        : $${(ov.avgPnlUsd ?? 0).toFixed(1)}`);
  } else {
    console.log("  Win rate         : — (pas encore d'issues)");
  }

  if (report.calibration.correlation !== null) {
    console.log(
      `  Calibration      : corrélation prédit↔réalisé ${report.calibration.correlation.toFixed(2)} (${report.calibration.samples} pts)`
    );
  }

  if (report.recurringErrors.length > 0) {
    console.log(`\n  Erreurs récurrentes :`);
    for (const e of report.recurringErrors.slice(0, 3)) {
      const sev = e.severity === "high" ? "\x1b[31m⚠ \x1b[0m" : "\x1b[33m! \x1b[0m";
      console.log(`    ${sev}${e.description} — $${e.avgPnlUsd.toFixed(1)} moy`);
    }
  }

  if (report.suggestions.length > 0) {
    console.log(`\n  Suggestions :`);
    for (const s of report.suggestions.slice(0, 3)) {
      console.log(`    → ${s.recommendation}`);
    }
  }

  // ── Pied de page ──

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Réseau : ${config.NETWORK}  |  DRY_RUN : ${config.DRY_RUN}  |  ${new Date().toLocaleString("fr-FR")}`);
  console.log(`  Dashboard web  → cd dashboard && npm run dev  (http://localhost:3000)`);
  console.log(`${"─".repeat(60)}\n`);

  journal.close();
  portfolio.close();
}

main();
