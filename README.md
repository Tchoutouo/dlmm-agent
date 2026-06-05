# DLMM Agent — Socle Phase 1

Agent IA autonome de gestion de liquidité **DLMM** (Meteora / Solana).
Ce dépôt contient la **Phase 1 : Fondations** — collecte de données, analyse de marché
et journal de trading intelligent. Lecture seule, aucune transaction réelle.

## Ce qui est implémenté

Agent 1 fonctionne en **deux étages** : un filtre rapide sur toutes les pools, puis
une analyse approfondie ajustée du risque sur les meilleures candidates seulement
(respecte les rate limits de l'API de données).

| Module | Rôle | Étage |
|---|---|---|
| `src/data/meteoraClient.ts` | Lecture API pair/all, normalisation | 1 |
| `src/analytics/opportunityScanner.ts` | Filtrage + scoring WSM + explications | 1 |
| `src/data/dataApiClient.ts` | OHLCV via `dlmm.datapi.meteora.ag` | 2 |
| `src/data/priceOracle.ts` | Prix USD via Jupiter Price API V3 (+ stables) | risque |
| `src/analytics/quoteRisk.ts` | Profil du quote + shock de stress USD (TOKEN/SOL) | risque |
| `src/analytics/volatility.ts` | Vol. réalisée (close-to-close + Parkinson), anomalies de volume | 2 |
| `src/analytics/dlmmFees.ts` | Frais de base (formule officielle) + régime de fees | 2 |
| `src/analytics/impermanentLoss.ts` | IL concentré (CLMM borné) + suggestion de range | 2 |
| `src/analytics/deepAnalysis.ts` | Combine tout → APR ajusté du risque + rationale | 2 |
| `src/analytics/feeApr.ts` | Fee APR proxy, rotation, APR net d'IL | 1/2 |
| `src/risk/positionSizing.ts` | Plafonds de dimensionnement (min de tous) | risque |
| `src/risk/hedging.ts` | Exposition directionnelle + hedge ratio | risque |
| `src/risk/riskAgent.ts` | Verdict auditable : HALT/VETO/APPROVE(_REDUCED) | risque |
| `src/portfolio/portfolio.ts` | Suivi NAV, positions, drawdown (SQLite) | risque |
| `src/orchestration/graph.ts` | Graphe LangGraph : nœuds + boucle + human-in-the-loop | orchestration |
| `src/orchestration/deps.ts` | Interface de dépendances injectées + exécution dry-run | orchestration |
| `src/orchestration/productionDeps.ts` | Câblage des clients réels | orchestration |
| `src/learning/performance.ts` | Métriques de perf + calibration prédit/réalisé | Agent 5 |
| `src/learning/recurringErrors.ts` | Détection d'erreurs récurrentes par feature | Agent 5 |
| `src/learning/suggestions.ts` | Suggestions d'amélioration concrètes | Agent 5 |
| `src/learning/learningAgent.ts` | Rapport d'apprentissage complet (+ rendu texte) | Agent 5 |
| `src/backtest/positionSimulator.ts` | Simule fees + variation de valeur + sortie de range | backtest |
| `src/backtest/backtester.ts` | Walk-forward mono-pool : rejoue Agent 1+2 | backtest |
| `src/backtest/multiBacktester.ts` | Walk-forward multi-pools, capital partagé, allocation | backtest |
| `src/paper/paperPnl.ts` | Marquage au marché + accrual de fees (pur) | paper |
| `src/paper/paperBroker.ts` | Positions simulées persistées, marquage, clôture | paper |
| `src/paper/paperDeps.ts` | Deps orchestrateur en mode paper + tick | paper |
| `src/execution/safetyGate.ts` | Garde-fou : REFUSE / DRY_RUN / LIVE (pur) | Agent 3 |
| `src/execution/wallet.ts` | Chargement wallet base58 + connexion RPC | Agent 3 |
| `src/execution/strategyMap.ts` | Régime → stratégie DLMM (Spot/Curve/BidAsk) | Agent 3 |
| `src/execution/realExecutor.ts` | Ouverture/fermeture de position via le SDK | Agent 3 |
| `src/execution/positionValue.ts` | Valorisation USD on-chain (pur) | Agent 3 |
| `src/execution/livePositionManager.ts` | Suivi/mark/clôture des positions réelles | Agent 3 |
| `src/execution/walletBalance.ts` | Lecture des soldes wallet réels → USD | Agent 3 |
| `src/whale/swapValue.ts` | Magnitude USD d'un swap (pur) | whale |
| `src/whale/whaleTracker.ts` | Détection on-chain des gros swaps (RPC) | whale |
| `src/ml/volatilityClient.ts` | Client du service ML (repli gracieux) | ML |
| `ml/` (Python) | Microservice FastAPI + cache de modèles (TTL) | ML |
| `src/journal/journal.ts` | Journal SQLite : décisions + features + post-mortem | — |

Le **scoring étage 1** combine trois critères normalisés (min-max) : rendement
(fees/TVL), soutenabilité (volume/liquidité), profondeur (liquidité en log).

L'**analyse étage 2** s'appuie sur la mécanique réelle du DLMM : les frais sont
`f_s = f_b + f_v`, où le frais variable `f_v` croît avec la volatilité. La volatilité
est donc à double tranchant (plus de fees, mais plus d'IL et de sorties de range).
L'agent classe par **APR net d'IL**, pas par fee brut.

### Deux API officielles, complémentaires

- `dlmm-api.meteora.ag/pair/all` — liste des pools + métriques de fees (`fee_tvl_ratio`).
- `dlmm.datapi.meteora.ag/pools/{addr}/ohlcv` — historique OHLCV pour la volatilité (30 RPS).

### Sur le suivi des whales

Le proxy actuel (`detectVolumeAnomalies`) repère les pics de volume anormaux à partir
de l'OHLCV — honnête et suffisant pour signaler une activité importante. Le vrai
whale-tracking par wallet exige le parsing on-chain (RPC `getSignaturesForAddress` +
décodage des swaps) ou un indexeur tiers ; il est planifié comme enrichissement de
l'agent d'exécution en Phase 2.

## Installation

```bash
npm install          # nécessite un toolchain C (better-sqlite3 se compile)
cp .env.example .env # config sécurisée par défaut (devnet + dry-run)
```

## Utilisation

```bash
npm run scan         # scanne le marché, classe les opportunités, journalise
npm run learn        # analyse le journal : perfs, erreurs récurrentes, suggestions
npm run backtest -- <adresse_pool>   # rejoue l'historique et valide la stratégie
npm run backtest:multi -- <addr1> <addr2> ...  # multi-pools, capital partagé
npm run paper        # paper trading sur prix réels (un tick) ; --loop pour boucler
npm test             # vérifie la justesse des maths (IL, scoring)
npm run typecheck    # vérification stricte des types
```

> Note : `npm run scan` interroge l'API Meteora en direct — nécessite donc un
> accès réseau à `dlmm-api.meteora.ag`. Les tests, eux, sont hors-ligne.

## Sécurité & responsabilité

Ce socle est **en lecture seule**. Quand l'exécution arrivera (Phase 2) :

- `DRY_RUN=true` reste le défaut — aucune transaction tant qu'on ne le désactive pas.
- Commence sur **devnet**, puis **paper trading** sur mainnet avant tout capital réel.
- L'IL en liquidité concentrée est **réel et amplifié** : un range serré démultiplie
  les fees mais aussi le risque de sortie de range. L'agent de risque arbitre les deux.
- Utilise un wallet **dédié** avec un capital limité, jamais ton wallet principal.
- L'humain reste dans la boucle : l'agent superviseur valide les décisions importantes.

Aucune de ces métriques n'est une garantie de rendement. C'est un outil d'aide à la
décision, pas un conseil financier.

### Agent 2 — Risque (droit de veto)

L'agent de risque a un **droit de veto** sur l'Agent 1. Sa logique, entièrement
auditable (`checks` traçables) :

1. **Disjoncteur drawdown** — si le drawdown ≥ `MAX_DRAWDOWN_PCT`, verdict `HALT` :
   aucune nouvelle entrée, protection du capital.
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

### Valorisation USD et paires TOKEN/SOL

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

### Orchestration (LangGraph.js)

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
- `execute` (Agent 3, **placeholder dry-run**) : aucune transaction réelle pour l'instant.
- `advance` boucle sur la candidate suivante.

Les dépendances (clients réseau, portefeuille, journal) sont **injectées**
(`OrchestratorDeps`), ce qui rend le graphe testable sans réseau ni SQLite — les
tests couvrent les chemins approve / veto / halt et l'interruption/reprise du
superviseur.

### Agent 5 — Apprentissage & Optimisation

`analyzeJournal(entries)` (fonction pure) transforme l'historique en rapport :

- **Performances** globales et tranchées par régime, pool, verdict (win rate, PnL, fees).
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

### Validation par backtest (avant tout capital)

`runBacktest(pool, candles)` rejoue l'historique en **walk-forward** : à chaque
pas il ré-exécute toute la chaîne (Agent 1 + Agent 2) sur l'état passé, et si
l'entrée est approuvée, `simulatePosition` calcule l'issue sur la fenêtre suivante
(fees gagnés, variation de valeur LP, sortie de range). Le NAV évolue au fil des
trades, ce qui teste aussi le disjoncteur de drawdown. Les sorties sont des
`JournalEntry` que l'Agent 5 analyse directement.

Le modèle de fees est **délibérément conservateur** (il sous-estime probablement
le boost de concentration) : pour un outil dont le but est de *ne pas perdre*,
mieux vaut un backtest prudent qu'optimiste.

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

Lancer : `npm run backtest:multi -- <addr1> <addr2> ...`

### Paper trading (dernier filtre avant tout capital)

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

## Dashboard de supervision (Next.js)

Un dashboard web (`dashboard/`, App Router) lit le **même fichier SQLite** que les
agents et offre la visibilité et le contrôle :

- portefeuille papier en direct (NAV, cash, PnL cumulé, drawdown, win rate) ;
- courbe de PnL, positions ouvertes, journal des décisions ;
- panneau **Agent 5** (performance par régime, calibration, erreurs récurrentes, suggestions) ;
- panneau **superviseur** : les propositions en attente (mode `--supervised`) se
  valident ou se rejettent en un clic ; l'agent ouvre les positions approuvées au
  tick suivant.

```bash
cd dashboard
npm install            # better-sqlite3 se compile (toolchain C requis)
npm run dev            # http://localhost:3000
```

Boucle superviseur complète : `npm run paper -- --supervised --loop` (agent, à la
racine) + le dashboard ouvert. Esthétique « terminal de recherche » : fond sombre,
données en monospace, accent ambre.

## Agent 3 — Exécution réelle (devnet d'abord)

L'exécuteur (`src/execution/realExecutor.ts`) ouvre/ferme de vraies positions DLMM
via le SDK officiel `@meteora-ag/dlmm`, mais **toujours derrière un garde-fou** à
plusieurs couches (`executionGate`, testé) :

1. pas de wallet → **REFUSE** ;
2. `DRY_RUN=true` (défaut) → **DRY_RUN** : la transaction est construite mais jamais envoyée ;
3. envoi réel sur mainnet → **REFUSE** sauf `ACKNOWLEDGE_REAL_FUNDS=true` ;
4. sinon (devnet, ou mainnet+ACK) → **LIVE**.

Il faut donc réunir `DRY_RUN=false` **et** `NETWORK=mainnet-beta` **et**
`ACKNOWLEDGE_REAL_FUNDS=true` pour qu'un centime réel bouge — impossible par accident.

La stratégie de range suit le régime de l'Agent 1 (calm→Curve, active→Spot,
volatile→BidAsk). L'exécution se lance **délibérément et à l'unité** (jamais dans
une boucle automatique) :

```bash
npm run execute -- open <adresse_pool> <taille_usd>     # devnet + dry-run par défaut
npm run execute -- close <adresse_pool> <position_pubkey>
```

> ⚠️ **Ne pointe pas l'Agent 3 vers du capital réel** tant que le backtest et le
> paper trading n'ont pas confirmé un avantage. Commence sur **devnet** avec un
> wallet **dédié** (jamais ton principal) et de petits montants. La conversion
> taille USD → montants de tokens suppose un quote stable et doit être validée
> sur devnet. Ce dépôt est un outil d'aide à la décision, pas un conseil financier
> ni une garantie de rendement.

### Cycle de vie des positions on-chain

`LivePositionManager` est l'équivalent réel du broker papier. Après une ouverture
LIVE, la position est enregistrée ; ensuite, à chaque tick :

- **marquage** : lecture de l'état on-chain via le SDK (`getPositionsByUserAndLbPair`),
  conversion des montants + fees réclamables en USD (`positionValueUsd`, testé) ;
- **clôture** à l'échéance (`PAPER_HOLDING_DAYS`) via l'exécuteur réel (donc le
  garde-fou), avec l'issue réelle bouclée dans le journal → l'Agent 5 apprend de
  vrais résultats.

```bash
npm run live           # un tick (mark + clôture des échues)
npm run live -- --loop # tick toutes les heures
```

Le marquage est en lecture seule (sûr même en DRY_RUN) ; la clôture respecte le
garde-fou. La caisse interne (amorcée par `INITIAL_CASH_USD`) sert au
dimensionnement du risque — lire les soldes réels du wallet est un raffinement.

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

`readWalletUsd` lit le solde on-chain (SOL natif + comptes SPL / Token-2022) et le
valorise via l'oracle. `LivePositionManager.realSnapshot()` l'utilise pour un NAV
réel (cash on-chain + positions), utilisé par `npm run live`.

## Roadmap

- **Phase 1 ✅** — fondations + Agent 1 complet
- **Phase 2 ✅** — Agent 2 (risque) · orchestration LangGraph · Agent 5 (apprentissage) · backtest mono & multi-pools
- **Phase 3 ✅** — paper trading sur prix réels · dashboard de supervision Next.js
- **Phase 4 ✅** — Agent 3 : exécution réelle DLMM (devnet, garde-fous) + cycle de vie on-chain
- **Phase 5 ✅** — couche ML Python (microservice FastAPI auto-validant, cache + ré-entraînement)
- **Phase 6 ✅** — whale-tracking on-chain · lecture des soldes wallet réels
- **Prochaine étape utilisateur** — tests bout-en-bout sur **devnet** (wallet dédié, petits montants) (pilote les interruptions)

## Stack

TypeScript / Node 20+ · API Meteora (lecture) · SQLite (journal) · Vitest (tests).
Le SDK `@meteora-ag/dlmm` et la couche ML Python arrivent aux phases suivantes.
