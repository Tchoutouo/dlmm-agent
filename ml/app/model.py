"""Entraînement et sélection de modèle, auto-validants.

Politique honnête : on entraîne un GradientBoostingRegressor, on le compare à la
baseline EWMA sur un holdout temporel (sans mélange), et on n'utilise le modèle
QUE s'il bat la baseline. Pour la volatilité, l'EWMA est souvent difficile à
battre — c'est tout l'intérêt de cette sélection transparente.

`train()` renvoie un modèle réutilisable (cacheable) ; `predict_point()` applique
un modèle (entraîné ou non) aux dernières bougies. `predict_volatility()` est le
chemin stateless (entraîne + prédit) conservé pour la compatibilité.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor

from .features import build_dataset, features_at_last
from .volatility import periods_per_day, periods_per_year


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    if a.size == 0:
        return float("nan")
    return float(np.mean(np.abs(a - b)))


@dataclass
class TrainedModel:
    estimator: GradientBoostingRegressor | None  # None si repli EWMA
    method: str  # "model" | "ewma"
    model_mae: float | None
    ewma_mae: float | None
    n_train: int
    n_test: int
    window: int


def train(closes, highs, lows, volumes, window: int) -> TrainedModel:
    """Entraîne et sélectionne (modèle vs EWMA) sur un holdout temporel."""
    X, y, ewma_fc = build_dataset(closes, highs, lows, volumes, window)
    if X.shape[0] < 20:
        return TrainedModel(None, "ewma", None, None, 0, 0, window)

    split = int(X.shape[0] * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]
    ewma_te = np.clip(ewma_fc[split:], 0, None)

    gbr = GradientBoostingRegressor(n_estimators=80, max_depth=3, learning_rate=0.05)
    gbr.fit(X_tr, y_tr)
    model_mae = _mae(np.clip(gbr.predict(X_te), 0, None), y_te)
    ewma_mae = _mae(ewma_te, y_te)

    if model_mae < ewma_mae:
        return TrainedModel(gbr, "model", model_mae, ewma_mae, int(X_tr.shape[0]), int(X_te.shape[0]), window)
    return TrainedModel(None, "ewma", model_mae, ewma_mae, int(X_tr.shape[0]), int(X_te.shape[0]), window)


def predict_point(tm: TrainedModel, closes, highs, lows, volumes, timeframe: str) -> dict:
    """Applique un modèle (entraîné ou repli) aux bougies les plus récentes."""
    ppd = periods_per_day(timeframe)
    ppy = periods_per_year(timeframe)
    feats_last, ewma_last = features_at_last(closes, highs, lows, volumes, tm.window)

    if tm.method == "model" and tm.estimator is not None and feats_last is not None:
        period = float(np.clip(tm.estimator.predict([feats_last])[0], 0, None))
        method = "model"
        note = f"Modele (MAE {tm.model_mae:.5f} < EWMA {tm.ewma_mae:.5f})."
    else:
        period = max(0.0, ewma_last)
        method = "ewma"
        note = (
            "Historique insuffisant : baseline EWMA."
            if tm.n_train == 0
            else f"EWMA retenue (MAE {tm.ewma_mae:.5f} <= modele {tm.model_mae:.5f})."
        )

    return {
        "predicted_period_vol": period,
        "predicted_daily_vol": period * float(np.sqrt(ppd)),
        "predicted_annual_vol": period * float(np.sqrt(ppy)),
        "method": method,
        "model_test_mae": tm.model_mae,
        "ewma_test_mae": tm.ewma_mae,
        "baseline_daily_vol": max(0.0, ewma_last) * float(np.sqrt(ppd)),
        "samples_train": tm.n_train,
        "samples_test": tm.n_test,
        "note": note,
    }


def predict_volatility(closes, highs, lows, volumes, timeframe: str, window: int) -> dict:
    """Chemin stateless : entraine puis predit (sans cache)."""
    tm = train(closes, highs, lows, volumes, window)
    return predict_point(tm, closes, highs, lows, volumes, timeframe)
