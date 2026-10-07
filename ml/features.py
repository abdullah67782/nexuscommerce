import numpy as np
import pandas as pd


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Input:  DataFrame with [sale_date (datetime), quantity (float)]
            All calendar days must be present (fill missing with 0)
            Must be sorted by sale_date ascending
    Output: DataFrame with 60+ features, NaN rows dropped
    """
    df = df.copy()

    # Calendar features
    d = df['sale_date'].dt
    df['day_of_week']    = d.dayofweek
    df['day_of_month']   = d.day
    df['day_of_year']    = d.dayofyear
    df['week_of_year']   = d.isocalendar().week.astype(int)
    df['month']          = d.month
    df['quarter']        = d.quarter
    df['year']           = d.year
    df['is_weekend']     = (d.dayofweek >= 5).astype(int)
    df['is_month_start'] = d.is_month_start.astype(int)
    df['is_month_end']   = d.is_month_end.astype(int)
    df['is_quarter_end'] = d.is_quarter_end.astype(int)

    # Cyclical encoding
    df['dow_sin']   = np.sin(2 * np.pi * df['day_of_week'] / 7)
    df['dow_cos']   = np.cos(2 * np.pi * df['day_of_week'] / 7)
    df['month_sin'] = np.sin(2 * np.pi * df['month'] / 12)
    df['month_cos'] = np.cos(2 * np.pi * df['month'] / 12)
    df['doy_sin']   = np.sin(2 * np.pi * df['day_of_year'] / 365)
    df['doy_cos']   = np.cos(2 * np.pi * df['day_of_year'] / 365)

    # Lag features
    for lag in [1, 2, 3, 4, 5, 6, 7, 14, 21, 28]:
        df[f'lag_{lag}'] = df['quantity'].shift(lag)

    # Rolling statistics
    for window in [3, 7, 14, 28, 56]:
        roll = df['quantity'].shift(1).rolling(window, min_periods=1)
        df[f'roll_mean_{window}']   = roll.mean()
        df[f'roll_std_{window}']    = roll.std().fillna(0)
        df[f'roll_min_{window}']    = roll.min()
        df[f'roll_max_{window}']    = roll.max()
        df[f'roll_median_{window}'] = roll.median()

    # Exponentially weighted moving averages
    for span in [3, 7, 14, 28]:
        df[f'ewm_{span}'] = (
            df['quantity'].shift(1).ewm(span=span, adjust=False).mean()
        )

    # Trend features
    df['trend_7']  = df['quantity'].shift(1) - df['quantity'].shift(8)
    df['trend_14'] = df['quantity'].shift(1) - df['quantity'].shift(15)
    df['trend_28'] = df['quantity'].shift(1) - df['quantity'].shift(29)

    # Lag ratios
    df['lag1_over_roll7']  = df['lag_1'] / (df['roll_mean_7']  + 1)
    df['lag7_over_roll28'] = df['lag_7'] / (df['roll_mean_28'] + 1)

    return df.dropna().reset_index(drop=True)


EXCLUDE_COLS = [
    'sale_date', 'category', 'quantity', 'revenue',
    'avg_price', 'n_orders'
]
