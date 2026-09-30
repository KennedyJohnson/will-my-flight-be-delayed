# Will My Flight Be Delayed?

Static GitHub Pages site (`docs/`, served from main) predicting P(arrival 15+ min late, or cancelled/diverted) for a US domestic flight. LightGBM model trained in Python, flattened to JSON, evaluated in the browser. No backend.

## Pipeline (`pipeline/`, run in order; `raw/` is gitignored, ~1 GB)
- `00_download.py` - rolling 12 months of BTS On-Time zips (`raw/YYYY_M.zip`), OurAirports `airports.csv`, FAA registry → `raw/faa/{MASTER,ACFTREF}.txt`. `--check` prints latest BTS month only. FAA needs a browser User-Agent (503s otherwise).
- `01_load.py` → `raw/flights.parquet` (target `delayed`).
- `02_weather.py` - Open-Meteo archive hourly weather per airport → `raw/weather/<IATA>.parquet`. Skips existing files, so delete `raw/weather` when the date window changes.
- `features.py` - shared feature code (turn time, holidays, aircraft age/type, weather join, target encoding).
- `train.py` (run from `pipeline/`) - validates on last 2 months (derived from data), SHAP feature pruning, final model on all data → `raw/model.txt`, `report/metrics.json` + SHAP pngs. `SMOKE=1` = fast 300k-row run into `raw/smoke`.
- `scorecard.py` (from `pipeline/`, BEFORE train/export) - scores the *published* model (`docs/data/model.json` + stats + schedules, Python port of `model.js`) on flights after its training window → appends to `docs/data/scorecard.json`; writes `raw/drift.txt` if live AUC < validation AUC - 0.03 (workflow opens an issue).
- `check_metrics.py` - fails if new validation AUC drops >0.02 vs committed `report/metrics.json`.
- `export.py` (from `pipeline/`) → `docs/data/{model,stats,airports,carriers,metrics}.json`, `docs/data/flights/<carrier>.json` (schedules from last 8 weeks).

## Site
`docs/index.html`, `docs/js/app.js` (UI, flight lookup, live forecast weather from Open-Meteo), `docs/js/model.js` (tree evaluator). Stale banner shows when `metrics.schedule_through` > 150 days old.

## Live route lookup (`worker/`)
Cloudflare Worker `will-my-flight-be-delayed` (https://will-my-flight-be-delayed.ken-j.workers.dev, also deployable via Cloudflare Workers Builds with root directory `worker`): `GET ?flight=AA2472&date=YYYY-MM-DD` → today's scheduled legs from AeroDataBox (RapidAPI free plan, ~600 units/mo), edge-cached. Deployed by `.github/workflows/worker.yml` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RAPIDAPI_KEY`; skips if unset). `LIVE_URL` in `docs/js/app.js` points the site at it (empty = off). The site borrows history features from the BTS leg on the same route (same number, else the airline's regular flight nearest in time) and falls back to BTS-only when the Worker fails.

## Automation
`.github/workflows/retrain.yml` - weekly check; full retrain only when a new BTS month appears (or manual `force`). ~2-4 h on the runner. Commits `docs/ report/` + `docs/data/last_updated.json` every run (keeps cron alive). Requests a Pages build after pushing. Failure → `stale-data` issue.
