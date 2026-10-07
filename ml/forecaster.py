import pandas as pd
import numpy as np
from features import build_features


def forecast_future(model, feature_cols, history_df, horizon_days=30):
    """
    Generates future predictions one day at a time.
    history_df: DataFrame with [sale_date (datetime), quantity (float)]
    Returns: list of {"date": str, "quantity": float}
    """
    working = history_df[['sale_date', 'quantity']].copy()
    working = working.sort_values('sale_date').reset_index(drop=True)
    predictions = []

    for _ in range(horizon_days):
        # Fill missing calendar days in working history
        full_idx = pd.date_range(
            working['sale_date'].min(),
            working['sale_date'].max(),
            freq='D'
        )
        working = (working
                   .set_index('sale_date')
                   .reindex(full_idx, fill_value=0)
                   .rename_axis('sale_date')
                   .reset_index())

        # Build features
        featured = build_features(working.copy())
        if featured.empty:
            break

        # Ensure all expected feature columns exist in featured
        for c in feature_cols:
            if c not in featured.columns:
                featured[c] = 0.0
        last_row = featured.iloc[[-1]][feature_cols]

        # Predict next day
        next_qty  = float(model.predict(last_row)[0])
        next_qty  = max(0.0, next_qty)
        next_date = working['sale_date'].max() + pd.Timedelta(days=1)

        # Append to history for next iteration
        new_row  = pd.DataFrame({
            'sale_date': [next_date],
            'quantity':  [next_qty]
        })
        working = pd.concat([working, new_row], ignore_index=True)

        predictions.append({
            'date'    : next_date.strftime('%Y-%m-%d'),
            'quantity': round(next_qty, 2)
        })

    return predictions
