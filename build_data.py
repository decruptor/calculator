#!/usr/bin/env python3
"""Regenerate data.js from the census snapshot.

Usage:  python3 build_data.py [path/to/census.json]

Emits a compact data.js (no spend histories — those are hundreds of KB and the
calculator only needs the prize/state fields). Census provenance (date, tip,
method notes) is stamped into the file so the table can never be silently
confused with a different snapshot.
"""
import json
import sys
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_SRC = HERE.parent / "census-2026-10" / "census.json"

KEEP = ("n", "address", "prize_btc", "prize_sats", "solved", "status",
        "pubkey_known", "work_type", "claimed_at", "pubkey_source",
        "kangaroo_ops", "gpu_hours_kangaroo")


def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    census = json.loads(src.read_text())
    rows = []
    for p in census["puzzles"]:
        row = {}
        for k in KEEP:
            v = p.get(k)
            if v is not None:
                row[k] = v
        # prize_btc: census gives 0.0 for rows with no live prize; keep as-is.
        rows.append(row)

    method = census["method"]
    lines = []
    lines.append("// GENERATED FILE — do not edit by hand.")
    lines.append("// Source: %s (Bitcoin puzzle census)" % src.name)
    lines.append("// Regenerate with: python3 build_data.py <census.json>")
    lines.append("// Every puzzle row is independently verifiable on-chain via the")
    lines.append("// mempool.space address links the calculator renders.")
    lines.append("const CENSUS = {")
    lines.append("  asOfUtc: %s," % js_str(census["as_of"]["utc"]))
    lines.append("  tipHeight: %d," % census["as_of"]["tip_height"])
    lines.append("  fundingTx: %s," % js_str(census["funding_tx"]["txid"]))
    lines.append("  fundingBlock: %d," % census["funding_tx"]["block_height"])
    lines.append("  fundingTime: %d," % census["funding_tx"]["block_time"])
    lines.append("  method: {")
    lines.append("    solved: %s," % js_str(method["solved"]))
    lines.append("    pubkeyKnown: %s," % js_str(method["pubkey_known"]))
    lines.append("    kangarooOps: %s," % js_str(method["kangaroo_ops"]))
    lines.append("    gpuRate: %s," % js_str(method["gpu_rate"]))
    lines.append("    hash160Rate: %s," % js_str(method["hash160_rate"]))
    lines.append("  },")
    lines.append("  puzzles: [")
    for r in rows:
        fields = []
        for k, v in r.items():
            if isinstance(v, str):
                fields.append("%s:%s" % (k, js_str(v)))
            elif isinstance(v, bool):
                fields.append("%s:%s" % (k, "true" if v else "false"))
            elif v is None:
                fields.append("%s:null" % k)
            else:
                fields.append("%s:%s" % (k, repr(v)))
        lines.append("   {%s}," % ",".join(fields))
    lines.append("  ]")
    lines.append("};")
    lines.append("if (typeof window !== 'undefined') window.CENSUS = CENSUS;")
    lines.append("if (typeof module !== 'undefined' && module.exports) module.exports = CENSUS;")
    lines.append("")
    out = HERE / "data.js"
    out.write_text("\n".join(lines))
    size = out.stat().st_size
    print("wrote %s (%d bytes, %d puzzles)" % (out, size, len(rows)))


if __name__ == "__main__":
    main()
