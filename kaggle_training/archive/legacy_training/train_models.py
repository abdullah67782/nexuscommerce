# ═══════════════════════════════════════════════════════════════════════════════
# NexusCommerce — Model Training Script (Google Colab)
# ═══════════════════════════════════════════════════════════════════════════════
# Run each section as a separate Colab cell.
# Upload your sales CSV when prompted.
# Downloads trained model files at the end.
# ═══════════════════════════════════════════════════════════════════════════════

# %% ── Cell 1: Install Dependencies ──────────────────────────────────────────
# !pip install pandas numpy scikit-learn

# %% ── Cell 2: Imports ───────────────────────────────────────────────────────
import pandas as pd
import numpy as np
import pickle
import warnings
warnings.filterwarnings("ignore")

from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# For downloading files from Colab
try:
    from google.colab import files as colab_files
    IN_COLAB = True
except ImportError:
    IN_COLAB = False

print("All imports successful")

# %% ── Cell 3: Load Dataset ─────────────────────────────────────────────────
# Upload your CSV in Colab, or set csv_path manually.

# Base model output directory (relative to this script)
import os as _os
BASE_MODEL_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)) if not IN_COLAB else ".", "models", "base")
_os.makedirs(BASE_MODEL_DIR, exist_ok=True)
print(f"Base model directory: {BASE_MODEL_DIR}")

if IN_COLAB:
    print("Upload your sales CSV file:")
    uploaded = colab_files.upload()
    csv_path = list(uploaded.keys())[0]
else:
    csv_path = "sales_data.csv"  # Change this path for local use

df = pd.read_csv(csv_path)

# Normalize column names
df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

print(f"Dataset shape: {df.shape}")
print(f"Columns: {list(df.columns)}")
df.head()

# %% ── Cell 4: Data Preprocessing ───────────────────────────────────────────

# Detect date and quantity columns
date_col = None
for col in ["sale_date", "date", "order_date"]:
    if col in df.columns:
        date_col = col
        break
if date_col is None:
    raise ValueError("No date column found. Expected: sale_date, date, or order_date")

qty_col = None
for col in ["quantity", "qty", "units_sold", "demand"]:
    if col in df.columns:
        qty_col = col
        break
if qty_col is None:
    raise ValueError("No quantity column found. Expected: quantity, qty, units_sold, or demand")

# Detect product_id column
pid_col = None
for col in ["product_id", "productid", "item_id"]:
    if col in df.columns:
        pid_col = col
        break

print(f"Using date column: {date_col}")
print(f"Using quantity column: {qty_col}")
print(f"Using product_id column: {pid_col}")

# Parse dates and sort
df[date_col] = pd.to_datetime(df[date_col])
df = df.sort_values(date_col).reset_index(drop=True)

# Aggregate daily totals (sum across products if no specific product_id)
daily = df.groupby(date_col)[qty_col].sum().reset_index()
daily.columns = ["date", "quantity"]
daily = daily.set_index("date").asfreq("D").fillna(method="ffill").fillna(0)

print(f"Daily time series: {len(daily)} days")
print(f"Date range: {daily.index.min()} → {daily.index.max()}")

# %% ── Cell 5: Feature Engineering ──────────────────────────────────────────

features = daily.copy()
features["month"] = features.index.month
features["day"] = features.index.day
features["day_of_week"] = features.index.dayofweek

# Product ID (use 0 as default for aggregated series)
features["product_id"] = 0

# Lag features
features["lag_7"] = features["quantity"].shift(7)
features["lag_14"] = features["quantity"].shift(14)

# Rolling mean
features["rolling_mean_7"] = features["quantity"].rolling(window=7).mean()

# Drop rows with NaN from lag/rolling
features = features.dropna()

print(f"Feature matrix shape: {features.shape}")
print("Features:", ["month", "day", "day_of_week", "product_id", "lag_7", "lag_14", "rolling_mean_7"])
features.head()

# %% ── Cell 6: Train/Test Split ─────────────────────────────────────────────

FEATURE_COLS = ["month", "day", "day_of_week", "product_id", "lag_7", "lag_14", "rolling_mean_7"]
TARGET_COL = "quantity"

split_idx = int(len(features) * 0.8)
train = features.iloc[:split_idx]
test = features.iloc[split_idx:]

X_train = train[FEATURE_COLS].values
y_train = train[TARGET_COL].values
X_test = test[FEATURE_COLS].values
y_test = test[TARGET_COL].values

print(f"Training set: {len(train)} samples")
print(f"Test set:     {len(test)} samples")

# %% ── Cell 7: Helper — Calculate Metrics ───────────────────────────────────

def calculate_metrics(y_true, y_pred, model_name):
    """Calculate MAE, RMSE, R², MAPE for a model."""
    mae = mean_absolute_error(y_true, y_pred)
    rmse = np.sqrt(mean_squared_error(y_true, y_pred))
    r2 = r2_score(y_true, y_pred)
    # MAPE: avoid division by zero
    mask = y_true != 0
    if mask.sum() > 0:
        mape = np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100
    else:
        mape = 0.0

    print(f"\n{'='*40}")
    print(f"  {model_name} Metrics")
    print(f"{'='*40}")
    print(f"  MAE:   {mae:.4f}")
    print(f"  RMSE:  {rmse:.4f}")
    print(f"  R²:    {r2:.4f}")
    print(f"  MAPE:  {mape:.4f}%")

    return {"model": model_name, "mae": mae, "rmse": rmse, "r2_score": r2, "mape": mape}

# %% ── Cell 8: Train Random Forest ─────────────────────────────────────────

print("Training Random Forest model...")

rf_model = RandomForestRegressor(
    n_estimators=200,
    max_depth=15,
    min_samples_split=5,
    min_samples_leaf=2,
    random_state=42,
    n_jobs=-1,
)
rf_model.fit(X_train, y_train)
rf_preds = rf_model.predict(X_test)

rf_metrics = calculate_metrics(y_test, rf_preds, "Random Forest")

# Feature importance
importance = pd.DataFrame({
    "feature": FEATURE_COLS,
    "importance": rf_model.feature_importances_
}).sort_values("importance", ascending=False)
print("\nFeature Importance:")
print(importance.to_string(index=False))

# Save model
with open(_os.path.join(BASE_MODEL_DIR, "rf_model.pkl"), "wb") as f:
    pickle.dump(rf_model, f)
print("\n✅ Random Forest model saved to models/base/rf_model.pkl")

# %% ── Cell 9: Model Metrics ────────────────────────────────────────────────

print("\n" + "═" * 70)
print("  MODEL METRICS — NexusCommerce Demand Forecasting")
print("═" * 70)

comparison_df = pd.DataFrame([rf_metrics])
comparison_df = comparison_df.set_index("model")
comparison_df = comparison_df.round(4)

print(comparison_df.to_string())

# %% ── Cell 10: Download Model Files ──────────────────────────────────────

model_files = ["rf_model.pkl"]

if IN_COLAB:
    print("\nDownloading model files...")
    for f in model_files:
        try:
            colab_files.download(_os.path.join(BASE_MODEL_DIR, f))
            print(f"  ✅ Downloaded {f}")
        except Exception as e:
            print(f"  ❌ Failed to download {f}: {e}")
else:
    print(f"\nModel files saved to: {BASE_MODEL_DIR}")
    for f in model_files:
        print(f"  📁 {f}")

print("\n✅ Training complete! Base models are in nexuscommerce/ml/models/base/")
