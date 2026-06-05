"""Microservice FastAPI de prediction de volatilite.

Stateless par defaut et "data-light" : le client TS possede deja l'OHLCV et le
poste ici. Avec une 'key', le modele est mis en cache et re-entraine seulement
au-dela de son TTL (re-entrainement periodique).

Lancer :  uvicorn app.main:app --reload  (depuis le dossier ml/)
"""
from __future__ import annotations

import numpy as np
from fastapi import FastAPI

from .schemas import (
    PredictRequest, PredictResponse, TrainRequest, TrainResponse, ModelInfo,
)
from .model import predict_volatility
from .store import store, predict_cached

app = FastAPI(title="DLMM Volatility Service", version="0.2.0")


def _arrays(candles):
    closes = np.array([x.close for x in candles], dtype=float)
    highs = np.array([x.high for x in candles], dtype=float)
    lows = np.array([x.low for x in candles], dtype=float)
    volumes = np.array([x.volume for x in candles], dtype=float)
    return closes, highs, lows, volumes


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "volatility", "cached_models": len(store.info())}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    closes, highs, lows, volumes = _arrays(req.candles)
    if req.key:
        out = predict_cached(req.key, closes, highs, lows, volumes, req.timeframe, req.window, req.ttl_seconds)
    else:
        out = predict_volatility(closes, highs, lows, volumes, req.timeframe, req.window)
        out["retrained"] = True
    return PredictResponse(**out)


@app.post("/train", response_model=TrainResponse)
def train_endpoint(req: TrainRequest) -> TrainResponse:
    closes, highs, lows, volumes = _arrays(req.candles)
    m = store.train_and_store(req.key, closes, highs, lows, volumes, req.window)
    return TrainResponse(
        key=req.key, method=m.method, model_test_mae=m.model_mae,
        ewma_test_mae=m.ewma_mae, samples_train=m.n_train, samples_test=m.n_test,
    )


@app.get("/models", response_model=list[ModelInfo])
def models() -> list[ModelInfo]:
    return [ModelInfo(**m) for m in store.info()]
