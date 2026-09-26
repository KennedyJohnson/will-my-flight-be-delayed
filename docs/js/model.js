// Evaluates the exported LightGBM model in the browser.
// Node layout: [feature, threshold, defaultLeft, missingType(0 None,1 Zero,2 NaN), left, right, value]

function goesLeft(node, x) {
  const [, thr, defLeft, missing] = node;
  if (Number.isNaN(x) || x == null) {
    if (missing === 2) return !!defLeft;
    x = 0;
  }
  if (missing === 1 && Math.abs(x) < 1e-35) return !!defLeft;
  return x <= thr;
}

export class DelayModel {
  constructor({ features, trees }) {
    this.features = features;
    this.trees = trees;
  }

  // Returns probability plus per-feature contributions (path attribution in log-odds space).
  predict(row) {
    const x = this.features.map((f) => (row[f] == null ? NaN : row[f]));
    const contrib = new Float64Array(x.length);
    let bias = 0;
    let score = 0;
    for (const nodes of this.trees) {
      let i = 0;
      bias += nodes[0][6];
      while (nodes[i][0] !== -1) {
        const n = nodes[i];
        const next = goesLeft(n, x[n[0]]) ? n[4] : n[5];
        contrib[n[0]] += nodes[next][6] - n[6];
        i = next;
      }
      score += nodes[i][6];
    }
    const p = 1 / (1 + Math.exp(-score));
    const baseP = 1 / (1 + Math.exp(-bias));
    const contributions = this.features
      .map((f, k) => ({ feature: f, value: x[k], logit: contrib[k] }))
      .filter((c) => Math.abs(c.logit) > 1e-6);
    return { p, baseP, contributions };
  }
}
