"""Make the Pakistan DEVELOPMENT extract (standard library only). Run from the repository root:

    python kaggle_training/stage3/extract_pakistan_dev.py

For each line of data/Pakistan Largest Ecommerce Dataset.csv the date field is tested
first. Lines dated after DEV_END are dropped immediately: none of their other fields is
converted, summed or written, and they are not counted. Only development lines are
written, so the final period (2018-01-01 .. 2018-08-28) never leaves this machine.

Output: kaggle_training/stage3/data_dev/pakistan_dev_2016-07-01_2017-12-31.csv
        kaggle_training/stage3/data_dev/pakistan_dev_manifest.json
Refuses to overwrite an existing extract.
"""
import csv
import hashlib
import json
import os
from datetime import date, datetime, timezone

SOURCE = os.path.join('data', 'Pakistan Largest Ecommerce Dataset.csv')
OUT_DIR = os.path.join('kaggle_training', 'stage3', 'data_dev')
OUT = os.path.join(OUT_DIR, 'pakistan_dev_2016-07-01_2017-12-31.csv')
MANIFEST = os.path.join(OUT_DIR, 'pakistan_dev_manifest.json')
DEV_END = date(2017, 12, 31)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def main():
    if os.path.exists(OUT) or os.path.exists(MANIFEST):
        raise SystemExit('The development extract already exists; it is not remade.')
    os.makedirs(OUT_DIR, exist_ok=True)
    written = 0
    dev_rows_after_first_later_row = 0
    seen_later = False
    with open(SOURCE, newline='', encoding='utf-8') as src, open(OUT, 'w', newline='', encoding='utf-8') as dst:
        reader = csv.reader(src)
        header = next(reader)
        i_date = header.index('sale_date')
        writer = csv.writer(dst)
        writer.writerow(['sale_date', 'product_name', 'category', 'price', 'quantity', 'revenue'])
        idx = [header.index(c) for c in ['product_name', 'category', 'price', 'quantity', 'revenue']]
        for row in reader:
            m, d, y = row[i_date].split('/')
            day = date(int(y), int(m), int(d))
            if day > DEV_END:
                seen_later = True          # dropped: no other field is touched
                continue
            if seen_later:
                dev_rows_after_first_later_row += 1
            writer.writerow([day.isoformat()] + [row[i] for i in idx])
            written += 1
    manifest = {
        'source': SOURCE, 'source_sha256': sha256(SOURCE), 'dev_end': DEV_END.isoformat(),
        'rule': 'date field tested first; later lines dropped without reading other fields or counting them',
        'rows_written': written, 'file_ordered_by_date': dev_rows_after_first_later_row == 0,
        'extract_sha256': sha256(OUT), 'made_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    }
    with open(MANIFEST, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
