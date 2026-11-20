"""Compile exported closed-loop system archives in OpenModelica 1.27.2 and compare against WASM RuntimeTrace."""
import argparse
import csv
import json
from pathlib import Path
import shutil
import tempfile
from zipfile import ZipFile

from verify import command, digest, require


MODELS = Path(__file__).resolve().parents[2] / "public/modelica"
POS_TOL_MM = 0.02
VEL_TOL_MMS = 0.5


def verify_case(case_dir: Path, omc: str, out_root: Path):
    expected = json.loads((case_dir / "expected.json").read_text(encoding="utf-8"))
    archive_path = case_dir / "experiment.zip"
    browser_rows = list(csv.DictReader((case_dir / "browser.csv").open(encoding="utf-8")))
    case_id = expected["case"]

    with tempfile.TemporaryDirectory(prefix=f"gouyuan-cl-{case_id}-") as tmp:
        work = Path(tmp)
        with ZipFile(archive_path) as zf:
            sys_map = json.loads(zf.read("system-map.json"))
            for rel, sha in sys_map["sourceSha256"].items():
                require(digest(MODELS / rel) == sha, f"{case_id}: digest mismatch on {rel}")
            for member in ("Gouyuan.mo", "GouyuanFeedTracking.mo", "ClosedLoopSystemRun.mo", "run.mos"):
                (work / member).write_bytes(zf.read(member))

        run_dir = out_root / case_id
        run_dir.mkdir(parents=True, exist_ok=True)
        command([omc, "run.mos"], work, run_dir / "omc.log", timeout=120)
        res_csv = work / "ClosedLoopSystemRun_res.csv"
        require(res_csv.exists(), f"{case_id}: ClosedLoopSystemRun_res.csv was not generated")
        shutil.copyfile(res_csv, run_dir / "native.csv")
        native_rows = list(csv.DictReader(res_csv.open(encoding="utf-8")))

    # Index native rows by rounded millisecond timestamp (may include event duplicates at sample times)
    native_by_ms = {}
    for row in native_rows:
        ms = round(float(row["time"]) * 1000.0)
        if abs(float(row["time"]) * 1000.0 - ms) <= 1e-4:
            native_by_ms[ms] = row  # last sample at tick t carries post-when discrete state

    max_pos_diff = 0.0
    max_vel_diff = 0.0
    max_stop_diff = 0
    for b_row in browser_rows:
        ms = int(b_row["timeMs"])
        require(ms in native_by_ms, f"{case_id}: missing native sample at {ms} ms")
        n_row = native_by_ms[ms]
        for idx, summary in enumerate(expected["axisSummaries"]):
            aid = summary["axisId"]
            pos_diff = abs(float(n_row[f"posMm_{idx}"]) - float(b_row[f"{aid}_posMm"]))
            vel_diff = abs(float(n_row[f"velMmS_{idx}"]) - float(b_row[f"{aid}_velMmS"]))
            stop_diff = abs(int(round(float(n_row[f"stopOut_{idx}"]))) - int(b_row[f"{aid}_stopLatched"]))
            max_pos_diff = max(max_pos_diff, pos_diff)
            max_vel_diff = max(max_vel_diff, vel_diff)
            max_stop_diff = max(max_stop_diff, stop_diff)

    require(max_pos_diff <= POS_TOL_MM, f"{case_id}: max pos diff {max_pos_diff:.5f} mm > {POS_TOL_MM} mm")
    require(max_vel_diff <= VEL_TOL_MMS, f"{case_id}: max vel diff {max_vel_diff:.4f} mm/s > {VEL_TOL_MMS} mm/s")
    require(max_stop_diff == 0, f"{case_id}: discrete stopOut differed from browser stopLatched")
    print(f"{case_id}: max_pos_diff={max_pos_diff:.6f} mm, max_vel_diff={max_vel_diff:.4f} mm/s, exact discrete lockstep={len(browser_rows)} ticks")
    return {
        "case": case_id,
        "ticks": len(browser_rows),
        "maxPosDiffMm": max_pos_diff,
        "maxVelDiffMmS": max_vel_diff,
        "stopTicksMatched": max_stop_diff == 0,
        "axisSummaries": expected["axisSummaries"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omc", default="omc", help="path to OpenModelica compiler")
    parser.add_argument("--out", required=True, help="verification working directory")
    args = parser.parse_args()
    omc = shutil.which(args.omc) or args.omc
    out_root = Path(args.out).resolve() / "closed-loop"
    results = {}
    for cid in ("baseline-10ms", "fast-filter-2ms", "dual-axis-gantry-reverse"):
        results[cid] = verify_case(out_root / cid, omc, out_root)

    base = results["baseline-10ms"]["axisSummaries"][0]
    fast = results["fast-filter-2ms"]["axisSummaries"][0]
    require(fast["stopTriggeredAtMs"] < base["stopTriggeredAtMs"],
            f"Expected 2ms filter stop earlier than 10ms filter: {fast['stopTriggeredAtMs']} vs {base['stopTriggeredAtMs']}")
    require(fast["finalPositionMm"] < base["finalPositionMm"],
            f"Expected 2ms filter smaller finalPositionMm: {fast['finalPositionMm']} vs {base['finalPositionMm']}")
    (Path(args.out).resolve() / "closed-loop-comparison.json").write_text(
        json.dumps(results, indent=2) + "\n", encoding="utf-8",
    )


if __name__ == "__main__":
    main()
