import os
import joblib

MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')


def get_model_for_seller(seller_id: int, category: str):
    """
    Returns (model, feature_cols, model_name)
    Priority 1: Fine-tuned model for this seller
    Priority 2: Base model for seller's category
    Priority 3: United Kingdom base model (fallback)
    """
    safe_cat       = category.replace(' ', '_').replace('/', '_')
    finetuned_path = f"{MODELS_DIR}/xgb_finetuned_{seller_id}.pkl"
    base_path      = f"{MODELS_DIR}/xgb_{safe_cat}.pkl"
    fallback_path  = f"{MODELS_DIR}/xgb_United_Kingdom.pkl"

    if os.path.exists(finetuned_path):
        model     = joblib.load(finetuned_path)
        feat_cols = joblib.load(
            f"{MODELS_DIR}/features_finetuned_{seller_id}.pkl"
        )
        model_name = "xgboost_finetuned"

    elif os.path.exists(base_path):
        model     = joblib.load(base_path)
        feat_cols = joblib.load(f"{MODELS_DIR}/features_{safe_cat}.pkl")
        model_name = "xgboost_base"

    else:
        model     = joblib.load(fallback_path)
        feat_cols = joblib.load(
            f"{MODELS_DIR}/features_United_Kingdom.pkl"
        )
        model_name = "xgboost_fallback"

    return model, feat_cols, model_name
