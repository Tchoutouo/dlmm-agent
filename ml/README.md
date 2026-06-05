# Service ML — Prédiction de volatilité

Microservice FastAPI qui prédit la volatilité **future** d'une pool à partir de
son historique OHLCV. Conçu « data-light » : l'agent TypeScript possède déjà les
bougies (il les fetch) et les **poste** ici ; le service se concentre sur le
calcul et la prédiction. Stateless.

## Politique honnête (auto-validation)

À chaque requête, le service :

1. construit un dataset supervisé (features passées → vol réalisée future) ;
2. entraîne un `GradientBoostingRegressor` sur 80 % (split **temporel**, sans mélange) ;
3. le compare à la **baseline EWMA** (RiskMetrics) sur les 20 % restants ;
4. n'utilise le modèle **que s'il bat l'EWMA** sur ce holdout, sinon il renvoie l'EWMA.

Pour la volatilité, l'EWMA est souvent difficile à battre : cette sélection
transparente évite de surévaluer le ML. La réponse indique toujours la méthode
retenue et les MAE des deux approches.

## Lancer

```bash
cd ml
pip install -r requirements.txt
uvicorn app.main:app --reload      # http://localhost:8000
pytest                              # tests
```

## Endpoints

- `GET /health` → `{ "status": "ok" }`
- `POST /predict` — corps : `{ candles: [{timestamp,open,high,low,close,volume}], timeframe, window }`
  → `{ predicted_daily_vol, predicted_annual_vol, method, model_test_mae, ewma_test_mae, ... }`

## Intégration côté agent

Activer dans le `.env` de l'agent : `ML_ENABLED=true` et `ML_SERVICE_URL`.
Le client TS (`src/ml/volatilityClient.ts`) interroge `/predict` ; en cas
d'indisponibilité, il retombe silencieusement sur la volatilité réalisée. La vol
prédite sert alors à dimensionner le range (couvrir l'horizon à venir plutôt que
le passé) dans `deepAnalyze`.
