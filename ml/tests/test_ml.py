"""Tests du service ML : volatilité, sélection de modèle, endpoints."""
import numpy as np
from fastapi.testclient import TestClient

from app.volatility import (
    log_returns, realized_vol, parkinson_vol, ewma_sigma,
    periods_per_day, periods_per_year,
)
from app.model import predict_volatility
from app.main import app

client = TestClient(app)
rng = np.random.default_rng(42)


def _series(n, sigma):
    """Série de prix synthétique avec vol par période ~sigma."""
    r = rng.normal(0, sigma, n)
    closes = 100 * np.exp(np.cumsum(r))
    highs = closes * (1 + np.abs(rng.normal(0, sigma / 2, n)))
    lows = closes * (1 - np.abs(rng.normal(0, sigma / 2, n)))
    vols = np.abs(rng.normal(50_000, 10_000, n))
    return closes, highs, lows, vols


# ---- Volatilité ----

def test_realized_vol_matches_std():
    r = rng.normal(0, 0.02, 500)
    assert abs(realized_vol(r) - np.std(r, ddof=1)) < 1e-9


def test_realized_vol_increases_with_dispersion():
    assert realized_vol(rng.normal(0, 0.05, 500)) > realized_vol(rng.normal(0, 0.01, 500))


def test_ewma_sigma_positive_and_reasonable():
    r = rng.normal(0, 0.03, 300)
    s = ewma_sigma(r)
    assert 0.01 < s < 0.06


def test_parkinson_positive():
    _, h, l, _ = _series(200, 0.02)
    assert parkinson_vol(h, l) > 0


def test_scaling_factors():
    assert periods_per_day("1h") == 24
    assert abs(periods_per_year("1h") - 24 * 365) < 1e-6


# ---- Modèle ----

def test_predict_returns_scaled_vols():
    closes, h, l, v = _series(400, 0.02)
    out = predict_volatility(closes, h, l, v, "1h", 24)
    assert out["predicted_period_vol"] >= 0
    # journalier = période × sqrt(24)
    assert abs(out["predicted_daily_vol"] - out["predicted_period_vol"] * np.sqrt(24)) < 1e-6
    assert out["method"] in ("model", "ewma")


def test_predict_distinguishes_calm_vs_volatile():
    calm = predict_volatility(*_series(400, 0.005), "1h", 24)
    volatile = predict_volatility(*_series(400, 0.04), "1h", 24)
    assert volatile["predicted_daily_vol"] > calm["predicted_daily_vol"]


def test_insufficient_history_falls_back_to_ewma():
    closes, h, l, v = _series(30, 0.02)
    out = predict_volatility(closes, h, l, v, "1h", 24)
    assert out["method"] == "ewma"
    assert out["samples_train"] == 0


# ---- Endpoints ----

def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_predict_endpoint():
    closes, h, l, v = _series(300, 0.02)
    candles = [
        {"timestamp": 1_700_000_000 + i * 3600, "open": float(closes[i]),
         "high": float(h[i]), "low": float(l[i]), "close": float(closes[i]),
         "volume": float(v[i])}
        for i in range(len(closes))
    ]
    r = client.post("/predict", json={"candles": candles, "timeframe": "1h", "window": 24})
    assert r.status_code == 200
    body = r.json()
    assert body["predicted_annual_vol"] >= 0
    assert body["method"] in ("model", "ewma")
