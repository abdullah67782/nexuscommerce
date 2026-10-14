# Stage 3 training / calibration run

- Protocol: `nexus-stage3-final-protocol-v1`, sha256 `8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af`
- Environment: Python 3.13.16, numpy 2.5.3, pandas 3.0.5, xgboost 3.4.1; GPU: none
- Reserved outcomes: not read (guarded development loaders only).

## Development reproduction (research copies)

| Period | Rows | Parity vs app | max abs F diff vs development | Reproduces |
|---|---|---|---|---|
| FIT_A | 229756 | 2.29e-05 | 0.00e+00 | True |
| FIT_B | 277529 | 7.63e-06 | 0.00e+00 | True |
| CAL | 120649 | 2.00e-05 | 0.00e+00 | True |
| SEL | 183946 | 6.97e-06 | 0.00e+00 | True |

## U2 boosters (selected artifacts are the development CPU boosters; never replaced)

| h, p | CPU retrain identical to selected | CPU max abs pred diff | GPU max abs pred diff (diagnostic) |
|---|---|---|---|
| h=7, p=0.8 | True | 0.00e+00 | skipped |
| h=28, p=0.8 | True | 0.00e+00 | skipped |
| h=7, p=0.9 | True | 0.00e+00 | skipped |
| h=28, p=0.9 | True | 0.00e+00 | skipped |

## Calibration artifacts

- `calibration_pk.json` sha256 `0b58d273c0b1ecd719d6875b94f02521469fdc1501755793e607d217b2b7ed6c`
- `calibration_pk_rows.csv.gz` sha256 `0d8c45c57521fd2cfa5acdc7affecf4bea13c1b1bba6bf2fdf30b4c6ff88222d`
- `calibration_us.json` sha256 `edba6daa409b48a2b49c3f04de8991786daded1431f947ddcfb4405d0ba2e3e5`
- `calibration_us_rows.csv.gz` sha256 `b2c597c6cf50c92b03cda091e73574a6a845e9df44e381671e47d710adb7f494`
