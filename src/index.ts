import { buildOrchestrator } from "./orchestration/graph.js";
import { createClients, createProductionDeps } from "./orchestration/productionDeps.js";
import { config } from "./config.js";

/**
 * Point d'entrée : exécute le graphe d'orchestration multi-agents en mode
 * autonome (lecture seule, dry-run). Le superviseur (human-in-the-loop) est
 * câblé et testé ; il s'active en mode "supervised" et sera piloté par le
 * dashboard Next.js (Phase 4) via interrupt/resume.
 */
async function main() {
  console.log(`▶ Orchestrateur DLMM — réseau=${config.NETWORK} dry_run=${config.DRY_RUN}\n`);

  const clients = createClients();
  const deps = createProductionDeps(clients);
  const graph = buildOrchestrator(deps).compile();

  // topN × ~6 nœuds par candidat + marge → 150 couvre jusqu'à ~20 candidats
  const result = await graph.invoke({ mode: "autonomous" }, { recursionLimit: 150 });

  console.log(`\n── Décisions (${result.decisions.length}) ──`);
  for (const d of result.decisions) {
    const tag = d.decision === "ENTER" ? `ENTER $${d.sizeUsd.toFixed(0)}` : d.decision;
    console.log(`• ${d.poolName.padEnd(16)} ${tag}${d.verdict ? `  [${d.verdict}]` : ""}`);
    if (d.note) console.log(`    ${d.note}`);
  }
  if (result.halted) console.log("\n⚠ Disjoncteur activé — entrées suspendues.");

  clients.journal.close();
  clients.portfolio.close();
  clients.manager?.close();
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
