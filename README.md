# DLMM Agent

Agent IA de gestion de liquidité **DLMM** (Meteora / Solana) : il repère les pools
intéressantes, évalue le risque, simule ou exécute les positions, et apprend de
ses résultats. Plusieurs agents spécialisés sont orchestrés par LangGraph, avec un
dashboard de supervision Next.js et une couche ML Python optionnelle.

> **Statut** — fonctionnel en **devnet / dry-run / paper trading**. L'exécution
> réelle existe (Agent 3) mais reste derrière plusieurs garde-fous et n'a pas
> encore été validée sur la durée. Rien ne bouge sans action délibérée
> (voir [Sécurité](#sécurité--responsabilité)).

## Vue d'ensemble

```
Scanner (Agent 1, étage 1) → Analyse (Agent 1, étage 2) → Risque (Agent 2, veto)
      → Superviseur humain (optionnel) → Exécution (paper / dry-run / réelle)
      → Journal SQLite → Apprentissage (Agent 5) → Dashboard
```

| Module | Rôle |
|---|---|
| `src/data/meteoraClient.ts` | Liste des pools (`dlmm.datapi.meteora.ag/pools`), normalisation, token de base, mode de fees |
| `src/data/dataApiClient.ts` | OHLCV (découpage automatique en tranches ≤ 4 jours, limite de l'API) |
| `src/data/priceOracle.ts` | Prix USD via Jupiter Price API V3 (stables = 1) |
| `src/analytics/opportunityScanner.ts` | Filtres de sélection + scoring WSM + explications |
| `src/analytics/deepAnalysis.ts` | Volatilité, IL concentré, régime de fees → APR net ajusté du risque |
| `src/analytics/feeApr.ts` | APR de fees, rotation du capital, fees par volume (backtest) |
| `src/analytics/bidAsk.ts` · `positionPlan.ts` | Position bid-ask d'un seul côté (modèle par bins) · choix spot / bid-ask |
| `src/risk/riskAgent.ts` | Verdict auditable : HALT / VETO / APPROVE(_REDUCED) |
| `src/risk/positionSizing.ts` · `hedging.ts` · `dailyLoss.ts` | Plafonds de taille · couverture · perte journalière |
| `src/orchestration/graph.ts` | Graphe LangGraph (boucle, human-in-the-loop) |
| `src/paper/*` | Broker papier, file d'approbations, ticks autonome / supervisé |
| `src/execution/*` | Exécution réelle via le SDK `@meteora-ag/dlmm`, garde-fous, suivi on-chain |
| `src/backtest/*` | Simulateur de position, backtests mono / multi-pools, historique USD du quote |
| `src/learning/*` | Agent 5 : performances, profit factor, calibration, erreurs récurrentes |
| `src/whale/*` | Détection on-chain des gros swaps |
| `src/journal/journal.ts` · `src/portfolio/portfolio.ts` | Journal des décisions · portefeuille du scan (SQLite) |
| `dashboard/` | Dashboard Next.js (même base SQLite) |
| `ml/` | Microservice FastAPI de prédiction de volatilité (optionnel) |

## Installation

```bash
npm install          # Node ≥ 20 ; better-sqlite3 se compile (toolchain C requis)
cp .env.example .env # configuration sûre par défaut : devnet + DRY_RUN=true
npm test             # 207 tests (src/ et test/), hors-ligne
npm run typecheck
```

`npm run setup` fait tout d'un coup (dossier `data/`, `.env`, dépendances racine,
dashboard et ML). Avec npm 11, les scripts d'installation natifs peuvent demander
une approbation (`npm approve-scripts`) ; les tests vérifient que SQLite fonctionne.

## Commandes

| Commande | Effet | Réseau |
|---|---|---|
| `npm run scan` | Un cycle complet scan → analyse → risque → exécution (dry-run par défaut ; **réelle** si `DRY_RUN=false` et un wallet est configuré) | lecture / écriture |
| `npm run paper` | Un tick de paper trading sur prix réels (`--loop` : toutes les heures, `--supervised` : via le dashboard) | lecture |
| `npm run learn` | Rapport de l'Agent 5 sur le journal | aucun |
| `npm run status` | État du système dans le terminal | aucun |
| `npm run backtest -- <pool>` | Backtest walk-forward d'une pool (~30 jours) | lecture |
| `npm run backtest:multi -- <p1> <p2> …` | Backtest multi-pools, capital partagé | lecture |
| `npm run backtest:sltp [-- <pools>]` | Compare 7 couples stop-loss / take-profit | lecture |
| `npm run backtest:strategy [-- <pools>]` | Compare spot, bid-ask et bid-ask après une chute | lecture |
| `npm run whales -- <pool>` | Gros swaps récents d'une pool | lecture RPC |
| `npm run check` | Soldes du wallet configuré | lecture RPC |
| `npm run devnet:wallet` · `devnet:check` · `devnet:run` | Wallet de test devnet, airdrop, test bout-en-bout | devnet |
| `npm run execute -- open <pool> <usd>` | Ouvre une position réelle (garde-fous) | écriture |
| `npm run live` · `npm run daemon` | Suivi des positions réelles · démon autonome (mark, claim, rebalancing, scan) | écriture |

`./start.sh` lance paper trading + dashboard ensemble (`--supervised`,
`--dashboard-only`, `--agent-only`, `--status`).

## Sélection des pools (Agent 1)

L'Agent 1 travaille en **deux étages** : un filtre rapide sur ~1 000 pools, puis
une analyse approfondie (OHLCV, volatilité, IL) des meilleures candidates.

**Filtres** (réglables dans `.env`, `0` = désactivé) — issus des règles des
traders DLMM et vérifiés sur les données réelles (255 → ~45 pools éligibles) :

| Réglage | Défaut | Règle |
|---|---|---|
| — | — | pool non blacklistée, liquidité ≥ 10 k$, volume 24h ≥ 5 k$ |
| — | — | **les deux tokens vérifiés** (sinon tout memecoin face à SOL/USDC passerait) |
| `MIN_VOLUME_TVL_RATIO` | `1` | volume 24h ≥ TVL, sinon la liquidité génère trop peu de fees |
| `MIN_MARKET_CAP_USD` | `1000000` | market cap du token de base ≥ 1 M$ |
| `MIN_RECENT_VOLUME_RATIO` | `0.5` | volume des 4 dernières heures (×6) ≥ 50 % du volume 24h : écarte les pools qui s'éteignent |
| `EXCLUDE_TOKEN_COPIES` | `true` | même symbole qu'un token à plus grosse market cap → copie écartée |
| — | — | **une seule pool par token**, la plus profonde |

**Score** : moyenne pondérée de trois critères normalisés — rendement (fees/TVL),
soutenabilité (volume/liquidité), profondeur (liquidité en log). Les pools qui
versent leurs fees **en SOL ou en stable** (`collect_fee_mode = OnlyY`) reçoivent un
bonus `QUOTE_FEES_SCORE_BONUS` (0,1) : leurs fees ne perdent pas de valeur avec le
memecoin.

**Analyse** : les frais DLMM sont `f_s = f_b + f_v`, où le frais variable `f_v`
croît avec la volatilité. La volatilité est donc à double tranchant (plus de fees,
mais plus d'IL et de sorties de range) : l'agent classe par **APR net d'IL**, pas
par fee brut. Les tokens à volatilité journalière > 100 % ne font pas planter
l'analyse : le scénario de baisse est borné et l'Agent 2 rend un VETO motivé.

## Sécurité & responsabilité

- `DRY_RUN=true` et `NETWORK=devnet` par défaut : aucune transaction réelle.
- Une transaction réelle sur mainnet exige `DRY_RUN=false`, `NETWORK=mainnet-beta`,
  un RPC **réellement** mainnet (vérifié par son hash de genèse) **et**
  `ACKNOWLEDGE_REAL_FUNDS=true` — impossible par accident.
- Le dashboard n'écoute que sur `127.0.0.1` ; l'exposer exige `DASHBOARD_PASSWORD`
  (voir [Dashboard](#dashboard-de-supervision-nextjs)).
- Ordre de validation : **backtest → paper trading → devnet → petits montants**.
- L'IL en liquidité concentrée est **réel et amplifié** ; pour une pool TOKEN/SOL,
  le prix de SOL pèse autant que les fees.
- Utilise un wallet **dédié** avec un capital limité, jamais ton wallet principal,
  et ne committe jamais le `.env`.
- L'humain peut rester dans la boucle (mode supervisé + dashboard).

Aucune métrique ici n'est une garantie de rendement. C'est un outil d'aide à la
décision, pas un conseil financier.

## Agent 2 — Risque (droit de veto)

L'agent de risque a un **droit de veto** sur l'Agent 1. Sa logique, entièrement
auditable (`checks` traçables) :

1. **Disjoncteur drawdown** — si le drawdown ≥ `MAX_DRAWDOWN_PCT`, verdict `HALT` :
   aucune nouvelle entrée, protection du capital.
   **Limite journalière** — si la perte depuis l'ouverture du jour UTC atteint
   `MAX_DAILY_LOSS_PCT` (5 %), `HALT` jusqu'au lendemain : un mauvais jour
   (série de pertes, sur-trading) suspend les entrées sans attendre −15 %.
2. **Checks de veto** — volatilité, APR net minimal, perte de stress, liquidité,
   capital disponible. Un seul échec → `VETO`.
3. **Dimensionnement** — taille = minimum de cinq plafonds indépendants (plafond
   absolu, capital disponible, concentration par pool, part de TVL, budget de
   risque basé sur la perte de stress). Sous le minimum viable → `VETO`.
4. **Verdict** — `APPROVE` (plafond absolu) ou `APPROVE_REDUCED` (bridé par un
   autre plafond), avec taille recommandée et recommandation de couverture.

La **perte de stress** mesure la variation de capital réelle si le prix tombe au
bas du range (pas l'IL vs HODL) — c'est la bonne mesure pour protéger le capital.
La **couverture** calcule la part directionnelle de la position et suggère un short
notionnel ; son exécution viendra avec l'agent d'exécution.

## Valorisation USD et paires TOKEN/SOL

Le stress doit être en USD. Pour une paire TOKEN/USDC, valeur-en-quote ≈ valeur-USD.
Mais pour une paire TOKEN/SOL, la valeur USD de **toute** la position suit le prix
de SOL (`V_usd = (x·p + y)·S`, élasticité 1). Le scénario de stress combine donc :

- le prix du TOKEN qui tombe au bas du range (risque TOKEN/SOL), et
- une chute de SOL/USD de `k·σ` journaliers (risque quote/USD),

supposés corrélés (conservateur). Conséquence : une paire TOKEN/SOL est dimensionnée
plus petit qu'une TOKEN/USDC équivalente, et la couverture signale l'exposition SOL.

Les prix USD viennent de **Jupiter Price API V3** (`src/data/priceOracle.ts`), avec
court-circuit des stablecoins (USDC/USDT = 1). La vol USD du quote est estimée par
défaut (`QUOTE_DAILY_VOL_PCT`) ou calculée depuis une série de référence.

## Orchestration (LangGraph.js)

Les agents sont assemblés en un graphe stateful (`@langchain/langgraph`) :

```
scan → [ analyze → assess → (halt | supervise → execute/skip | skip) ] (boucle) → END
```

- `scan` (Agent 1, étage 1) liste les candidates.
- `analyze` (Agent 1, étage 2) : OHLCV, volatilité, IL, régime de fees.
- `assess` (Agent 2) : verdict de risque. `HALT` coupe toute la boucle (disjoncteur).
- `supervise` : **human-in-the-loop**. En mode `supervised`, le graphe s'interrompt
  (`interrupt`) et attend une décision `{ approved }` ; en mode `autonomous`, il
  applique la politique d'auto-approbation (le risque a déjà filtré).
- `execute` : broker papier, dry-run, ou exécuteur réel (Agent 3) selon le mode et les garde-fous.
- `advance` boucle sur la candidate suivante.

Les dépendances (clients réseau, portefeuille, journal) sont **injectées**
(`OrchestratorDeps`), ce qui rend le graphe testable sans réseau ni SQLite — les
tests couvrent les chemins approve / veto / halt et l'interruption/reprise du
superviseur.

## Agent 5 — Apprentissage & Optimisation

`analyzeJournal(entries)` (fonction pure) transforme l'historique en rapport :

- **Performances** globales et tranchées par régime, pool, verdict (win rate, PnL,
  fees, **profit factor** = gains bruts / pertes brutes).
- **Calibration** : corrélation entre l'APR net *prédit* et le rendement *réalisé*
  annualisé — une faible corrélation signale un modèle à recalibrer.
- **Erreurs récurrentes** : groupes de positions qui perdent systématiquement
  (par régime, couverture, sortie de range, bin step), avec sévérité.
- **Suggestions** concrètes rattachées aux paramètres (`MIN_NET_APR_PCT`,
  `rangeSigma`, couverture, `MAX_POSITION_USD`…).

La « mémoire stratégique » s'incarne dans les agrégats par régime/pool, qui
s'affinent à mesure que les issues s'accumulent. Pour alimenter l'apprentissage,
l'orchestrateur enregistre désormais des **features structurées** sur chaque
décision (régime, volatilité, bin step, couverture, APR net prédit, taille).

Lancer : `npm run learn` (lit le journal et affiche le rapport).

## Validation par backtest (avant tout capital)

`runBacktest(pool, candles)` rejoue l'historique en **walk-forward** : à chaque
pas il ré-exécute toute la chaîne (Agent 1 + Agent 2) sur l'état passé, et si
l'entrée est approuvée, `simulatePosition` calcule l'issue sur la fenêtre suivante
(fees gagnés, variation de valeur LP, sortie de range). Le NAV évolue au fil des
trades, ce qui teste aussi le disjoncteur de drawdown. Les sorties sont des
`JournalEntry` que l'Agent 5 analyse directement.

Le modèle est **délibérément prudent**, et corrigé de deux biais majeurs :

- **Fees issues du volume réel de chaque bougie** : `volume × (fees/volume) / TVL ×
  taille`, et l'APR attendu à chaque pas vient du volume des 24 bougies
  *précédentes*. L'ancien modèle étalait l'activité d'aujourd'hui sur tout le
  passé ; comme le scanner retient les pools très actives aujourd'hui, il
  surestimait les fees d'environ 5×. Restent fixes : le taux de fees et la TVL
  actuels (pas d'historique dans l'API), et le boost de concentration (ignoré).
- **Valorisation en USD** : pour une pool TOKEN/SOL, la valeur est convertie avec
  l'historique du prix de SOL (pool SOL/stable la plus profonde) ; les stops
  réagissent donc aussi à une baisse de SOL.

Les positions peuvent sortir avant la fin de leur fenêtre (`stopLossPct`,
`takeProfitPct`, évalués à chaque clôture) ; le capital est alors réengagé dès la
bougie suivante.

> Un backtest favorable **ne garantit pas** un profit réel : surapprentissage,
> slippage, MEV, changement de régime et approximations du modèle de fees s'y
> ajoutent en conditions réelles. C'est un outil d'aide à la décision, pas un
> conseil financier ni une promesse de rendement. L'étape suivante avant tout
> capital reste le **paper trading** sur mainnet.

Lancer : `npm run backtest -- <adresse_pool>`

Le **backtest multi-pools** (`runMultiBacktest`) va plus loin : un portefeuille
partagé alloue le capital entre plusieurs pools concurrentes. Les pools sont
classées par APR net ajusté et servies dans l'ordre ; chaque ouverture réduit le
capital vu par les suivantes, donc les plafonds d'exposition et de concentration
de l'Agent 2 s'appliquent **réellement entre pools**. C'est ce qui valide
l'allocation, pas seulement le timing d'une pool isolée.

Lancer : `npm run backtest:multi -- <addr1> <addr2> ...` (fees par volume ; la
valorisation USD du quote n'y est pas encore branchée).

### Comparer des variantes sur les mêmes décisions

- `npm run backtest:sltp` compare 7 couples stop-loss / take-profit (dont le
  −4 %/+5 % des traders manuels).
- `npm run backtest:strategy` compare la position **spot** (deux côtés, centrée),
  la **bid-ask d'un seul côté** en SOL/stable, et la bid-ask ouverte **seulement
  après une chute** (5–20 % en 6–24 h).

Résultats observés (8 pools, 30 jours, octobre 2026, SOL −17 %) : aucun couple
SL/TP ne bat nettement la détention (le défaut −8 %/+15 % ≈ détention, −4 %/+5 %
fait moins bien en multipliant les trades) ; la bid-ask gagne beaucoup moins de
fees que le spot et reste perdante, même en attendant une chute (profit factor
< 1, peu de trades). D'où les défauts actuels : sorties −8 %/+15 %, positions spot.
Ces chiffres dépendent de la période : relancer les comparaisons avant de changer
un réglage.

## Paper trading (dernier filtre avant tout capital)

`npm run paper` exécute un **tick** sur les prix réels (mainnet), sans aucune
transaction. Chaque tick :

1. **gère les positions vivantes** : il récupère le prix courant de chaque pool,
   marque les positions au marché (valeur LP + fees accumulés au prorata du temps
   passé en range) et clôture celles ayant atteint `PAPER_HOLDING_DAYS` ;
2. **boucle l'issue sur le journal** (`recordOutcome` sur l'entrée ENTER d'origine)
   → l'Agent 5 apprend de résultats sur prix réels ;
3. **décide et ouvre** : il rejoue le graphe d'orchestration, dont l'exécuteur est
   ici le broker papier.

`--loop` répète le tick toutes les heures. C'est le pont vers l'Agent 3 : ce
dernier remplacera simplement l'exécuteur papier par le SDK réel — même interface.

- **Valorisation USD** : le prix USD du quote est mémorisé à l'ouverture, et la
  valeur de la position suit sa variation (une baisse de SOL se voit dans le PnL).
- **Forme des positions** : `PAPER_STRATEGY=spot` (défaut) ou `sol_bidask`
  (un seul côté en SOL/stable, bins sous le prix, plus chargés en profondeur,
  ≤ 69 bins). Repli automatique sur `spot` si le quote n'est ni SOL ni stable.

## Dashboard de supervision (Next.js)

Un dashboard web (`dashboard/`, App Router) lit le **même fichier SQLite** que les
agents et offre la visibilité et le contrôle :

- portefeuille en direct (NAV, cash, PnL cumulé, drawdown, win rate, profit factor),
  lu dans **une seule source** : positions réelles si le mode live existe, sinon
  paper trading, sinon portefeuille du scan ;
- courbe de PnL, **PnL par jour** (14 derniers jours UTC), positions ouvertes,
  journal des décisions ;
- panneau **Agent 5** (performance par régime, calibration, erreurs récurrentes, suggestions) ;
- panneau **superviseur** : les propositions en attente (mode `--supervised`) se
  valident ou se rejettent en un clic ; l'agent ouvre les positions approuvées au
  tick suivant.

```bash
cd dashboard
npm install            # better-sqlite3 se compile (toolchain C requis)
npm run dev            # http://localhost:3000 (écoute sur 127.0.0.1 uniquement)
```

**Protection** (`dashboard/middleware.ts`, `lib/security.ts`, testés) : le
dashboard peut approuver des trades et demander des clôtures, donc

- sans `DASHBOARD_PASSWORD` : accessible **depuis la machine locale seulement**
  (y compris contre le DNS rebinding) ;
- avec `DASHBOARD_PASSWORD` (à mettre dans `dashboard/.env.local`, ignoré par git) :
  authentification HTTP Basic sur tout le site — **obligatoire pour l'exposer**,
  par exemple sur un VPS derrière un reverse proxy qui transmet l'en-tête `Host` ;
- toute requête qui modifie (`POST /api/…`) doit venir de la même origine et être
  du JSON : un site tiers ne peut pas approuver un trade à ta place (CSRF).

Une approbation porte sur un prix et un portefeuille datés : elle **expire** après
`APPROVAL_TTL_MIN` (120 min) et, avant toute ouverture, l'agent la **revalide**
(prix à moins de 3 % du prix approuvé, nouvelle analyse et agent de risque sur le
portefeuille courant, au plus `MAX_POSITIONS_PER_SCAN` ouvertures par tick). La
position s'ouvre au prix courant, pour min(taille approuvée, taille revalidée) ;
le motif de chaque abandon est conservé dans la file.

Boucle superviseur complète : `npm run paper -- --supervised --loop` (agent, à la
racine) + le dashboard ouvert. Esthétique « terminal de recherche » : fond sombre,
données en monospace, accent ambre.

## Agent 3 — Exécution réelle (devnet d'abord)

L'exécuteur (`src/execution/realExecutor.ts`) ouvre/ferme de vraies positions DLMM
via le SDK officiel `@meteora-ag/dlmm`, mais **toujours derrière un garde-fou** à
plusieurs couches (`executionGate`, testé) :

1. pas de wallet → **REFUSE** ;
2. `SOLANA_RPC_URL` sur un autre réseau que `NETWORK` (hash de genèse) → **REFUSE** ;
3. `DRY_RUN=true` (défaut) → **DRY_RUN** : rien n'est envoyé ;
4. réseau du RPC non vérifiable → **REFUSE** ;
5. envoi réel sur mainnet → **REFUSE** sauf `ACKNOWLEDGE_REAL_FUNDS=true` ;
6. sinon (devnet, ou mainnet+ACK) → **LIVE**.

Il faut donc réunir `DRY_RUN=false`, `NETWORK=mainnet-beta`, un RPC mainnet **et**
`ACKNOWLEDGE_REAL_FUNDS=true` pour qu'un centime réel bouge — impossible par accident.
Le garde-fou s'applique aussi aux swaps Jupiter de l'auto-swap.

**Ce qui est ouvert = ce qui a été évalué.** La position est une forme **Spot** sur
le range que l'agent de risque a évalué (`planPosition`), borné à 69 bins — avec un
petit bin step, ce range est étroit (1 bps → ±0,34 %), et le risque l'évalue tel
quel. Avant tout envoi :

- les montants sont convertis avec le **prix USD du quote** (une pool TOKEN/SOL est
  cotée en SOL, pas en dollars) ;
- le prix on-chain du bin actif doit rester à moins de 3 % du prix analysé ;
- la valeur totale du dépôt construit ne dépasse jamais 110 % de la taille approuvée ;
- les soldes sont vérifiés, SOL natif compris (réserve pour la rent et les frais).

L'exécution manuelle se lance à l'unité ; le démon (`npm run daemon`) et
`npm run scan` exécutent aussi automatiquement dès que `DRY_RUN=false` :

```bash
npm run execute -- open <adresse_pool> <taille_usd>     # devnet + dry-run par défaut
npm run execute -- close <adresse_pool> <position_pubkey>
```

> ⚠️ **Ne pointe pas l'Agent 3 vers du capital réel** tant que le backtest et le
> paper trading n'ont pas confirmé un avantage. Commence sur **devnet** avec un
> wallet **dédié** (jamais ton principal) et de petits montants. En `DRY_RUN`,
> l'ouverture n'interroge pas la chaîne : seul un essai devnet valide la
> construction réelle des transactions. Ce dépôt est un outil d'aide à la
> décision, pas un conseil financier ni une garantie de rendement.

### Cycle de vie des positions on-chain

`LivePositionManager` est l'équivalent réel du broker papier. Après une ouverture
LIVE, la position est enregistrée ; ensuite, à chaque tick :

- **marquage** : lecture de l'état on-chain via le SDK (`getPositionsByUserAndLbPair`),
  conversion des montants + fees réclamables en USD (`positionValueUsd`, testé) ;
- **clôture** à l'échéance (`PAPER_HOLDING_DAYS`) via l'exécuteur réel (donc le
  garde-fou), avec l'issue réelle bouclée dans le journal → l'Agent 5 apprend de
  vrais résultats ;
- **rééquilibrage** d'une position hors range : elle est **fermée**, sans
  réouverture automatique — la réentrée passe par le scan suivant, donc par
  l'agent de risque (disjoncteurs, limite journalière, veto, plafonds).

Un prix USD manquant ne valorise jamais un token à 0 : le marquage est reporté
(dernière valeur conservée), ce qui évite un faux stop-loss sur donnée absente.

```bash
npm run live           # un tick (mark + clôture des échues)
npm run live -- --loop # tick toutes les heures
```

Le marquage est en lecture seule (sûr même en DRY_RUN) ; la clôture respecte le
garde-fou. En live, l'agent de risque décide sur la **photo on-chain** du wallet
(voir ci-dessous), pas sur une caisse interne.

## Couche ML — Prédiction de volatilité (optionnelle)

Un microservice Python/FastAPI (`ml/`) prédit la volatilité **future** d'une pool
et n'utilise un modèle (gradient boosting) **que s'il bat la baseline EWMA** sur
un holdout temporel — sélection transparente et honnête (voir `ml/README.md`).

Côté agent, le client (`src/ml/volatilityClient.ts`) interroge `/predict` quand
`ML_ENABLED=true` ; sinon, ou si le service est injoignable, il retombe
silencieusement sur la volatilité réalisée. La vol prédite dimensionne alors le
range dans `deepAnalyze` (couvrir l'horizon à venir plutôt que le passé). Le
système fonctionne identiquement sans le service — le ML est un bonus, jamais une
dépendance dure.

```bash
cd ml && pip install -r requirements.txt && uvicorn app.main:app --reload
# puis, dans le .env de l'agent : ML_ENABLED=true
```

Le service met les modèles en **cache par pool** et ne ré-entraîne qu'au-delà de
`ttl_seconds` (ré-entraînement périodique). Endpoints additionnels : `POST /train`
(forcer), `GET /models` (état du cache).

## Whale-tracking on-chain

`WhaleTracker` lit les dernières transactions touchant une pool via RPC
(`getSignaturesForAddress` + `getParsedTransactions`) et mesure le mouvement dans
ses coffres (reserveX/reserveY) pour estimer la taille USD de chaque swap — sans
parser d'instructions, uniquement des primitives standard. Il classe les swaps
au-delà de `WHALE_MIN_USD` et déduit une direction nette (accumulation / distribution).

```bash
npm run whales -- <adresse_pool>
```

## Soldes wallet réels

`readWalletBalances` lit le solde on-chain (SOL natif + comptes SPL / Token-2022),
valorisé via l'oracle. `LivePositionManager.realSnapshot()` en tire la photo
utilisée par l'agent de risque en live (`npm run scan`, démon) :

- **cash déployable** = SOL + stablecoins ;
- **inventaire** = tous les autres tokens (restes de positions fermées, souvent du
  memecoin) : compté comme **exposition**, pas comme cash, donc soumis aux plafonds ;
- **pic de NAV** calibré une fois sur la première photo réelle, puis jamais abaissé
  automatiquement : après une perte, le disjoncteur reste armé jusqu'à décision
  humaine (corriger `live_meta.peak_nav` si le pic est erroné).

Les swaps Jupiter de l'auto-swap sont contrôlés avant signature : devis conforme
(tokens, montant, slippage borné, impact ≤ 1 %), transaction limitée aux
programmes du swap et sans virement vers un compte tiers, simulation réussie ; le
résultat on-chain est vérifié après envoi.

## Roadmap

- **Phase 1 ✅** — fondations + Agent 1 complet
- **Phase 2 ✅** — Agent 2 (risque) · orchestration LangGraph · Agent 5 (apprentissage) · backtest mono & multi-pools
- **Phase 3 ✅** — paper trading sur prix réels · dashboard de supervision Next.js
- **Phase 4 ✅** — Agent 3 : exécution réelle DLMM (devnet, garde-fous) + cycle de vie on-chain
- **Phase 5 ✅** — couche ML Python (microservice FastAPI auto-validant, cache + ré-entraînement)
- **Phase 6 ✅** — whale-tracking on-chain · lecture des soldes wallet réels
- **Phase 7 ✅** — règles des traders DLMM : filtres de sélection, limite de perte
  journalière, bonus fees en quote, exclusion des copies · backtest réaliste (fees
  par volume, valorisation USD) et comparaisons SL/TP et spot / bid-ask
- **Prochaines étapes** — paper trading sur la durée · tests bout-en-bout sur
  **devnet** (wallet dédié, petits montants) · déploiement sur un **VPS** (agent en
  démon + dashboard protégé)

## Stack

TypeScript / Node 20+ · LangGraph.js · SDK `@meteora-ag/dlmm` · `@solana/web3.js` ·
API de données Meteora · Jupiter Price API · SQLite (`better-sqlite3`) · Vitest ·
Next.js 15 (dashboard) · Python / FastAPI (ML, optionnel).
