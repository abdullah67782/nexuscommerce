# Correction to the Stage 3 data audit (architect review 2026-10-13, item 1)

The original audit is **preserved unchanged**:

| File | sha256 |
|---|---|
| `audit_datasets.py` | `bc24e21a6f64428b85ae8760a99a3e8e75e8be2affd620f00a1ed798a383c2b8` |
| `outputs/audit.json` | `e34ee9abc759f81f9bb1d6146c83500b07964168283edd43c7ed9f4dc674c99c` |

**Do not rerun `audit_datasets.py`.** It loads complete files.

## What the original audit claimed, and what it actually did

Each dataset was **loaded into memory, then excluded from analysis**. The claim "never read" was inaccurate.

| Dataset | Claim in the script and proposal | What the code actually did |
|---|---|---|
| M5 | Sales read only for the 180 consumed products | Loaded every product's sales columns (`pd.read_csv(..., usecols=id_cols + day_cols)`), **then** filtered to the 180 consumed products before any aggregation |
| Pakistan e-commerce | Rows after 2017-12-31 "never aggregated; only the latest date read" | Loaded every row (`pd.read_csv(path)`), **then** kept rows dated ≤ 2017-12-31 before any aggregation. The full date column was used for the reported range. |
| Store Item Demand | 2017 sales not read | Loaded every row including 2017 sales, **then** filtered to dates ≤ 2016-12-31 before any aggregation. Ids and the date range were reported for all years. |

Code inspection (the architect's and ours) finds no reported number computed from an excluded target:
- M5 aggregates use only the filtered `sales` frame;
- Pakistan aggregates use only the filtered `df`;
- Store Item aggregates use only `dev`.

`audit.json` contains, for excluded parts, only:
- the Pakistan final period's latest date (2018-08-28);
- the Store Item date range and id counts;
- M5 catalog counts.

The holdouts therefore remain usable. Their provenance is "loaded into memory by the audit and excluded from analysis", not "never read".

## Other corrections to the audit's wording

1. **Pakistan categories.** "16 categories, plus 295 products with no category" was a miscount. The data has **15 named categories plus one uncategorised group (`\N`, 295 products)**: 16 groups in all.
2. **Eid in M5.** The descriptive audit supports only "**no consistent Eid pattern was observed in the inspected US sample**" (180 consumed products × 10 stores, 5 occurrences of each Eid). It does not prove the absence of an Eid effect.
3. **Pakistan target.** Without order status, the target is **recorded order quantities**, which include orders that may have been cancelled or refunded. It is not verified fulfilled demand.

## Corrected loaders (used by all further work)

`kaggle_training/stage3/data_access.py`:

- **M5**
  - Only sales-day columns up to the requested end date are selected (`usecols`).
  - Rows of products that were not requested are skipped by the CSV parser (`skiprows`), so their sales are never converted into values.
  - Development calls cannot end after 2015-10-31 and cannot request a reserved holdout product; both raise `FinalAccessSealed`.
- **Pakistan**
  - `extract_pakistan_dev.py` runs on the owner's machine. It tests the date field of each line first and drops later lines without converting any other field or counting them.
  - Only development rows are written, and only that extract reaches the cloud workspace. The full file never does.
  - Extract: 424,809 rows (the same count the audit reported), sha256 `fa96772c…ec19f4`. The source file is ordered by date: every final-period line follows all development lines.
  - The loader verifies the extract's manifest and refuses any date after 2017-12-31.
- **Store Item Demand** is not used by Stage 3.
