"""Cache de modèles entraînés, avec TTL (ré-entraînement périodique).

Évite de ré-entraîner à chaque /predict : un modèle est conservé par clé (p.ex.
adresse de pool) et ré-entraîné seulement quand il dépasse son TTL. Persistance
disque optionnelle via joblib (MODELS_DIR) pour survivre aux redémarrages.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass

import numpy as np

from .model import train, predict_point, TrainedModel

MODELS_DIR = os.environ.get("MODELS_DIR")  # optionnel


@dataclass
class CacheEntry:
    model: TrainedModel
    trained_at: float


class ModelStore:
    def __init__(self) -> None:
        self._cache: dict[str, CacheEntry] = {}
        if MODELS_DIR:
            os.makedirs(MODELS_DIR, exist_ok=True)

    def _disk_path(self, key: str) -> str | None:
        if not MODELS_DIR:
            return None
        safe = "".join(c if c.isalnum() else "_" for c in key)
        return os.path.join(MODELS_DIR, f"{safe}.joblib")

    def _load_disk(self, key: str) -> CacheEntry | None:
        path = self._disk_path(key)
        if not path or not os.path.exists(path):
            return None
        try:
            import joblib

            return joblib.load(path)
        except Exception:
            return None

    def _save_disk(self, key: str, entry: CacheEntry) -> None:
        path = self._disk_path(key)
        if not path:
            return
        try:
            import joblib

            joblib.dump(entry, path)
        except Exception:
            pass

    def get_fresh(self, key: str, ttl_seconds: float) -> TrainedModel | None:
        entry = self._cache.get(key) or self._load_disk(key)
        if entry is None:
            return None
        if (time.time() - entry.trained_at) > ttl_seconds:
            return None
        self._cache[key] = entry
        return entry.model

    def train_and_store(
        self, key: str, closes, highs, lows, volumes, window: int
    ) -> TrainedModel:
        model = train(closes, highs, lows, volumes, window)
        entry = CacheEntry(model=model, trained_at=time.time())
        self._cache[key] = entry
        self._save_disk(key, entry)
        return model

    def info(self) -> list[dict]:
        now = time.time()
        return [
            {
                "key": k,
                "method": e.model.method,
                "age_seconds": round(now - e.trained_at, 1),
                "model_test_mae": e.model.model_mae,
                "ewma_test_mae": e.model.ewma_mae,
            }
            for k, e in self._cache.items()
        ]


# Instance partagée par le service
store = ModelStore()


def predict_cached(
    key: str, closes, highs, lows, volumes, timeframe: str, window: int, ttl_seconds: float
) -> dict:
    """Réutilise le modèle en cache s'il est frais, sinon ré-entraîne."""
    model = store.get_fresh(key, ttl_seconds)
    retrained = False
    if model is None or model.window != window:
        model = store.train_and_store(key, closes, highs, lows, volumes, window)
        retrained = True
    out = predict_point(model, closes, highs, lows, volumes, timeframe)
    out["retrained"] = retrained
    return out
