# Step 5: later-period audit and final-test readiness

Step 5 is complete. This formalizes the later-period check already performed in Step 4 and freezes the setup for Step 6. No new reserved-product sales were read, and the final evaluation has not started.

## Later-period conclusion

The fixed group rule improved five of six comparisons in September-November 2015. Weekly error reductions are small: about 0.22 percentage points in California, 0.24 in Texas and 0.03 in Wisconsin. Four-week error falls about 1.09 points in Texas, falls 0.08 in California and increases 0.24 in Wisconsin. We preserved the Wisconsin loss and did not choose a replacement method from these outcomes.

These dates were examined earlier, so this remains a retrospective development check. It is not independent proof of accuracy.

## What is frozen

`../frozen_final_protocol/protocol.json` records the exact rules, features, training settings, library versions, source-file hashes and model hashes. The package contains copies of the code and all 12 existing May-2015 model files, so later edits to development code do not silently change the final experiment. The evaluator rejects changed listed files or versions.

- Targets: CA_1, TX_1 and WI_1; the 60 previously reserved products.
- Forecast totals: 7 and 28 days.
- Training cutoff: May 31, 2015. Models use only the 53 development products; no reserved-product training or final-test retraining.
- Rule: TSB for rare sellers; general model for regular, occasional and dormant sellers. No per-product override or automatic personalization.
- The fixed personalized model remains a diagnostic comparison, trained earlier on development products from that store. It will not be adapted using reserved histories.
- Groups update from past history at each forecast origin. Earlier actual observations may supply inputs; future sales cannot enter forecasts.
- Eligibility: each target-store/product pair must have at least 180 days since first recorded price at the training cutoff. Report every one of the 180 possible pairs, including exclusions. No replacement products or outcome-based exclusions.
- Keep observed zeros. Percentage error is undefined when actual volume is zero; unit errors remain reported. Invalid or incomplete eligible data cause an explicit failure instead of silent cleaning.

The planned period is December 1, 2015-May 22, 2016. Complete non-overlapping windows give **24 weekly windows and six four-week windows**, both ending May 16. May 17-22 is outside complete windows and will not be scored. Exact dates are saved in `planned_final_windows.csv`.

## Verification

Reproduced the later-period selection and all 196 saved metric rows. All 23 development/protocol unit tests passed. Four synthetic-data tests also passed from the frozen code copy. All 12 frozen model files loaded and produced finite, nonnegative predictions in six store/horizon synthetic inference checks. Bundle integrity passed, and all 18 application runtime artifacts retain their original hashes.

The reservation and freezing are reproducibility safeguards, not encryption or external preregistration. Step 6 will be a new-product test within the same US retail chain, not validation for new countries or independent businesses. The application itself still uses its existing models.

## Next

Step 6 runs the frozen evaluator once against the reserved products, reports every result and verifies the saved metrics. Do not tune the rules after seeing that result and present the rerun as the same final test. The command, to run only when Step 6 is authorized, is:

```powershell
ml/venv/Scripts/python.exe kaggle_training/new_training/outputs/frozen_final_protocol/code/reserved_final_evaluation.py --execute-final
```

Results will go to `outputs/reserved_final_results`. No such evaluation was executed in Step 5.
