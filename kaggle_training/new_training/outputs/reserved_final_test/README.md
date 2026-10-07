# Reserved final-evaluation products

Reserved 60 previously unused product IDs: 20 Foods, 20 Hobbies and 20 Household. These define 600 potential product/store pairs across the 10 M5 stores. The primary final comparison is predefined for CA_1, TX_1 and WI_1 (180 potential pairs); the other pairs remain reserved as well.

Only catalog metadata was parsed. No sales quantities, forecast errors or demand summaries were examined to select products. All 60 original sampled candidates were excluded, including the seven that did not enter earlier experiments. Selection uses a fixed SHA-256 ranking, recorded in `reservation.json`, so it can be reproduced without sales outcomes.

Keep every reserved product out of development, source-store training and selection. The next experiment must assert this exclusion before it fits any models. This folder records a protocol; it does not encrypt or physically remove data from the source archive.

Freeze code, settings, eligibility and group-routing rules before reading reserved histories. Final prediction may use earlier product history (and predetermined personalization) after the protocol is frozen, but reserved forecast errors must never select methods or tune settings. Retain all outcomes and record skipped/cold-start cases; do not replace difficult products.

The planned training cutoff and evaluation dates are recorded in `reservation.json`. This is a new-product holdout in the same retailer, not proof of transfer to unrelated businesses or countries. Eligibility must use earlier availability, not later sales volume. Potential pair counts are not yet eligible-history counts: sales remain unexamined.

Checks passed for exclusion, category balance, stable selection independent of row order, and duplicate catalog handling. A post-export audit confirmed the 60 products and 600 pairs with no overlap against previously evaluated items.
