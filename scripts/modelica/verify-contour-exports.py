"""Run complete contour downloads with native DASSL and compare all controller/feedback observations by time."""
import argparse
from bisect import bisect_left, bisect_right
import csv
from hashlib import sha256
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import BadZipFile, ZipFile

from verify import command, digest, require


ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public/modelica"
CASES = ("pocket", "heavy-rotor", "helical")
AXES = "XYZ"
NATIVE_FILES = ("Gouyuan.mo", "GouyuanMotor.mo", "GouyuanContour.mo", "AssembledMotor.mo", "ContourRun.mo", "reference.txt", "run.mos")
TIME_TOLERANCE = 2e-7  # Event localization of DASSL at exact (non-grid) block boundaries, seconds.
LIMITS = {**{"command"+a: 5e-6 for a in AXES}, **{"commandV"+a: 1e-4 for a in AXES},
          **{"actual"+a: 5e-4 for a in AXES}, **{"actualV"+a: 0.01 for a in AXES},
          **{"error"+a: 5.1e-4 for a in AXES}, "errorMm": 9e-4}
WEB_COLUMNS = {"time": "time_s", "errorMm": "tip_error_mm",
               **{model+axis: f"{axis.lower()}_{metric}" for axis in AXES for model, metric in
                  (("command","command_mm"), ("actual","actual_mm"), ("commandV","command_mm_s"),
                   ("actualV","actual_mm_s"), ("error","error_mm"))}}


def identity(pkg):
    return json.dumps([pkg[name] for name in ("manufacturer", "model", "revision")], ensure_ascii=False, separators=(",", ":"))


def follow(devices, key, path):
    chain, quantity = [key], 1
    for slot in path:
        pkg = devices[chain[-1]]
        if pkg.get("mechanics", {}).get("kind") == "assembly":
            children = pkg["mechanics"]["assembly"]["nodes"]
        else:
            children = pkg["composition"]["parts"]
        child = next(c for c in children if c["id"] == slot)
        chain.append(child["packageKey"])
        quantity *= child.get("quantity", 1)
    return chain, quantity


def verify_install(archive, expected, manifest, registry):
    mapping = json.loads(archive.read("contour-map.json"))
    workspace = json.loads(archive.read("contour.twin.json"))
    require(mapping["kind"] == "cnc-contour-map" and mapping["schemaVersion"] == 1, "Wrong contour-map identity")
    program = archive.read("program.nc")
    require(sha256(program).hexdigest() == mapping["program"]["sha256"] == expected["programSha256"], "G-code digest differs")
    layout = next(item for item in workspace["factories"] if item["id"] == mapping["layoutId"])
    cnc = next(r for r in layout["resources"] if r["id"] == expected["resourceId"])
    require(cnc["id"] == mapping["resourceId"] and cnc["contourRun"]["program"] == program.decode("utf8"), "Wrong installed program")
    records = {identity(pkg): pkg for pkg in workspace["packages"]}
    root = records[cnc["packageKey"]]
    require(mapping["rootKey"] == cnc["packageKey"] and root["contour"] == mapping["profile"], "Wrong machine profile or revision")
    require(root["contour"]["zBalance"] == "counterbalanced" and len(mapping["axes"]) == 3, "Unexpected fixture")
    require(mapping["motorKey"] == expected["motorKey"] and len(set(a["axisId"] for a in mapping["axes"])) == 3, "Wrong motor or duplicate axis")
    paths = set()
    for axis, letter in zip(mapping["axes"], AXES):
        axis_id = root["contour"]["axes"][letter.lower()]
        port = next(p for p in root["axisPorts"] if p["id"] == axis_id)
        require(axis["coordinate"] == letter and axis["axisId"] == axis_id and axis["axisPath"] == port["path"]
                and axis["motorSlot"] == port["motorSlot"], "Wrong " + letter + " mount")
        path = (*port["path"], port["motorSlot"])
        chain, count = follow(records, cnc["packageKey"], path)
        require(path not in paths and count == 1 and chain[-2] == axis["axisKey"] and
                chain[-1] == axis["motorKey"] == mapping["motorKey"], "Axes did not select three distinct single mounts of the same revision")
        paths.add(path)
        require(set(axis["parameters"]) == set(axis["parameterSources"]) == set(manifest["parameters"]), "Wrong axis parameters")
        for field, datum in axis["parameterSources"].items():
            chain, count = follow(records, cnc["packageKey"], datum["path"])
            require(chain == datum["packagePath"] and chain[-1] == datum["packageKey"] and
                    datum["unit"] == registry["assembly"]["parameters"][field]["unit"] and
                    axis["parameters"][field] == datum["value"], "Invalid parameter provenance: " + field)
            if datum["kind"] == "axis":
                require(datum["field"] == f"axisPorts.{axis_id}.{field}" and port[field] == datum["value"], "Wrong fixture: " + field)
            elif datum["kind"] == "part":
                rating = records[chain[-1]]["composition"]["ratings"][datum["field"]]
                require(rating["unit"] == datum["unit"] and rating["value"] == datum["value"], "Wrong installed part rating: " + field)
            else:
                require(datum["kind"] == "slot" and field == "bearingCount" and count == datum["value"], "Incorrect bearing count")
    require(mapping["native"]["solver"] == "dassl" and mapping["native"]["tolerance"] == 1e-8 and
            mapping["wasmSha256"] == manifest["wasmSha256"], "Unexpected native or browser kernel")
    return mapping


def verify_reference(archive, mapping, expected):
    ref = mapping["reference"]
    raw = archive.read("reference.txt")
    require(sha256(raw).hexdigest() == ref["sha256"] and ref["programEndS"] == expected["programEndS"] and
            ref["endS"] == expected["endS"] and ref["initialWorkMm"] == mapping["profile"]["initialWorkMm"], "Wrong reference table or frame")
    table = io.StringIO(raw.decode("ascii"))
    require(table.readline().strip() == "#1" and table.readline().strip() == f"double command({ref['knots']},7)",
            "Invalid Modelica interpolation table header")
    data = [list(map(float, line.split())) for line in table if line.strip()]
    require(len(data) == ref["knots"] and all(len(row) == 7 and all(map(math.isfinite, row)) for row in data), "Invalid reference rows")
    times = [r[0] for r in data]
    require(times[0] == 0 and times[-1] == ref["endS"] and
            all(0 < b-a <= .001 + 2e-12 for a, b in zip(times, times[1:])) and data[0][1:4] == ref["initialWorkMm"],
            "Reference clock or starting WCS position differs")
    require(abs(ref["endS"] - ref["programEndS"] - 1) < 1e-8 and
            all(row[1:4] == ref["segments"][-1]["endMm"] and max(map(abs, row[4:])) < 1e-9 for row in data if row[0] >= ref["programEndS"]),
            "Reference did not hold the last tool point for one second")
    checked = {"G2": 0, "G3": 0}
    for seg in ref["segments"]:
        if seg["mode"] not in checked:
            continue
        left, right = bisect_right(times, seg["startS"]), bisect_left(times, seg["endS"])
        cx, cy = seg["arc"]["centerMm"]
        radius = seg["arc"]["radiusMm"]
        require(right > left, "Missing in-arc observations")
        mid = data[(left+right)//2]
        cross = (mid[1]-cx)*mid[5] - (mid[2]-cy)*mid[4]
        require(cross < 0 if seg["mode"] == "G2" else cross > 0, seg["mode"] + " direction is reversed")
        require(all(abs(math.hypot(row[1]-cx, row[2]-cy)-radius) < 1e-7 for row in data[left:right]), "Arc knots left the declared circle")
        checked[seg["mode"]] += 1
    require(min(checked.values()) > 0, "Both clockwise and counterclockwise arcs must execute")
    return checked


def load_curve(path, fields, aliases=None):
    with path.open(encoding="utf-8-sig", newline="") as csv_input:
        rows = [{k: float(row[aliases[k] if aliases else k]) for k in fields} for row in csv.DictReader(csv_input)]
    require(rows and all(all(map(math.isfinite, row.values())) for row in rows), "Empty or nonfinite curve: " + str(path))
    return rows


def compare(native_file, browser_file, expected, mapping):
    fields = ["time", *LIMITS]
    native, browser = load_curve(native_file, fields), load_curve(browser_file, fields, WEB_COLUMNS)
    times, grid = [row["time"] for row in native], [row["time"] for row in browser]
    require(all(a<=b for a, b in zip(times, times[1:])) and all(a<b for a, b in zip(grid, grid[1:])), "Non-monotonic observation times")
    require(len(grid) == expected["samples"] and grid[0] == 0 and grid[-1] == expected["endS"], "Truncated web observation grid")
    required_times = [i/100 for i in range(math.floor(expected["endS"]*100)+1)]
    required_times += [s["endS"] for s in mapping["reference"]["segments"]] + [expected["endS"]]
    for t in required_times:
        i = bisect_left(grid, t)
        require(min(abs(k-t) for k in grid[max(0,i-1):i+1]) < 1e-8, f"Missing browser observation at {t} s")
    errors = dict.fromkeys(LIMITS, 0.0)
    peak, max_clock, peak_t, native_peak = 0.0, 0.0, 0.0, 0.0
    integrated, prev_time, prev_squared = [0.0, 0.0], 0.0, [0.0, 0.0]
    for web in browser:
        t = web["time"]
        i = bisect_left(times, t)
        near = min(native[max(0,i-1):i+1], key=lambda row: abs(row["time"]-t))
        delta = abs(near["time"]-t)
        require(delta <= TIME_TOLERANCE, f"Native CSV has no exact output or localized event at {t} s")
        max_clock = max(max_clock, delta)
        for field in LIMITS:
            errors[field] = max(errors[field], abs(near[field]-web[field]))
        for index, row in enumerate((web, near)):
            components = [row["actual"+a]-row["command"+a] for a in AXES]
            require(all(abs(diff-row["error"+axis]) < 1e-9 for diff, axis in zip(components, AXES))
                    and abs(math.hypot(*components)-row["errorMm"]) < 1e-9, "Tool following error was not measured in the common WCS frame")
            squared = sum(value*value for value in components)
            integrated[index] += 0.5*(squared + prev_squared[index])*(t-prev_time)
            prev_squared[index] = squared
        prev_time = t
        native_peak = max(native_peak, near["errorMm"])
        if web["errorMm"] > peak:
            peak, peak_t = web["errorMm"], t
    for field, limit in LIMITS.items():
        require(errors[field] <= limit, f"{field}: native/web difference {errors[field]:.9g} exceeds {limit}")
    for axis in AXES:
        require(max(abs(s["actualV"+axis]) for s in browser) > .01 and
                abs(browser[0]["actual"+axis] - mapping["profile"]["initialWorkMm"][AXES.index(axis)]) < 1e-12,
                "An axis never moved or did not start at the declared tool origin")
    require(peak > 1e-3, "Feedback coincides with command throughout the program")
    rms, native_rms = (math.sqrt(value/grid[-1]) for value in integrated)
    require(abs(rms-expected["rmsErrorMm"]) < 1e-10 and abs(peak-expected["maxErrorMm"]) < 1e-10 and
            abs(native_rms-rms) <= LIMITS["errorMm"] and abs(native_peak-peak) <= LIMITS["errorMm"],
            "Displayed following-error statistics do not match the measured native/browser samples")
    return {"nativeRows": len(native), "matchedTimes": len(browser), "peakFollowingErrorMm": peak, "peakTimeS": peak_t,
            "rmsFollowingErrorMm": rms, "nativeRmsFollowingErrorMm": native_rms, "nativePeakFollowingErrorMm": native_peak,
            "maxClockDifferenceS": max_clock, "maxAbsError": errors, "lastFeedbackMm": [browser[-1]["actual"+a] for a in AXES]}


def verify_case(omc, out, name, manifest, registry):
    path = out/"contour-exports"/name
    exported, browser_csv, native_csv = path/"contour.zip", path/"browser.csv", path/"native.csv"
    expected = json.loads((path/"expected.json").read_text(encoding="utf8"))
    require(expected["kind"] == name and "Chrome/" in expected["browser"] and expected["archiveSha256"] == digest(exported)
            and expected["csvSha256"] == digest(browser_csv) and expected["wasmSha256"] == manifest["wasmSha256"],
            "Wrong archive, browser samples or released WASM")
    with ZipFile(exported) as archive, tempfile.TemporaryDirectory(prefix="gouyuan-contour-native-") as temp:
        work = Path(temp)
        mapping = verify_install(archive, expected, manifest, registry)
        arcs = verify_reference(archive, mapping, expected)
        for filename in NATIVE_FILES:
            (work/filename).write_bytes(archive.read(filename))
        for filename, check in {registry["source"]: manifest["sourceSha256"], **manifest["dependencySha256"]}.items():
            require(digest(work/filename) == check == mapping["sourceSha256"][filename] == digest(MODELS/filename), filename + ": source mismatch")
        log = command([omc, "run.mos"], work, path/"omc.log", 360)
        require("The simulation finished successfully" in log and "Error:" not in log, "Native contour simulation failed")
        shutil.copyfile(work/"ContourRun_res.csv", native_csv)
    stats = compare(native_csv, browser_csv, expected, mapping)
    return {**stats, "passed": True, "browser": expected["browser"], "programEndS": expected["programEndS"], "endS": expected["endS"],
            "referenceKnots": mapping["reference"]["knots"], "arcs": arcs, "motorKey": mapping["motorKey"],
            "programSha256": expected["programSha256"], "referenceSha256": mapping["reference"]["sha256"],
            "archiveSha256": digest(exported), "browserCsvSha256": digest(browser_csv), "nativeCsvSha256": digest(native_csv)}


def check_rotor_substitution(folder):
    names = ("pocket", "heavy-rotor")
    params = []
    for name in names:
        with ZipFile(folder/name/"contour.zip") as archive:
            params.append([a["parameters"] for a in json.loads(archive.read("contour-map.json"))["axes"]])
    for standard, heavy in zip(*params):
        require({k for k in standard if standard[k] != heavy[k]} == {"rotorInertiaKgM2"} and
                heavy["rotorInertiaKgM2"] > standard["rotorInertiaKgM2"], "Substitution must change only the mounted rotor inertia")
    fields = ["time", *["actual"+a for a in AXES], *["actualV"+a for a in AXES]]
    a, b = (load_curve(folder/name/"browser.csv", fields, WEB_COLUMNS) for name in names)
    require(len(a) == len(b) and all(s["time"] == h["time"] for s, h in zip(a,b)), "Substitution changed observation times")
    def peak(prefix):
        return max(abs(h[prefix+axis]-s[prefix+axis]) for s,h in zip(a,b) for axis in AXES)
    position, velocity = peak("actual"), peak("actualV")
    require(position > .001 and velocity > .01, "Changing only the installed rotor did not affect contour following")
    return {"rotorInertiaKgM2": [p[0]["rotorInertiaKgM2"] for p in params],
            "maxPositionChangeMm": position, "maxVelocityChangeMmS": velocity}


def check_negative_control(folder):
    # A coherent +0.1 mm bias in one feedback channel must fail the independent comparison.
    with ZipFile(folder/"contour.zip") as archive:
        mapping = json.loads(archive.read("contour-map.json"))
    expected = json.loads((folder/"expected.json").read_text(encoding="utf8"))
    with (folder/"native.csv").open(newline="",encoding="utf8") as stream:
        reader = csv.DictReader(stream)
        rows, header = list(reader), reader.fieldnames
    row = next(r for r in rows if abs(float(r["time"])-.1) < 1e-9)
    row["actualX"] = str(float(row["actualX"])+.1)
    row["errorX"] = str(float(row["actualX"])-float(row["commandX"]))
    row["errorMm"] = str(math.hypot(*(float(row["error"+axis]) for axis in AXES)))
    with tempfile.TemporaryDirectory(prefix="gouyuan-contour-negative-") as temp:
        altered = Path(temp)/"native.csv"
        with altered.open("w",newline="",encoding="utf8") as stream:
            writer = csv.DictWriter(stream, fieldnames=header)
            writer.writeheader()
            writer.writerows(rows)
        try:
            compare(altered, folder/"browser.csv", expected, mapping)
        except ValueError as error:
            require(str(error).startswith("actualX: native/web difference"), "Unexpected negative-control failure: "+str(error))
            return str(error)
    raise ValueError("An injected 0.1 mm feedback bias was not detected")


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--omc", default="omc")
    cli.add_argument("--out", type=Path, required=True)
    args = cli.parse_args()
    out = args.out.resolve()
    manifest = json.loads((MODELS/"runtime/contour-axis.json").read_text(encoding="utf8"))
    registry = json.loads((MODELS/"contour-library.json").read_text(encoding="utf8"))
    report = {"passed": False, "compiler": manifest["compiler"], "msl": manifest["msl"], "solver": "DASSL",
              "sourceSha256": manifest["sourceSha256"], "wasmSha256": manifest["wasmSha256"], "verifierSha256": digest(Path(__file__)),
              "timeToleranceS": TIME_TOLERANCE, "limits": LIMITS, "cases": {}}
    try:
        omc = shutil.which(args.omc)
        require(omc and subprocess.check_output([omc,"--version"],text=True).strip() == manifest["compiler"], "Unexpected native compiler")
        for name in CASES:
            stats = verify_case(omc, out, name, manifest, registry)
            report["cases"][name] = stats
            print(f"{name}: {stats['matchedTimes']} native/browser times, peak following error {stats['peakFollowingErrorMm']:.6g} mm")
        basic, alternative = (report["cases"][n] for n in ("pocket","heavy-rotor"))
        require(basic["motorKey"] != alternative["motorKey"] and basic["referenceSha256"] == alternative["referenceSha256"],
                "Rotor substitution needs identical references and distinct installed motor revisions")
        report["rotorSubstitution"] = check_rotor_substitution(out/"contour-exports")
        report["negativeControl"] = check_negative_control(out/"contour-exports"/"pocket")
        require(report["cases"]["helical"]["programSha256"] != basic["programSha256"], "Helical test did not use a distinct program")
        report["maxAbsError"] = {k:max(c["maxAbsError"][k] for c in report["cases"].values()) for k in LIMITS}
        report["passed"] = True
    except (ValueError, RuntimeError, OSError, KeyError, StopIteration, BadZipFile, subprocess.SubprocessError) as error:
        report["error"] = str(error)
        raise SystemExit(str(error)) from error
    finally:
        (out/"contour-export-comparison.json").write_text(json.dumps(report,indent=2,ensure_ascii=False,allow_nan=False)+"\n",encoding="utf8")


if __name__ == "__main__":
    main()
