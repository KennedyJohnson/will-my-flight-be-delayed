"""Train the delay model, evaluate on a held-out time period, run SHAP feature selection, fit final model."""
import json
from pathlib import Path

import lightgbm as lgb
import matplotlib
import numpy as np
import pandas as pd
import shap
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

import features as F

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW, REPORT = ROOT / "raw", ROOT / "report"
REPORT.mkdir(exist_ok=True)
WX_COLS = [c for c in F.FEATURES if c[:2] in ("o_", "d_")]
PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=255, min_data_in_leaf=500,
              feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1)

import os
SMOKE = os.environ.get("SMOKE")
raw = pd.read_parquet(RAW / "flights.parquet")
# Validate on the last 2 months of data (rolling window, so derive instead of hardcoding)
SPLIT = raw["date"].max().to_period("M").to_timestamp() - pd.DateOffset(months=1)
if SMOKE:
    raw = raw.sample(300_000, random_state=0); RAW = ROOT / "raw" / "smoke"; RAW.mkdir(exist_ok=True); REPORT = RAW
    PARAMS["learning_rate"] = 0.3
df = F.base_features(raw)
df = F.add_weather(df, F.load_weather())
df.to_parquet(RAW / "features_base.parquet", index=False)
print("rows", len(df), "weather coverage", round(df["o_temperature_2m"].notna().mean(), 3))


def blank_weather(X, frac=0.15, seed=1):
    # Forecasts are unavailable >16 days out, so teach the model a no-weather path
    m = np.random.default_rng(seed).random(len(X)) < frac
    X.loc[m, [c for c in WX_COLS if c in X]] = np.nan
    return X


tr, va = df[df["date"] < SPLIT].copy(), df[df["date"] >= SPLIT].copy()
prior = tr["delayed"].mean()
tr = F.oof_te(tr, prior)
va = F.apply_te(va, F.te_stats(tr, prior), prior)


def fit(feats, rounds=3000):
    dtr = lgb.Dataset(blank_weather(tr[feats].copy()), tr["delayed"])
    dva = lgb.Dataset(va[feats], va["delayed"], reference=dtr)
    return lgb.train(PARAMS, dtr, rounds, valid_sets=[dva],
                     callbacks=[lgb.early_stopping(100), lgb.log_evaluation(200)])


def metrics(y, p):
    return dict(auc=round(roc_auc_score(y, p), 4), logloss=round(log_loss(y, p), 4),
                brier=round(brier_score_loss(y, p), 4))


y = va["delayed"].values
results = {
    "baseline_overall_rate": metrics(y, np.full(len(y), prior)),
    "baseline_carrier_rate": metrics(y, va["carrier_rate"]),
    "baseline_flight_rate": metrics(y, va["flight_rate"]),
}
model = fit(F.FEATURES)
results["all_features"] = metrics(y, model.predict(va[F.FEATURES]))
print(results)

# ---- SHAP ----
sample = va.sample(min(50_000, len(va)), random_state=0)
sv = shap.TreeExplainer(model).shap_values(sample[F.FEATURES])
sv = sv[1] if isinstance(sv, list) else sv
imp = pd.Series(np.abs(sv).mean(0), index=F.FEATURES).sort_values(ascending=False)
imp.to_csv(REPORT / "shap_importance.csv", header=["mean_abs_shap"])
shap.summary_plot(sv, sample[F.FEATURES], max_display=20, show=False)
plt.tight_layout(); plt.savefig(REPORT / "shap_beeswarm.png", dpi=130); plt.close()
shap.summary_plot(sv, sample[F.FEATURES], plot_type="bar", max_display=25, show=False)
plt.tight_layout(); plt.savefig(REPORT / "shap_bar.png", dpi=130); plt.close()

# Feature selection: drop features contributing <2% of the top feature's mean |SHAP|
selected = [f for f in F.FEATURES if imp[f] >= 0.02 * imp.iloc[0]]
dropped = [f for f in F.FEATURES if f not in selected]
model_sel = fit(selected)
results["selected_features"] = metrics(y, model_sel.predict(va[selected]))
if results["selected_features"]["logloss"] > results["all_features"]["logloss"] + 0.0005:
    selected, dropped, model_sel = F.FEATURES, [], model
print("dropped", dropped, results)

# Performance on flights without weather (what users see for dates >16 days out)
va_nowx = va[selected].copy(); va_nowx[[c for c in WX_COLS if c in selected]] = np.nan
results["selected_no_weather"] = metrics(y, model_sel.predict(va_nowx))

# Calibration table
p = model_sel.predict(va[selected])
bins = pd.cut(p, np.linspace(0, 1, 11))
calib = pd.DataFrame({"p": p, "y": y}).groupby(bins, observed=True).agg(pred=("p", "mean"), actual=("y", "mean"), n=("y", "size"))
results["calibration"] = calib.round(4).reset_index(drop=True).to_dict("records")

# ---- Final model on all 24 months ----
best_iter = model_sel.best_iteration
prior_all = df["delayed"].mean()
df = F.oof_te(df, prior_all)
dall = lgb.Dataset(blank_weather(df[selected].copy()), df["delayed"])
final = lgb.train(PARAMS, dall, int(best_iter * 1.1))
final.save_model(str(RAW / "model.txt"))

sv_imp = imp.reindex(selected).sort_values(ascending=False)
summary = dict(results=results, features=selected, dropped=dropped, best_iter=best_iter, prior=prior_all,
               shap_importance=sv_imp.round(5).to_dict(),
               train_period=[str(df["date"].min().date()), str(df["date"].max().date())],
               n_flights=len(df), validation_period=[str(SPLIT.date()), str(va["date"].max().date())])
(REPORT / "metrics.json").write_text(json.dumps(summary, indent=2, default=float))
print(json.dumps(results, indent=2, default=float))
