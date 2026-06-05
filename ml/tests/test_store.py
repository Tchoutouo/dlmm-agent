"""Tests du cache de modeles avec TTL et des endpoints train/models."""
import numpy as np
from fastapi.testclient import TestClient

from app.store import ModelStore, predict_cached, store
from app.main import app

client = TestClient(app)
rng = np.random.default_rng(7)


def _series(n, sigma):
    r = rng.normal(0, sigma, n)
    closes = 100 * np.exp(np.cumsum(r))
    highs = closes * (1 + np.abs(rng.normal(0, sigma / 2, n)))
    lows = closes * (1 - np.abs(rng.normal(0, sigma / 2, n)))
    vols = np.abs(rng.normal(50_000, 10_000, n))
    return closes, highs, lows, vols


def _candles(closes, h, l, v):
    return [
        {"timestamp": 1_700_000_000 + i * 3600, "open": float(closes[i]),
         "high": float(h[i]), "low": float(l[i]), "close": float(closes[i]),
         "volume": float(v[i])}
        for i in range(len(closes))
    ]


def test_store_freshness_ttl():
    s = ModelStore()
    c, h, l, v = _series(400, 0.02)
    s.train_and_store("poolA", c, h, l, v, 24)
    # frais avec un grand TTL, périmé avec TTL nul
    assert s.get_fresh("poolA", ttl_seconds=10_000) is not None
    assert s.get_fresh("poolA", ttl_seconds=0) is None
    assert s.get_fresh("inconnu", ttl_seconds=10_000) is None


def test_predict_cached_reuses_within_ttl():
    c, h, l, v = _series(400, 0.02)
    out1 = predict_cached("poolB", c, h, l, v, "1h", 24, ttl_seconds=10_000)
    out2 = predict_cached("poolB", c, h, l, v, "1h", 24, ttl_seconds=10_000)
    assert out1["retrained"] is True
    assert out2["retrained"] is False  # réutilisé depuis le cache


def test_predict_cached_retrains_when_stale():
    c, h, l, v = _series(400, 0.02)
    predict_cached("poolC", c, h, l, v, "1h", 24, ttl_seconds=10_000)
    out = predict_cached("poolC", c, h, l, v, "1h", 24, ttl_seconds=0)  # TTL nul → ré-entraîne
    assert out["retrained"] is True


def test_train_and_models_endpoints():
    c, h, l, v = _series(400, 0.02)
    r = client.post("/train", json={"candles": _candles(c, h, l, v), "timeframe": "1h", "window": 24, "key": "poolD"})
    assert r.status_code == 200
    assert r.json()["method"] in ("model", "ewma")

    m = client.get("/models")
    assert m.status_code == 200
    assert any(x["key"] == "poolD" for x in m.json())


def test_predict_endpoint_with_key():
    c, h, l, v = _series(400, 0.02)
    body = {"candles": _candles(c, h, l, v), "timeframe": "1h", "window": 24, "key": "poolE", "ttl_seconds": 10_000}
    r1 = client.post("/predict", json=body)
    r2 = client.post("/predict", json=body)
    assert r1.json()["retrained"] is True
    assert r2.json()["retrained"] is False
