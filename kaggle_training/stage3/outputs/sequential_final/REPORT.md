# Sequential inventory evaluation — FINAL (one time)

- Protocol `87578cccf92dfcf1b70ca0ddd6adf3cbc14c0a85457f88e0eb43dbb3963cc97b`; replay 2015-11-23 to 2016-05-22; 1498 series
- Engine parity on the final run's decisions: 3005/3005 exact
- Under amendment F1 nothing here authorises promotion; a passed cell authorises only an implementation review of optional, seller-approved advice.

| Cell | Series | Lost units D0 → candidate | Net benefit (30%, 25%) | G1 | G2 | G3 | G4 seller rule | G5 | G6 | Passed |
|---|---|---|---|---|---|---|---|---|---|---|
| regular / 0.9 | 162 | 122923 → 45809 | 54293 | True | True | True | False | True | True | False |
| occasional / 0.9 | 822 | 146845 → 53234 | 89460 | True | True | True | False | True | True | False |
| rare / 0.8 | 490 | 25686 → 16262 | 13849 | True | True | True | False | True | True | False |
| rare / 0.9 | 490 | 25686 → 12418 | 16310 | True | True | True | False | True | True | False |
| short_history / 0.8 | 8 | 648 → 506 | 162 | False | True | True | False | True | True | False |
| short_history / 0.9 | 8 | 648 → 447 | 221 | False | True | True | False | True | True | False |
