"""Event layer E1: adjusted = F * exp(x . beta), no intercept (dev protocol 'event_layer_E1').

Fit: Poisson deviance with exposure F on rows aggregated by (origin, h, cell), ridge penalty.
Objective (fixed before any selection-period result was seen):
    L(beta) = sum_r [F_r exp(eta_r) - A_r eta_r] / sum_r F_r  +  (alpha * 1e-3 / 2) * ||beta||^2
Rows with F < 1 unit were excluded upstream (never adjusted). Levels add cell-specific
deviations scaled by `group_feature_scale` (stronger effective shrinkage to the pooled effect).
"""
import numpy as np
from scipy import optimize


def fit_poisson(X, A, F, alpha):
    X = np.asarray(X, dtype=float)
    A = np.asarray(A, dtype=float)
    F = np.asarray(F, dtype=float)
    total = F.sum()
    lam = alpha * 1e-3

    def fun(beta):
        eta = X @ beta
        mu = F * np.exp(eta)
        loss = (mu.sum() - (A * eta).sum()) / total + lam / 2 * beta @ beta
        grad = X.T @ (mu - A) / total + lam * beta
        return loss, grad

    res = optimize.minimize(fun, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B",
                            options={"maxiter": 2000, "gtol": 1e-9})
    return res.x, res


def design(x, cells, n_cells, scale):
    """Pooled features x, plus one scaled copy per cell (only that cell's rows non-zero)."""
    if n_cells == 0:
        return x
    blocks = [x]
    for c in range(n_cells):
        blocks.append(np.where((cells == c)[:, None], x * scale, 0.0))
    return np.hstack(blocks)


def fit_poisson_weighted(X, A, F, alpha):
    """Amendment A1 (E1w): penalty per coefficient scaled by its share of exposure-weighted forecast units,
    lam_k = alpha * 1e-3 * (sum_r F_r x_rk / sum_r F_r), so rarely exposed effects are not over-shrunk."""
    X = np.asarray(X, dtype=float)
    A = np.asarray(A, dtype=float)
    F = np.asarray(F, dtype=float)
    total = F.sum()
    lam = alpha * 1e-3 * np.maximum((F[:, None] * X).sum(axis=0) / total, 1e-12)

    def fun(beta):
        eta = X @ beta
        mu = F * np.exp(eta)
        loss = (mu.sum() - (A * eta).sum()) / total + 0.5 * (lam * beta * beta).sum()
        grad = X.T @ (mu - A) / total + lam * beta
        return loss, grad

    res = optimize.minimize(fun, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B",
                            options={"maxiter": 5000, "gtol": 1e-10})
    return res.x, res
