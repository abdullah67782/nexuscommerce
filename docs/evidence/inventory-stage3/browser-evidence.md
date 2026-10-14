# Inventory AI — browser evidence (phone, tablet, desktop)

These screens were captured on 2026-10-14 from the running app on the owner's laptop: production frontend build, backend, ML server (`nexus-v2-shared-20261008`), all three feature switches on.

- **Capture script:** `capture-stage3.mjs` (this folder). It created a new evidence seller through the public API; no existing seller was touched.
- **Screens and log:** 33 screens are in `screens/`, and the API answers are in `evidence-log.json`.
- **Viewports:** each screen was captured at 390 × 844, 768 × 1024 and 1440 × 900, with the window made taller until the whole panel showed.

| # | Screen | What it shows | API check |
|---|---|---|---|
| 01–03 | Upper estimate: country not confirmed → profile step → department step | Reason and next step; the forecast is still shown | — |
| 04–05 | Regular product, 80% and 90% | Upper 7-day 30.2 / 34.9, 28-day 112.0 / 126.0 against forecasts of 23.6 / 89.2; method U0; benchmark coverage; label "Benchmark reference · not calibrated to your store" | `available` |
| 06 | Rare product | U3 / U0 / U1 by cell; applicability checklist | `available` |
| 07 | Short history (100 days) | Refused, with the reason | `short_history` |
| 08 | Dormant | Refused, with the reason | `dormant` |
| 09 | Calendar | Supplier delay, closure and demand-change entries; holidays | — |
| 10 | Product outlook | `replenishment-2`; overdue order warning; shortage before arrival; suggested order | Labels: closure `declared_by_seller`, demand change `assumed_by_seller`, supplier delay `declared_by_seller`, holidays "Effect unknown" |
| 11 | Supplier delivery performance | Declared 7 days; observed 9 days (n = 1); on time 0 / 2 (open late order counted); "Not enough history" (1 of 8); delay scenarios; date-quality notes | — |
| — | Stale recommendation | A draft from a recommendation made before the calendar changed is refused | **409** `recommendation_stale` (fingerprint changed) |

**Fixes made after the first captures:**
- **Calendar tab on phones.** The page scrolled sideways because `.stack` let a wide table widen the page. The column can now shrink (`minmax(0, 1fr)`), so tables scroll inside their own panel. After the fix, no screen scrolls sideways.
- **Upper-estimate panel.** It stretched, leaving empty space, because it inherited `height: 100%` from the totals grid. It now uses its own height.
- **Capture script.** The app scrolls inside its panels, so the script now grows the window until nothing scrolls and records any sideways scroll.

The date-quality notes in screen 11 are expected. The evidence orders were entered today with past order and receipt dates, so the app correctly flags them as back-dated and late-recorded.
