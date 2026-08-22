from __future__ import annotations

import os
import hashlib
from datetime import date
from math import isfinite

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from statsforecast import StatsForecast
from statsforecast.models import AutoARIMA, AutoETS, AutoTheta, DynamicOptimizedTheta, SeasonalNaive


MODEL_LABELS = {
    "AutoARIMA": "AutoARIMA",
    "AutoETS": "AutoETS",
    "AutoTheta": "AutoTheta",
    "DynamicOptimizedTheta": "Dynamic optimized Theta",
    "SeasonalNaive": "Seasonal naive",
}

FORECAST_CACHE: dict[str, dict] = {}

class DailySale(BaseModel):
    date: date
    sales: float


class ForecastRequest(BaseModel):
    daily: list[DailySale] = Field(min_length=1, max_length=5000)
    horizon: int = Field(ge=7, le=180)


def minimum_history_days(horizon: int) -> int:
    return max(91, horizon * 5)


def _models():
    return [
        SeasonalNaive(season_length=7),
        AutoETS(season_length=7),
        AutoARIMA(season_length=7),
        AutoTheta(season_length=7),
        DynamicOptimizedTheta(season_length=7),
    ]


def _confidence(wape: float, folds: int) -> str:
    if folds < 3 or wape > 0.30:
        return "Very low"
    if wape > 0.20:
        return "Low"
    if wape > 0.10:
        return "Moderate"
    return "High"


def _prepare_frame(points: list[DailySale]) -> pd.DataFrame:
    frame = pd.DataFrame([{"ds": point.date, "y": point.sales} for point in points])
    if not all(isfinite(value) for value in frame["y"]):
        raise HTTPException(status_code=422, detail="Sales values must be finite numbers.")
    frame["ds"] = pd.to_datetime(frame["ds"])
    frame = frame.groupby("ds", as_index=False)["y"].sum().sort_values("ds")
    complete_dates = pd.date_range(frame["ds"].min(), frame["ds"].max(), freq="D")
    frame = frame.set_index("ds").reindex(complete_dates, fill_value=0).rename_axis("ds").reset_index()
    frame.insert(0, "unique_id", "revenue")
    return frame


def run_forecast(points: list[DailySale], horizon: int) -> dict:
    frame = _prepare_frame(points)
    required = minimum_history_days(horizon)
    if len(frame) < required:
        raise HTTPException(
            status_code=422,
            detail=f"The {horizon}-day forecast needs at least {required} calendar days; this file has {len(frame)}.",
        )

    minimum_train = 84
    available_windows = max(1, (len(frame) - minimum_train) // horizon)
    folds = min(8, available_windows)
    if folds < 3:
        raise HTTPException(status_code=422, detail="At least three historical test windows are required.")

    engine = StatsForecast(models=_models(), freq="D", n_jobs=1)
    cross_validation = engine.cross_validation(
        df=frame,
        h=horizon,
        n_windows=folds,
        step_size=horizon,
    )

    actual = cross_validation["y"].to_numpy(dtype=float)
    actual_total = max(1.0, float(np.abs(actual).sum()))
    results = []
    residuals_by_model: dict[str, np.ndarray] = {}
    for model_name in MODEL_LABELS:
        predicted = cross_validation[model_name].to_numpy(dtype=float)
        residuals = actual - predicted
        residuals_by_model[model_name] = residuals
        absolute = np.abs(residuals)
        results.append(
            {
                "key": model_name,
                "name": MODEL_LABELS[model_name],
                "wape": float(absolute.sum() / actual_total),
                "mae": float(absolute.mean()),
                "bias": float(residuals.sum() / actual_total),
                "foldWapes": [],
                "residuals": [],
            }
        )

    results.sort(key=lambda item: item["wape"])
    winner = results[0]
    baseline = next(item for item in results if item["key"] == "SeasonalNaive")
    future = engine.forecast(df=frame, h=horizon)
    values = future[winner["key"]].to_numpy(dtype=float)
    absolute_residuals = np.abs(residuals_by_model[winner["key"]])
    interval = float(np.quantile(absolute_residuals, 0.80))
    coverage = float((absolute_residuals <= interval).mean())

    last_date = frame["ds"].max()
    points_out = []
    for offset, value in enumerate(values, start=1):
        forecast_date = last_date + pd.Timedelta(days=offset)
        safe_value = max(0.0, float(value))
        points_out.append(
            {
                "date": forecast_date.strftime("%Y-%m-%d"),
                "value": safe_value,
                "lower": max(0.0, safe_value - interval),
                "upper": safe_value + interval,
            }
        )

    for item in results:
        item.pop("key", None)

    return {
        "winner": winner,
        "baseline": baseline,
        "models": results,
        "points": points_out,
        "folds": folds,
        "evaluatedDays": folds * horizon,
        "intervalCoverage": coverage,
        "relativeImprovement": (baseline["wape"] - winner["wape"]) / baseline["wape"] if baseline["wape"] else 0,
        "confidence": _confidence(winner["wape"], folds),
        "engine": "StatsForecast",
        "historyDays": len(frame),
    }


app = FastAPI(title="RetailPulse Forecast Service", version="1.0.0")
origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok", "engine": "StatsForecast"}


@app.post("/forecast")
def forecast(request: ForecastRequest):
    signature = "|".join(f"{point.date.isoformat()}:{point.sales:.6f}" for point in request.daily)
    cache_key = hashlib.sha256(f"{request.horizon}|{signature}".encode()).hexdigest()
    if cache_key not in FORECAST_CACHE:
        if len(FORECAST_CACHE) >= 64:
            FORECAST_CACHE.pop(next(iter(FORECAST_CACHE)))
        FORECAST_CACHE[cache_key] = run_forecast(request.daily, request.horizon)
    return FORECAST_CACHE[cache_key]
