"""Fail (exit 1) if a retrained model is meaningfully worse than the currently published one."""
import json
import subprocess
import sys
from pathlib import Path

MAX_AUC_DROP = 0.02
MIN_AUC = 0.65
ROOT = Path(__file__).resolve().parent.parent

new = json.loads((ROOT / "report" / "metrics.json").read_text())["results"]["selected_features"]["auc"]
old_txt = subprocess.run(["git", "show", "HEAD:report/metrics.json"], cwd=ROOT, capture_output=True, text=True).stdout
old = json.loads(old_txt)["results"]["selected_features"]["auc"] if old_txt else None
print(f"validation AUC: new {new}, published {old}")
if new < MIN_AUC or (old is not None and new < old - MAX_AUC_DROP):
    sys.exit("new model is worse than the published one; not publishing")
