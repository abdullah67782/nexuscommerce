"""
NexusCommerce — Fine-tuning utilities (legacy compatibility module)

All fine-tuning logic is now handled directly in main.py's
_run_finetune_background function. This module is kept for
any external imports that reference helper functions.
"""
import os
import joblib

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")


def user_has_model(user_id: int) -> bool:
    """Check if a fine-tuned model exists for this seller."""
    finetuned_path = os.path.join(MODELS_DIR, f"xgb_finetuned_{user_id}.pkl")
    return os.path.exists(finetuned_path)


def get_model_path(user_id: int, category: str = "United_Kingdom") -> str:
    """
    Return the best model path for a given seller.
    Priority: finetuned → category base → UK fallback.
    """
    safe_cat = category.replace(' ', '_').replace('/', '_')

    finetuned = os.path.join(MODELS_DIR, f"xgb_finetuned_{user_id}.pkl")
    if os.path.exists(finetuned):
        return finetuned

    base = os.path.join(MODELS_DIR, f"xgb_{safe_cat}.pkl")
    if os.path.exists(base):
        return base

    return os.path.join(MODELS_DIR, "xgb_United_Kingdom.pkl")
