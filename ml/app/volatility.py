"""Calculs de volatilité : vol réalisée, Parkinson, baseline EWMA.

Tout est en volatilité PAR PÉRIODE (écart-type des log-returns sur une période) ;
la mise à l'échelle journalière/annuelle se fait à la toute fin.
"""
from __future__ import annotations

import numpy as np

TIMEFRAME_SECONDS = {
    "5m": 300, "30m": 1800, "1h": 3600, "2h": 7200,
    "4h": 14400, "12h": 43200, "24h": 86400,
}
SECONDS_PER_DAY = 86_400
SECONDS_PER_YEAR = 365 * 86_400


def log_returns(closes: np.ndarray) -> np.ndarray:
    closes = np.asarray(closes, dtype=float)
    closes = np.where(closes > 0, closes, np.nan)
    r = np.diff(np.log(closes))
    return r[~np.isnan(r)]


def realized_vol(returns: np.ndarray) -> float:
    """Écart-type d'échantillon des log-returns (vol par période)."""
    returns = np.asarray(returns, dtype=float)
    if returns.size < 2:
        return 0.0
    return float(np.std(returns, ddof=1))


def parkinson_vol(highs: np.ndarray, lows: np.ndarray) -> float:
    """Estimateur de Parkinson (high/low), vol par période."""
    highs = np.asarray(highs, dtype=float)
    lows = np.asarray(lows, dtype=float)
    mask = (highs > 0) & (lows > 0)
    if mask.sum() == 0:
        return 0.0
    hl = np.log(highs[mask] / lows[mask]) ** 2
    return float(np.sqrt(np.mean(hl) / (4 * np.log(2))))


def ewma_sigma(returns: np.ndarray, lam: float = 0.94) -> float:
    """Prévision EWMA (RiskMetrics) de la vol par période — baseline robuste."""
    returns = np.asarray(returns, dtype=float)
    if returns.size == 0:
        return 0.0
    var = float(returns[0] ** 2)
    for r in returns[1:]:
        var = lam * var + (1 - lam) * float(r) ** 2
    return float(np.sqrt(max(var, 0.0)))


def periods_per_day(timeframe: str) -> float:
    return SECONDS_PER_DAY / TIMEFRAME_SECONDS.get(timeframe, 3600)


def periods_per_year(timeframe: str) -> float:
    return SECONDS_PER_YEAR / TIMEFRAME_SECONDS.get(timeframe, 3600)
