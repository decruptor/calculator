/*
 * Unit checks for the calculator math. Runs under node (`node tests.js`) or in
 * a browser (open tests.html). Cross-checks the calculator against the census
 * snapshot's own published estimates for #1, #66, #135, #140, #160 and the
 * paper's published formula/geometry values.
 *
 * Conventions: W = 2^n (full n-bit range, census tasking spec), ops = K·2^(n/2).
 * The paper's own sweeps quote interval widths directly (its "r = 31" is
 * W = 2^31), so geometry tests pass n = 31 to match the paper's table.
 */
'use strict';

let Calc, CENSUS;
if (typeof require === 'function' && typeof window === 'undefined') {
  Calc = require('./app.js');
  CENSUS = require('./data.js');
} else {
  Calc = window.Calc;
  CENSUS = window.CENSUS;
}

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) {
    failed++; failures.push(name + ' :: ' + e.message);
    console.log('FAIL  ' + name + ' :: ' + e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, relTol, label) {
  relTol = relTol === undefined ? 1e-9 : relTol;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-300);
  const rel = Math.abs(a - b) / denom;
  assert(rel <= relTol, (label || 'value') + ': got ' + a + ', want ' + b + ' (rel ' + rel.toExponential(2) + ')');
}

const byN = {};
for (const p of CENSUS.puzzles) byN[p.n] = p;

/* ---- census integrity ------------------------------------------------ */
test('census has all 256 puzzles, n = 1..256', () => {
  assert(CENSUS.puzzles.length === 256, 'expected 256 rows, got ' + CENSUS.puzzles.length);
  for (let n = 1; n <= 256; n++) assert(byN[n], 'missing puzzle #' + n);
});

test('census metadata stamped (as_of, tip, funding tx)', () => {
  assert(CENSUS.asOfUtc === '2026-10-23T13:45:05Z', 'asOfUtc changed: ' + CENSUS.asOfUtc);
  assert(CENSUS.tipHeight === 972774, 'tipHeight changed');
  assert(CENSUS.fundingTx === '08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15', 'funding tx changed');
});

/* ---- cross-checks vs the census's own published numbers -------------- */
// Census method: kangaroo_ops = 1.15*2^(n/2), gpu_rate = 1.45e10 ops/s/GPU.
// The calculator must reproduce kangaroo_ops / gpu_hours_kangaroo exactly.
test('ops at n=140 matches census kangaroo_ops (1.357680363825023e21)', () => {
  near(Calc.expectedOps(140, 1.15), byN[140].kangaroo_ops, 1e-12, 'ops(140)');
});

test('total GPU-hours at n=140 match census gpu_hours_kangaroo (26009202.37)', () => {
  near(Calc.gpuHours(Calc.expectedOps(140, 1.15), 1.45e10), byN[140].gpu_hours_kangaroo, 1e-9, 'gpuHours(140)');
});

test('cost is total GPU-hours × $/h — it must NOT shrink as the fleet grows', () => {
  const cfg = { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) };
  const one = Calc.row(byN[140], cfg);
  const many = Calc.row(byN[140], Object.assign({}, cfg, { gpus: 4096 }));
  near(one.cost, many.cost, 1e-12, 'cost fleet-invariance');
  near(one.cost, one.gpuHours * 0.4, 1e-12, 'cost = total GPU-h × $/h');
  // wall time does shrink with the fleet
  near(many.seconds, one.seconds / 4096, 1e-9, 'wall time ÷ fleet');
});

const CROSS = [1, 66, 135, 140, 160];
test('cross-check #1, #66, #135, #140, #160: ops & hours vs census', () => {
  for (const n of CROSS) {
    const p = byN[n];
    const r = Calc.row(p, { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
      useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
    if (p.kangaroo_ops) near(r.ops, p.kangaroo_ops, 1e-12, 'ops(#' + n + ')');
    else near(r.ops, 1.15 * Math.pow(2, n / 2), 1e-12, 'ops(#' + n + ') spec');
    if (p.gpu_hours_kangaroo) near(r.gpuHours, p.gpu_hours_kangaroo, 1e-9, 'gpuHours(#' + n + ')');
    else near(r.gpuHours, 1.15 * Math.pow(2, n / 2) / (1.45e10 * 3600), 1e-9, 'gpuHours(#' + n + ') spec');
  }
});

test('cross-check #140/#160: prize BTC and classification', () => {
  near(byN[140].prize_btc, 14.0000224, 1e-12, 'prize #140');
  near(byN[160].prize_btc, 16.00123082, 1e-12, 'prize #160');
  assert(Calc.classify(byN[140]) === 'kangaroo', '#140 should be kangaroo-able');
  assert(Calc.classify(byN[160]) === 'kangaroo', '#160 should be kangaroo-able');
  assert(Calc.classify(byN[1]) === 'solved', '#1 should be solved');
  assert(Calc.classify(byN[66]) === 'solved', '#66 should be solved');
  assert(Calc.classify(byN[135]) === 'solved', '#135 should be solved (claimed 2026-07-28)');
  assert(Calc.classify(byN[71]) === 'unreachable', '#71 has no pubkey — unreachable');
  assert(Calc.classify(byN[200]) === 'swept', '#200 was swept by the creator in 2017');
});

/* ---- paper constants -------------------------------------------------- */
test('RC DP-overhead formula: DPK=3.253 -> K=1.3987 (paper §5.3 table)', () => {
  near(Calc.kFromFormula(3.253), 1.3987, 1e-4, 'K formula');
  // and the DPK itself: r=31 sweep, h=512, dp=5
  near(Calc.dpk(31, 512, 5), 3.253, 1e-3, 'DPK(31,512,5)');
});

test('RC DP-overhead formula: DPK=73.60 -> K=1.1569 (calibration point)', () => {
  near(Calc.kFromFormula(73.60), 1.1569, 1e-4, 'K calibration');
});

test('K for the 1.15 constant mode is exactly 1.15', () => {
  const k = Calc.kFor(140, 4096, 15, false);
  assert(k.k === 1.15, 'simple mode must return 1.15, got ' + k.k);
  assert(k.dpk === null, 'simple mode should not compute DPK');
});

test('formula mode returns K≈1.15 at huge DPK and inflates at tiny DPK', () => {
  near(Calc.kFromFormula(74), 1.1569, 1e-3, 'large DPK');
  assert(Calc.kFromFormula(0.025) > 5.9, 'tiny DPK should inflate K, got ' + Calc.kFromFormula(0.025));
});

/* ---- spacing/band geometry (paper §5.5, §7.3) ------------------------ */
// Known under-tiled case from the paper: r=31, h=64, dp=5, M=2^14.
// Paper measured +13.9% K there and quotes spacing/band ≈ 2.4 (B ≈ 2^24.4);
// with the §7.3 rule-of-thumb B = 400·√W·(M/2^14)^0.4 the ratio is ≈ 2.9 —
// either way > 1: the flag must fire.
test('spacing/band flag fires for the paper under-tiled case (r=31, h=64)', () => {
  const ratio = Calc.spacingBandRatio(31, 64, Math.pow(2, 14));
  assert(ratio > 2 && ratio < 4, 'expected ratio ≈ 2.4–2.9, got ' + ratio);
  assert(ratio > 1, 'under-tiled flag must fire (flag rule: ratio <= 1 is tiled)');
  assert(Calc.minHerd(31, Math.pow(2, 14)) > 128, 'h=128 must still be under minHerd');
});

test('calibration herd (r=31, h=512) is safely tiled: ratio ≈ 0.3, matches paper', () => {
  const ratio = Calc.spacingBandRatio(31, 512, Math.pow(2, 14));
  assert(ratio > 0.2 && ratio < 0.5, 'expected ratio ≈ 0.3, got ' + ratio);
  near(Calc.wildSpacing(31, 512), Math.pow(2, 22.7), 0.02, 'wild spacing 2^22.7');
});

test('minHerd satisfies the paper rule h ≳ 3·1.0625·W/(2·B)', () => {
  const n = 40, M = Math.pow(2, 14);
  near(Calc.minHerd(n, M), 3 * 1.0625 * Math.pow(2, n) / (2 * Calc.band(n, M)), 1e-12, 'minHerd identity');
  // and minHerd is exactly the h at which spacing/band = 1
  const h = Calc.minHerd(n, M);
  near(Calc.spacingBandRatio(n, h, M), 1, 1e-9, 'ratio at minHerd');
});

test('band scales as (M/2^14)^0.4 (paper §3.2 power-law fit)', () => {
  near(Calc.band(31, Math.pow(2, 14)), 400 * Math.pow(2, 15.5), 1e-12, 'band at default M');
  near(Calc.band(31, Math.pow(2, 6)) / Calc.band(31, Math.pow(2, 14)), Math.pow(Math.pow(2, -8), 0.4), 1e-12, 'M exponent');
});

/* ---- economics -------------------------------------------------------- */
test('EV: 0.632·prize − cost (P(success at mean budget) = 1 − 1/e)', () => {
  near(Calc.P_SUCCESS_AT_MEAN, 1 - Math.exp(-1), 1e-15, 'P at mean');
  near(Calc.ev(1000, 100), (1 - Math.exp(-1)) * 1000 - 100, 1e-12, 'EV');
});

test('prize/cost multiple and USD formatting', () => {
  near(Calc.prizeOverCost(200000, 100000), 2, 1e-12, 'multiple');
  assert(Calc.fmtUsd(1234) === '$1,234', 'fmtUsd(1234) -> ' + Calc.fmtUsd(1234));
  assert(Calc.fmtUsd(1500000) === '$1.50M', 'fmtUsd(1.5e6) -> ' + Calc.fmtUsd(1500000));
  assert(Calc.fmtUsd(2.5e9) === '$2.50B', 'fmtUsd(2.5e9) -> ' + Calc.fmtUsd(2.5e9));
  assert(Calc.fmtUsd(-3.5) === '−$3.50', 'fmtUsd(-3.5) -> ' + Calc.fmtUsd(-3.5));
});

test('prize BTC formatting keeps census precision (#140: 14.0000224)', () => {
  assert(Calc.fmtBtc(14.0000224) === '14.0000224', 'fmtBtc(#140) -> ' + Calc.fmtBtc(14.0000224));
  assert(Calc.fmtBtc(16.00123082) === '16.00123082', 'fmtBtc(#160) -> ' + Calc.fmtBtc(16.00123082));
  assert(Calc.fmtBtc(0) === '0', 'fmtBtc(0) -> ' + Calc.fmtBtc(0));
});

test('time formatting spans seconds to exayears without lying', () => {
  assert(Calc.fmtSeconds(72) === '72 s', '72 s -> ' + Calc.fmtSeconds(72));
  assert(Calc.fmtSeconds(90) === '1.5 min', '90 s -> ' + Calc.fmtSeconds(90));
  assert(Calc.fmtSeconds(7200) === '2.0 h', '7200 -> ' + Calc.fmtSeconds(7200));
  assert(Calc.fmtSeconds(3 * 86400) === '3.0 d', '3 d -> ' + Calc.fmtSeconds(259200));
  assert(Calc.fmtSeconds(3.15576e7) === '1.00 y', '1 y -> ' + Calc.fmtSeconds(3.15576e7));
  assert(Calc.fmtSeconds(1e9) === '31.7 y', '31.7 y -> ' + Calc.fmtSeconds(1e9));
  assert(/^1e14 y$/.test(Calc.fmtSeconds(3.15576e21)), 'huge spans go scientific: ' + Calc.fmtSeconds(3.15576e21));
});

test('#140 row: verdict, expected time and cost at 1×4090 defaults', () => {
  const r = Calc.row(byN[140], { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
  near(r.prize, 1400002.24, 1e-9, 'prize USD @ 100k/BTC');
  near(r.cost, r.gpuHours * 0.4, 1e-12, 'cost = hours × $/h');
  assert(r.verdict === 'lifetime+', '1 GPU at #140 must be lifetime+, got ' + r.verdict);
  assert(r.ev < 0, 'EV must be negative at 1 GPU');
});

test('#160 row at 4096×4090 fleet: cost unchanged, wall time divided, EV still negative', () => {
  const r = Calc.row(byN[160], { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 4096, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
  near(r.gpuHours, byN[160].gpu_hours_kangaroo, 1e-9, 'total GPU-h is fleet-invariant');
  near(r.seconds, byN[160].gpu_hours_kangaroo * 3600 / 4096, 1e-9, 'wall time ÷ fleet');
  assert(r.ev < 0, 'EV negative even at 4096 GPUs');
  assert(r.verdict === 'negative EV', 'verdict: ' + r.verdict);
});

// #135 was claimed 2026-07-28 (it used to be the flagship "unreachable" row),
// so the live no-pubkey rows nearest it are #133/#134/#136/#139.
test('unreachable rows get hash160 brute-force estimates, not kangaroo numbers', () => {
  assert(Calc.classify(byN[135]) === 'solved', '#135 is now solved — census is current');
  const r = Calc.row(byN[139], { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
  assert(r.cls === 'unreachable', '#139 should be unreachable');
  // no pubkey -> no meet-in-the-middle: expected work is 2^(n-1) hash160s
  near(r.hash160Ops, Math.pow(2, 138), 1e-12, 'hash160 ops (#139)');
  near(r.hash160Seconds, Math.pow(2, 138) / 5e6, 1e-12, 'hash160 seconds (#139)');
  assert(r.ops === undefined && r.cost === undefined, 'no kangaroo numbers for unreachable rows');
});

test('hash160 brute force is ~7.5M GPU-years even for #71 at 1 GPU', () => {
  const r = Calc.row(byN[71], { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
  const years = r.hash160Seconds / 3.15576e7;
  near(years, Math.pow(2, 70) / 5e6 / 3.15576e7, 1e-12, '#71 GPU-years');
  assert(years > 5e6 && years < 1e7, 'expected ~7.5e6 GPU-years, got ' + years);
});

test('swept rows (#161-256) show no prize, no EV', () => {
  const r = Calc.row(byN[200], { btcPrice: 1e5, usdPerGpuHour: 0.4, gpus: 1, ratePerGpu: 1.45e10,
    useFormula: false, herdPerGpu: 4096, dpBits: 15, jumpTable: Math.pow(2, 14) });
  assert(r.cls === 'swept', '#200 swept');
  assert(r.prizeBtc === 0, 'prize must be 0, got ' + r.prizeBtc);
  assert(r.ev === undefined && r.cost === undefined, 'no EV for swept rows');
});

test('every census address is a valid mainnet P2PKH string for mempool links', () => {
  for (const p of CENSUS.puzzles) {
    assert(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(p.address), 'bad address at #' + p.n + ': ' + p.address);
    assert(p.address.length >= 26 && p.address.length <= 35, 'bad length at #' + p.n);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) console.log('FAILURES:\n  - ' + failures.join('\n  - '));
if (typeof process !== 'undefined' && process.exitCode !== undefined) process.exitCode = failed ? 1 : 0;
