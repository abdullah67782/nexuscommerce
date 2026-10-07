"""Build self-contained Kaggle notebooks from the verified experiment code."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
CORE = (ROOT / "store_personalization.py").read_text(encoding="utf-8").split('\nif __name__ == "__main__":')[0]
ADAPTER = (ROOT / "m5_adapter.py").read_text(encoding="utf-8")


def markdown(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(keepends=True)}


def code(text):
    compile(text, "<notebook cell>", "exec")
    return {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": text.splitlines(keepends=True)}


def write_notebook(name, cells):
    for i, cell in enumerate(cells):
        cell["id"] = f"experiment-{i:02d}"
    notebook = {"cells": cells, "nbformat": 4, "nbformat_minor": 5,
                "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                             "language_info": {"name": "python"}}}
    (ROOT / name).write_text(json.dumps(notebook, indent=2, ensure_ascii=False), encoding="utf-8")
    print("Built", name)


COMMON_INTRO = """
CPU settings and the forecasting method remain fixed. Do not adjust settings after looking at final-test scores.
Each run excludes its target store from general training and uses only its earlier sales for adaptation.
Validation chooses the method; the later final test measures it. Report every planned store, including failures to improve.
These folds share source data and are not statistically independent experiments.
The output models remain experimental and must not replace application files yet.
"""

SUMMARY = """
summary = pd.concat(all_metrics, ignore_index=True)
summary.to_csv(OUTPUT_ROOT / 'all_store_metrics.csv', index=False)
display(summary.round(3))
comparison = summary.loc[summary.period == 'final_test'].pivot(index=['target_store', 'horizon'], columns='method', values='WAPE_percent')
comparison['personalization_gain_relative_percent'] = 100 * (comparison.general - comparison.personalized) / comparison.general
comparison.to_csv(OUTPUT_ROOT / 'personalization_comparison.csv')
display(comparison.round(3))
print('Positive gain means lower error after personalization. Selection still uses validation only.')
import shutil
archive = shutil.make_archive(str(OUTPUT_ROOT), 'zip', OUTPUT_ROOT)
print('Download:', archive)
"""


def build():
    write_notebook("nexus_additional_stores.ipynb", [
        markdown("# NexusCommerce: additional-store experiment\nAdd Store Item Demand Forecasting Challenge as Kaggle input. Run cells in order.\n" + COMMON_INTRO + "\nStores 1 and 5 are chosen in advance, not selected after inspecting their outcomes. Store 10's completed results are retained separately. Training through 2016, validation Jan-Jun 2017, final test Jul-Dec 2017.\n"),
        code(CORE),
        code("data = load_data(locate_data())\nprint('Rows:', len(data), 'Stores:', data.store.nunique(), 'Products:', data.item.nunique())\n"),
        code(r"""TARGET_STORES = [1, 5]  # Predefined follow-up; keep both outcomes.
OUTPUT_ROOT = Path('/kaggle/working/nexus_additional_stores')
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
all_metrics = []
for target_store in TARGET_STORES:
    print('\nTARGET STORE', target_store)
    config = Config(target_store=target_store)
    validation, final_test, selection = run_experiment(data, OUTPUT_ROOT / f'store_{target_store}', config)
    for period, table in [('validation', validation), ('final_test', final_test)]:
        all_metrics.append(table.assign(target_store=target_store, period=period))
"""),
        markdown("## Compare all outcomes\nLower WAPE is better. A gain does not automatically demonstrate statistical significance or transfer to unrelated businesses. Download the ZIP and completed notebook.\n"),
        code(SUMMARY),
    ])
    write_notebook("nexus_m5_personalization.ipynb", [
        markdown("# NexusCommerce: M5 personalization experiment\nAdd M5 calendar, sales_train_evaluation (or validation), and sell_prices inputs. This is a separate experiment, not merged with the store-item dataset.\n" + COMMON_INTRO + "\nWe sample up to 20 items per category using seed 42, then require early price availability in all stores. This bounds memory and produces a catalog-selected subset, not a complete M5 benchmark. Training ends May 2015, validation Jun-Nov 2015, final test Dec 2015-May 2016. Prices trim pre-launch zeros; they are not forecasting inputs. No holiday/price effects or prediction intervals are claimed.\n"),
        code(CORE), code(ADAPTER),
        code("""calendar_path, sales_path, prices_path = locate_m5()
data, details = adapt_m5(calendar_path, sales_path, prices_path, items_per_category=20)
print('Store mapping:', details['store_mapping'])
display(data.head())
"""),
        code("""TARGET_STORE_NAMES = ['CA_1', 'TX_1', 'WI_1']  # One predefined store in each state.
OUTPUT_ROOT = Path('/kaggle/working/nexus_m5_personalization')
save_m5_metadata(details, OUTPUT_ROOT)
all_metrics = []
for store_name in TARGET_STORE_NAMES:
    target_store = details['store_mapping'][store_name]
    config = Config(target_store=target_store, train_end='2015-05-31', validation_end='2015-11-30', test_end='2016-05-22')
    run_dir = OUTPUT_ROOT / store_name
    validation, final_test, selection = run_experiment(data, run_dir, config)
    manifest_path = run_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest.update(dataset='M5 subset', target_store_name=store_name,
                    training_countries='US retail stores; no cross-country claim',
                    scope='Predefined subset and held-out stores; results are not the official full M5 benchmark.')
    manifest_path.write_text(json.dumps(manifest, indent=2))
    for period, table in [('validation', validation), ('final_test', final_test)]:
        all_metrics.append(table.assign(target_store=store_name, period=period))
"""),
        markdown("## Review and download\nResults for intermittent low-volume sales can be weaker than the earlier dataset. Report that rather than hiding it. Evaluate the per-item reports and the chosen method, not just an overall average.\n"),
        code(SUMMARY),
    ])


if __name__ == "__main__":
    build()
