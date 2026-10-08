# v2 production models

These scripts produced the two shared models in `ml/models_v2/`, and evaluated them once.

## Scripts

Run them in this order, from this folder. Each script refuses to run twice or out of order.

| Step | Script | What it does |
|---|---|---|
| 1 | `reserve_holdout.py` | Reserves 60 fresh products by reading catalog metadata only. Their sales are never read here. |
| 2 | `train_production.py` | Trains the 7-day and 28-day models using the fixed recipe and the 53 development products, with data up to 2015-05-31. |
| 3 | `freeze_evaluation.py` | Records the hashes of the reservation, models, manifest and code before any holdout sales are read. |
| 4 | `evaluate_production.py --execute-once` | Evaluates once, through the app's own `ml/v2` code. |

## Results

`outputs/review.md` has the results, the order of work and the limits. Raw outputs are in
`outputs/evaluation_results/`.

## Requirements

The scripts need the M5 files in `data/m5/`. That folder is not in git; see the
repository README.

The runs above used xgboost 3.4.1, built from the official source tag, the version the
app pins.

## Do not rerun

The holdout has been used. Rerunning any step requires deleting evidence, and must not
be done. Any change to the models or rules needs a new reservation.
