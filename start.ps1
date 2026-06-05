# ============================================================
#  DLMM Agent — Démarrage complet (Windows PowerShell)
#  Lance le paper trading + le dashboard dans deux fenêtres.
#
#  USAGE :
#    .\start.ps1                   # paper trading autonome + dashboard
#    .\start.ps1 -Supervised       # mode superviseur (approbation via dashboard)
#    .\start.ps1 -DashboardOnly    # dashboard seul (si agent tourne ailleurs)
#    .\start.ps1 -AgentOnly        # agent seul (sans dashboard)
#    .\start.ps1 -Status           # affiche l'état du journal en terminal
# ============================================================

param(
  [switch]$Supervised,
  [switch]$DashboardOnly,
  [switch]$AgentOnly,
  [switch]$Status
)

$Root = $PSScriptRoot
$Dashboard = Join-Path $Root "dashboard"

# ── Vérifications préliminaires ──────────────────────────────

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Write-Host ""
  Write-Host "  ❌  node_modules manquant — lance d'abord :" -ForegroundColor Red
  Write-Host "       npm run setup" -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

if (-not (Test-Path (Join-Path $Dashboard "node_modules"))) {
  Write-Host ""
  Write-Host "  ❌  dashboard/node_modules manquant — lance d'abord :" -ForegroundColor Red
  Write-Host "       npm run setup" -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

# ── Mode Status ──────────────────────────────────────────────

if ($Status) {
  npm run status
  exit 0
}

# ── Mode Agent seul ──────────────────────────────────────────

if ($AgentOnly) {
  $agentCmd = if ($Supervised) { "npm run paper -- --loop --supervised" } else { "npm run paper -- --loop" }
  Write-Host ""
  Write-Host "  ▶  Agent paper trading (sans dashboard)" -ForegroundColor Cyan
  Write-Host "     $agentCmd" -ForegroundColor Gray
  Write-Host ""
  Invoke-Expression $agentCmd
  exit 0
}

# ── Mode Dashboard seul ──────────────────────────────────────

if ($DashboardOnly) {
  Write-Host ""
  Write-Host "  ▶  Dashboard Next.js → http://localhost:3000" -ForegroundColor Cyan
  Write-Host ""
  Set-Location $Dashboard
  npm run dev
  exit 0
}

# ── Mode complet : Agent + Dashboard ─────────────────────────

$agentFlag = if ($Supervised) { "--loop --supervised" } else { "--loop" }
$agentCmd  = "npm run paper -- $agentFlag"
$label     = if ($Supervised) { "supervisé (approbations via dashboard)" } else { "autonome" }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor DarkCyan
Write-Host "  ║        DLMM Agent — Démarrage complet               ║" -ForegroundColor DarkCyan
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Mode agent   : $label" -ForegroundColor White
Write-Host "  Dashboard    : http://localhost:3000" -ForegroundColor White
Write-Host ""

# Fenêtre 1 : Agent paper trading
$agentWindow = @"
  Write-Host '  ▶ Agent paper trading ($label)' -ForegroundColor Cyan
  Set-Location '$Root'
  $agentCmd
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $agentWindow

# Délai pour laisser l'agent créer le journal avant que le dashboard l'ouvre
Start-Sleep -Seconds 3

# Fenêtre 2 : Dashboard Next.js
$dashWindow = @"
  Write-Host '  ▶ Dashboard Next.js → http://localhost:3000' -ForegroundColor Cyan
  Set-Location '$Dashboard'
  npm run dev
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $dashWindow

Write-Host "  ✅  Les deux processus ont démarré dans des fenêtres séparées." -ForegroundColor Green
Write-Host ""
Write-Host "  Ouvre http://localhost:3000 dans ton navigateur." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Raccourcis utiles :" -ForegroundColor White
Write-Host "    npm run status           → état du journal en terminal" -ForegroundColor Gray
Write-Host "    npm run learn            → rapport apprentissage Agent 5" -ForegroundColor Gray
Write-Host "    Ctrl+C dans chaque fenêtre pour arrêter" -ForegroundColor Gray
Write-Host ""
