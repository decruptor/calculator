# Decruptor — "which puzzle can you afford?"

A static, offline, zero-dependency calculator for the Bitcoin 256-puzzle races.
It answers the one question every newcomer actually asks — *can I afford to run
this?* — with the census's prize table and the Decruptor paper's cost constants,
for every puzzle at once, at whatever fleet size and dollar assumptions you have.

No frameworks, no CDN, no trackers, no network calls. Open `index.html` from
disk (`file://`) and it works.

## What it gives you

- **All 256 puzzles**, classified live from the census snapshot:
  - **kangaroo-able** (pubkey revealed on-chain): expected ops `K·2^(n/2)`,
    total GPU-hours (fleet-invariant — that is what you pay for), dollar cost,
    expected wall-clock time for your fleet, and a **solo EV line** —
    `0.544·prize − cost` (a kangaroo run's work-to-solution is birthday-shaped,
    close to a Rayleigh law — in the paper's SOTA runs the median is 0.93–0.95×
    the mean — so committing the mean budget succeeds with probability
    `1 − e^(−π/4)`; cost is the full mean budget, so the line is conservative).
    Fleet size divides the wall time, never the total GPU-hours: a 4096× fleet
    solves #140 in ~0.72 y instead of ~3000 y, and pays the same $10.4M at
    $0.40/GPU-h.
  - **unreachable** (pubkey never revealed — #71–#159 except the multiples of 5): marked
    with the reason. Interval ECDLP is *structurally impossible* without a
    pubkey, and there is no meet-in-the-middle on hash160 either (no group
    structure): the only known attack is plain enumeration at `2^(n-1)`
    expected hash160s — ~7.5M GPU-years for #71 alone, doubling every puzzle
    number. The tool shows those numbers so you don't have to take anyone's
    word for it.
  - **claimed** (prize paid) and **swept** (#161–256, swept by the creator in
    July 2017 — no prize left), kept for completeness with reference math.
- **Editable assumptions**: BTC price, $/GPU-hour, ops/s per GPU (default
  1.45e10, the 4090 figure RCKangaroo's README quotes for its turbo kernels),
  fleet presets from 1 to 4096 GPUs or custom.
- **Advanced panel**: K from RC's DP-overhead formula instead of the bare
  1.15 constant — plug in your herd size (kangaroos per GPU × GPUs), DP bits
  and jump table:

  ```
  K        = 1.15 + (0.07 + 0.76/√DPK) / (1 + 0.30·DPK)
  DPK      = 1.15·√W / (h·2^d)
  ```

  with the validity domain (DPK ∈ [0.025, 74] at h = 512 for r = 31–40, and at
  r = 47 only for h ≥ 2048 — a fit around (r, h) = (40, 512)) and the caveat
  that it degrades outside it (+79% at n = 48, h = 512, dp 20, even though
  DPK = 0.025 there: the DPK range is necessary, not sufficient).
- **Spacing/band geometry** (the "why fleets matter" column):
  the SOTA walk is a deterministic map, so each walk eventually cycles and its
  displacement freezes in a cycle-entry band `B = c·√W`, with c measured at
  897 / 1648 / 2114 for W = 2^31 / 2^39 / 2^47 (M = 2^14) and 119 / 367 / 897
  for M = 2^6 / 2^9 / 2^14 (W = 2^31). There is no clean power law in M, so the
  tool interpolates between measured rows only and shows **n/m** (not
  measured) everywhere else — including every live puzzle (#140+). A herd of
  `h` kangaroos tiles the interval at wild spacing `1.0625·W/(2h/3)`; the
  paper's rule of thumb is `spacing/band ≲ 1`, i.e.

  ```
  h ≳ 3·1.0625·W/(2·B)
  ```

  Under-tiled herds pay +7–14% K (measured); over-tiled herds waste hardware
  (−9…−22%). With the current census every kangaroo-able row is #140+, so `s/b` reads
  n/m on every row; the ratio, minimum herd and under-tiling flag appear only
  for (n, M) inside the measured table (see `Calc.spacingBandRatio` in the tests).
- **Verify on-chain**: every row links to the puzzle address on
  mempool.space. The prize data is a *snapshot*; the chain is the referee.
  Check the UTXO before you spend a single GPU-hour.

## Assumptions (all visible in the UI, all editable)

| Constant | Value | Source |
|---|---|---|
| Kangaroo constant K | 1.15 (or RC DP-overhead formula) | paper §5.1/§5.3 (SOTA family, RCKangaroo); paper + data: https://github.com/decruptor/kangaroo-constants (ePrint number pending) |
| Expected ops | `1.15·2^(n/2)` | census tasking spec |
| Interval width W | `2^n` | census convention (full n-bit range). The community's `2^(n-1)` convention would be √2 ≈ 1.41× cheaper; this tool is deliberately the conservative one. |
| GPU rate | 1.45e10 group ops/s per 4090-class GPU | RCKangaroo README ("about 14.5GH/s for 4090", turbo kernels) — RCKangaroo's own published figure, not our measurement; lower it for other solvers |
| hash160 rate | 5e6/s per GPU (brute-force fallback rows) | census method note |
| EV success factor | `1 − e^(−π/4) ≈ 54.4%` at the mean budget | Rayleigh (birthday) run-time law; paper's per-trial K: median/mean 0.933, sd/mean 0.544 (Rayleigh 0.939 / 0.523; exponential would be 0.693 / 1.0) |
| BTC price | 100,000 USD default | **user assumption — edit it** |
| $/GPU-hour | 0.40 USD default | **user assumption — edit it** (cloud 4090 ballpark; a self-owned rig on cheap power is a fraction of that) |
| Kangaroos per GPU | 4096 default | solver-dependent (RCKangaroo/JLP class); edit to your solver's config |

The census snapshot is stamped in `data.js` (date, tip height, funding tx,
method notes). Regenerate it against a newer census with
`python3 build_data.py <census.json>`.

## Cross-checks

`node tests.js` (or open `tests.html`) runs 25 unit checks, including exact
comparison against the census's own published estimates:

| Puzzle | Status | Quantity | Calculator | Census | Match |
|---|---|---|---|---|---|
| #1 | claimed 2023-04 | ops `1.15·2^0.5` | 1.6263 | (spec `1.15·2^(n/2)`) | ✓ |
| #66 | claimed 2024-09 | ops `1.15·2^33` | 9.8784e9 | (spec) | ✓ |
| #135 | claimed 2026-07-28 | ops `1.15·2^67.5` | 2.40006e20 | (spec) | ✓ |
| #140 | unsolved, 14.00002240 BTC | ops | 1.357680363825023e21 | 1.357680363825023e21 | exact |
| #140 | | total GPU-h | 26009202.372126877 | 26009202.372126877 | exact |
| #160 | unsolved, 16.00123082 BTC | ops | 1.3902646925568234e24 | 1.3902646925568234e24 | exact |
| #160 | | total GPU-h | 26633423229.057922 | 26633423229.057922 | exact |

Geometry checks reproduce the paper's published values: RC formula
`DPK = 3.253 → K = 1.3987` (§5.3 table), `DPK = 73.60 → K = 1.1569`
(calibration point), wild spacing `2^22.7` and spacing/band ≈ 0.16 at
(r = 31, h = 512), spacing/band ≈ 17.5 at (r = 47, h = 512) (paper: ≈ 18), and the
under-tiled case (r = 31, h = 64) is flagged with spacing/band ≈ 1.3 — the
configuration the paper measured at +13.9% K.

## Census-data issues found while building this

1. **#135 is solved** (claimed 2026-07-28) — any older list still calling
   #135 "unsolved / 13.5 BTC" is stale. The live kangaroo-able frontier is now
   exactly #140, #145, #150, #155, #160 (75.00139122 BTC total).
2. **#161–256 hold no prizes** — the creator swept all 96 on 2017-07-11 in
   one transaction (5d45587c…), the same transaction that topped up #1 and
   #53–160 by 9× their 2015 amounts (to n × 0.01 BTC; ~83.5 BTC of new funds
   on top of the 20.0 BTC swept). A second top-up on 2023-04-16 (12f34b58…,
   872.2 BTC of new funds) added n × 0.09 BTC to #1 and every puzzle still
   unsolved, so live prizes are nominally n × 0.1 BTC. Any EV
   table that prices #161+ as live puzzles is wrong; the calculator marks
   them "no prize".
3. **Prize ≠ n × 0.1 BTC exactly** on live rows — received dust makes
   #140 worth 14.00002240 BTC, #160 worth 16.00123082 BTC, etc. The tool uses
   the census's satoshi-exact values, not the nominal ones.
4. **Only 5 unsolved puzzles have known pubkeys.** 72 unsolved rows are
   structurally unreachable (no pubkey). A puzzle's status flips on a single
   creator spend — which is why every row links to the chain.

## Files

- `index.html` — the tool (open it, that's the whole runtime)
- `app.js` — pure math (`Calc`, reusable) + UI
- `data.js` — generated census snapshot (do not edit by hand)
- `build_data.py` — regenerates `data.js` from a census JSON
- `tests.js`, `tests.html` — unit checks (`node tests.js` or open the HTML)

## Running the tests

```
node tests.js        # 25 checks, exits non-zero on failure
open tests.html      # same checks in the browser
```

## License

GPL-3.0. Part of the **Decruptor** toolchain. The walk constants and their validity
domains come from the Decruptor paper on Pollard-kangaroo walk constants for
interval ECDLP on secp256k1 (https://github.com/decruptor/kangaroo-constants;
ePrint number pending) — the constants are K = 1.15 SOTA, the RC DP-overhead
formula, the §3.2 cycle-entry band and the §7.3 spacing/band rule. The EV
factor is this tool's Rayleigh fit to the paper's run data.
