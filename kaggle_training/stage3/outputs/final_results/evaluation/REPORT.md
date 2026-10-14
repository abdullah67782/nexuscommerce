# Stage 3 final evaluation — FINAL EVALUATION (one time)

- Protocol v1 `8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af`; manifest `6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e`; calibration freeze `7ea548e2d32f9da22d4a9a58a5e708778dbdf39e1de0f1cc94fc150c47ab6af1`
- Preflight (amendment F2): passed (24 checks)
- Environment: {'numpy': '1.26.4', 'pandas': '2.2.2', 'xgboost': '3.4.1'}

## Promotion gates (protocol v1)

| Capability | Pass |
|---|---|
| US event layer E1c | False |
| Pakistan E1 (Independence Day, Eid al-Adha) | False |
| US totals uncertainty regular / 7 / 0.8 | True |
| US totals uncertainty regular / 7 / 0.9 | True |
| US totals uncertainty regular / 28 / 0.8 | True |
| US totals uncertainty regular / 28 / 0.9 | True |
| US totals uncertainty occasional / 7 / 0.8 | True |
| US totals uncertainty occasional / 7 / 0.9 | True |
| US totals uncertainty occasional / 28 / 0.8 | True |
| US totals uncertainty occasional / 28 / 0.9 | True |
| US totals uncertainty rare / 7 / 0.8 | True |
| US totals uncertainty rare / 7 / 0.9 | True |
| US totals uncertainty rare / 28 / 0.8 | True |
| US totals uncertainty rare / 28 / 0.9 | True |
| US totals uncertainty dormant / 7 / 0.8 | False |
| US totals uncertainty dormant / 7 / 0.9 | False |
| US totals uncertainty dormant / 28 / 0.8 | False |
| US totals uncertainty dormant / 28 / 0.9 | False |
| US totals uncertainty short_history / 7 / 0.8 | False |
| US totals uncertainty short_history / 7 / 0.9 | False |
| US totals uncertainty short_history / 28 / 0.8 | False |
| US totals uncertainty short_history / 28 / 0.9 | False |

## Decision protection — research only (amendment F1; never authorises promotion)

| Segment, level | Research checks all met | Excess-cap stability check |
|---|---|---|
| regular / 0.8 | False | n/a (no selection) |
| regular / 0.9 | False | True |
| occasional / 0.8 | False | n/a (no selection) |
| occasional / 0.9 | True | True |
| rare / 0.8 | False | False |
| rare / 0.9 | True | True |
| dormant / 0.8 | False | n/a (no selection) |
| dormant / 0.9 | False | n/a (no selection) |
| short_history / 0.8 | False | True |
| short_history / 0.9 | False | True |

Full numbers: `results.json`. Production models, routing and replenishment-1 are unchanged.
