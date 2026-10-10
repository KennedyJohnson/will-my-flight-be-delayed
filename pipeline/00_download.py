"""Fetch a rolling 24 months of BTS On-Time zips plus OurAirports and FAA registry into raw/.

Prints the latest BTS month (YYYY-MM). With --check, only prints it (no downloads)."""
import io
import sys
import zipfile
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
RAW.mkdir(exist_ok=True)
MONTHS = 24
BTS = "https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{y}_{m}.zip"
AIRPORTS = "https://davidmegginson.github.io/ourairports-data/airports.csv"
FAA = "https://registry.faa.gov/database/ReleasableAircraft.zip"
S = requests.Session()
# FAA registry 503s non-browser user agents
S.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"


def back(y, m, n):
    k = y * 12 + (m - 1) - n
    return k // 12, k % 12 + 1


def latest_month():
    t = date.today()
    for n in range(1, 9):  # BTS lags ~2-3 months
        y, m = back(t.year, t.month, n)
        if S.head(BTS.format(y=y, m=m), timeout=60, allow_redirects=True).status_code == 200:
            return y, m
    sys.exit("no BTS month found in the last 8 months")


def download(url, path):
    with S.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)


y, m = latest_month()
if "--check" in sys.argv:
    print(f"{y}-{m:02d}")
    sys.exit()

want = {f"{yy}_{mm}.zip" for yy, mm in (back(y, m, n) for n in range(MONTHS))}
for old in RAW.glob("20*.zip"):
    if old.name not in want:
        old.unlink()
for name in sorted(want):
    if not (RAW / name).exists():
        yy, mm = name[:-4].split("_")
        download(BTS.format(y=yy, m=mm), RAW / name)
        print("bts", name, flush=True)

download(AIRPORTS, RAW / "airports.csv")
try:
    r = S.get(FAA, timeout=600)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        for n in ("MASTER.txt", "ACFTREF.txt"):
            z.extract(n, RAW / "faa")
except Exception as e:  # registry changes slowly; a cached copy is fine
    if not (RAW / "faa" / "MASTER.txt").exists():
        raise
    print("FAA download failed, using cached copy:", e, file=sys.stderr)
print(f"{y}-{m:02d}")
