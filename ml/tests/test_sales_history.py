"""Seller isolation for the ML server's sales-history queries.

Runs without a database or FastAPI: psycopg2 is replaced by a stub and the
connection by a fake that records the SQL and parameters it receives.
Run from the ml/ folder:  python -m unittest discover -s tests -v
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Stub psycopg2.extras.RealDictCursor so the module imports without psycopg2.
extras = types.ModuleType("psycopg2.extras")
extras.RealDictCursor = object
psycopg2_stub = types.ModuleType("psycopg2")
psycopg2_stub.extras = extras
sys.modules.setdefault("psycopg2", psycopg2_stub)
sys.modules.setdefault("psycopg2.extras", extras)

import sales_history  # noqa: E402


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []
        self.closed = False

    def cursor(self, cursor_factory=None):
        conn = self

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params):
                conn.executed.append((sql, params))

            def fetchall(self):
                return conn.rows

        return Cursor()

    def close(self):
        self.closed = True


class ProductHistoryIsolation(unittest.TestCase):
    def test_query_is_scoped_to_the_product_owner(self):
        conn = FakeConnection([{"sale_date": "2026-01-01", "quantity": 3}])
        sales_history.product_sales_history(lambda: conn, product_id=7, seller_id=42)
        sql, params = conn.executed[0]
        self.assertIn("FROM attributed_sales", sql)
        self.assertIn("seller_id = %s", sql)
        self.assertNotIn(" sales ", sql.replace("attributed_sales", ""), "must not read the raw sales table")
        self.assertEqual(params, (7, 42))
        self.assertTrue(conn.closed)

    def test_no_rows_means_no_history(self):
        conn = FakeConnection([])
        self.assertIsNone(sales_history.product_sales_history(lambda: conn, 7, 42))

    def test_missing_seller_never_queries(self):
        conn = FakeConnection([{"sale_date": "2026-01-01", "quantity": 3}])
        self.assertIsNone(sales_history.product_sales_history(lambda: conn, 7, None))
        self.assertEqual(conn.executed, [])

    def test_daily_filling_is_unchanged(self):
        conn = FakeConnection([
            {"sale_date": "2026-01-01", "quantity": 3},
            {"sale_date": "2026-01-04", "quantity": 5},
        ])
        df = sales_history.product_sales_history(lambda: conn, 7, 42)
        self.assertEqual(list(df["quantity"]), [3.0, 0.0, 0.0, 5.0])


class SellerHistoryIsolation(unittest.TestCase):
    def test_query_is_scoped_to_the_seller(self):
        conn = FakeConnection([{"sale_date": "2026-01-01", "quantity": 3}])
        sales_history.seller_sales_history(lambda: conn, seller_id=42)
        sql, params = conn.executed[0]
        self.assertIn("FROM attributed_sales", sql)
        self.assertIn("seller_id = %s", sql)
        self.assertEqual(params, (42,))


if __name__ == "__main__":
    unittest.main()
