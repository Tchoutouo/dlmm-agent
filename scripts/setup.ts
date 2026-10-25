/**
 * Installation et initialisation complète du projet DLMM Agent.
 *
 * USAGE : npx tsx scripts/setup.ts
 *         npm run setup
 *
 * Ce script effectue une seule fois :
 *   ① Vérifie la version de Node.js (≥ 20 requis)
 *   ② Crée le répertoire data/ (journal SQLite)
 *   ③ Copie .env.example → .env si absent
 *   ④ Installe les dépendances Node.js racine (better-sqlite3 compile en natif)
 *   ⑤ Installe les dépendances du dashboard Next.js
 *   ⑥ Installe les dépendances Python (couche ML — optionnel)
 *   ⑦ Affiche le récapitulatif et les prochaines étapes
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// fileURLToPath décode correctement les espaces (%20) et caractères spéciaux
// dans le chemin du dossier (ex: "dlmm-agent (1)").
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD = join(ROOT, "dashboard");
const ML_DIR = join(ROOT, "ml");

const ok = (msg: string) => console.log(`  ✅  ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️   ${msg}`);
const err = (msg: string) => console.log(`  ❌  ${msg}`);
const step = (n: number, title: string) =>
  console.log(`\n${"─".repeat(55)}\n  ${n}. ${title}\n${"─".repeat(55)}`);

function run(cmd: string, cwd?: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        DLMM Agent — Installation & Configuration     ║
╚══════════════════════════════════════════════════════╝
`);

  // ① Node.js version
  step(1, "Vérification de Node.js");
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split(".")[0] ?? "0", 10);
  if (major >= 20) {
    ok(`Node.js ${nodeVer} (≥ 20 requis)`);
  } else {
    err(`Node.js ${nodeVer} trop ancien — installe Node.js 20+ depuis nodejs.org`);
    process.exit(1);
  }

  // ② Répertoire data/
  step(2, "Répertoire data/ (journal SQLite)");
  const dataDir = join(ROOT, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    ok("Répertoire data/ créé");
  } else {
    ok("Répertoire data/ déjà présent");
  }

  // ③ Fichier .env
  step(3, "Configuration .env");
  const envPath = join(ROOT, ".env");
  const envExPath = join(ROOT, ".env.example");
  if (!existsSync(envPath)) {
    if (existsSync(envExPath)) {
      copyFileSync(envExPath, envPath);
      ok(".env créé depuis .env.example");
      warn("Ouvre .env et complète WALLET_SECRET_KEY (voir étape 6)");
    } else {
      warn(".env.example introuvable — crée .env manuellement");
    }
  } else {
    ok(".env déjà présent");
  }
  // Le .env contiendra la clé du wallet : lisible par son seul propriétaire
  if (existsSync(envPath) && process.platform !== "win32") {
    chmodSync(envPath, 0o600);
    ok(".env protégé (droits 600)");
  }

  // ④ Dépendances racine
  step(4, "Dépendances Node.js (racine)");
  if (existsSync(join(ROOT, "node_modules"))) {
    ok("node_modules déjà présent — skip (lance npm install manuellement pour forcer)");
  } else {
    console.log("  Installation en cours (better-sqlite3 compile en natif, ~1-2 min)...");
    if (run("npm install", ROOT)) ok("Dépendances installées");
    else {
      err("npm install échoué. Assure-toi d'avoir Visual Studio Build Tools sur Windows.");
      err("Installe via : npm install --global windows-build-tools");
    }
  }

  // ⑤ Dépendances dashboard
  step(5, "Dépendances dashboard Next.js");
  if (existsSync(join(DASHBOARD, "node_modules"))) {
    ok("dashboard/node_modules déjà présent — skip");
  } else {
    console.log("  Installation en cours...");
    if (run("npm install", DASHBOARD)) ok("Dépendances dashboard installées");
    else err("Échec : cd dashboard && npm install");
  }

  // ⑥ Python (optionnel)
  step(6, "Couche ML Python (optionnelle)");
  const pythonAvailable = spawnSync("python", ["--version"]).status === 0 ||
    spawnSync("python3", ["--version"]).status === 0;
  if (!pythonAvailable) {
    warn("Python non trouvé — la couche ML est optionnelle, l'agent fonctionne sans.");
  } else {
    const pipOk = run(`pip install -r requirements.txt`, ML_DIR) ||
      run(`pip3 install -r requirements.txt`, ML_DIR);
    if (pipOk) ok("Dépendances Python installées");
    else warn("pip install échoué — la couche ML restera désactivée (ML_ENABLED=false)");
  }

  // ⑦ Récapitulatif
  console.log(`
${"═".repeat(55)}
  INSTALLATION TERMINÉE — Prochaines étapes
${"═".repeat(55)}

  📌 DÉMARRAGE RAPIDE (paper trading + dashboard)
     Windows (PowerShell) :  .\\start.ps1
     Ou manuellement en deux terminaux :
       Terminal 1 → npm run paper -- --loop --supervised
       Terminal 2 → cd dashboard && npm run dev
       Navigateur → http://localhost:3000

  📌 TESTS DEVNET (zero capital réel)
     1. npm run devnet:wallet       → génère un keypair dédié
     2. Colle la clé dans .env      (WALLET_SECRET_KEY=...)
     3. npm run devnet:check        → airdrop SOL devnet automatique
     4. npm run devnet:run          → test complet DRY_RUN
     5. npm run devnet:run:live     → exécution réelle devnet
                                      (requiert DRY_RUN=false)

  📌 TOUTES LES COMMANDES
     npm run scan                   → scan marché (lecture seule)
     npm run paper -- --loop        → paper trading en boucle
     npm run paper -- --supervised  → mode superviseur (dashboard)
     npm run learn                  → rapport apprentissage Agent 5
     npm run backtest -- <pool>     → backtest historique
     npm run whales -- <pool>       → whale-tracking on-chain
     npm run live -- --loop         → cycle de vie positions réelles
     npm run status                 → état du journal en terminal
     npm test                       → 83 tests unitaires
     npm run typecheck              → vérification des types

  📌 COUCHE ML (optionnelle)
     cd ml
     uvicorn app.main:app --reload
     → puis ML_ENABLED=true dans .env

  ⚠️  NE JAMAIS committer .env (clé de wallet)
  ⚠️  Commencer sur devnet avant tout capital réel
`);
}

main().catch((e) => {
  console.error("Erreur setup :", e.message);
  process.exit(1);
});
