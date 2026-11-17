"""Download hourly historical weather (Open-Meteo, local time) for every airport in the data.

Default: observed weather from the archive API (raw/weather/). With --forecast: the Historical
Forecast API, i.e. the forecast Open-Meteo issued for each day, which matches what the live site
(docs/js/app.js, api.open-meteo.com/v1/forecast) shows users (raw/weather_fc/). Train on the
forecast version so model inputs have the same error profile as serving inputs.

Cached files from an earlier date window are extended rather than re-downloaded.
"""
import sys
import time
from datetime import timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
FORECAST = "--forecast" in sys.argv
OUT = RAW / ("weather_fc" if FORECAST else "weather")
URL = ("https://historical-forecast-api.open-meteo.com/v1/forecast" if FORECAST
       else "https://archive-api.open-meteo.com/v1/archive")
OUT.mkdir(exist_ok=True)

WX_VARS = ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m",
           "wind_gusts_10m", "cloud_cover", "cloud_cover_low", "weather_code", "visibility"]

flights = pd.read_parquet(RAW / "flights.parquet", columns=["date", "origin", "dest"])
start, end = flights["date"].min().date(), flights["date"].max().date()
codes = set(flights["origin"].astype(str)) | set(flights["dest"].astype(str))

ap = pd.read_csv(RAW / "airports.csv", usecols=["iata_code", "latitude_deg", "longitude_deg", "type"])
ap = ap[ap["iata_code"].isin(codes)].sort_values("type").drop_duplicates("iata_code").set_index("iata_code")
print(len(codes), "airports;", len(codes - set(ap.index)), "missing coords")

for code, row in ap.iterrows():
    path = OUT / f"{code}.parquet"
    # A file left by an earlier window (the workflow restores the previous month's cache) only
    # needs the days after it ends: fetch that tail and trim days before the new window, instead
    # of re-downloading all 24 months. Files that don't reach back to `start` are refetched whole.
    old, fetch_from = None, start
    if path.exists():
        old = pd.read_parquet(path)
        have_from, have_to = old["time"].min().date(), old["time"].max().date()
        if have_from <= start and have_to >= end:
            if have_from < start:
                old[old["time"].dt.date >= start].to_parquet(path, index=False)
            continue
        if have_from <= start and have_to >= start:
            fetch_from = have_to + timedelta(days=1)
            old = old[(old["time"].dt.date >= start) & (old["time"].dt.date < fetch_from)]
        else:
            old = None
    params = dict(latitude=row.latitude_deg, longitude=row.longitude_deg, start_date=fetch_from, end_date=end,
                  hourly=",".join(WX_VARS), timezone="auto", wind_speed_unit="mph",
                  temperature_unit="fahrenheit", precipitation_unit="inch")
    fails = 0
    while True:  # wait out Open-Meteo hourly/daily limits (429); retry slow responses and 5xx up to 5 times
        try:
            r = requests.get(URL, params=params, timeout=180)
        except (requests.Timeout, requests.ConnectionError):
            r = None
        if r is not None and r.status_code == 429:
            time.sleep(60)
            continue
        if (r is None or r.status_code >= 500) and fails < 5:
            fails += 1
            time.sleep(60)
            continue
        if r is None:
            raise RuntimeError(f"Open-Meteo unreachable for {code} after {fails} retries")
        r.raise_for_status()
        try:
            hourly = r.json()["hourly"]
        except (ValueError, KeyError):  # 200 with an empty or truncated body
            if fails < 5:
                fails += 1
                time.sleep(60)
                continue
            raise
        break
    h = pd.DataFrame(hourly)
    h["time"] = pd.to_datetime(h["time"])
    if old is not None:
        h = pd.concat([old, h], ignore_index=True)
    h.to_parquet(path, index=False)
    print(code, len(h), "(from", fetch_from, ")", flush=True)
    time.sleep(2)
