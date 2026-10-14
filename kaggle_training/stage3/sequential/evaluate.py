"""Gates and reporting for the sequential inventory evaluation (frozen with the protocol; used identically in
development and in the one-time final run).

Per cell (segment x level, the frozen A2 selection), on the series whose segment at the start of the replay is the
cell's segment, pooled over the five (L, R) pairs at kappa = 1:
  G1  >= 30 series and >= 200 series x pair replays;
  G2  fewer lost units than D0: reduction > 0, and the 95% intervals of the reduction (product-cluster bootstrap
      and 28-day date-block bootstrap) are both above 0;
  G3  net benefit > 0 at the primary assumptions (margin 30%, holding 25% a year), both 95% intervals above 0:
          net = m x (value of lost sales avoided) - h / 365 x (extra value of stock held, per day)
      values at the M5 sell price (a stand-in for unit value; cost is not in the data);
  G4  better than the seller rule: at the candidate's stock-holding value, the seller safety-stock curve S(0..14 days)
      (linear interpolation) loses at least as much sales value. A candidate holding more than S(14) fails G4: no
      seller rule that large was tested, so it cannot be shown to beat one;
  G5  robust to the starting stock: at kappa 0.5 and 1.5 the reduction and the net benefit stay above 0;
  G6  engine parity is exact (checked separately; recorded here).
All six must hold. Sensitivity of the net benefit over margin {15, 30, 45}% x holding {15, 25, 40}% is reported;
only the primary pair decides.
"""
import numpy as np

MARGIN, HOLD = 0.30, 0.25
GRID_M, GRID_H = (0.15, 0.30, 0.45), (0.15, 0.25, 0.40)
B = 1000
MIN_SERIES, MIN_REPLAYS = 30, 200


def net(m, h, d0, x, sl=slice(None)):
    return m * (d0["lost_value"][sl] - x["lost_value"][sl]) - h / 365 * (x["hold_value"][sl] - d0["hold_value"][sl])


def boot_ci(stat, groups, rng, b=B):
    groups = np.asarray(groups)
    u = np.unique(groups)
    members = {g: np.flatnonzero(groups == g) for g in u}
    vals = []
    for _ in range(b):
        pick = rng.choice(u, size=len(u), replace=True)
        vals.append(stat(np.concatenate([members[g] for g in pick])))
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def block_ci(per_block, rng, b=B):
    """per_block: [blocks] totals; resample blocks with replacement."""
    nb = len(per_block)
    vals = [per_block[rng.integers(0, nb, size=nb)].sum() for _ in range(b)]
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def stack(res, pairs, rows):
    """Pool metrics over pairs: res[(L, R)] = {metric: [N]} for kappa fixed; rows = series positions."""
    keys = ["lost", "lost_value", "hold_units", "hold_value", "ordered", "orders", "stockout_days", "demand", "end_stock"]
    out = {k: np.concatenate([res[p][k][rows] for p in pairs]) for k in keys}
    for k in ("blk_lost", "blk_lost_value", "blk_hold_value"):
        out[k] = np.concatenate([res[p][k][rows] for p in pairs])
    return out


def seller_interp(curve, hold):
    """curve: [(hold_value, lost_value)] for S(0), S(2), ... ; returns the seller lost value at `hold` (no extrapolation)."""
    pts = sorted(curve)
    hs = np.array([p[0] for p in pts])
    ls = np.array([p[1] for p in pts])
    if hold <= hs[0]:
        return float(ls[0]), "below_seller_range"
    if hold >= hs[-1]:
        return float(ls[-1]), "beyond_seller_range"
    return float(np.interp(hold, hs, ls)), "interpolated"


def cell_gates(name, rows, items, res, pairs, seller_days, seed, parity_ok):
    """res[policy][kappa][(L, R)] = {metric: [N]} over ALL series; rows = this cell's series positions."""
    rng = np.random.default_rng(seed)
    n_series = int(len(rows))
    out = {"cell": name, "series": n_series, "replays": n_series * len(pairs)}
    if n_series == 0:
        out.update(passed=False, reason="no series in this segment at the start of the replay")
        return out
    d0 = stack(res["D0"][1.0], pairs, rows)
    x = stack(res[name][1.0], pairs, rows)
    it = np.concatenate([items[rows]] * len(pairs))
    red = d0["lost"] - x["lost"]
    nb_primary = net(MARGIN, HOLD, d0, x)
    blk_red = (d0["blk_lost"] - x["blk_lost"]).sum(axis=0)
    blk_net = (MARGIN * (d0["blk_lost_value"] - x["blk_lost_value"]) - HOLD / 365 * (x["blk_hold_value"] - d0["blk_hold_value"])).sum(axis=0)
    out["totals"] = {
        "demand_units": float(d0["demand"].sum()), "lost_D0": float(d0["lost"].sum()), "lost_candidate": float(x["lost"].sum()),
        "fill_rate_D0": float(1 - d0["lost"].sum() / max(d0["demand"].sum(), 1e-9)),
        "fill_rate_candidate": float(1 - x["lost"].sum() / max(x["demand"].sum(), 1e-9)),
        "stockout_days_D0": float(d0["stockout_days"].sum()), "stockout_days_candidate": float(x["stockout_days"].sum()),
        "hold_unit_days_D0": float(d0["hold_units"].sum()), "hold_unit_days_candidate": float(x["hold_units"].sum()),
        "ordered_D0": float(d0["ordered"].sum()), "ordered_candidate": float(x["ordered"].sum()),
        "lost_value_D0": float(d0["lost_value"].sum()), "lost_value_candidate": float(x["lost_value"].sum()),
        "hold_value_D0": float(d0["hold_value"].sum()), "hold_value_candidate": float(x["hold_value"].sum()),
        "end_stock_D0": float(d0["end_stock"].sum()), "end_stock_candidate": float(x["end_stock"].sum()),
    }
    avoided = float(red.sum())
    extra_hold = float(x["hold_units"].sum() - d0["hold_units"].sum())
    out["extra_unit_days_per_avoided_unit"] = extra_hold / avoided if avoided > 0 else None
    out["reduction_units"] = avoided
    out["reduction_ci_product"] = boot_ci(lambda ix: red[ix].sum(), it, rng)
    out["reduction_ci_date_block"] = block_ci(blk_red, rng)
    out["net_benefit_primary"] = float(nb_primary.sum())
    out["net_ci_product"] = boot_ci(lambda ix: nb_primary[ix].sum(), it, rng)
    out["net_ci_date_block"] = block_ci(blk_net, rng)
    out["sensitivity"] = {f"m{int(m * 100)}_h{int(h * 100)}": float(net(m, h, d0, x).sum()) for m in GRID_M for h in GRID_H}
    curve = [(float(stack(res["D0"][1.0], pairs, rows)["hold_value"].sum()), float(d0["lost_value"].sum()))]
    for k in seller_days:
        s = stack(res[f"S{k}"][1.0], pairs, rows)
        curve.append((float(s["hold_value"].sum()), float(s["lost_value"].sum())))
    seller_lost, how = seller_interp(curve, float(x["hold_value"].sum()))
    out["seller_curve"] = [{"policy": n, "hold_value": c[0], "lost_value": c[1]} for n, c in zip(["D0"] + [f"S{k}" for k in seller_days], curve)]
    out["seller_lost_value_at_candidate_holding"] = seller_lost
    out["seller_comparison"] = how
    robust = {}
    for kap in (0.5, 1.5):
        d0k = stack(res["D0"][kap], pairs, rows)
        xk = stack(res[name][kap], pairs, rows)
        robust[str(kap)] = {"reduction_units": float((d0k["lost"] - xk["lost"]).sum()), "net_benefit_primary": float(net(MARGIN, HOLD, d0k, xk).sum())}
    out["kappa_robustness"] = robust
    per_pair = {}
    for p in pairs:
        dp, xp = res["D0"][1.0][p], res[name][1.0][p]
        per_pair[f"L{p[0]}_R{p[1]}"] = {"lost_D0": float(dp["lost"][rows].sum()), "lost_candidate": float(xp["lost"][rows].sum()),
                                        "net_benefit_primary": float(net(MARGIN, HOLD, {k: v[rows] for k, v in dp.items() if not isinstance(v, dict)},
                                                                         {k: v[rows] for k, v in xp.items() if not isinstance(v, dict)}).sum())}
    out["per_pair"] = per_pair
    g = {
        "G1_sample": n_series >= MIN_SERIES and n_series * len(pairs) >= MIN_REPLAYS,
        "G2_shortage_reduction": avoided > 0 and out["reduction_ci_product"][0] > 0 and out["reduction_ci_date_block"][0] > 0,
        "G3_net_benefit": out["net_benefit_primary"] > 0 and out["net_ci_product"][0] > 0 and out["net_ci_date_block"][0] > 0,
        "G4_better_than_seller_rule": how != "beyond_seller_range" and float(x["lost_value"].sum()) <= seller_lost,
        "G5_kappa_robust": all(v["reduction_units"] > 0 and v["net_benefit_primary"] > 0 for v in robust.values()),
        "G6_engine_parity": bool(parity_ok),
    }
    out["gates"] = g
    out["passed"] = all(g.values())
    out["promotion_authorised"] = False   # a pass authorises only an implementation review (optional, seller-approved advice)
    return out
