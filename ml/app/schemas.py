"""Schemas d'API (pydantic v2)."""
from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class Candle(BaseModel):
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class PredictRequest(BaseModel):
    candles: list[Candle] = Field(..., min_length=2)
    timeframe: str = "1h"
    window: int = Field(24, ge=2, description="Taille de la fenetre (en bougies)")
    # Mise en cache optionnelle : si 'key' est fourni, le modele est reutilise
    # tant qu'il est plus jeune que ttl_seconds (re-entrainement periodique).
    key: str | None = None
    ttl_seconds: float = 3600.0


class PredictResponse(BaseModel):
    predicted_period_vol: float
    predicted_daily_vol: float
    predicted_annual_vol: float
    method: Literal["model", "ewma"]
    model_test_mae: float | None
    ewma_test_mae: float | None
    baseline_daily_vol: float
    samples_train: int
    samples_test: int
    note: str
    retrained: bool = True


class TrainRequest(BaseModel):
    candles: list[Candle] = Field(..., min_length=2)
    timeframe: str = "1h"
    window: int = Field(24, ge=2)
    key: str = Field(..., description="Cle de cache (p.ex. adresse de pool)")


class TrainResponse(BaseModel):
    key: str
    method: Literal["model", "ewma"]
    model_test_mae: float | None
    ewma_test_mae: float | None
    samples_train: int
    samples_test: int


class ModelInfo(BaseModel):
    key: str
    method: str
    age_seconds: float
    model_test_mae: float | None
    ewma_test_mae: float | None
