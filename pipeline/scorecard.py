"""Live scorecard: how did the model the site was serving do on flights that happened after it was trained?

Run after 01_load/02_weather and BEFORE train/export, while docs/data still holds the published model.
Every flight dated after the published model's training window is one it never saw. Each flight is scored
exactly the way the site would have scored it: the published tree dump, stats tables and schedule entry,
evaluated with a port of docs/js/model.js. Flights the site couldn't look up (not in the published schedule) are
skipped and counted in `coverage`. Weather comes from the Open-Meteo archive (what happened), while the site uses
forecasts, so this is a best case for the weather inputs.

Appends one row per month to docs/data/scorecard.json (re-running a month replaces its row). Writes
raw/drift.txt if a month's AUC falls more than DRIFT_AUC below the published validation AUC.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

import features as F

ROOT = Path(__file__).resolve().parent.parent
RAW, DATA = ROOT / "raw", ROOT / "docs" / "data"
OUT = DATA / "scorecard.json"
DRIFT_AUC = 0.03
MIN_FLIGHTS = 10_000  # skip partial months


class TreeModel:
    """Vectorized port of docs/js/model.js (same node layout and missing-value rules)."""

    def __init__(self, dump):
        self.features = dump["features"]
        self.trees = [np.array([[np.nan if v is None else v for v in n] for n in t], dtype=np.float64)
                      for t in dump["trees"]]

    def predict(self, X: np.ndarray) -> np.ndarray:
        score = np.zeros(len(X))
        rows = np.arange(len(X))
        for t in self.trees:
            feat, thr, defl, miss = t[:, 0].astype(int), t[:, 1], t[:, 2] == 1, t[:, 3].astype(int)
            left, right, val = t[:, 4].astype(int), t[:, 5].astype(int), t[:, 6]
            node = np.zeros(len(X), dtype=int)
            live = feat[node] != -1
            while live.any():
                r, n = rows[live], node[live]
                x = X[r, feat[n]]
                nan = np.isnan(x)
                x = np.where(nan, 0.0, x)
                go_left = x <= thr[n]
                go_left = np.where(nan & (miss[n] == 2), defl[n], go_left)
                go_left = np.where(~(nan & (miss[n] == 2)) & (miss[n] == 1) & (np.abs(x) < 1e-35), defl[n], go_left)
                node[r] = np.where(go_left, left[n], right[n])
                live = feat[node] != -1
            score += val[node]
        return 1 / (1 + np.exp(-score))


def schedule_table() -> pd.DataFrame:
    rows = []
    for p in (DATA / "flights").glob("*.json"):
        for num, legs in json.loads(p.read_text()).items():
            for leg in legs:
                rows.append(dict(carrier=p.stem, flight_num=int(num), origin=leg["o"], dest=leg["d"], leg_index=leg["leg"],
                                 turnaround=leg["turn"], aircraft=leg["ac"], aircraft_age=leg["age"], seats=leg["seats"],
                                 inbound=leg["inb"], flight_rate=leg["fr"]))
    return pd.DataFrame(rows)


def site_features(df: pd.DataFrame, stats: dict) -> pd.DataFrame:
    """Mirror of the row built in docs/js/app.js showLeg()."""
    prior = stats["prior"]
    look = lambda table, keys: pd.Series(["|".join(map(str, k)) for k in zip(*keys)], index=df.index).map(stats[table])  # noqa: E731
    X = pd.DataFrame(index=df.index)
    X["month"], X["dow"] = df["date"].dt.month, df["date"].dt.dayofweek
    X["dep_hour"], X["arr_hour"] = df["dep_hour"], df["arr_hour"]
    X["distance"], X["crs_elapsed"] = df["distance"], df["crs_elapsed"]
    for c in ["leg_index", "turnaround", "aircraft_age", "seats"]:
        X[c] = df[c]
    X["origin_hour_volume"] = look("origin_hour_volume", [df["origin"], df["dep_hour"]]).fillna(0)
    X["dest_hour_volume"] = look("dest_hour_volume", [df["dest"], df["arr_hour"]]).fillna(0)
    c, o, d = df["carrier"].astype(str), df["origin"].astype(str), df["dest"].astype(str)
    X["carrier_rate"] = c.map(stats["carrier_rate"])
    X["origin_rate"] = o.map(stats["origin_rate"])
    X["dest_rate"] = d.map(stats["dest_rate"])
    X["route_rate"] = look("route_rate", [o, d])
    X["carrier_origin_rate"] = look("carrier_origin_rate", [c, o])
    X["origin_hour_rate"] = look("origin_hour_rate", [o, df["dep_hour"]])
    X["flight_rate"] = df["flight_rate"]
    X["carrier_dest_rate"] = look("carrier_dest_rate", [c, d])
    X["aircraft_rate"] = df["aircraft"].map(stats["aircraft_rate"])
    X["inbound_rate"] = df["inbound"].map(stats["inbound_rate"])
    rates = [k for k in X if k.endswith("_rate")]
    X[rates] = X[rates].astype(float).fillna(prior)
    X["regional"] = c.isin(F.REGIONAL).astype(int)
    X["days_to_holiday"] = df["date"].map(lambda t: min(abs((t - h).days) for h in F.HOLIDAYS))
    for col in df.columns:
        if col[:2] in ("o_", "d_"):
            X[col] = df[col]
    return X


def month_metrics(y, p, fr) -> dict:
    bins = pd.cut(p, np.linspace(0, 1, 11))
    calib = pd.DataFrame({"p": p, "y": y}).groupby(bins, observed=True).agg(pred=("p", "mean"), actual=("y", "mean"), n=("y", "size"))
    return dict(n=int(len(y)), auc=round(roc_auc_score(y, p), 4), brier=round(brier_score_loss(y, p), 4),
                logloss=round(log_loss(y, p), 4), baseline_flight_rate_auc=round(roc_auc_score(y, fr), 4),
                mean_pred=round(float(p.mean()), 4), actual_rate=round(float(y.mean()), 4),
                calibration=calib.round(4).reset_index(drop=True).to_dict("records"))


def main():
    published = json.loads((DATA / "metrics.json").read_text())
    trained_through = pd.Timestamp(published["train_period"][1])
    val_auc = published["results"]["selected_features"]["auc"]
    raw = pd.read_parquet(RAW / "flights.parquet")
    new = raw[raw["date"] > trained_through].copy()
    if new.empty:
        print("no flights after", trained_through.date(), "- nothing to score")
        return

    new["dep_hour"] = (new["crs_dep"] // 100).clip(0, 23).astype("int8")
    new["arr_hour"] = (new["crs_arr"] // 100).clip(0, 23).astype("int8")
    new["arr_date"] = new["date"] + pd.to_timedelta((new["crs_arr"] < new["crs_dep"]).astype(int), unit="D")
    total = new.groupby(new["date"].dt.to_period("M")).size()
    for col in ["carrier", "origin", "dest"]:
        new[col] = new[col].astype(str)
    new = new.merge(schedule_table(), on=["carrier", "flight_num", "origin", "dest"], how="inner")
    if (RAW / "weather").exists() and any((RAW / "weather").glob("*.parquet")):
        new = F.add_weather(new, F.load_weather())

    model = TreeModel(json.loads((DATA / "model.json").read_text()))
    X = site_features(new, json.loads((DATA / "stats.json").read_text()))
    X = X.reindex(columns=model.features).astype(float)
    new["p"] = model.predict(X.to_numpy())

    card = json.loads(OUT.read_text()) if OUT.exists() else {"months": []}
    drift = []
    for period, g in new.groupby(new["date"].dt.to_period("M")):
        if len(g) < MIN_FLIGHTS:
            print(period, "only", len(g), "scorable flights; skipping")
            continue
        m = dict(month=str(period), model_trained_through=str(trained_through.date()),
                 validation_auc=val_auc, coverage=round(len(g) / total[period], 4),
                 **month_metrics(g["delayed"].to_numpy(), g["p"].to_numpy(), g["flight_rate"].fillna(0).to_numpy()))
        card["months"] = [x for x in card["months"] if x["month"] != m["month"]] + [m]
        print({k: v for k, v in m.items() if k != "calibration"})
        if m["auc"] < val_auc - DRIFT_AUC:
            drift.append(f"{m['month']}: live AUC {m['auc']} vs validation AUC {val_auc}")
    card["months"].sort(key=lambda x: x["month"])
    OUT.write_text(json.dumps(card, indent=1))
    if drift:
        (RAW / "drift.txt").write_text("\n".join(drift) + "\n")
        print("DRIFT:", *drift, sep="\n")


if __name__ == "__main__":
    main()
