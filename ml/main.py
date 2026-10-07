import os
import joblib
import numpy as np
import pandas as pd
from math import sqrt
from typing import Optional

from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from features import build_features, EXCLUDE_COLS
from model_loader import get_model_for_seller
from forecaster import forecast_future

load_dotenv(os.path.join(os.path.dirname(__file__), '..', 'backend', '.env'))

app = FastAPI(
    title="NexusCommerce ML Server",
    description="Machine Learning prediction API for demand forecasting",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

# ─── Database ─────────────────────────────────────────────────────────────────

def get_db_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        database=os.getenv("DB_NAME"),
    )

# ─── Pydantic models ──────────────────────────────────────────────────────────

class PredictionRequest(BaseModel):
    product_id: int
    seller_id: int
    horizon_days: int = 30
    category: str = "United_Kingdom"

class FinetuneRequest(BaseModel):
    seller_id: int
    category: str = "United_Kingdom"

class PredictionResponse(BaseModel):
    predictions: list
    model_used: str
    horizon_days: int
    top_features: list
    status: str
    accuracy: Optional[int] = None
    residual_std: Optional[float] = None

# ─── Accuracy & residual helpers ──────────────────────────────────────────────

def compute_backtest_accuracy(model, feature_cols, history_df) -> Optional[int]:
    """
    Computes model accuracy on historical data via backtesting.
    Uses last 20% of history as test set.
    Returns accuracy as integer 0-100, or None if insufficient data.
    Formula: accuracy = max(0, round(100 - MAPE))
    Never returns a hardcoded number — always computed from real data.
    """
    featured = build_features(history_df.copy())
    if len(featured) < 60:
        return None

    for c in feature_cols:
        if c not in featured.columns:
            featured[c] = 0.0
    n_test = max(int(len(featured) * 0.20), 7)
    X_test = featured.iloc[-n_test:][feature_cols].values
    y_test = featured.iloc[-n_test:]['quantity'].values
    preds = model.predict(X_test).clip(min=0)

    mask = y_test > 0
    if mask.sum() == 0:
        return None

    mape = float(np.mean(
        np.abs((y_test[mask] - preds[mask]) / y_test[mask])
    ) * 100)
    return max(0, round(100 - mape))


def compute_residual_std(model, feature_cols, history_df) -> Optional[float]:
    """
    Computes std of prediction residuals on full historical data.
    Used for real (non-fake) confidence interval computation.
    Returns float std value, or None if insufficient data.
    """
    featured = build_features(history_df.copy())
    if len(featured) < 30:
        return None
    for c in feature_cols:
        if c not in featured.columns:
            featured[c] = 0.0
    X = featured[feature_cols].values
    y = featured['quantity'].values
    preds = model.predict(X).clip(min=0)
    return float(np.std(y - preds))

# ─── DB helpers ───────────────────────────────────────────────────────────────

def _get_stored_accuracy(seller_id: int) -> Optional[int]:
    """Return the persisted fine-tune accuracy for this seller, or None."""
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT accuracy FROM model_metrics
                   WHERE seller_id = %s AND accuracy IS NOT NULL
                   ORDER BY evaluated_at DESC LIMIT 1""",
                (seller_id,),
            )
            row = cur.fetchone()
            return int(row["accuracy"]) if row else None
    finally:
        conn.close()

def _get_product_sales_history(product_id: int, seller_id: int) -> Optional[pd.DataFrame]:
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT sale_date, SUM(quantity) as quantity
                   FROM sales
                   WHERE product_id = %s
                   GROUP BY sale_date
                   ORDER BY sale_date ASC""",
                (product_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return None

    df = pd.DataFrame(rows)
    df["sale_date"] = pd.to_datetime(df["sale_date"])
    df["quantity"] = df["quantity"].astype(float)
    full_idx = pd.date_range(df["sale_date"].min(), df["sale_date"].max(), freq="D")
    df = (
        df.set_index("sale_date")
        .reindex(full_idx, fill_value=0)
        .rename_axis("sale_date")
        .reset_index()
    )
    return df


def _get_seller_sales_history(seller_id: int) -> Optional[pd.DataFrame]:
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT s.sale_date, SUM(s.quantity) as quantity
                   FROM sales s
                   JOIN products p ON s.product_id = p.id
                   WHERE p.user_id = %s
                   GROUP BY s.sale_date
                   ORDER BY s.sale_date ASC""",
                (seller_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return None

    df = pd.DataFrame(rows)
    df["sale_date"] = pd.to_datetime(df["sale_date"])
    df["quantity"] = df["quantity"].astype(float)
    full_idx = pd.date_range(df["sale_date"].min(), df["sale_date"].max(), freq="D")
    df = (
        df.set_index("sale_date")
        .reindex(full_idx, fill_value=0)
        .rename_axis("sale_date")
        .reset_index()
    )
    return df


def _update_finetune_job(user_id: int, status: str, metrics=None, error=None):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE finetune_jobs
                   SET status = %s, metrics = %s, error_message = %s, completed_at = NOW()
                   WHERE user_id = %s AND status = 'running'""",
                (status, str(metrics) if metrics else None, error, user_id),
            )
        conn.commit()
    finally:
        conn.close()


def _save_metrics_to_db(seller_id: int, mae: float, rmse: float, r2: float, accuracy: Optional[int] = None):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO model_metrics (seller_id, model_name, mae, rmse, r2_score, mape, accuracy, evaluated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                   ON CONFLICT (seller_id, model_name)
                   DO UPDATE SET mae = EXCLUDED.mae,
                                 rmse = EXCLUDED.rmse,
                                 r2_score = EXCLUDED.r2_score,
                                 accuracy = EXCLUDED.accuracy,
                                 evaluated_at = NOW()""",
                (seller_id, "xgboost_finetuned", round(mae, 4), round(rmse, 4), round(r2, 4), 0.0, accuracy),
            )
        conn.commit()
    finally:
        conn.close()


def user_has_model(user_id: int) -> bool:
    return os.path.exists(os.path.join(MODELS_DIR, f"xgb_finetuned_{user_id}.pkl"))

# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "NexusCommerce ML Server running", "version": "2.0.0", "port": 8000}

# ═══════════════════════════════════════════════════════════════════════════════
# PREDICTION ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/predict/xgboost", response_model=PredictionResponse)
def predict_xgboost(req: PredictionRequest):
    # 1. Get sales history
    history_df = _get_product_sales_history(req.product_id, req.seller_id)
    days_available = len(history_df) if history_df is not None else 0

    if history_df is None or days_available < 30:
        return JSONResponse(
            status_code=422,
            content={
                "error": "insufficient_history",
                "message": "Need at least 30 days of sales history",
                "days_available": days_available,
                "days_needed": 30,
            },
        )

    # 2. Load model (3-tier priority: finetuned → category → fallback)
    model, feature_cols, model_name = get_model_for_seller(req.seller_id, req.category)

    # 3. Recursive forecasting
    predictions = forecast_future(model, feature_cols, history_df, req.horizon_days)

    # 4. Accuracy: use stored fine-tune metrics for personalised model (trained on
    #    seller-aggregate data, so per-product backtest would be wrong-domain).
    #    For base models, return None so the UI shows "—" rather than a misleading 0%.
    if "finetuned" in model_name:
        accuracy = _get_stored_accuracy(req.seller_id)
    else:
        raw = compute_backtest_accuracy(model, feature_cols, history_df)
        accuracy = raw if (raw is not None and raw > 0) else None

    residual_std = compute_residual_std(model, feature_cols, history_df)

    # 5. Feature importance (top 10)
    top_features = []
    if hasattr(model, 'feature_importances_'):
        importance_dict = dict(zip(feature_cols, model.feature_importances_))
        top_features = [
            {"feature": feat, "importance": round(float(imp), 6)}
            for feat, imp in sorted(importance_dict.items(), key=lambda x: x[1], reverse=True)[:10]
        ]

    return PredictionResponse(
        predictions=predictions,
        model_used=model_name,
        horizon_days=req.horizon_days,
        top_features=top_features,
        status="success",
        accuracy=accuracy,
        residual_std=residual_std,
    )


@app.post("/predict/ensemble", response_model=PredictionResponse)
def predict_ensemble(req: PredictionRequest):
    return predict_xgboost(req)

# ═══════════════════════════════════════════════════════════════════════════════
# FINE-TUNE ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

def _run_finetune_background(seller_id: int, category: str):
    import xgboost as xgb

    try:
        # 1. Get seller sales data
        sales_df = _get_seller_sales_history(seller_id)
        if sales_df is None or len(sales_df) == 0:
            _update_finetune_job(seller_id, "failed", error="No sales data found for this seller.")
            return

        # 2. Build features
        featured = build_features(sales_df)
        if featured.empty or len(featured) < 30:
            _update_finetune_job(seller_id, "failed", error="Not enough data after feature engineering (need 30+ rows).")
            return

        # 3. Load base model path
        safe_cat = category.replace(' ', '_').replace('/', '_')
        base_path = os.path.join(MODELS_DIR, f"xgb_{safe_cat}.pkl")
        if not os.path.exists(base_path):
            base_path = os.path.join(MODELS_DIR, "xgb_United_Kingdom.pkl")

        feat_path = os.path.join(MODELS_DIR, f"features_{safe_cat}.pkl")
        if not os.path.exists(feat_path):
            feat_path = os.path.join(MODELS_DIR, "features_United_Kingdom.pkl")
        feat_cols = joblib.load(feat_path)

        # 4. Prepare training data
        for c in feat_cols:
            if c not in featured.columns:
                featured[c] = 0.0
        X = featured[feat_cols].values
        y = featured['quantity'].values

        # 5. Warm-start fine-tuning from base model
        finetuned = xgb.XGBRegressor(
            xgb_model=base_path,
            n_estimators=500,
            learning_rate=0.01,
            tree_method='hist',
            random_state=42,
            verbosity=0,
        )
        finetuned.fit(X, y)

        # 6. Save fine-tuned model
        joblib.dump(finetuned, os.path.join(MODELS_DIR, f"xgb_finetuned_{seller_id}.pkl"))
        joblib.dump(feat_cols, os.path.join(MODELS_DIR, f"features_finetuned_{seller_id}.pkl"))

        # 7. Evaluate on last 20% of seller data
        n_test = max(int(len(X) * 0.2), 7)
        preds = finetuned.predict(X[-n_test:]).clip(min=0)
        mae = mean_absolute_error(y[-n_test:], preds)
        rmse_v = sqrt(mean_squared_error(y[-n_test:], preds))
        r2 = r2_score(y[-n_test:], preds)

        # 8. Compute dynamic accuracy (never hardcoded)
        accuracy = compute_backtest_accuracy(finetuned, feat_cols, sales_df)

        # 9. Persist metrics
        _save_metrics_to_db(seller_id, mae, rmse_v, r2, accuracy)

        # 10. Mark job completed
        _update_finetune_job(seller_id, "completed", metrics={
            "model": "xgboost_finetuned",
            "mae": round(float(mae), 4),
            "rmse": round(float(rmse_v), 4),
            "r2_score": round(float(r2), 4),
            "accuracy": accuracy,
        })

    except Exception as exc:
        _update_finetune_job(seller_id, "failed", error=str(exc))


@app.post("/finetune")
def finetune(req: FinetuneRequest, background_tasks: BackgroundTasks):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            # Expire stuck jobs older than 30 minutes
            cur.execute(
                """UPDATE finetune_jobs
                   SET status = 'failed', error_message = 'Timed out'
                   WHERE user_id = %s AND status = 'running'
                     AND started_at < NOW() - INTERVAL '30 minutes'""",
                (req.seller_id,),
            )
            cur.execute(
                "SELECT status FROM finetune_jobs WHERE user_id = %s AND status = 'running'",
                (req.seller_id,),
            )
            if cur.fetchone():
                conn.commit()
                return {"message": "Fine-tuning already in progress", "seller_id": req.seller_id}

            cur.execute(
                "INSERT INTO finetune_jobs (user_id, status, started_at) VALUES (%s, 'running', NOW())",
                (req.seller_id,),
            )
        conn.commit()
    finally:
        conn.close()

    background_tasks.add_task(_run_finetune_background, req.seller_id, req.category)
    return {"message": "Fine-tuning started", "seller_id": req.seller_id, "category": req.category}


@app.get("/finetune/status/{seller_id}")
def finetune_status(seller_id: int):
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT status, metrics, error_message, started_at, completed_at
                   FROM finetune_jobs
                   WHERE user_id = %s
                   ORDER BY started_at DESC
                   LIMIT 1""",
                (seller_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return {
            "seller_id": seller_id,
            "status": "never_run",
            "has_finetuned_model": user_has_model(seller_id),
        }

    return {
        "seller_id": seller_id,
        "status": row["status"],
        "metrics": row["metrics"],
        "error_message": row["error_message"],
        "started_at": str(row["started_at"]),
        "completed_at": str(row["completed_at"]) if row["completed_at"] else None,
        "has_finetuned_model": user_has_model(seller_id),
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
