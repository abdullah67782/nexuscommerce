"""Sequential (multi-cycle) inventory replay for the Stage 3 purchasing-protection evaluation.

One 182-day replay per series and configuration (lead time L, review period R, starting-stock factor kappa):
  * every R days (review day t, planning day 1 = day t) the frozen release is served on the history up to day t
    (application code, through common.serve) and each policy computes its order with the Stage 2 engine's own
    minimum-quantity rule (a port of backend/lib/replenishment/engine.js minimumQuantity + whole units; pack 1,
    MOQ 1; parity with the JavaScript engine is checked exactly on sampled decisions);
  * an order placed on day t is usable on day t + L + 1 (A2);
  * every day: deliveries usable that day join the stock, demand is the actual daily sales, unmet demand is lost
    (A3; a lower bound where stock-outs are unknown), end-of-day stock is held.
Policies:
  D0       Stage 2 quantity on the point forecast (A1 spreading), safety stock 0          (baseline)
  S(k)     the same with a seller-set safety stock of k days of average sales, fixed at the start      (comparators)
  cell     the frozen A2 selection for one segment and level (D2@p / D2c@p: the p-quantile of the Stage 2
           quantity over 100 analogue demand paths; D2c zeroes 25 December), applied at a review only when the
           product is in that segment at that review; otherwise the D0 quantity.
If the two forecast totals are inconsistent (T28 < T7) no policy orders at that review (the engine gives no quantity).
"""
import hashlib
import math

import numpy as np
import pandas as pd

EPS = 1e-9
J_PATHS = 100
REPLAY_DAYS = 182
PAIRS = [(3, 7), (7, 7), (3, 14), (7, 14), (14, 7)]
KAPPAS = (0.5, 1.0, 1.5)
SELLER_DAYS = (2, 4, 7, 10, 14)
BLOCK = 28


def whole(x):
    x = np.asarray(x, dtype=float)
    return np.where(x <= EPS, 0.0, np.ceil(x - 1e-6))


def grid_a1(t7, t28):
    """[N, 28] A1 spreading (days 1-7 at T7/7, 8-28 at (T28-T7)/21); rows with T28 < T7 are NaN (no quantity)."""
    t7 = np.asarray(t7, float)[:, None]
    t28 = np.asarray(t28, float)[:, None]
    g = np.concatenate([np.repeat(t7 / 7, 7, axis=1), np.repeat((t28 - t7) / 21, 21, axis=1)], axis=1)
    g[(t28 < t7)[:, 0]] = np.nan
    return g


def min_raw(start, demand, arrivals, a, R, SS=0.0):
    """Continuous minimum quantity (engine minimumQuantity): start [N], demand [N,28] or [N,J,28], arrivals [N,28]
    (planning day k at index k-1), a = L + 2. Broadcasts over a path axis."""
    demand = np.asarray(demand, float)
    stock = np.asarray(start, float)
    arr = np.asarray(arrivals, float)
    if demand.ndim == 3:
        stock = stock[:, None]
        arr = arr[:, None, :]
        SS = np.asarray(SS, float)[:, None] if np.ndim(SS) else SS
    for k in range(a - 1):                       # days 1..a-1, lost sales
        stock = np.maximum(0.0, stock + arr[..., k] - demand[..., k])
    bal = stock
    lowest = np.full(np.shape(bal), np.inf)
    for k in range(a - 1, a - 1 + R):            # days a..a+R-1: balance is linear in Q
        bal = bal + arr[..., k] - demand[..., k]
        lowest = np.minimum(lowest, bal)
    return np.maximum.reduce([np.zeros_like(bal), -lowest, SS - bal])


def series_seed(key, review):
    return int(hashlib.sha256(f"seq|{key}|{review}".encode()).hexdigest()[:16], 16)


def analogues(v, i):
    starts = [i - 7 * k for k in range(4, 53) if i - 7 * k >= 28]
    if not starts:
        return np.zeros((0, 28))
    return np.stack([v[u:u + 28] / (v[u - 28:u].mean() + 1.0) for u in starts])


class Prepared:
    """Forecasts, segments and demand paths at every 7-day review for a set of series (shared by all policies)."""

    def __init__(self, table, served_rows, start):
        self.keys = sorted(table)
        self.table = table
        self.start = pd.Timestamp(start)
        self.reviews = list(range(0, REPLAY_DAYS, 7))
        n, r = len(self.keys), len(self.reviews)
        self.T7 = np.full((n, r), np.nan)
        self.T28 = np.full((n, r), np.nan)
        self.seg = np.full((n, r), None, dtype=object)
        pos = {k: j for j, k in enumerate(self.keys)}
        rows = served_rows
        for row in rows.itertuples():
            j = pos[row.table_key]
            ri = (int(row.i) - table[row.table_key]["i0"]) // 7
            if row.h == 7:
                self.T7[j, ri] = row.F
            else:
                self.T28[j, ri] = row.F
            self.seg[j, ri] = row.group
        self.actual = np.stack([table[k]["actual"] for k in self.keys])
        self.price = np.stack([table[k]["price"] for k in self.keys])
        self.cat = np.array([table[k]["cat"] for k in self.keys])
        self.item = np.array([table[k]["item"] for k in self.keys])
        self.seg0 = self.seg[:, 0]
        # Seller-set safety stock: k days of the average daily sales over the 28 days before the replay (whole units).
        self.avg28 = np.array([table[k]["values"][table[k]["i0"] - 28:table[k]["i0"]].mean() for k in self.keys])
        self._pools = None

    def pools(self, rng_seed):
        """Pooled analogue windows per (category, segment, review) from series with >= 6 own windows (as development)."""
        if self._pools is None:
            self._pools = {}
            for ri, t in enumerate(self.reviews):
                groups = {}
                for j, k in enumerate(self.keys):
                    s = self.table[k]
                    w = analogues(s["values"], s["i0"] + t)
                    if len(w) >= 6:
                        groups.setdefault((self.cat[j], self.seg[j, ri]), []).append(w)
                for g, mats in groups.items():
                    allw = np.vstack(mats)
                    rng = np.random.default_rng(series_seed(f"pool|{g[0]}|{g[1]}", t) ^ rng_seed)
                    self._pools[(g[0], g[1], ri)] = allw[rng.choice(len(allw), size=min(len(allw), 400), replace=False)]
        return self._pools

    def paths(self, idx, ri, closure, rng_seed):
        """[len(idx), J, 28] demand paths at review ri (scaled to the 28-day forecast); source per series."""
        t = self.reviews[ri]
        pools = self.pools(rng_seed)
        out = np.zeros((len(idx), J_PATHS, 28))
        src = []
        day0 = self.start + pd.Timedelta(days=t)
        days = pd.date_range(day0, periods=28)
        xmas = np.asarray((days.month == 12) & (days.day == 25))
        for n, j in enumerate(idx):
            k = self.keys[j]
            s = self.table[k]
            T28 = self.T28[j, ri]
            W = analogues(s["values"], s["i0"] + t)
            how = "own"
            if len(W) < 6:
                W = pools.get((self.cat[j], self.seg[j, ri], ri), np.zeros((0, 28)))
                how = "pooled"
            if len(W) and np.isfinite(T28):
                rng = np.random.default_rng(series_seed(k, t) ^ rng_seed)
                pick = W[rng.integers(0, len(W), size=J_PATHS)]
                m = pick.sum(axis=1).mean()
                out[n] = pick * (T28 / m) if m > 0 else 0.0
            else:
                g = grid_a1([self.T7[j, ri]], [T28])[0]
                out[n] = np.nan_to_num(g)[None, :]
                how = "none(point)"
            if closure:
                out[n][:, xmas] = 0.0
            src.append(how)
        return out, src


def replay(prep, idx, configs, policy, rng_seed=0, record=None):
    """Run one policy for series idx under several configurations sharing one review period.
    configs: [(L, R, kappa)] with the same R. policy: ('D0',) | ('S', days) | ('M', segment, level, closure).
    Returns {metric: array [len(configs), len(idx)]} plus path-source counts. Demand paths are drawn once per
    series and review, so every configuration sees the same paths."""
    idx = np.asarray(idx)
    N, C = len(idx), len(configs)
    R = configs[0][1]
    assert all(c[1] == R for c in configs)
    Ls = [c[0] for c in configs]
    actual = prep.actual[idx]
    price = prep.price[idx]
    pending = np.zeros((C, N, REPLAY_DAYS + max(Ls) + 40))
    g0 = grid_a1(prep.T7[idx, 0], prep.T28[idx, 0])
    stock = np.zeros((C, N))
    for c, (L, _, kappa) in enumerate(configs):
        # Starting stock: kappa x the forecast for the first L + 1 + R days (A1; rate T28/28 when inconsistent).
        base = np.where(np.isnan(g0).any(axis=1), prep.T28[idx, 0] / 28 * (L + 1 + R), np.nansum(g0[:, :L + 1 + R], axis=1))
        stock[c] = np.round(kappa * np.nan_to_num(base))
    SS = np.zeros(N) if policy[0] != "S" else np.round(policy[1] * prep.avg28[idx])
    z = lambda: np.zeros((C, N))  # noqa: E731
    lost, hold_units, hold_value, lost_value, ordered, n_orders, stockout_days = z(), z(), z(), z(), z(), z(), z()
    nb = math.ceil(REPLAY_DAYS / BLOCK)
    blk_lost, blk_lost_value, blk_hold_value = np.zeros((C, N, nb)), np.zeros((C, N, nb)), np.zeros((C, N, nb))
    sources = {}
    for t in range(REPLAY_DAYS):
        stock = stock + pending[:, :, t]                     # deliveries usable today
        if t % R == 0:
            ri = t // 7
            T7, T28 = prep.T7[idx, ri], prep.T28[idx, ri]
            grid = grid_a1(T7, T28)
            ok = ~np.isnan(grid).any(axis=1)
            demand = np.nan_to_num(grid)
            use = np.zeros(N, dtype=bool)
            if policy[0] == "M":
                _, seg, level, closure = policy
                use = ok & (prep.seg[idx, ri] == seg)
                if use.any():
                    w = np.flatnonzero(use)
                    paths, src = prep.paths(idx[w], ri, closure, rng_seed)
                    for s_ in src:
                        sources[s_] = sources.get(s_, 0) + 1
            for c, (L, _, _) in enumerate(configs):
                a = L + 2
                arrivals = np.zeros((N, 28))
                arrivals[:, 1:] = pending[c, :, t + 1:t + 28]    # planning days 2..28 (day 1 is already in stock)
                q = whole(min_raw(stock[c], demand, arrivals, a, R, SS))
                if use.any():
                    per_path = min_raw(stock[c][w], paths, arrivals[w], a, R, 0.0)
                    q[w] = whole(np.quantile(per_path, level, axis=1))
                q = np.where(ok, q, 0.0)
                if record is not None and policy[0] in ("D0", "S"):
                    record(idx, t, L, R, stock[c], T7, T28, arrivals, SS, q, ok)
                pending[c, :, t + L + 1] += q
                ordered[c] += q
                n_orders[c] += q > 0
        d = actual[:, t][None, :]
        sold = np.minimum(stock, d)
        short = d - sold
        stock = stock - sold
        b = t // BLOCK
        p = price[:, t][None, :]
        lost += short
        lost_value += short * p
        hold_units += stock
        hold_value += stock * p
        stockout_days += short > EPS
        blk_lost[:, :, b] += short
        blk_lost_value[:, :, b] += short * p
        blk_hold_value[:, :, b] += stock * p
    return {"lost": lost, "lost_value": lost_value, "hold_units": hold_units, "hold_value": hold_value,
            "ordered": ordered, "orders": n_orders, "stockout_days": stockout_days, "end_stock": stock,
            "demand": np.broadcast_to(actual.sum(axis=1), (C, N)).copy(), "blk_lost": blk_lost,
            "blk_lost_value": blk_lost_value, "blk_hold_value": blk_hold_value, "path_sources": sources}
