/*
 * Decruptor — "which puzzle can you afford?"
 * A static calculator for the Bitcoin 256-puzzle races.
 *
 * All math lives in the pure `Calc` object below (no DOM), so tests.js can
 * exercise it under node or in a browser. The UI half only runs when it
 * finds its mount point in index.html.
 *
 * Conventions (matching the census tasking spec):
 *   W  = 2^n              interval width (full n-bit range; see README for the
 *                         2^(n-1) community convention — this is ~sqrt(2) more
 *                         conservative)
 *   ops = K * 2^(n/2)     expected group operations (K = 1.15 SOTA constant)
 *   rate 1.45e10 group ops/s per 4090-class GPU (RCKangaroo README turbo-kernel figure; also the census gpu_rate)
 *
 * Formulas cited from "An empirical analysis of Pollard-kangaroo walk
 * constants for interval ECDLP on secp256k1, including the unpublished SOTA
 * family" (Decruptor, 2026):
 *   RC DP-overhead formula   K = 1.15 + (0.07 + 0.76/sqrt(DPK)) / (1 + 0.30*DPK)
 *   DPK                      = 1.15 * sqrt(W) / (h * 2^d)
 *   cycle-entry band         B = c(r, M) * sqrt(W), c from the measured table of §3.2
 *                            (897 / 1648 / 2114 at r = 31 / 39 / 47, M = 2^14; 119 / 367 / 897
 *                            at M = 2^6 / 2^9 / 2^14, r = 31). No clean power law in M (§3.2, §7.3):
 *                            interpolated between measured rows only, NaN outside them.
 *   wild start spacing       = 1.0625 * W / (2h/3)                  (§5.5)
 *   tiling rule of thumb     spacing/band ≲ 1  ⇔  h ≳ 3*1.0625*W/(2*B)  (§7.3)
 */
(function () {
  'use strict';

  const TWO14 = Math.pow(2, 14);

  const Calc = {
    /* ---- core cost model ------------------------------------------------ */
    sqrtW: n => Math.pow(2, n / 2),
    expectedOps: (n, K) => K * Math.pow(2, n / 2),

    /** RC's "ideal DPs per kangaroo" load parameter. W = 2^n. */
    dpk: (n, h, d) => 1.15 * Calc.sqrtW(n) / (h * Math.pow(2, d)),

    /** RC DP-overhead formula (paper §5.3). Accurate to ≤2.5% in its domain. */
    kFromFormula: dpk => 1.15 + (0.07 + 0.76 / Math.sqrt(dpk)) / (1 + 0.30 * dpk),

    /** Formula validity domain of the paper's validation sweep (§5.3, abstract). */
    dpkInDomain: dpk => dpk >= 0.025 && dpk <= 74,

    /** K given a herd/DP configuration: 1.15 constant, or the RC formula. */
    kFor: (n, h, d, useFormula) => {
      if (!useFormula) return { k: 1.15, dpk: null, inDomain: true };
      const dpk = Calc.dpk(n, h, d);
      return { k: Calc.kFromFormula(dpk), dpk: dpk, inDomain: Calc.dpkInDomain(dpk) };
    },

    /**
     * Total GPU-hours for the expected work — fleet-size invariant and the
     * number comparable with the census's gpu_hours_kangaroo (it is what you
     * pay for: N GPUs × wall hours).
     */
    gpuHours: (ops, ratePerGpu) => ops / (ratePerGpu * 3600),
    /** Wall-clock seconds for a fleet of `gpus` GPUs. */
    wallSeconds: (ops, ratePerGpu, gpus) => ops / (ratePerGpu * gpus),

    costUsd: (gpuHours, dollarsPerGpuHour) => gpuHours * dollarsPerGpuHour,
    prizeUsd: (btc, btcPrice) => btc * btcPrice,

    /**
     * Solo EV. A kangaroo run's work to solution is birthday-shaped, not
     * exponential: the paper's per-trial K at the Kang-1 configuration has
     * median/mean 0.933 and sd/mean 0.544 (Rayleigh: 0.939 and 0.523;
     * exponential: 0.693 and 1.0). Under the Rayleigh law, committing exactly
     * the mean budget succeeds with probability 1 - e^(-pi/4) ≈ 54.4%.
     * EV = 0.544*prize - cost.
     */
    P_SUCCESS_AT_MEAN: 1 - Math.exp(-Math.PI / 4),
    ev: (prizeUsd, costUsd) => Calc.P_SUCCESS_AT_MEAN * prizeUsd - costUsd,
    /** Prize/cost multiple at full expected spend (no 0.544 haircut). */
    prizeOverCost: (prizeUsd, costUsd) => (costUsd > 0 ? prizeUsd / costUsd : Infinity),

    /* ---- herd geometry (paper §3.2 / §5.5 / §7.3) ------------------------ */
    /**
     * Cycle-entry band B = c·√W from the measured rows of paper §3.2. The
     * paper finds no clean power law in M and says to interpolate
     * between measured rows (§7.3), so this returns NaN outside them: the
     * walk geometry at W = 2^140 is outside the paper's measurements (they stop at W = 2^47).
     */
    BAND_R: [[31, 897], [39, 1648], [47, 2114]],          // at M = 2^14
    BAND_M31: [[6, 119], [9, 367], [14, 897]],            // at r = 31, by log2 M
    bandCoef: (n, M) => {
      const lerp = (rows, x) => {
        if (x < rows[0][0] || x > rows[rows.length - 1][0]) return NaN;
        for (let i = 1; i < rows.length; i++) {
          if (x <= rows[i][0]) {
            const [x0, y0] = rows[i - 1], [x1, y1] = rows[i];
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
          }
        }
        return NaN;
      };
      if (M === TWO14) return lerp(Calc.BAND_R, n);
      if (n === 31) return lerp(Calc.BAND_M31, Math.log2(M));
      return NaN;
    },
    band: (n, M) => Calc.bandCoef(n, M) * Calc.sqrtW(n),
    /** True when (n, M) lies inside the measured band table. */
    bandMeasured: (n, M) => isFinite(Calc.bandCoef(n, M)),
    /** Wild-range start spacing = 1.0625·W/(2h/3). */
    wildSpacing: (n, h) => 1.0625 * Math.pow(2, n) / (2 * h / 3),
    spacingBandRatio: (n, h, M) => Calc.wildSpacing(n, h) / Calc.band(n, M),
    /** Smallest herd that tiles the interval: h ≳ 3·1.0625·W/(2·B). */
    minHerd: (n, M) => 3 * 1.0625 * Math.pow(2, n) / (2 * Calc.band(n, M)),

    /* ---- hash160 fallback (pubkey unknown) ------------------------------- */
    /**
     * No pubkey -> no pair of known EC points -> no kangaroo, and no
     * meet-in-the-middle either (hash160 has no group structure). The only
     * known attack is plain enumeration: expected 2^(n-1) hash160 evaluations
     * over the n-bit range (mean position of a uniform key).
     */
    hash160Ops: n => Math.pow(2, n - 1),
    hash160Seconds: (n, gpus, ratePerGpu) => Math.pow(2, n - 1) / (ratePerGpu * gpus),

    /* ---- formatting ------------------------------------------------------ */
    fmtSci: x => {
      if (!isFinite(x)) return '∞';
      if (x === 0) return '0';
      const e = x.toExponential(3);
      const m = e.match(/^(-?\d)\.(\d+)e([+-]\d+)$/);
      if (!m) return e;
      const mant = m[1] + '.' + m[2].replace(/0+$/, '');
      return mant.replace(/\.$/, '') + 'e' + m[3].replace('+', '');
    },
    fmtBtc: v => {
      if (!v) return '0';
      let s = v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      return s;
    },
    fmtUsd: v => {
      if (!isFinite(v)) return '∞';
      const a = Math.abs(v), sign = v < 0 ? '−$' : '$';
      if (a < 1000) return sign + a.toFixed(2);
      if (a < 1e6) return sign + Math.round(a).toLocaleString('en-US');
      if (a < 1e9) return sign + (a / 1e6).toFixed(2) + 'M';
      if (a < 1e12) return sign + (a / 1e9).toFixed(2) + 'B';
      if (a < 1e15) return sign + (a / 1e12).toFixed(2) + 'T';
      return sign + Calc.fmtSci(a).replace('e', 'e');
    },
    fmtHours: h => Calc.fmtSeconds(h * 3600),
    fmtSeconds: s => {
      if (!isFinite(s)) return '∞';
      if (s < 90) return Math.round(s) + ' s';
      if (s < 5400) return (s / 60).toFixed(s / 60 < 10 ? 1 : 0) + ' min';
      if (s < 129600) return (s / 3600).toFixed(1) + ' h';
      if (s < 5.184e6) return (s / 86400).toFixed(1) + ' d';
      const y = s / 3.15576e7;
      if (y < 2) return y.toFixed(2) + ' y';
      if (y < 100) return y.toFixed(1) + ' y';
      return Calc.fmtSci(y) + ' y';
    },

    /** Row classification used by both the UI and the tests. */
    classify: p => {
      if (p.solved) return 'solved';
      if (p.status === 'moved_by_creator') return 'swept';
      if (p.pubkey_known) return 'kangaroo';
      return 'unreachable';
    },

    /**
     * Full per-row computation. `cfg` = {btcPrice, usdPerGpuHour, gpus,
     * ratePerGpu, useFormula, herdPerGpu, dpBits, jumpTable}.
     */
    row: (p, cfg) => {
      const cls = Calc.classify(p);
      const out = { cls: cls, n: p.n, prizeBtc: p.prize_btc };
      if (cls === 'swept' || cls === 'solved') {
        // Reference math still shown for solved rows; no EV (no live prize).
        const kres = Calc.kFor(p.n, cfg.gpus * cfg.herdPerGpu, cfg.dpBits, cfg.useFormula);
        const ops = Calc.expectedOps(p.n, kres.k);
        out.k = kres.k; out.dpk = kres.dpk; out.ops = ops;
        out.gpuHours = Calc.gpuHours(ops, cfg.ratePerGpu);
        return out;
      }
      if (cls === 'unreachable') {
        out.hash160Seconds = Calc.hash160Seconds(p.n, cfg.gpus, cfg.rateHash160 || 5e6);
        out.hash160Ops = Calc.hash160Ops(p.n);
        return out;
      }
      const h = cfg.gpus * cfg.herdPerGpu;
      const kres = Calc.kFor(p.n, h, cfg.dpBits, cfg.useFormula);
      const ops = Calc.expectedOps(p.n, kres.k);
      const gpuHours = Calc.gpuHours(ops, cfg.ratePerGpu);       // total, what you pay for
      const seconds = Calc.wallSeconds(ops, cfg.ratePerGpu, cfg.gpus); // wall clock
      const cost = Calc.costUsd(gpuHours, cfg.usdPerGpuHour);
      const prize = Calc.prizeUsd(p.prize_btc, cfg.btcPrice);
      out.k = kres.k; out.dpk = kres.dpk; out.dpkDomain = kres.inDomain;
      out.ops = ops; out.gpuHours = gpuHours; out.cost = cost; out.prize = prize;
      out.ev = Calc.ev(prize, cost);
      out.multiple = Calc.prizeOverCost(prize, cost);
      out.seconds = seconds;
      out.ratio = Calc.spacingBandRatio(p.n, h, cfg.jumpTable);
      out.minHerd = Calc.minHerd(p.n, cfg.jumpTable);
      out.geoMeasured = isFinite(out.ratio);
      out.tiled = out.geoMeasured && out.ratio <= 1;
      // verdict
      if (out.seconds / 3.15576e7 > 1000) out.verdict = 'lifetime+';
      else if (out.ev > 0) out.verdict = 'positive EV';
      else out.verdict = 'negative EV';
      if (!isFinite(out.gpuHours) || out.gpuHours > 1e30) out.verdict = 'unbuildable';
      return out;
    }
  };

  if (typeof window !== 'undefined') window.Calc = Calc;
  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;

  /* ======================================================================
   * UI half — only runs inside index.html
   * ==================================================================== */
  if (typeof document === 'undefined' || !document.getElementById('app')) return;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const DEFAULTS = {
    btcPrice: 100000,      // editable assumption — see README
    usdPerGpuHour: 0.40,   // cloud 4090-class rental ballpark; edit for your rig
    gpus: 1,
    ratePerGpu: 1.45e10,   // RCKangaroo README: ~14.5 GH/s on a 4090 (turbo kernels)
    useFormula: false,
    herdPerGpu: 4096,      // kangaroos per GPU (solver-dependent — edit)
    dpBits: 15,
    jumpTable: Math.pow(2, 14),
    rateHash160: 5e6
  };

  let state = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem('decruptor-calc') || '{}');
    state = Object.assign(state, saved);
  } catch (e) { /* file:// privacy mode etc. */ }

  function saveState() {
    try { localStorage.setItem('decruptor-calc', JSON.stringify(state)); } catch (e) {}
  }

  const FLEET_PRESETS = [
    [1, '1× GPU (you, one 4090)'],
    [8, '8× GPU (a good rig)'],
    [32, '32× GPU (a mining-basement rig)'],
    [128, '128× GPU (small fund)'],
    [512, '512× GPU (serious fund)'],
    [4096, '4096× GPU (nation-state-adjacent)']
  ];

  function readInputs() {
    state.btcPrice = Math.max(0, parseFloat($('btcPrice').value) || 0);
    state.usdPerGpuHour = Math.max(0, parseFloat($('usdPerGpuHour').value) || 0);
    state.gpus = Math.max(1, Math.round(parseFloat($('gpus').value) || 1));
    state.ratePerGpu = Math.max(1, parseFloat($('ratePerGpu').value) || DEFAULTS.ratePerGpu);
    state.useFormula = $('useFormula').checked;
    state.herdPerGpu = Math.max(1, Math.round(parseFloat($('herdPerGpu').value) || DEFAULTS.herdPerGpu));
    state.dpBits = Math.max(1, Math.round(parseFloat($('dpBits').value) || DEFAULTS.dpBits));
    state.jumpTable = Math.pow(2, Math.max(4, Math.round(parseFloat($('jumpBits').value) || 14)));
    state.rateHash160 = Math.max(1, parseFloat($('rateHash160').value) || DEFAULTS.rateHash160);
    saveState();
    render();
  }

  function verdictBadge(r) {
    if (r.cls === 'solved') return '<span class="badge solved">claimed</span>';
    if (r.cls === 'swept') return '<span class="badge swept">no prize</span>';
    if (r.cls === 'unreachable') return '<span class="badge unreach">unreachable</span>';
    const map = {
      'positive EV': 'good',
      'negative EV': 'bad',
      'lifetime+': 'bad',
      'unbuildable': 'unreach'
    };
    return '<span class="badge ' + map[r.verdict] + '">' + r.verdict + '</span>';
  }

  function rowHtml(p, r) {
    const addr = 'https://mempool.space/address/' + p.address;
    const cells = [];
    cells.push('<td class="num n">' + p.n + '</td>');
    cells.push('<td class="num">' + (r.prizeBtc ? Calc.fmtBtc(r.prizeBtc) : '—') + '</td>');
    cells.push('<td class="num">' + (r.prize ? Calc.fmtUsd(r.prize) : '—') + '</td>');
    cells.push('<td class="center">' + (p.pubkey_known
      ? '<span class="pk yes" title="pubkey revealed on-chain (' + esc(p.pubkey_source || 'chain') + ')">yes</span>'
      : '<span class="pk no" title="pubkey never revealed — ECDLP kangaroo impossible">no</span>') + '</td>');
    cells.push('<td class="num">' + (r.ops ? Calc.fmtSci(r.ops) : '—') + '</td>');
    cells.push('<td class="num">' + (r.gpuHours !== undefined ? Calc.fmtSci(r.gpuHours) : '—') + '</td>');
    cells.push('<td class="num">' + (r.cost !== undefined ? Calc.fmtUsd(r.cost) : '—') + '</td>');
    cells.push('<td class="num">' + (r.seconds !== undefined ? Calc.fmtSeconds(r.seconds) : (r.hash160Seconds !== undefined ? Calc.fmtSeconds(r.hash160Seconds) : '—')) + '</td>');
    cells.push('<td class="num">' + (r.ev !== undefined ? Calc.fmtUsd(r.ev) : '—') + '</td>');
    if (r.cls === 'kangaroo' && !r.geoMeasured) {
      cells.push('<td class="num muted" title="' + esc('not measured: the cycle-entry band is only known for W = 2^31…2^47 at M = 2^14 (and M = 2^6…2^14 at 2^31), paper §3.2; no extrapolation') + '">n/m</td>');
    } else if (r.cls === 'kangaroo') {
      const t = 'wild spacing ' + Calc.fmtSci(Calc.wildSpacing(p.n, state.gpus * state.herdPerGpu)) +
        ' vs band ' + Calc.fmtSci(Calc.band(p.n, state.jumpTable)) +
        ' — spacing/band ' + r.ratio.toFixed(2) + (r.tiled ? ' (tiled)' : ' (under-tiled: +7–14% K, paper §5.5)') +
        '; herd for full tiling: ' + Calc.fmtSci(r.minHerd);
      cells.push('<td class="num ' + (r.tiled ? 'tiled' : 'undertiled') + '" title="' + esc(t) + '">' + r.ratio.toFixed(2) + '</td>');
    } else if (r.cls === 'unreachable') {
      cells.push('<td class="num muted" title="' + esc('brute force: ' + Calc.fmtSci(r.hash160Ops) + ' expected hash160s (no meet-in-the-middle without a pubkey)') + '">hash160</td>');
    } else {
      cells.push('<td class="num muted">—</td>');
    }
    cells.push('<td class="center">' + verdictBadge(r) + '</td>');
    cells.push('<td class="addr"><a href="' + addr + '" rel="noopener">verify ↗</a></td>');
    const cls = 'r-' + r.cls + (r.cls === 'kangaroo' && r.verdict === 'positive EV' ? ' hot' : '');
    return '<tr class="' + cls + '">' + cells.join('') + '</tr>';
  }

  function summary(rows) {
    const live = rows.filter(r => r.cls === 'kangaroo');
    const totalBtc = live.reduce((a, p) => a + p.prizeBtc, 0);
    const cheapest = live.slice().sort((a, b) => a.gpuHours - b.gpuHours)[0];
    let s = '<b>' + live.length + '</b> puzzles hold a live prize and a known pubkey (' +
      Calc.fmtBtc(totalBtc) + ' BTC on the table). ';
    if (cheapest) {
      s += 'Cheapest at your settings: <b>#' + cheapest.n + '</b> — ' +
        Calc.fmtSci(cheapest.ops) + ' ops ≈ ' + Calc.fmtSci(cheapest.gpuHours) +
        ' GPU-h ≈ ' + Calc.fmtUsd(cheapest.cost) + ' → EV ' + Calc.fmtUsd(cheapest.ev) +
        ' (' + cheapest.verdict + ').';
    }
    $('summary').innerHTML = s;
  }

  function render() {
    const ps = CENSUS.puzzles;
    const filter = $('filter').value;
    const rows = ps.map(p => Calc.row(p, state));
    summary(rows);
    const tbody = [];
    for (let i = 0; i < ps.length; i++) {
      const r = rows[i];
      if (filter === 'live' && !(r.cls === 'kangaroo' || r.cls === 'unreachable')) continue;
      if (filter === 'kangaroo' && r.cls !== 'kangaroo') continue;
      if (filter === 'unreachable' && r.cls !== 'unreachable') continue;
      if (filter === 'dead' && !(r.cls === 'solved' || r.cls === 'swept')) continue;
      tbody.push(rowHtml(ps[i], r));
    }
    $('tbody').innerHTML = tbody.join('');
    // header meta
    const hTotal = state.gpus * state.herdPerGpu;
    $('metaLine').innerHTML =
      'Census ' + esc(CENSUS.asOfUtc) + ' · tip ' + CENSUS.tipHeight.toLocaleString('en-US') +
      ' · funding tx <code>' + esc(CENSUS.fundingTx.slice(0, 10)) + '…</code> (block ' + CENSUS.fundingBlock + ')' +
      ' · your fleet: ' + state.gpus + ' GPU×' + Calc.fmtSci(state.ratePerGpu) + ' ops/s, herd ' +
      Calc.fmtSci(hTotal) + ' kangaroos, dp ' + state.dpBits + ', K = ' +
      (state.useFormula ? Calc.kFor(140, hTotal, state.dpBits, true).k.toFixed(4) + ' (RC formula @ #140)' : '1.15 (SOTA constant)');
  }

  function hydrate() {
    $('btcPrice').value = state.btcPrice;
    $('usdPerGpuHour').value = state.usdPerGpuHour;
    $('gpus').value = state.gpus;
    $('ratePerGpu').value = state.ratePerGpu;
    $('herdPerGpu').value = state.herdPerGpu;
    $('dpBits').value = state.dpBits;
    $('jumpBits').value = Math.round(Math.log2(state.jumpTable));
    $('rateHash160').value = state.rateHash160;
    $('useFormula').checked = state.useFormula;
    $('fleetPreset').value = FLEET_PRESETS.some(f => f[0] === state.gpus) ? String(state.gpus) : 'custom';
  }

  function init() {
    const gpus = $('gpus');
    gpus.addEventListener('change', () => {
      // keep the preset dropdown in sync if the value matches one
      $('fleetPreset').value = FLEET_PRESETS.some(f => f[0] === state.gpus) ? String(state.gpus) : 'custom';
    });
    $('fleetPreset').addEventListener('change', e => {
      const v = e.target.value;
      if (v !== 'custom') { $('gpus').value = v; readInputs(); }
    });
    for (const id of ['btcPrice', 'usdPerGpuHour', 'gpus', 'ratePerGpu', 'herdPerGpu', 'dpBits', 'jumpBits', 'rateHash160']) {
      $(id).addEventListener('input', readInputs);
      $(id).addEventListener('change', readInputs);
    }
    $('useFormula').addEventListener('change', readInputs);
    $('filter').addEventListener('change', render);
    $('resetBtn').addEventListener('click', () => {
      state = Object.assign({}, DEFAULTS);
      saveState();
      hydrate();
      render();
    });
    hydrate();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
