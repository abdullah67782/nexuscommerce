# Training materials

- `original_training/model-training-final.ipynb`: original Kaggle XGBoost training notebook, retained unchanged for audit and comparison.
- `original_training/datasets/`: original UCI and Superstore CSV files.
- `archive/legacy_training/`: older Random Forest notebooks and standalone training script. These are historical references, not the new training pipeline. The standalone script's relative output directory refers to its old location; do not run it as the production training workflow.
- `new_training/`: new Kaggle notebook, matching Python pipeline and verification checks for general forecasting and store personalization.
- `../data/store_item_demand/`: new Store Item Demand Forecasting dataset archive.
- `../data/m5/`: M5 sales and price archives plus calendar CSV.

The original notebook still contains its Kaggle input paths. Upload the original datasets to Kaggle when reproducing it; local folder organization does not change those paths.

Runtime XGBoost models remain in `../ml/models/`. No model files or datasets were deleted.
