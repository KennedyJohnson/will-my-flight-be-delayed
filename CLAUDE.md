# Will My Flight Be Delayed?

Static GitHub Pages site (`docs/`, served from main) predicting P(arrival 15+ min late, or cancelled/diverted) for a US domestic flight. LightGBM model trained in Python, flattened to JSON, evaluated in the browser. No backend.

## Pipeline (`pipeline/`, run in order; `raw/` is gitignored, ~1 GB)
- `00_download.py` - rolling 12 months of BTS On-Time zips (`raw/YYYY_M.zip`), OurAirports `airports.csv`, FAA registry → `raw/faa/{MASTER,ACFTREF}.txt`. `--check` prints latest BTS month only. FAA needs a browser User-Agent (503s otherwise).
- `01_load.py` → `raw/flights.parquet` (target `delayed`).
- `02_weather.py` - Open-Meteo archive hourly weather per airport → `raw/weather/<IATA>.parquet`. Skips existing files, so delete `raw/weather` when the date window changes.
- `features.py` - shared feature code (turn time, holidays, aircraft age/type, weather join, target encoding).
- `train.py` (run from `pipeline/`) - validates on last 2 months (derived from data), SHAP feature pruning, final model on all data → `raw/model.txt`, `report/metrics.json` + SHAP pngs. `SMOKE=1` = fast 300k-row run into `raw/smoke`.
- `check_metrics.py` - fails if new validation AUC drops >0.02 vs committed `report/metrics.json`.
- `export.py` (from `pipeline/`) → `docs/data/{model,stats,airports,carriers,metrics}.json`, `docs/data/flights/<carrier>.json` (schedules from last 8 weeks).

## Site
`docs/index.html`, `docs/js/app.js` (UI, flight lookup, live forecast weather from Open-Meteo), `docs/js/model.js` (tree evaluator). Stale banner shows when `metrics.schedule_through` > 150 days old.

## Automation
`.github/workflows/retrain.yml` - weekly check; full retrain only when a new BTS month appears (or manual `force`). ~2-4 h on the runner. Commits `docs/ report/` + `docs/data/last_updated.json` every run (keeps cron alive). Requests a Pages build after pushing. Failure → `stale-data` issue.
