"""Run the exported factory projects unchanged in OMC and compare their event records with the web run."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile

from verify import command, digest, require


ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / "public/modelica"
PACKAGE = Path("GouyuanFactory/package.mo")
HEADER = Path("GouyuanFactory/Resources/Include/factory_schedule.h")
PROJECT_FILES = (Path("FactoryRun.mo"), Path("run.mos"), PACKAGE, HEADER)
CASES = ("baseline", "fast-amr", "alternate-cnc", "single-cnc", "reduced-feed-part")
FIELDS = ("station", "carrier", "fromStation", "carrierOrigin", "readyS", "dispatchS",
          "pickupStartS", "loadedStartS", "dropStartS", "serviceStartS", "finishS")
EPS = 1e-8  # seconds; all identifiers are compared exactly
EVENT_RTOL = 1e-9  # CSV event localization for the two sides of a native time event


def check_topology(expected, rows):
    """Verify native reservations, conservation, and each empty/loaded trip from the physical inputs."""
    nr, ns, nj = (expected[k] for k in ("nr", "ns", "nj"))
    jobs, resources, mask = (expected[k] for k in ("jobs", "resources", "mask"))
    require(len(jobs) == 3*nj and len(resources) == 8*nr and len(mask) == nr*ns, "Invalid expected input dimensions")
    resources = [resources[i:i+8] for i in range(0, len(resources), 8)]
    occupied = [[] for _ in range(nr)]
    states = [[] for _ in range(nr)]
    releases, finishes, machining = [], [], []
    operations, transfers = 0, 0

    def xy(identifier):
        return resources[identifier-1][1:3]

    for j in range(nj):
        first, last, ready = jobs[j*3:j*3+3]
        require(1 <= first <= last <= ns and int(first) == first and int(last) == last, "Invalid job route")
        previous = 0
        releases.append(ready)
        for s in range(ns):
            row = rows[j*ns+s]
            if not first <= s+1 <= last:
                require(all(v == 0 for v in row), "A job traversed a stage outside its route")
                continue
            operations += 1
            station, carrier, origin_station, carrier_origin = map(int, row[:4])
            observed_ready, dispatch, pickup, loaded, drop, service, finish = row[4:]
            tag = f"job {j+1} stage {s+1}"
            require(1 <= station <= nr and mask[s*nr+station-1] == 1, tag + ": incorrect workstation")
            require(0 <= carrier <= nr and 0 <= carrier_origin <= nr and origin_station == previous, tag + ": invalid origin")
            require(abs(observed_ready-ready) <= EPS and all(a <= b+EPS for a, b in zip(row[4:], row[5:])),
                    tag + ": invalid event order")
            require(abs(finish-service-resources[station-1][3]) <= EPS and finish > service, tag + ": incorrect service")
            occupied[station-1].append((dispatch, finish, 0, 0))
            if dispatch < service:
                states[station-1].append((dispatch, service, 1))
            states[station-1].append((service, finish, 2))
            if resources[station-1][0] == 2:
                machining.extend([(service, 1), (finish, -1)])
            if carrier:
                transfers += 1
                p = resources[carrier-1]
                require(previous and carrier_origin and mask[s*nr+carrier-1] == 2, tag + ": invalid carrier")
                require(abs(pickup-dispatch-math.dist(xy(carrier_origin), xy(previous))*p[4]) <= EPS,
                        tag + ": incorrect empty travel")
                require(abs(drop-loaded-math.dist(xy(previous), xy(station))*p[5]) <= EPS,
                        tag + ": incorrect loaded travel")
                require(abs(loaded-pickup-p[6]) <= EPS and abs(service-drop-p[7]) <= EPS, tag + ": incorrect handling times")
                occupied[carrier-1].append((dispatch, service, carrier_origin, station))
                states[carrier-1].append((dispatch, service, 2))
            else:
                require(carrier_origin == 0 and abs(dispatch-service) <= EPS and
                        (not previous or xy(previous) == xy(station)), tag + ": unmodelled transport")
            previous, ready = station, finish
        finishes.append(ready)
    for r, intervals in enumerate(occupied):
        free, location = 0, r+1
        for start, stop, origin, destination in sorted(intervals):
            require(start >= free-EPS, f"Resource {r+1} was reserved twice")
            if resources[r][0] == 4:
                require(xy(origin) == xy(location), f"Mobile robot {r+1} changed position while idle")
                location = destination
            free = stop
    active = peak = 0
    for _, change in sorted(machining):  # release before start at a shared timestamp
        active += change
        peak = max(peak, active)
    return releases, finishes, states, {"operations": operations, "transfers": transfers, "peakSimultaneousCnc": peak}


def check_cnc_part(case, mapping, rows, makespan):
    """Compare the exported slot provenance with the observed native CNC-B service interval."""
    if case not in ("baseline", "reduced-feed-part"):
        return {}
    reduced = case == "reduced-feed-part"
    machines = [(i, r) for i, r in enumerate(mapping["resources"], 1) if r["id"] == "cnc-b"]
    require(len(machines) == 1, "Export must identify the selected CNC-B")
    slot, machine = machines[0]
    source = machine["parameterSources"]["feedMmMin"]
    chain = [json.loads(key) for key in source["packagePath"]]
    feed, service_s = (600, 51) if reduced else (900, 36)
    require(machine["slot"] == f"Device{slot}" and machine["model"] == "GouyuanFactory.FeedCNC" and
            source["kind"] == "part" and source["path"] == ["feed", "x"] and source["rating"] == "nominalFeed" and
            source["value"] == feed and source["unit"] == "mm/min", "Incorrect CNC-B feed parameter or slot path")
    require(len(chain) == 3 and source["packagePath"][0] == machine["packageKey"] and
            source["packagePath"][2] == source["packageKey"] and
            chain[0] == ["构元教学件", "CELL-CNC-F900", "2-reduced-feed" if reduced else "2"] and
            len(chain[1]) == 3 and chain[1][:2] == ["构元教学件", "CNC-FEED-900"] and
            bool(chain[1][2]) and ((chain[1][2] != "1") == reduced) and
            chain[2] == ["构元教学件", f"FEED-AXIS-{feed}", "1"], "Incorrect CNC-B part revision chain")
    intervals = [row[-1]-row[-2] for row in rows if row[0] == slot]
    require(intervals and all(abs(t-service_s) <= EPS for t in intervals), "Wrong native service duration on CNC-B")
    require(abs(makespan - (339.299595775 if reduced else 324.499266257)) <= EPS, "Unexpected factory duration")
    return {"verifiedPartParameter": {"resource": "cnc-b", "parameter": "feedMmMin", "serviceS": service_s, **source}}


def compare_case(case, folder, omc, evidence):
    expected = json.loads((folder/"expected.json").read_text(encoding="utf-8"))
    map_file = folder/"factory-map.json"
    require(digest(map_file) == expected["mapSha256"], "Exported Modelica instance map differs")
    mapping = json.loads(map_file.read_text(encoding="utf-8"))
    nr, ns, nj = (expected[k] for k in ("nr", "ns", "nj"))
    require(all(type(n) is int and 0 < n <= high for n, high in zip((nr, ns, nj), (32, 16, 64))),
            "Expected run dimensions exceed the factory ABI")
    wanted = expected["records"]
    require(len(wanted) == nj*ns*len(FIELDS) and all(math.isfinite(x) for x in wanted), "Invalid expected event records")
    require(math.isfinite(expected["makespanS"]) and expected["makespanS"] > 0, "Invalid expected makespan")
    log, native_csv = evidence / f"factory-{case}.log", evidence / f"factory-{case}.csv"
    with tempfile.TemporaryDirectory(prefix="gouyuan-export-") as tmp:
        work = Path(tmp)
        for relative in PROJECT_FILES:
            target = work/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(folder/relative, target)
        require(digest(work/HEADER) == digest(MODEL_ROOT/HEADER), "Exported scheduler header differs")
        require(digest(work/PACKAGE) == digest(MODEL_ROOT/PACKAGE), "Exported Modelica library differs")
        for field, relative in (("sourceSha256", "FactoryRun.mo"), ("modelSha256", PACKAGE), ("schedulerSha256", HEADER)):
            if field in expected:
                require(digest(work/relative) == expected[field], f"Reference source digest differs: {relative}")
        output = command([omc, "run.mos"], work, log, 600)
        require("Error:" not in output and "LOG_ERROR" not in output and (work/"FactoryRun_res.csv").is_file(),
                f"Exported run.mos failed. See {log}\n{output[-1500:]}")
        shutil.copyfile(work/"FactoryRun_res.csv", native_csv)

    observation = {field: 0.0 for field in FIELDS}
    record_keys = [f"trace[{i+1}]" for i in range(len(wanted))]
    state_keys = [f"deviceState[{i+1}]" for i in range(nr)]
    samples = 0
    native_rows = None
    last_time = -math.inf
    max_makespan_error = 0.0
    with native_csv.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        require(len(headers) == len(set(headers)), "Duplicate native CSV columns")
        required = {"time", "status", "completed", "inProcess", "makespan", *record_keys, *state_keys}
        missing = required.difference(headers)
        require(not missing, "Missing native CSV columns: " + ", ".join(sorted(missing)[:10]))
        for raw in reader:
            t, status, complete, wip, span = (float(raw[k]) for k in ("time", "status", "completed", "inProcess", "makespan"))
            require(all(math.isfinite(v) for v in (t, status, complete, wip, span)) and status == 0 and t >= last_time,
                    "Factory execution returned invalid status or time")
            max_makespan_error = max(max_makespan_error, abs(span-expected["makespanS"]))
            require(max_makespan_error <= EPS, "Exported/native makespan differs from the browser")
            values = [float(raw[k]) for k in record_keys]
            require(all(math.isfinite(v) for v in values), "Non-finite native trace")
            if native_rows is None:
                require(abs(t) <= EPS, "Native export did not start at t=0")
                native_rows = [values[i:i+len(FIELDS)] for i in range(0, len(values), len(FIELDS))]
                releases, finishes, resource_states, topology = check_topology(expected, native_rows)
                require(abs(max(finishes)-span) <= EPS, "Makespan does not match the last completed piece")
            for i, (value, reference) in enumerate(zip(values, wanted)):
                slot = i % len(FIELDS)
                field = FIELDS[slot]
                delta = abs(value-reference)
                if delta > observation[field]:
                    observation[field] = delta
                if delta > (0 if slot < 4 else EPS):
                    raise ValueError(f"{field}, job {i//(ns*len(FIELDS))+1}, stage {i//len(FIELDS)%ns+1}, "
                                     f"t={t}: OMC {value}, browser {reference}")
            require(complete.is_integer() and wip.is_integer() and complete >= 0 and wip >= 0, "Invalid part counts")
            # OMC can emit both sides of a scheduled event at the same timestamp.
            event_eps = max(EPS, EVENT_RTOL * abs(t))
            for count, event_times in ((complete, finishes), (complete+wip, releases)):
                require(sum(x < t-event_eps for x in event_times) <= count <= sum(x <= t+event_eps for x in event_times),
                        f"t={t}: native inventory is inconsistent with release/completion")
            for key, windows in zip(state_keys, resource_states):
                possible = {next((state for start, stop, state in windows if start <= when < stop), 0)
                            for when in (t-event_eps, t, t+event_eps)}
                require(float(raw[key]) in possible, f"t={t}: {key} disagrees with the reserved/working intervals")
            samples += 1
            last_time = t
    require(samples >= 2 and abs(last_time) > EPS and last_time+EPS >= expected["makespanS"],
            "Native trace does not cover the entire batch")
    require(complete == nj and wip == 0, "Some parts were lost or unfinished")
    return {
        **check_cnc_part(case, mapping, native_rows, span),
        **topology, "passed": True, "jobs": nj, "stages": ns, "resources": nr, "nativeSamples": samples,
        "recordFieldsChecked": len(wanted), "completed": int(complete), "endingWip": int(wip),
        "makespanS": span, "durationMaxAbsErrorS": max_makespan_error, "maxAbsError": observation,
        "nativeEventSha256": hashlib.sha256(json.dumps(native_rows, separators=(",", ":")).encode()).hexdigest(),
        "sourceSha256": digest(folder/"FactoryRun.mo"), "mosSha256": digest(folder/"run.mos"),
        "expectedSha256": digest(folder/"expected.json"), "mapSha256": digest(map_file), "nativeCsv": native_csv.name, "nativeCsvSha256": digest(native_csv),
        "log": log.name, "logSha256": digest(log)
    }


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--omc", default="omc")
    cli.add_argument("--out", type=Path, required=True, help="Evidence directory containing factory-cases/<case>/")
    args = cli.parse_args()
    compiler = shutil.which(args.omc)
    require(compiler is not None, "OpenModelica 1.27.2 is required")
    evidence = args.out.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    toolchain = subprocess.check_output([compiler, "--version"], text=True).strip()
    report = {"passed": False, "compiler": toolchain, "timeToleranceSeconds": EPS, "csvEventTimeRelativeTolerance": EVENT_RTOL,
              "librarySha256": digest(MODEL_ROOT/PACKAGE), "schedulerSha256": digest(MODEL_ROOT/HEADER),
              "verifierSha256": digest(Path(__file__)), "cases": {}}
    summary = evidence/"factory-comparison.json"
    try:
        require(toolchain == "OpenModelica 1.27.2", f"Unexpected compiler: {toolchain}")
        with tempfile.TemporaryDirectory(prefix="gouyuan-factory-msl-") as tmp:
            work = Path(tmp)
            (work/"version.mos").write_text('loadModel(Modelica, {"4.0.0"}, requireExactVersion=true);\ngetVersion(Modelica);\n')
            output = command([compiler, "version.mos"], work, evidence/"factory-msl-version.log", 60)
            require('true' in output.splitlines() and '"4.0.0"' in output.splitlines(), "Pinned Modelica 4.0.0 unavailable")
            report["msl"] = "4.0.0"
        for case in CASES:
            try:
                result = compare_case(case, evidence/"factory-cases"/case, compiler, evidence)
                print(f"{case}: {result['completed']} completed, {result['makespanS']:.9g} s, "
                      f"{result['recordFieldsChecked']} schedule fields matched")
                report["cases"][case] = result
            except (ValueError, KeyError, TypeError, OSError, RuntimeError, subprocess.SubprocessError) as failure:
                report["cases"][case] = {"passed": False, "error": str(failure)}
        require(all(r["passed"] for r in report["cases"].values()), "Failed cases: " + "; ".join(
            f"{case}: {r['error']}" for case, r in report["cases"].items() if not r["passed"]))
        require(report["cases"]["baseline"]["peakSimultaneousCnc"] >= 2, "Baseline never used two machines concurrently")
        require(report["cases"]["single-cnc"]["peakSimultaneousCnc"] == 1, "Single-CNC variant used multiple machines")
        baseline = report["cases"]["baseline"]["nativeEventSha256"]
        require(all(report["cases"][case]["nativeEventSha256"] != baseline for case in CASES[1:]),
                "One or more substitutions produced an identical native schedule")
        report["maxAbsError"] = {field: max(case["maxAbsError"][field] for case in report["cases"].values()) for field in FIELDS}
        report["totalRecordFields"] = sum(case["recordFieldsChecked"] for case in report["cases"].values())
        report["passed"] = True
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as failure:
        report["error"] = str(failure)
        raise SystemExit(str(failure)) from failure
    finally:
        summary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"PASS: {len(CASES)} exported factory models, part parameter provenance, native inventory and all eleven event fields. {summary}")


if __name__ == "__main__":
    main()
