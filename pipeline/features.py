"""Feature engineering shared by training and export."""
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"

WX_VARS = ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m",
           "wind_gusts_10m", "cloud_cover", "cloud_cover_low", "weather_code"]
TE_KEYS = {
    "carrier_rate": ["carrier"],
    "origin_rate": ["origin"],
    "dest_rate": ["dest"],
    "route_rate": ["origin", "dest"],
    "carrier_origin_rate": ["carrier", "origin"],
    "origin_hour_rate": ["origin", "dep_hour"],
    "flight_rate": ["carrier", "flight_num", "origin"],
    "carrier_dest_rate": ["carrier", "dest"],
    "aircraft_rate": ["aircraft"],
    "inbound_rate": ["inbound"],
}
SMOOTH = 50
REGIONAL = {"MQ", "OH", "OO", "YX", "9E", "QX", "ZW", "C5", "G7", "PT", "EV", "YV", "CP"}
# Peak travel holidays (Thanksgiving, Christmas, New Year, July 4, Memorial/Labor Day, spring-break Easter)
HOLIDAYS = pd.to_datetime([
    "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25", "2026-01-01", "2026-04-05",
    "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-26", "2026-12-25", "2027-01-01", "2027-03-28",
    "2027-05-31", "2027-07-04", "2027-09-06", "2027-11-25", "2027-12-25"])


def aircraft_family(mfr: str, model: str) -> str:
    m, f = str(model).upper().replace(" ", ""), str(mfr).upper()
    # FAA lists the MAX simply as "737-8"/"737-9"/"737-7"; NGs carry a customer code (e.g. 737-8H4)
    if "BOEING" in f and m.rstrip("MAX") in ("737-7", "737-8", "737-9", "737-8200"):
        return "737 MAX " + m[4]
    table = [("BD-500", "A220"), ("CL-600-2B19", "CRJ200"), ("CL-600-2C", "CRJ700"), ("CL-600-2D", "CRJ900"),
             ("CL-600-2E", "CRJ900"), ("ERJ170-2", "E175"), ("ERJ170-1", "E170"), ("ERJ190", "E190"),
             ("EMB-145", "ERJ-145"), ("EMB-135", "ERJ-145"), ("DHC-8-4", "Q400"), ("A319", "A319"), ("A320", "A320"),
             ("A321", "A321"), ("A330", "A330"), ("A350", "A350"), ("717", "717"), ("737-7", "737-700"),
             ("737-8", "737-800"), ("737-9", "737-900"), ("737-", "737"), ("757", "757"), ("767", "767"),
             ("777", "777"), ("787", "787")]
    for pat, name in table:
        if m.startswith(pat):
            return name
    return "Other"


def load_aircraft() -> pd.DataFrame:
    master = pd.read_csv(RAW / "faa" / "MASTER.txt", usecols=[0, 2, 4], dtype=str, encoding="utf-8-sig")
    master.columns = ["n", "code", "year"]
    ref = pd.read_csv(RAW / "faa" / "ACFTREF.txt", usecols=[0, 1, 2, 8], dtype=str, encoding="utf-8-sig")
    ref.columns = ["code", "mfr", "model", "seats"]
    a = master.merge(ref, on="code", how="left")
    a["tail"] = "N" + a["n"].str.strip()
    a["aircraft"] = [aircraft_family(f, m) for f, m in zip(a["mfr"], a["model"])]
    a["year"] = pd.to_numeric(a["year"], errors="coerce")
    a["seats"] = pd.to_numeric(a["seats"], errors="coerce")
    return a[["tail", "aircraft", "year", "seats"]].drop_duplicates("tail")


def hhmm_to_min(x):
    return (x // 100) * 60 + x % 100


def base_features(df: pd.DataFrame) -> pd.DataFrame:
    df["dep_hour"] = (df["crs_dep"] // 100).clip(0, 23).astype("int8")
    df["arr_hour"] = (df["crs_arr"] // 100).clip(0, 23).astype("int8")
    df["month"] = df["date"].dt.month.astype("int8")
    df["dow"] = df["date"].dt.dayofweek.astype("int8")  # 0 = Monday
    df["arr_date"] = df["date"] + pd.to_timedelta((df["crs_arr"] < df["crs_dep"]).astype(int), unit="D")

    # Typical position of this flight in the aircraft's daily rotation (delays propagate through the day)
    t = df[df["tail"].notna()].sort_values(["tail", "date", "crs_dep"])
    g = t.groupby(["tail", "date"], observed=True)
    df.loc[t.index, "leg"] = g.cumcount() + 1
    # Scheduled turnaround: minutes between the plane's previous scheduled arrival and this departure
    df.loc[t.index, "turn"] = hhmm_to_min(t["crs_dep"]) - hhmm_to_min(g["crs_arr"].shift(1))
    df.loc[t.index, "inbound"] = g["origin"].shift(1).astype(str).values
    df.loc[df["turn"] < 0, "turn"] = np.nan

    # Aircraft type/age from the FAA registry
    ac = load_aircraft()
    df["tail"] = df["tail"].astype(str)
    df = df.merge(ac, on="tail", how="left")
    df["age"] = df["date"].dt.year - df["year"]

    # Use each flight's *typical* values, since that's what is known before the day of travel
    fkey = ["carrier", "flight_num", "origin"]
    fg = df.groupby(fkey, observed=True)
    df["leg_index"] = fg["leg"].transform("median").astype("float32")
    df["turnaround"] = fg["turn"].transform("median").astype("float32")
    df["aircraft_age"] = fg["age"].transform("median").astype("float32")
    df["seats"] = fg["seats"].transform("median").astype("float32")
    mode = lambda s: s.mode().iat[0] if s.notna().any() else "Unknown"  # noqa: E731
    for col in ["aircraft", "inbound"]:
        m = df.groupby(fkey, observed=True)[col].agg(mode).rename(col + "_mode")
        df = df.drop(columns=col).join(m, on=fkey).rename(columns={col + "_mode": col})
    df["inbound"] = df["inbound"].replace({"nan": "Overnight", "Unknown": "Overnight"})
    df["regional"] = df["carrier"].astype(str).isin(REGIONAL).astype("int8")
    dates = pd.Series(df["date"].unique())
    dist = {d: min(abs((d - h).days) for h in HOLIDAYS) for d in dates}
    df["days_to_holiday"] = df["date"].map(dist).astype("float32")

    # Congestion: avg scheduled departures/arrivals per hour at each airport
    ndays = df["date"].nunique()
    dv = df.groupby(["origin", "dep_hour"], observed=True).size().div(ndays).rename("origin_hour_volume")
    av = df.groupby(["dest", "arr_hour"], observed=True).size().div(ndays).rename("dest_hour_volume")
    df = df.join(dv, on=["origin", "dep_hour"]).join(av, on=["dest", "arr_hour"])
    return df


def load_weather() -> pd.DataFrame:
    frames = []
    for p in (RAW / "weather").glob("*.parquet"):
        w = pd.read_parquet(p)
        w["airport"] = p.stem
        frames.append(w)
    w = pd.concat(frames, ignore_index=True)
    w["wdate"] = w["time"].dt.normalize()
    w["hour"] = w["time"].dt.hour.astype("int8")
    daily = w.groupby(["airport", "wdate"])[["precipitation", "snowfall"]].sum().add_suffix("_day")
    w = w.join(daily, on=["airport", "wdate"])
    for c in WX_VARS + ["precipitation_day", "snowfall_day"]:
        w[c] = w[c].astype("float32")
    return w.drop(columns="time")


def add_weather(df: pd.DataFrame, w: pd.DataFrame) -> pd.DataFrame:
    cols = WX_VARS + ["precipitation_day", "snowfall_day"]
    for side, ap, d, h in [("o", "origin", "date", "dep_hour"), ("d", "dest", "arr_date", "arr_hour")]:
        ww = w.rename(columns={"airport": ap, "wdate": d, "hour": h, **{c: f"{side}_{c}" for c in cols}})
        ww[ap] = ww[ap].astype(df[ap].dtype)
        df = df.merge(ww, on=[ap, d, h], how="left")
    return df


def te_stats(df: pd.DataFrame, prior: float) -> dict:
    out = {}
    for name, keys in TE_KEYS.items():
        g = df.groupby(keys, observed=True)["delayed"].agg(["sum", "count"])
        out[name] = ((g["sum"] + SMOOTH * prior) / (g["count"] + SMOOTH)).rename(name)
    return out


def apply_te(df: pd.DataFrame, stats: dict, prior: float) -> pd.DataFrame:
    for name, keys in TE_KEYS.items():
        df[name] = df.join(stats[name], on=keys)[name].fillna(prior).astype("float32")
    return df


def oof_te(df: pd.DataFrame, prior: float, folds: int = 5, seed: int = 0) -> pd.DataFrame:
    fold = np.random.default_rng(seed).integers(0, folds, len(df))
    res = {n: np.full(len(df), prior, dtype="float32") for n in TE_KEYS}
    for k in range(folds):
        m = fold == k
        stats = te_stats(df[~m], prior)
        part = apply_te(df.loc[m, list(dict.fromkeys(sum(TE_KEYS.values(), [])))].copy(), stats, prior)
        for n in TE_KEYS:
            res[n][m] = part[n].values
    for n in TE_KEYS:
        df[n] = res[n]
    return df


FEATURES = (["month", "dow", "dep_hour", "arr_hour", "distance", "crs_elapsed", "leg_index", "turnaround",
             "aircraft_age", "seats", "regional", "days_to_holiday",
             "origin_hour_volume", "dest_hour_volume"] + list(TE_KEYS)
            + [f"{s}_{c}" for s in "od" for c in WX_VARS + ["precipitation_day", "snowfall_day"]])
