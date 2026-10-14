"""Stage 3 data audit (read-only). Run from the repository root:

    ml/venv/Scripts/python.exe kaggle_training/stage3_audit/audit_datasets.py      (Windows)
    python3 kaggle_training/stage3_audit/audit_datasets.py                          (Linux)

Writes kaggle_training/stage3_audit/outputs/audit.json and prints a summary.
It trains nothing and changes no model or application file.

RESERVATION RULES — declared here, BEFORE any sales are read, so that later Stage 3
experiments still have untouched evidence:

* M5: sales columns are read ONLY for the 180 products already consumed by earlier work
  (60 original sample candidates incl. the 53 development products, the first reserved
  holdout of 60, and the production holdout of 60). The other M5 products are described
  from catalog columns and the calendar only, so a fresh product reservation can still be
  drawn "before their sales are read".
* Pakistan e-commerce file: sales are read only up to PAKISTAN_DEV_END. Later rows are
  never aggregated; the audit reports only the latest date present.
* Store Item Demand: only the date column and ids are read for 2017; sales are read only
  up to 2016-12-31 (2017 was used for store 1/5/10 validation and final evaluation, and
  stays unread for the other stores).
* UCI Online Retail and Superstore were consumed by the legacy country models; they are
  described in full.
Event dates for Pakistan are APPROXIMATE (moon-sighting dependent) and must be
confirmed locally before any use beyond this descriptive audit.
"""
import json
import os
import sys
import zipfile
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = os.getcwd()
OUT = os.path.join(ROOT, 'kaggle_training', 'stage3_audit', 'outputs')
PAKISTAN_DEV_END = '2017-12-31'
STORE_ITEM_DEV_END = '2016-12-31'

# Approximate Pakistan event days (to be confirmed against official notifications).
PK_EVENTS = [
    ('Eid al-Fitr', 'religious', '2016-07-06'), ('Eid al-Adha', 'religious', '2016-09-13'),
    ('Black/White Friday', 'commercial', '2016-11-25'), ('Christmas / Quaid Day', 'national', '2016-12-25'),
    ('New Year', 'national', '2017-01-01'), ('Pakistan Day', 'national', '2017-03-23'),
    ('Ramadan start', 'religious', '2017-05-27'), ('Eid al-Fitr', 'religious', '2017-06-26'),
    ('Independence Day', 'national', '2017-08-14'), ('Eid al-Adha', 'religious', '2017-09-02'),
    ('Black/White Friday', 'commercial', '2017-11-24'), ('Christmas / Quaid Day', 'national', '2017-12-25'),
    ('New Year', 'national', '2018-01-01'), ('Ramadan start', 'religious', '2018-05-17'),
    ('Eid al-Fitr', 'religious', '2018-06-16'), ('Independence Day', 'national', '2018-08-14'),
    ('Eid al-Adha', 'religious', '2018-08-22'),
]


def p(path):
    return os.path.join(ROOT, path)


def event_windows(daily, events, dev_end, first_day):
    """Descriptive ratios around each event, development period only.
    baseline = mean daily units over days -35..-8; pre = -7..-1; event = 0..+2; post = +3..+9."""
    out = []
    for name, kind, d in events:
        day = pd.Timestamp(d)
        rec = {'event': name, 'type': kind, 'date': d}
        if str(day.date()) > dev_end:
            rec['status'] = 'reserved period — not read'
        elif day - pd.Timedelta(days=35) < first_day:
            rec['status'] = 'not enough earlier history in the file'
        else:
            def mean(a, b):
                s = daily.reindex(pd.date_range(day + pd.Timedelta(days=a), day + pd.Timedelta(days=b)), fill_value=0)
                return float(s.mean())
            base = mean(-35, -8)
            rec.update({'status': 'development', 'baseline_daily_units': round(base, 2),
                        'pre_7d_ratio': round(mean(-7, -1) / base, 2) if base else None,
                        'event_3d_ratio': round(mean(0, 2) / base, 2) if base else None,
                        'post_7d_ratio': round(mean(3, 9) / base, 2) if base else None})
        out.append(rec)
    return out


def audit_m5():
    cal = pd.read_csv(p('data/m5/calendar.csv'), parse_dates=['date'])
    res = json.load(open(p('kaggle_training/production_v2/outputs/holdout_reservation.json')))
    consumed = sorted(set(res['excluded_products']) | set(res['selected_products']))
    zf = zipfile.ZipFile(p('data/m5/sales_train_evaluation.csv.zip'))
    name = [n for n in zf.namelist() if n.endswith('.csv')][0]
    header = pd.read_csv(zf.open(name), nrows=0).columns.tolist()
    id_cols = [c for c in header if not c.startswith('d_')]
    day_cols = [c for c in header if c.startswith('d_')]
    ids = pd.read_csv(zf.open(name), usecols=id_cols)
    d2date = dict(zip(cal['d'], cal['date']))
    last_sales_day = d2date[day_cols[-1]]

    events = []
    for col_n, col_t in [('event_name_1', 'event_type_1'), ('event_name_2', 'event_type_2')]:
        e = cal.loc[cal[col_n].notna(), ['date', col_n, col_t]]
        e.columns = ['date', 'name', 'type']
        events.append(e)
    events = pd.concat(events).sort_values('date')
    focus = ['Christmas', 'NewYear', 'Eid al-Fitr', 'EidAlAdha', 'Ramadan starts', 'Thanksgiving', 'Easter', 'IndependenceDay']
    focus_dates = {n: [str(d.date()) for d in events.loc[events['name'] == n, 'date'] if d <= last_sales_day] for n in focus}

    # Sales of the 180 consumed products only.
    sales = pd.read_csv(zf.open(name), usecols=id_cols + day_cols)
    sales = sales[sales['item_id'].isin(consumed)]
    daily = sales[day_cols].sum(axis=0)
    daily.index = [d2date[c] for c in day_cols]
    store_days = sales[day_cols]
    christmas = []
    for d in focus_dates['Christmas']:
        col = [c for c in day_cols if str(d2date[c].date()) == d]
        if col:
            christmas.append({'date': d, 'units': int(sales[col[0]].sum()),
                              'store_product_rows_nonzero': int((sales[col[0]] > 0).sum())})
    ev_list = [(n, 'm5', d) for n in focus for d in focus_dates[n]]
    windows = event_windows(daily, ev_list, str(last_sales_day.date()), daily.index[0])
    for w in windows:
        w['type'] = events.loc[(events['name'] == w['event']), 'type'].iloc[0]

    return {
        'source': 'M5 (Walmart, USA): calendar.csv, sales_train_evaluation.csv.zip, sell_prices.csv.zip',
        'country': 'United States', 'states': sorted(ids['state_id'].unique().tolist()),
        'stores': sorted(ids['store_id'].unique().tolist()),
        'timezone_note': 'Store-local US dates (states span Pacific and Central time); no timestamps.',
        'calendar_range': [str(cal['date'].min().date()), str(cal['date'].max().date())],
        'sales_range': [str(daily.index[0].date()), str(last_sales_day.date())], 'sales_days': len(day_cols),
        'products': int(ids['item_id'].nunique()), 'series': int(len(ids)),
        'categories': ids.groupby('cat_id')['item_id'].nunique().to_dict(),
        'departments': ids.groupby('dept_id')['item_id'].nunique().to_dict(),
        'consumed_products': len(consumed),
        'unused_products': int(ids['item_id'].nunique() - len(set(consumed) & set(ids['item_id']))),
        'event_types': events.groupby('type')['name'].nunique().to_dict(),
        'event_names': sorted(events['name'].unique().tolist()),
        'focus_event_dates_within_sales': focus_dates,
        'snap_days': {s: int(cal[f'snap_{s}'].sum()) for s in ['CA', 'TX', 'WI']},
        'christmas_consumed_products': christmas,
        'event_windows_consumed_products': windows,
        'recorded': {'promotions': 'no (weekly sell prices only; price cuts are a possible proxy)',
                     'closures': 'not recorded; Christmas shows near-zero sales (store closure)',
                     'stockouts': 'not recorded; zeros cannot be separated from lost sales'},
        'consumed_history': {
            'development_products': 53,
            'periods_examined_for_used_products': 'all sales days up to 2016-05-22 (training to 2015-05-31, '
            'validation 2015-06..11, final test 2015-12-01..2016-05-22)',
            'holdouts_used': ['first reserved holdout (60 products, reserved_final_results)',
                              'nexus-production-holdout-20261008-v1 (60 products)'],
        },
    }


def audit_pakistan():
    path = p('data/Pakistan Largest Ecommerce Dataset.csv')
    cols = pd.read_csv(path, nrows=0).columns.tolist()
    dates = pd.to_datetime(pd.read_csv(path, usecols=['sale_date'])['sale_date'], format='%m/%d/%Y', errors='coerce')
    meta = pd.read_csv(path, usecols=['product_name', 'category'])
    dev_mask = dates <= pd.Timestamp(PAKISTAN_DEV_END)
    df = pd.read_csv(path)[dev_mask.values]
    df['sale_date'] = dates[dev_mask].values
    df['list_value'] = df['price'] * df['quantity']
    discount = (df['revenue'] < df['list_value'] - 0.5)
    daily = df.groupby('sale_date')['quantity'].sum()
    full_days = pd.date_range(daily.index.min(), daily.index.max())
    per_product_days = df.groupby('product_name')['sale_date'].nunique()
    cat_month = df.assign(month=df['sale_date'].dt.to_period('M').astype(str)).groupby(['category', 'month'])['quantity'].sum()
    return {
        'source': 'data/Pakistan Largest Ecommerce Dataset.csv (converted to the app import format)',
        'country': 'Pakistan', 'timezone': 'Asia/Karachi assumed (dates only, no timestamps)',
        'columns': cols,
        'missing_from_conversion': 'order status (cancelled/refunded), payment method, customer, discount amount '
                                   '— the original Kaggle columns are not in this file',
        'rows_total': int(len(dates)), 'unparsed_dates': int(dates.isna().sum()),
        'date_range_all': [str(dates.min().date()), str(dates.max().date())],
        'development_end': PAKISTAN_DEV_END,
        'products_all': int(meta['product_name'].nunique()),
        'categories_all': meta.groupby('category')['product_name'].nunique().sort_values(ascending=False).to_dict(),
        'development': {
            'rows': int(len(df)), 'units': float(df['quantity'].sum()),
            'days_with_sales': int(daily.size), 'calendar_days': int(len(full_days)),
            'days_without_any_sale': [str(d.date()) for d in full_days.difference(daily.index)],
            'rows_revenue_below_price_x_qty': int(discount.sum()),
            'share_rows_revenue_below_price_x_qty': round(float(discount.mean()), 4),
            'rows_nonpositive_quantity': int((df['quantity'] <= 0).sum()),
            'products': int(df['product_name'].nunique()),
            'product_selling_days': {
                'median': float(per_product_days.median()),
                'p90': float(per_product_days.quantile(0.9)),
                'products_with_180_or_more_days': int((per_product_days >= 180).sum()),
                'products_with_28_or_more_days': int((per_product_days >= 28).sum()),
                'products_with_1_day': int((per_product_days == 1).sum()),
            },
            'units_by_month': {str(k): float(v) for k, v in df.groupby(df['sale_date'].dt.to_period('M'))['quantity'].sum().items()},
            'top_categories_units': df.groupby('category')['quantity'].sum().sort_values(ascending=False).head(10).to_dict(),
            'category_months_with_sales': {c: int(n) for c, n in cat_month.groupby(level=0).size().items()},
        },
        'event_windows_total_units': event_windows(daily, PK_EVENTS, PAKISTAN_DEV_END, daily.index.min()),
        'reserved': {'from': str((pd.Timestamp(PAKISTAN_DEV_END) + pd.Timedelta(days=1)).date()),
                     'to': str(dates.max().date()), 'note': 'not aggregated by this audit'},
        'recorded': {'promotions': 'not as a field; revenue below price × quantity is a partial discount proxy',
                     'closures': 'not recorded', 'stockouts': 'not recorded (marketplace, no stock data)'},
        'prior_use': 'demo upload only (backend/uploads); not used to train or evaluate the v2 models',
    }


def audit_store_item():
    zf = zipfile.ZipFile(p('data/store_item_demand/train.csv.zip'))
    name = [n for n in zf.namelist() if n.endswith('.csv')][0]
    ids = pd.read_csv(zf.open(name), usecols=['date', 'store', 'item'], parse_dates=['date'])
    df = pd.read_csv(zf.open(name), parse_dates=['date'])
    dev = df[df['date'] <= STORE_ITEM_DEV_END]
    days = pd.date_range(dev['date'].min(), dev['date'].max())
    missing = days.difference(pd.DatetimeIndex(dev['date'].unique()))
    christmas = dev[(dev['date'].dt.month == 12) & (dev['date'].dt.day == 25)].groupby('date')['sales'].sum()
    return {
        'source': 'data/store_item_demand/train.csv.zip (Kaggle Store Item Demand Forecasting Challenge)',
        'country': 'not stated (anonymised; widely regarded as simulated)', 'timezone': 'unknown',
        'date_range': [str(ids['date'].min().date()), str(ids['date'].max().date())],
        'stores': int(ids['store'].nunique()), 'items': int(ids['item'].nunique()),
        'development_end_for_audit': STORE_ITEM_DEV_END,
        'missing_calendar_days_before_2017': [str(d.date()) for d in missing],
        'christmas_units_all_stores': {str(k.date()): int(v) for k, v in christmas.items()},
        'zero_sale_rows_share_before_2017': round(float((dev['sales'] == 0).mean()), 4),
        'recorded': {'promotions': 'no', 'closures': 'no', 'stockouts': 'no', 'product_groups': 'no (item ids only)'},
        'prior_use': 'store 10 (validation 2017-01..06, final 2017-07..12); stores 1 and 5 repeated the protocol; '
                     'other stores trained the general model through 2016',
    }


def audit_legacy(path, label, cat_is_country):
    df = pd.read_csv(p(path), parse_dates=['sale_date'])
    daily = df.groupby('sale_date')['quantity'].sum()
    full = pd.date_range(daily.index.min(), daily.index.max())
    no_sale = full.difference(daily.index)
    out = {
        'source': path, 'rows': int(len(df)), 'products': int(df['product_name'].nunique()),
        'date_range': [str(df['sale_date'].min().date()), str(df['sale_date'].max().date())],
        'days_without_any_sale': int(len(no_sale)),
        'late_dec_early_jan_days_without_sale': [str(d.date()) for d in no_sale if (d.month == 12 and d.day >= 20) or (d.month == 1 and d.day <= 7)],
        'negative_quantity_rows': int((df['quantity'] < 0).sum()),
        'stock_columns': {c: [float(df[c].min()), float(df[c].max())] for c in ['stock_level', 'reorder_threshold'] if c in df},
        'stock_columns_note': 'derived during the earlier conversion (values count down from 500 per row); not observed stock',
    }
    if cat_is_country:
        out['countries_rows'] = df['category'].value_counts().head(15).to_dict()
    else:
        out['categories_rows'] = df['category'].value_counts().to_dict()
    out['label'] = label
    return out


def audit_redated(path):
    df = pd.read_csv(p(path))
    d = pd.to_datetime(df['sale_date'], errors='coerce')
    return {'source': path, 'rows': int(len(df)), 'products': int(df['product_name'].nunique()),
            'date_range': [str(d.min().date()), str(d.max().date())],
            'note': 'dates in 2026: a re-dated or generated demo file — not evidence of real seasonal or holiday behaviour'}


def main():
    os.makedirs(OUT, exist_ok=True)
    result = {'generated_at': str(pd.Timestamp.now('UTC')), 'reservation_rules': __doc__.split('RESERVATION RULES')[1].strip(),
              'pandas': pd.__version__}
    steps = [('m5', audit_m5), ('pakistan_ecommerce', audit_pakistan), ('store_item_demand', audit_store_item),
             ('uci_online_retail', lambda: audit_legacy('kaggle_training/original_training/datasets/uci_training_data.csv', 'UCI Online Retail (UK and Europe), legacy country models', True)),
             ('superstore', lambda: audit_legacy('kaggle_training/original_training/datasets/superstore_validation_data.csv', 'US Superstore, legacy validation', False)),
             ('final_dataset', lambda: audit_redated('data/Final_Dataset.csv')),
             ('sample_forecast_data', lambda: audit_redated('data/sample_forecast_data.csv'))]
    only = sys.argv[1:] or [s for s, _ in steps]
    prev = {}
    target = os.path.join(OUT, 'audit.json')
    if os.path.exists(target):
        prev = json.load(open(target))
    for key, fn in steps:
        if key in only:
            print(f'auditing {key} …', flush=True)
            prev[key] = fn()
    prev.update({k: v for k, v in result.items()})
    with open(target, 'w') as f:
        json.dump(prev, f, indent=2, default=str)
    print(f'wrote {target}')


if __name__ == '__main__':
    main()
