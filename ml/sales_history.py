"""Sales-history queries used by the ML server.

Every query is scoped to the requesting seller: a product's history is only
returned when the product belongs to that seller (products with no owner never
match). Kept separate from main.py so it can be tested without FastAPI.

Daily filling is unchanged from the original behaviour (zeros between the first
and last recorded sale). Coverage-aware filling is planned for a later phase.
"""
from typing import Callable, Optional

import pandas as pd

PRODUCT_HISTORY_SQL = """
    SELECT s.sale_date, SUM(s.quantity) AS quantity
    FROM sales s
    JOIN products p ON p.id = s.product_id
    WHERE s.product_id = %s
      AND p.user_id = %s
    GROUP BY s.sale_date
    ORDER BY s.sale_date ASC
"""

SELLER_HISTORY_SQL = """
    SELECT s.sale_date, SUM(s.quantity) AS quantity
    FROM sales s
    JOIN products p ON s.product_id = p.id
    WHERE p.user_id = %s
    GROUP BY s.sale_date
    ORDER BY s.sale_date ASC
"""


def _fetch(connect: Callable, sql: str, params: tuple):
    from psycopg2.extras import RealDictCursor  # imported lazily for testability

    conn = connect()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def _to_daily_frame(rows) -> Optional[pd.DataFrame]:
    if not rows:
        return None
    df = pd.DataFrame(rows)
    df["sale_date"] = pd.to_datetime(df["sale_date"])
    df["quantity"] = df["quantity"].astype(float)
    full_idx = pd.date_range(df["sale_date"].min(), df["sale_date"].max(), freq="D")
    return (
        df.set_index("sale_date")
        .reindex(full_idx, fill_value=0)
        .rename_axis("sale_date")
        .reset_index()
    )


def product_sales_history(connect: Callable, product_id: int, seller_id: int) -> Optional[pd.DataFrame]:
    """Daily history for one product, or None if it has no sales or is not the seller's."""
    if seller_id is None:
        return None
    return _to_daily_frame(_fetch(connect, PRODUCT_HISTORY_SQL, (product_id, seller_id)))


def seller_sales_history(connect: Callable, seller_id: int) -> Optional[pd.DataFrame]:
    """Daily total across all of the seller's products, or None if there are no sales."""
    if seller_id is None:
        return None
    return _to_daily_frame(_fetch(connect, SELLER_HISTORY_SQL, (seller_id,)))
