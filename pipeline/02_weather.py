"""Download hourly historical weather (Open-Meteo archive, local time) for every airport in the data."""
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = RAW / "weather"
OUT.mkdir(exist_ok=True)

WX_VARS = ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m",
           "wind_gusts_10m", "cloud_cover", "cloud_cover_low", "weather_code"]

flights = pd.read_parquet(RAW / "flights.parquet", columns=["date", "origin", "dest"])
start, end = flights["date"].min().date(), flights["date"].max().date()
codes = set(flights["origin"].astype(str)) | set(flights["dest"].astype(str))

ap = pd.read_csv(RAW / "airports.csv", usecols=["iata_code", "latitude_deg", "longitude_deg", "type"])
ap = ap[ap["iata_code"].isin(codes)].sort_values("type").drop_duplicates("iata_code").set_index("iata_code")
print(len(codes), "airports;", len(codes - set(ap.index)), "missing coords")

for code, row in ap.iterrows():
    path = OUT / f"{code}.parquet"
    if path.exists():
        continue
    params = dict(latitude=row.latitude_deg, longitude=row.longitude_deg, start_date=start, end_date=end,
                  hourly=",".join(WX_VARS), timezone="auto", wind_speed_unit="mph",
                  temperature_unit="fahrenheit", precipitation_unit="inch")
    while True:  # wait out Open-Meteo hourly/daily limits
        r = requests.get("https://archive-api.open-meteo.com/v1/archive", params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(60)
            continue
        r.raise_for_status()
        break
    h = pd.DataFrame(r.json()["hourly"])
    h["time"] = pd.to_datetime(h["time"])
    h.to_parquet(path, index=False)
    print(code, len(h), flush=True)
    time.sleep(2)
