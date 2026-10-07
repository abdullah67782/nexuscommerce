"""HTTP endpoints for forecasting v2 (included by main.py).

POST /v2/forecast  { start: 'YYYY-MM-DD', quantities: [daily totals, oldest first] }
  The caller (the Express backend) sends only the product's usable history:
  consecutive known days, unknown days already excluded. Returns 7- and 28-day
  totals, their dates, the method and the history tier — never a daily breakdown,
  accuracy figure or confidence interval.
GET  /v2/status    whether the approved models load (hash-checked manifest).
"""
from datetime import date
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from v2.forecast import forecast_totals, history_tier
from v2.registry import ModelRegistryError, get_models

router = APIRouter(prefix="/v2", tags=["forecast v2"])


class ForecastRequest(BaseModel):
    start: date
    quantities: List[float] = Field(default_factory=list, max_length=20000)


@router.post("/forecast")
def forecast(req: ForecastRequest):
    models, release = None, None
    if history_tier(len(req.quantities)) == "model":
        try:
            models, manifest = get_models()
            release = manifest["release"]
        except ModelRegistryError as exc:
            raise HTTPException(status_code=503, detail=f"v2 models unavailable: {exc}")
    try:
        result = forecast_totals(req.start, req.quantities, models)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    result["models_release"] = release
    return result


@router.get("/status")
def status():
    try:
        _, manifest = get_models()
        return {"ready": True, "release": manifest["release"], "status": manifest.get("status"),
                "horizons": sorted(int(h) for h in manifest["models"])}
    except ModelRegistryError as exc:
        return {"ready": False, "error": str(exc)}
