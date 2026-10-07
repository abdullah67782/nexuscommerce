"""Sales-history queries used by the ML server.

Every query is scoped to the requesting seller: a product's history is only
returned when the product belongs to that seller (products with no owner never
match), and sales quarantined for conflicting provenance are excluded. Kept
separate from main.py so it can be tested without FastAPI.

Daily filling is unchanged from the original behaviour (zeros between the first
and last recorded sale). Coverage-aware filling is planned for a later phase.
"""
from typing import Callable, Optional

import pandas as pd

# Both queries read the attributed_sales view (created by backend/config/initDb.js):
# sales of products owned by the seller, excluding rows whose import was made by
# a different seller (quarantined provenance conflicts). The view is the single
# definition of "this seller's sales" for the backend and the ML server.
PRODUCT_HISTORY_SQL = """
    SELECT sale_date, SUM(quantity) AS quantity
    FROM attributed_sales
    WHERE product_id = %s
      AND seller_id = %s
    GROUP BY sale_date
    ORDER BY sale_date ASC
"""

SELLER_HISTORY_SQL = """
    SELECT sale_date, SUM(quantity) AS quantity
    FROM attributed_sales
    WHERE seller_id = %s
    GROUP BY sale_date
    ORDER BY sale_date ASC
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
