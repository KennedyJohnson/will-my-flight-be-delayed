"""Export the trained model and lookup tables as static JSON for the GitHub Pages site."""
import json
import shutil
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

import features as F

ROOT = Path(__file__).resolve().parent.parent
RAW, DOCS, REPORT = ROOT / "raw", ROOT / "docs", ROOT / "report"
DATA = DOCS / "data"
(DATA / "flights").mkdir(parents=True, exist_ok=True)
SCHEDULE_WEEKS = 8
import os
if os.environ.get("SMOKE"):
    RAW = REPORT = RAW / "smoke"

CARRIERS = {"AA": "American Airlines", "AS": "Alaska Airlines", "B6": "JetBlue", "DL": "Delta Air Lines",
            "F9": "Frontier Airlines", "G4": "Allegiant Air", "HA": "Hawaiian Airlines", "NK": "Spirit Airlines",
            "UA": "United Airlines", "WN": "Southwest Airlines", "MQ": "Envoy Air", "OH": "PSA Airlines",
            "OO": "SkyWest Airlines", "YX": "Republic Airways", "9E": "Endeavor Air", "QX": "Horizon Air",
            "ZW": "Air Wisconsin", "C5": "CommuteAir", "G7": "GoJet Airlines", "PT": "Piedmont Airlines",
            "EV": "ExpressJet", "YV": "Mesa Airlines", "CP": "Compass Airlines", "MX": "Breeze Airways",
            "XP": "Avelo Airlines", "SY": "Sun Country Airlines"}


def r(x, n=4):
    return None if pd.isna(x) else round(float(x), n)


# ---------- Model: flatten LightGBM trees ----------
def flatten(node, out):
    i = len(out)
    out.append(None)
    if "leaf_index" in node:
        out[i] = [-1, 0, 0, 0, 0, 0, r(node["leaf_value"], 6)]
        return i
    left = flatten(node["left_child"], out)
    right = flatten(node["right_child"], out)
    mt = {"None": 0, "Zero": 1, "NaN": 2}[node["missing_type"]]
    out[i] = [node["split_feature"], r(node["threshold"], 6), int(node["default_left"]), mt, left, right,
              r(node["internal_value"], 6)]
    return i


booster = lgb.Booster(model_file=str(RAW / "model.txt"))
dump = booster.dump_model()
trees = []
for t in dump["tree_info"]:
    nodes = []
    flatten(t["tree_structure"], nodes)
    trees.append(nodes)
(DATA / "model.json").write_text(json.dumps({"features": dump["feature_names"], "trees": trees},
                                            separators=(",", ":")))

# ---------- Stats tables used as model inputs ----------
df = pd.read_parquet(RAW / "features_base.parquet",
                     columns=["date", "carrier", "flight_num", "origin", "dest", "crs_dep", "crs_arr",
                              "crs_elapsed", "distance", "dep_hour", "arr_hour", "delayed", "arr_delay",
                              "cancelled", "leg_index", "origin_hour_volume", "dest_hour_volume", "turnaround",
                              "aircraft", "aircraft_age", "seats", "inbound"])
prior = df["delayed"].mean()
stats = F.te_stats(df, prior)


def keyed(s, sep="|"):
    return {sep.join(map(str, k)) if isinstance(k, tuple) else str(k): r(v) for k, v in s.items()}


tables = {name: keyed(stats[name]) for name in F.TE_KEYS if name != "flight_rate"}
tables["origin_hour_volume"] = keyed(df.groupby(["origin", "dep_hour"], observed=True)["origin_hour_volume"].first(), "|")
tables["dest_hour_volume"] = keyed(df.groupby(["dest", "arr_hour"], observed=True)["dest_hour_volume"].first(), "|")
tables["prior"] = r(prior)
(DATA / "stats.json").write_text(json.dumps(tables, separators=(",", ":")))

# ---------- Flight schedule lookup (one file per operating carrier) ----------
last = df["date"].max()
recent = df[df["date"] > last - pd.Timedelta(weeks=SCHEDULE_WEEKS)]
fkey = ["carrier", "flight_num", "origin", "dest"]
g = recent.groupby(fkey, observed=True)
sched = pd.DataFrame({
    "dep": g["crs_dep"].agg(lambda s: s.mode().iat[0]),
    "arr": g["crs_arr"].agg(lambda s: s.mode().iat[0]),
    "el": g["crs_elapsed"].median(),
    "dist": g["distance"].first(),
    "dows": g["date"].agg(lambda d: int(np.bitwise_or.reduce(1 << d.dt.dayofweek.unique()))),
    "n": g.size(),
    "last": g["date"].max().dt.strftime("%Y-%m-%d"),
    "leg": g["leg_index"].first(),
    "turn": g["turnaround"].first(),
    "ac": g["aircraft"].first(),
    "age": g["aircraft_age"].first(),
    "seats": g["seats"].first(),
    "inb": g["inbound"].first(),
}).reset_index()
hist = df.groupby(fkey, observed=True).agg(hn=("delayed", "size"), hrate=("delayed", "mean"),
                                           avgdel=("arr_delay", lambda s: s[s > 0].mean()),
                                           canc=("cancelled", "mean")).reset_index()
sched = sched.merge(hist, on=fkey, how="left")
sched = sched.join(stats["flight_rate"], on=["carrier", "flight_num", "origin"])

for carrier, part in sched.groupby("carrier", observed=True):
    out = {}
    for row in part.sort_values("dep").itertuples():
        out.setdefault(str(row.flight_num), []).append({
            "o": row.origin, "d": row.dest, "dep": int(row.dep), "arr": int(row.arr), "el": r(row.el, 0),
            "dist": int(row.dist), "dows": row.dows, "n": int(row.n), "last": row.last, "leg": r(row.leg, 1),
            "turn": r(row.turn, 0), "ac": row.ac, "age": r(row.age, 1), "seats": r(row.seats, 0), "inb": row.inb,
            "fr": r(row.flight_rate), "hn": int(row.hn), "hr": r(row.hrate), "ad": r(row.avgdel, 0),
            "cx": r(row.canc)})
    (DATA / "flights" / f"{carrier}.json").write_text(json.dumps(out, separators=(",", ":")))

# ---------- Airports & carriers ----------
codes = set(df["origin"].astype(str)) | set(df["dest"].astype(str))
ap = pd.read_csv(ROOT / "raw" / "airports.csv", usecols=["iata_code", "name", "municipality", "iso_region",
                                                "latitude_deg", "longitude_deg", "type"])
ap = ap[ap["iata_code"].isin(codes)].sort_values("type").drop_duplicates("iata_code")
vol = df.groupby("origin", observed=True).size()
airports = {a.iata_code: {"name": a.name, "city": a.municipality, "region": str(a.iso_region).split("-")[-1],
                          "lat": r(a.latitude_deg), "lon": r(a.longitude_deg),
                          "rate": tables["origin_rate"].get(a.iata_code), "flights": int(vol.get(a.iata_code, 0))}
            for a in ap.itertuples()}
(DATA / "airports.json").write_text(json.dumps(airports, separators=(",", ":")))

carriers = {c: {"name": CARRIERS.get(c, c), "rate": tables["carrier_rate"].get(c),
                "flights": int((df["carrier"] == c).sum())} for c in sorted(df["carrier"].astype(str).unique())}
(DATA / "carriers.json").write_text(json.dumps(carriers, separators=(",", ":")))

# ---------- Model report ----------
metrics = json.loads((REPORT / "metrics.json").read_text())
metrics["schedule_through"] = str(last.date())
(DATA / "metrics.json").write_text(json.dumps(metrics, separators=(",", ":")))
for png in ["shap_beeswarm.png", "shap_bar.png"]:
    shutil.copy(REPORT / png, DOCS / "img" / png) if (DOCS / "img").exists() else None
print("exported", len(trees), "trees;", len(sched), "scheduled flight legs")
