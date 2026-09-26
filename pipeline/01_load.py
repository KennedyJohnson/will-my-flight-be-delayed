"""Combine monthly BTS On-Time Performance zips into one parquet file."""
import glob
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"

COLS = {
    "FlightDate": "date",
    "Reporting_Airline": "carrier",
    "Flight_Number_Reporting_Airline": "flight_num",
    "Tail_Number": "tail",
    "Origin": "origin",
    "Dest": "dest",
    "CRSDepTime": "crs_dep",
    "CRSArrTime": "crs_arr",
    "CRSElapsedTime": "crs_elapsed",
    "Distance": "distance",
    "DepDelay": "dep_delay",
    "ArrDelay": "arr_delay",
    "ArrDel15": "arr_del15",
    "Cancelled": "cancelled",
    "Diverted": "diverted",
}

frames = []
for zp in sorted(glob.glob(str(RAW / "20*.zip"))):
    with zipfile.ZipFile(zp) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        df = pd.read_csv(z.open(name), usecols=list(COLS), low_memory=False)
    frames.append(df.rename(columns=COLS))
    print(zp, len(df))

df = pd.concat(frames, ignore_index=True)
df["date"] = pd.to_datetime(df["date"])
for c in ["carrier", "origin", "dest", "tail"]:
    df[c] = df[c].astype("category")
# Target: arrived 15+ min late, or cancelled/diverted (all count as "delayed" to a traveler)
df["delayed"] = ((df["arr_del15"] == 1) | (df["cancelled"] == 1) | (df["diverted"] == 1)).astype("int8")
df.to_parquet(RAW / "flights.parquet", index=False)
print(len(df), "flights; delay rate", round(df["delayed"].mean(), 4))
