"""Construction du dataset supervisé pour la prédiction de volatilité.

Cible : la volatilité réalisée par période sur la FENÊTRE FUTURE [t, t+W].
Features à t : volatilités passées (clustering de volatilité = signal dominant),
amplitude récente, Parkinson, ratio de volume, et la prévision EWMA.
"""
from __future__ import annotations

import numpy as np

from .volatility import realized_vol, parkinson_vol, ewma_sigma


def _features_at(
    returns: np.ndarray, highs: np.ndarray, lows: np.ndarray,
    volumes: np.ndarray, t: int, w: int,
) -> list[float]:
    trail = returns[t - w : t]
    short = returns[max(0, t - w // 2) : t]
    last_abs = abs(returns[t - 1]) if t >= 1 else 0.0
    park = parkinson_vol(highs[t - w : t], lows[t - w : t])
    vol_window = volumes[t - w : t]
    vol_mean = float(np.mean(vol_window)) if vol_window.size else 0.0
    vol_ratio = (float(volumes[t - 1]) / vol_mean) if vol_mean > 0 else 1.0
    return [
        realized_vol(trail),
        realized_vol(short),
        last_abs,
        park,
        vol_ratio,
        ewma_sigma(trail),
    ]


def build_dataset(
    closes: np.ndarray, highs: np.ndarray, lows: np.ndarray,
    volumes: np.ndarray, w: int,
):
    """Renvoie X, y, ewma_forecasts (alignés) à partir des séries de bougies.

    `returns` a une longueur N-1 (N = nb de bougies). On indexe sur `returns`.
    """
    returns = np.diff(np.log(np.where(closes > 0, closes, np.nan)))
    returns = np.nan_to_num(returns)
    n = returns.size

    X: list[list[float]] = []
    y: list[float] = []
    ewma_fc: list[float] = []
    # Les highs/lows/volumes sont par bougie ; on les aligne sur les returns
    # en décalant d'un (la return i correspond à la bougie i+1).
    h = highs[1:]
    lo = lows[1:]
    v = volumes[1:]

    for t in range(w, n - w):
        feats = _features_at(returns, h, lo, v, t, w)
        target = realized_vol(returns[t : t + w])
        X.append(feats)
        y.append(target)
        ewma_fc.append(ewma_sigma(returns[t - w : t]))

    return (
        np.array(X, dtype=float),
        np.array(y, dtype=float),
        np.array(ewma_fc, dtype=float),
    )


def features_at_last(
    closes: np.ndarray, highs: np.ndarray, lows: np.ndarray,
    volumes: np.ndarray, w: int,
):
    """Features et prévision EWMA au point le plus récent (pour la prédiction)."""
    returns = np.diff(np.log(np.where(closes > 0, closes, np.nan)))
    returns = np.nan_to_num(returns)
    n = returns.size
    if n < w:
        # Pas assez d'historique : on rabat sur le trailing disponible
        return None, ewma_sigma(returns)
    h, lo, v = highs[1:], lows[1:], volumes[1:]
    feats = _features_at(returns, h, lo, v, n, w)
    return feats, ewma_sigma(returns[n - w : n])
