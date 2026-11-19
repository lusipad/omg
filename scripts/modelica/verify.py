#!/usr/bin/env python3
"""Build and run the pinned Modelica models. Requires Python 3 and the native OMC toolchain."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


HERE = Path(__file__).resolve().parent
MODEL = HERE.parents[1] / "public" / "modelica" / "Gouyuan.mo"
SCRIPT = HERE / "check-build.mos"
SERVO = "Gouyuan.ServoAxis"
SCREW = "Gouyuan.IdealLeadScrewBench"
SMPM = "Modelica.Electrical.Machines.Examples.SynchronousMachines.SMPM_VoltageSource"
CHECKED = ["Gouyuan.PositionDrive", "Gouyuan.RatedTorqueMotor", SERVO, "Gouyuan.IdealLeadScrew", SCREW, SMPM]
MSL_PIN = "6626538a236a34a390655b55d5e8c906bfe31772"
MSL_FILES = {
    "Mechanics/Rotational/Components/Inertia.mo": "f3686d31c0612222f93a9e6f548731c3bb1f51e4b25305c2c152c68684d10c6a",
    "Mechanics/Rotational/Components/IdealGearR2T.mo": "a73f9f7b0852325ed26f7be3a331c41c15a2ead83755dc154bc2b39482306e83",
    "Electrical/Machines/Examples/SynchronousMachines/SMPM_VoltageSource.mo": "478a8121e00e39d5c0cfa5f60f78190827c48630834f1b504f3bbef72a922c5c",
}
NOMINAL = dict(targetDeg=90, loadInertiaRatio=1, rotorInertiaKgM2=0.0000145, ratedTorqueNm=1.27,
               ratedPowerW=400, ratedSpeedRpm=3000, driveRatedCurrentA=2.8, motorRatedCurrentA=2.8)
CASES = {
    "normal": {}, "negative": {"targetDeg": -90}, "load-5": {"loadInertiaRatio": 5},
    "low-current": {"driveRatedCurrentA": 0.02}, "zero": {"targetDeg": 0}, "zero-load": {"loadInertiaRatio": 0},
    "speed-limit": {"targetDeg": 3600, "ratedSpeedRpm": 60}, "power-limit": {"targetDeg": 3600, "ratedPowerW": 4},
    "torque-limit": {"targetDeg": 3600, "ratedTorqueNm": 0.1},
    "double-rotor": {"driveRatedCurrentA": 0.02, "rotorInertiaKgM2": 0.000029},
    "motor-current": {"driveRatedCurrentA": 0.02, "motorRatedCurrentA": 1.4},
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, work, log, timeout):
    with log.open("wb") as f:
        completed = subprocess.run(args, cwd=work, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    text = log.read_text(encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(f"{args[0]} exited {completed.returncode}. See {log}\n{text[-1500:]}")
    return text


def simulate(model, label, overrides, stop, count, work, out):
    filename = label + ".csv"
    log = out / (label + ".log")
    args = [str(work / model), "-noEventEmit", "-r=" + filename]
    if overrides:
        args.append("-override=" + ",".join(f"{k}={v}" for k, v in overrides.items()))
    text = command(args, work, log, 120)
    require("The simulation finished successfully" in text and "LOG_ERROR" not in text, f"Simulation failed: {log}")
    result = work / filename
    with result.open(encoding="utf-8", newline="") as f:
        rows = [{k: float(v) for k, v in row.items()} for row in csv.DictReader(f)]
    require(len(rows) == count + 1, f"{label}: expected {count + 1} exact grid points; got {len(rows)}")
    require(all(abs(row["time"] - stop*i/count) < 1e-9 and all(map(math.isfinite, row.values()))
                for i, row in enumerate(rows)), f"{label}: invalid time grid or nonfinite native results")
    shutil.copyfile(result, out / filename)
    return rows, {"samples": len(rows), "csv": filename, "csvSha256": digest(result), "logSha256": digest(log)}


def settled_time(rows, target):
    since = None
    for row in rows:
        if abs(row["angleDeg"] - target) > 0.1 or abs(row["speedRpm"]) > 0.5:
            since = None
        else:
            if since is None:
                since = row["time"]
            if row["time"] - since >= 0.05 - 1e-12:
                return row["time"]
    return None


def reference_step(t, target, ratio, rotor):
    """Closed-form solution of J q'' + Kd q' + Kp q = Kp qref, for an unsaturated step."""
    wn = 24.0
    k = 2 / (1 + ratio)
    decay = k*wn
    wn2 = k*wn**2
    if k == 1:
        error = math.exp(-wn*t) * (1 + wn*t)
        velocity = wn**2*t*math.exp(-wn*t)
    elif k < 1:
        beta = math.sqrt(wn2 - decay**2)
        error = math.exp(-decay*t) * (math.cos(beta*t) + decay/beta*math.sin(beta*t))
        velocity = wn2/beta * math.exp(-decay*t)*math.sin(beta*t)
    else:
        gap = math.sqrt(decay**2 - wn2)
        r1, r2 = -decay + gap, -decay - gap
        error = (-r2*math.exp(r1*t) + r1*math.exp(r2*t)) / (r1-r2)
        velocity = wn2*(math.exp(r1*t) - math.exp(r2*t)) / (r1-r2)
    target_rad = math.radians(target)
    return target*(1-error), target_rad*velocity*30/math.pi, rotor*(1+ratio)*target_rad*(wn2*error - 2*decay*velocity)


def verify_servos(work, out):
    reports, traces = {}, {}
    for label, changes in CASES.items():
        p = {**NOMINAL, **changes}
        rows, report = simulate(SERVO, "servo-" + label, p, 8, 800, work, out)
        cap = p["ratedTorqueNm"]*min(1, p["driveRatedCurrentA"]/p["motorRatedCurrentA"])
        max_torque = max(abs(s["torqueNm"]) for s in rows)
        max_power = max(abs(s["torqueNm"]*s["speedRpm"]*math.pi/30) for s in rows)
        max_rpm = max(abs(s["speedRpm"]) for s in rows)
        require(max_torque <= cap + 1e-8 and max_power <= p["ratedPowerW"] + 1e-6 and max_rpm <= p["ratedSpeedRpm"] + 1e-4,
                f"{label}: exceeded the current/torque, power or speed limit")
        require(rows[0]["angleDeg"] == 0 and rows[0]["speedRpm"] == 0, f"{label}: initial state not at rest")
        report.update(parameters=p, at100ms=rows[10], final=rows[-1], maxAbsTorqueNm=max_torque, maxAbsPowerW=max_power,
                      maxAbsSpeedRpm=max_rpm, settledAtS=settled_time(rows, p["targetDeg"]))
        if label in ("normal", "negative", "load-5", "zero-load"):
            maxima = [0.0]*3
            for s in rows:
                expected = reference_step(s["time"], p["targetDeg"], p["loadInertiaRatio"], p["rotorInertiaKgM2"])
                for i, field in enumerate(("angleDeg", "speedRpm", "torqueNm")):
                    maxima[i] = max(maxima[i], abs(s[field] - expected[i]))
            require(all(e <= tol for e, tol in zip(maxima, [1e-4, 1e-3, 3e-7])), f"{label}: analytic error {maxima}")
            report["analyticMaxAbsError"] = dict(zip(["angleDeg", "speedRpm", "torqueNm"], maxima))
        reports[label], traces[label] = report, rows

    require(all(s["angleDeg"] == 0 and s["speedRpm"] == 0 and s["torqueNm"] == 0 for s in traces["zero"]), "Zero step moved")
    require(max(abs(a["angleDeg"] + b["angleDeg"]) for a, b in zip(traces["normal"], traces["negative"])) < 1e-4, "Lost signed symmetry")
    require(reports["load-5"]["settledAtS"] > reports["normal"]["settledAtS"] and max(s["angleDeg"] for s in traces["load-5"]) > 90,
            "Changing the load did not produce the expected underdamped response")
    require(traces["double-rotor"][5]["angleDeg"] < traces["low-current"][5]["angleDeg"] < traces["normal"][5]["angleDeg"],
            "Current-limited displacement did not decrease with added rotor inertia")
    require(abs(traces["low-current"][0]["torqueNm"] - NOMINAL["ratedTorqueNm"]*0.02/2.8) < 1e-10 and
            abs(traces["motor-current"][0]["torqueNm"] - 2*traces["low-current"][0]["torqueNm"]) < 1e-10, "Rated-current mapping mismatch")
    require(abs(reports["torque-limit"]["maxAbsTorqueNm"] - 0.1) < 1e-8, "Torque limit was not exercised")
    require(abs(reports["power-limit"]["maxAbsPowerW"] - 4) < 1e-5, "Power limit was not exercised")
    require(abs(reports["speed-limit"]["maxAbsSpeedRpm"] - 60) < 1e-4 and reports["speed-limit"]["settledAtS"] is None,
            "Speed limiting or genuine timeout was not exercised")
    return reports


def verify_screws(work, out):
    reports = {}
    for lead, rpm in [(5, 120), (10, 120), (5, -120)]:
        name = f"screw-{lead}mm-{rpm}rpm"
        p = dict(leadMmPerRev=lead, inputSpeedRpm=rpm, loadN=100)
        rows, report = simulate(SCREW, name, p, 1, 100, work, out)
        speed = rpm*lead/60
        torque = p["loadN"]*lead/(1000*2*math.pi)
        power = p["loadN"]*speed/1000
        errors = {}
        for row in rows:
            expected = {"positionMm": speed*row["time"], "speedMmS": speed, "driveTorqueNm": torque,
                        "source.flange.tau": -torque, "axialForceN": p["loadN"], "shaftPowerW": power, "linearPowerW": power}
            for key, value in expected.items():
                errors[key] = max(errors.get(key, 0), abs(row[key] - value))
        require(max(errors.values()) < 1e-8, f"{name}: transmission or sign disagreement {errors}")
        report.update(parameters=p, atOneRevolution=rows[50], maxAbsPowerImbalanceW=max(abs(s["shaftPowerW"]-s["linearPowerW"]) for s in rows),
                      analyticMaxAbsError=errors)
        reports[name] = report
    return reports


def verify_standard_example(work, out):
    rows, report = simulate(SMPM, "msl-smpm-voltage-source", {}, 2, 20000, work, out)
    init = ET.parse(work / (SMPM + "_init.xml"))

    def parameter(name):
        return float(init.find(f".//ScalarVariable[@name='{name}']/*").attrib["start"])

    inertia, torque = parameter("JLoad"), parameter("TLoad")
    nominal_w = 2*math.pi*parameter("smpmData.fsNominal")/parameter("smpmData.p")
    balance = 0.0
    for i in range(100, len(rows)-1):
        before, current, after = rows[i-1:i+2]
        acceleration = (after["inertiaLoad.w"] - before["inertiaLoad.w"]) / (after["time"] - before["time"])
        expected = inertia*acceleration + torque*(current["inertiaLoad.w"]/nominal_w)**2
        balance = max(balance, abs(current["multiSensor.tau"] - expected))
    require(rows[0]["inertiaLoad.w"] == 0 and abs(rows[-1]["inertiaLoad.w"]/nominal_w - 1) < 0.01 and
            rows[-1]["currentQuasiRMSSensor.I"] > 0 and balance < 0.05, f"MSL default run or shaft/load torque balance failed: {balance}")
    report.update(model=SMPM, nativeDefaults=True, final=rows[-1], nominalSpeedRadS=nominal_w, loadInertiaKgM2=inertia,
                  nominalLoadTorqueNm=torque, maxLoadBalanceResidualNm=balance)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omc", default="omc", help="OpenModelica 1.27.2 executable")
    parser.add_argument("--out", type=Path, help="Directory for native CSV, logs and native-results.json")
    args = parser.parse_args()
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="gouyuan-modelica-results-"))
    out.mkdir(parents=True, exist_ok=True)
    omc = shutil.which(args.omc)
    if not omc:
        parser.error("OpenModelica 1.27.2 not found. Supply --omc or set PATH.")
    print(f"Native regression output: {out}", flush=True)
    with tempfile.TemporaryDirectory(prefix="gouyuan-modelica-build-") as tmp:
        work = Path(tmp)
        shutil.copyfile(MODEL, work / "Gouyuan.mo")
        log = command([omc, str(SCRIPT)], work, out / "build.log", 600)
        expected_versions = "OpenModelica 1.27.2 / Modelica 4.0.0 / Gouyuan 1.0.0"
        require("GOUYUAN_VERSIONS " + expected_versions in log, "Native compiler or loaded library version mismatch")
        for cls in CHECKED:
            require(f"Check of {cls} completed successfully" in log, f"Missing successful checkModel: {cls}")
        library = Path(next(line.removeprefix("GOUYUAN_MSL_FILE ") for line in log.splitlines() if line.startswith("GOUYUAN_MSL_FILE "))).parent
        for filename, expected in MSL_FILES.items():
            require(digest(library/filename) == expected, f"Loaded MSL source differs from v4.0.0: {filename}")
        report = {"passed": True, "toolchain": expected_versions, "mslRevision": MSL_PIN, "verifiedMslFiles": MSL_FILES,
                  "sourceSha256": digest(MODEL), "mosSha256": digest(SCRIPT), "verifierSha256": digest(Path(__file__)),
                  "buildLogSha256": digest(out / "build.log"), "checkedClasses": CHECKED,
                  "compilerWarnings": [s.strip().strip('"') for s in log.splitlines() if "Warning:" in s],
                  "solver": "DASSL", "servoTolerance": 1e-8, "smpmTolerance": 1e-6,
                  "servoCases": verify_servos(work, out), "screwCases": verify_screws(work, out),
                  "standardExample": verify_standard_example(work, out)}
    summary = out / "native-results.json"
    summary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"PASS: {len(report['servoCases'])} servo cases, {len(report['screwCases'])} screw cases, 1 unmodified MSL SMPM example. {summary}")


if __name__ == "__main__":
    main()
