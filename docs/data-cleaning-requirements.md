# Data cleaning requirements

These requirements replace the earlier SRS FR-2 wording, which called for median
imputation and IQR outlier removal (architect decisions of 2026-10). They apply
to file uploads (`POST /api/data/upload`) and, where marked, to store-connect
imports (`POST /api/store/connect`).

**Principle:** never invent a sale, and never delete a genuine one. A row that
cannot be read safely is rejected and reported; it is not repaired by guessing.

## Rows that are rejected

A rejected row is reported as a `critical` anomaly, with its original row number
and value. Nothing from it is stored.

| Problem | Anomaly type | Applies to |
|---|---|---|
| Product name missing | `missing_product_name` | files |
| Quantity missing or empty | `missing_quantity` | files, store connect |
| Quantity not a number (e.g. `two`, `1,200`) | `invalid_quantity` | files, store connect |
| Quantity zero or negative | `zero_quantity`, `negative_value` | files, store connect |
| Fractional quantity (e.g. `1.5`). Whole-unit products only, for now | `fractional_quantity` | files, store connect |
| Revenue zero or negative | `zero_revenue`, `negative_value` | files, store connect |
| Date that is not ISO or is ambiguous (e.g. `03/04/2026`) | `invalid_date` | files, store connect |
| Date after today in the source's timezone | `future_date` | files, store connect |

### Accepted date formats

The upload result lists these, with the rejected examples, whenever a date was rejected:

- `YYYY-MM-DD`, for example `2026-03-14`;
- `YYYY-MM-DD HH:MM[:SS]`, read as local time of the store;
- an ISO timestamp with `Z` or `±HH:MM`, converted to the store's business day;
- Excel date cells.

Day/month order is never guessed.

## Values that are not invented

- **Missing revenue** stays empty (`NULL`).
- **Missing price** leaves the product's stored price unchanged.
- **Missing stock level** leaves the stored stock unchanged.
- **No median imputation of any field.** `values_imputed` and `imputed_value`
  anomalies no longer occur.

## Unusually large orders: kept and flagged

- **The rule:** within one import, a product that has at least 8 dated rows gets a
  limit of Q3 + 3 × max(IQR, 1) on its order quantities. Orders above that limit
  are **imported** and reported as `unusually_large_order` warnings.
- **Reporting:** the upload result shows `large_orders_flagged`.
- **No IQR deletion:** `outliers_removed` no longer occurs. Demand spikes are real
  sales unless the seller says otherwise. To correct one, roll the import back and
  re-upload; there is no silent removal.

## Quality score

The quality score is the share of rows that were not rejected:
`(rows − rejected) / rows × 100`. Previously it was the share left after outlier
removal.

## Business dates and timezones

- **What a sale date is:** a calendar day in the timezone of the import's source.
- **New sources:** default to **Asia/Karachi**, or `DEFAULT_BUSINESS_TIMEZONE` if
  it is set.
- **Existing sources** keep their timezone. Sources backfilled by migration 002 are
  `UTC`.
- **Changing a timezone:** each source's timezone can be changed with
  `PATCH /api/data/sources/:id`. Store connections can set theirs when created.
- **Stored dates are never reinterpreted.** A timezone change affects later
  imports only.

## Confirmed coverage (completeness)

A seller can confirm that a file contains **every** sale for a date range: for
all products, or only for the products in the file, either while uploading or
later from Upload history. Inside a confirmed period, a day with no rows is a real
zero. **Only confirmed days count as forecasting history.** Outside confirmation,
sales records are kept and shown everywhere, but a day with some records may still
be missing sales, so it does not count toward forecasting; a day with no records is
unknown and never treated as zero.

- **With rejections:** a file with rejected rows cannot be confirmed as complete.
  The import is refused, and the rejected rows are listed.
- **Dates:** every dated row must fall inside the confirmed period.
- **No sales at all:** a file or delivery with no sales rows is accepted only with
  confirmed coverage for all products (a "nothing was sold" export).
- **Overlap:**
  - A confirmed period may not overlap earlier sales or earlier confirmed periods of
    the same source for the same products. Replacing a period is deferred.
  - New rows inside a confirmed period need an explicit `overlap_mode = append`.
- **Rollback:** rolling an import back revokes its confirmed period.

Details: `docs/import-identity-and-coverage.md`, section E.
