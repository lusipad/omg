"""Compile real workbench motor-axis downloads, verify installed part provenance and compare their native curves."""
import argparse
import csv
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import BadZipFile, ZipFile

from verify import command, digest, require


MODELS = Path(__file__).resolve().parents[2] / "public/modelica"
NATIVE_FILES = ("Gouyuan.mo", "GouyuanMotor.mo", "AssembledMotor.mo", "MotorAxisRun.mo", "run.mos")
VARIANTS = {"standard": None, "high-inductance": "qInductanceH", "high-inertia": "rotorInertiaKgM2",
            "high-damping": "bearingViscousNmS", "reverse": "targetMm"}
LIMITS = {"positionMm": 0.0005, "velocityMmS": 0.01, "angleDeg": 0.005, "speedRpm": 0.02,
          "currentA": 0.0002, "motorTorqueNm": 0.00002}


def key(pkg):
    return json.dumps([pkg[name] for name in ("manufacturer", "model", "revision")], ensure_ascii=False, separators=(",", ":"))


def follow(devices, root_key, path):
    chain, count = [root_key], 1
    for slot_id in path:
        slot = next(item for item in devices[chain[-1]]["composition"]["parts"] if item["id"] == slot_id)
        chain.append(slot["packageKey"])
        count *= slot["quantity"]
    return chain, count


def verify_install(archive, expected, registry):
    mapping = json.loads(archive.read("motor-map.json"))
    workspace = json.loads(archive.read("installed.twin.json"))
    library = json.loads(archive.read("motor.library.json"))
    require(mapping["kind"] == "motor-axis-map" and mapping["schemaVersion"] == 1, "Wrong installed-axis marker")
    layout = next(f for f in workspace["factories"] if f["id"] == mapping["layoutId"])
    installed = {key(pkg): pkg for pkg in workspace["packages"]}
    resource = next(r for r in layout["resources"] if r["id"] == expected["resourceId"])
    root_key = resource["packageKey"]
    port = next(p for p in installed[root_key]["axisPorts"] if p["id"] == expected["axisId"])
    require(mapping["resourceId"] == resource["id"] and mapping["rootKey"] == root_key
            and mapping["axisId"] == port["id"] and mapping["axisPath"] == port["path"]
            and mapping["motorSlot"] == port["motorSlot"], "Exported mount disagrees with the installed CNC")
    motor_path = [*port["path"], port["motorSlot"]]
    trail, copies = follow(installed, root_key, motor_path)
    motor_key = trail[-1]
    require(copies == 1 and trail[-2] == mapping["axisKey"] and motor_key == mapping["motor"]["packageKey"]
            == expected["motorKey"], "The motor in the exported axis is not the selected motor")
    declaration = installed[motor_key]["motorPhysics"]
    require(declaration["modelRef"] == mapping["motor"]["modelRef"] and declaration["fit"] == port["fit"], "Wrong motor model or fit")
    require(library["kind"] == "device-library" and library["schemaVersion"] == 1, "Invalid portable motor package")
    closure = set()
    pending = [motor_key]
    while pending:
        selected = pending.pop()
        if selected not in closure:
            closure.add(selected)
            pending.extend(p["packageKey"] for p in installed[selected]["composition"].get("parts", []))
    require({key(p): p for p in library["packages"]} == {k: installed[k] for k in closure},
            "Portable motor package does not cover its installed revisions exactly")
    calibrated = {}
    for role, part in mapping["parts"].items():
        path = declaration[role + "Path"]
        chain, quantity = follow(installed, motor_key, path)
        part_key = chain[-1]
        require(part_key == expected["selection"][role+"Key"] == part["packageKey"]
                and quantity == (2 if role == "bearing" else 1), f"Incorrect installed {role}")
        calibration = installed[part_key]
        require(calibration["motorPhysics"]["kind"] == role and calibration["motorPhysics"]["modelRef"] == part["modelRef"],
                f"Wrong {role} calibration model")
        calibrated[role] = part_key

    values, sources = mapping["parameters"], mapping["parameterSources"]
    require(set(values) == set(sources) == set(registry["assembly"]["parameters"]), "Incomplete parameter map")
    for name, value in values.items():
        origin = sources[name]
        chain, count = follow(installed, root_key, origin["path"])
        require(chain == origin["packagePath"] and chain[-1] == origin["packageKey"], name + ": installed revision chain differs")
        require(value == origin["value"] and origin["unit"] == registry["assembly"]["parameters"][name]["unit"],
                name + ": invalid unit or parameter")
        if name == "targetMm":
            require(origin["kind"] == "command" and resource["axisTargetsMm"][port["id"]] == value == expected["targetMm"],
                    "Incorrect saved target")
        elif name in port:
            require(origin["kind"] == "axis" and chain == [root_key] and port[name] == value, name + ": incorrect axis fixture")
        elif name == "bearingCount":
            require(origin["kind"] == "slot" and chain[-1] == calibrated["bearing"] and value == count,
                    "Incorrect installed bearing multiplicity")
        else:
            require(origin["kind"] == "part" and origin["field"] == name and chain[-1] in calibrated.values(),
                    name + ": missing part provenance")
            rating = installed[chain[-1]]["composition"]["ratings"][name]
            require(rating["value"] == value and rating["unit"] == origin["unit"], name + ": calibrated rating differs")
    return mapping


def compare_native(native_file, browser_file, expected, values):
    with browser_file.open(encoding="utf-8", newline="") as stream:
        browser = {int(row["timeMs"]): {k: float(row[k]) for k in LIMITS} for row in csv.DictReader(stream)}
    last_ms = max(browser)
    require(len(browser) == expected["samples"] and list(browser) == sorted({*range(0, last_ms+1, 10), last_ms}),
            "Browser samples are not the workbench 10 ms grid plus the stopping point")
    max_error = dict.fromkeys(LIMITS, 0.0)
    native_end = stable_start = None
    target_deg = values["targetMm"] / values["leadMmPerRev"] * 360
    count, at_100 = 0, {}
    with native_file.open(encoding="utf-8", newline="") as stream:
        for i, row in enumerate(csv.DictReader(stream)):
            require(abs(float(row["time"]) * 1000-i) < 1e-7, "Native output is missing a millisecond")
            sample = {k: float(row[k]) for k in LIMITS}
            require(all(math.isfinite(v) for v in sample.values()), f"Non-finite native output at {i} ms")
            if abs(sample["angleDeg"] - target_deg) <= 0.1 and abs(sample["speedRpm"]) <= 0.5:
                if stable_start is None:
                    stable_start = i
                if native_end is None and i - stable_start >= 50:
                    native_end = i
            else:
                stable_start = None
            if i in browser:
                for field, limit in LIMITS.items():
                    error = abs(sample[field] - browser[i][field])
                    require(math.isfinite(error) and error <= limit, f"{field} at {i} ms differs by {error}")
                    max_error[field] = max(max_error[field], error)
            if i == 100:
                at_100 = sample
            count += 1
    require(count == 8001 and last_ms <= count-1, "Native output did not cover the browser trace")
    require(expected["settled"] and native_end is not None and abs(native_end - last_ms) <= 1, "Settling time differs")
    return {"nativeSamples": count, "browserSamples": len(browser), "stopMs": last_ms, "nativeStopMs": native_end,
            "at100ms": at_100, "maxAbsError": max_error}


def verify_case(omc, out, case, registry, runtime):
    folder = out / "motor-assemblies" / case
    archive_path, browser_file = folder / "experiment.zip", folder / "browser.csv"
    expected = json.loads((folder / "expected.json").read_text(encoding="utf-8"))
    require(expected["case"] == case and expected["archiveSha256"] == digest(archive_path)
            and expected["browserCsvSha256"] == digest(browser_file) and expected["wasmSha256"] == runtime["wasmSha256"],
            "Browser evidence does not match the archive, samples or released kernel")
    with ZipFile(archive_path) as archive, tempfile.TemporaryDirectory(prefix="gouyuan-motor-export-") as tmp:
        work = Path(tmp)
        mapping = verify_install(archive, expected, registry)
        for filename in NATIVE_FILES:
            (work / filename).write_bytes(archive.read(filename))
        for name, hash_value in {"GouyuanMotor.mo": runtime["sourceSha256"], **runtime["dependencySha256"]}.items():
            require(digest(work/name) == hash_value == digest(MODELS/name) == mapping["sourceSha256"][name],
                    name + ": native source differs from the browser model")
        log = command([omc, "run.mos"], work, folder / "omc.log", 300)
        require("The simulation finished successfully" in log and "Error:" not in log, "Exported native simulation failed")
        csv_file = folder / "native.csv"
        shutil.copyfile(work / "MotorAxisRun_res.csv", csv_file)
    stats = compare_native(csv_file, browser_file, expected, mapping["parameters"])
    return {**stats, "passed": True, "motorKey": mapping["motor"]["packageKey"], "selected": expected["selection"],
            "archiveSha256": digest(archive_path), "browserCsvSha256": digest(browser_file), "nativeCsvSha256": digest(csv_file)}, mapping["parameters"]


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--omc", default="omc")
    cli.add_argument("--out", required=True, type=Path)
    args = cli.parse_args()
    out = args.out.resolve()
    runtime = json.loads((MODELS/"runtime/motor-axis.json").read_text(encoding="utf-8"))
    registry = json.loads((MODELS/"motor-library.json").read_text(encoding="utf-8"))
    omc = shutil.which(args.omc)
    report = {"passed": False, "compiler": runtime["compiler"], "msl": runtime["msl"], "nativeSolver": "DASSL",
              "sourceSha256": runtime["sourceSha256"], "wasmSha256": runtime["wasmSha256"],
              "verifierSha256": digest(Path(__file__)), "limits": LIMITS, "cases": {}}
    try:
        require(omc and subprocess.check_output([omc, "--version"], text=True).strip() == runtime["compiler"], "Incorrect OMC version")
        baseline = {}
        for name, changed in VARIANTS.items():
            stats, parameters = verify_case(omc, out, name, registry, runtime)
            report["cases"][name] = stats
            if changed is None:
                baseline = parameters
            else:
                require([k for k in parameters if parameters[k] != baseline[k]] == [changed],
                        f"{name} must change only {changed}")
                delta = stats["at100ms"]["positionMm"] - report["cases"]["standard"]["at100ms"]["positionMm"]
                require(abs(delta) > LIMITS["positionMm"], name + ": substitution did not change the actual axis motion")
            print(f"{name}: {stats['browserSamples']} browser points x 6 outputs, native stop {stats['nativeStopMs']} ms")
        report["maxAbsError"] = {k: max(v["maxAbsError"][k] for v in report["cases"].values()) for k in LIMITS}
        report["passed"] = True
    except (ValueError, OSError, KeyError, StopIteration, RuntimeError, BadZipFile, subprocess.SubprocessError) as error:
        report["error"] = str(error)
        raise SystemExit(str(error)) from error
    finally:
        (out/"motor-assembly-comparison.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2)+"\n", encoding="utf-8")
    print("PASS: Saved stator, rotor and bearing revisions reproduced by OpenModelica. " + str(out/"motor-assembly-comparison.json"))


if __name__ == "__main__":
    main()
