#!/usr/bin/env python3
"""Run the feed-axis model with native DASSL and check its dynamics against independent balances."""
import argparse
import json
import math
from pathlib import Path
import shutil
import tempfile

from verify import MSL_FILES, MSL_PIN, command, digest, reference_step, require, settled_time, simulate


HERE = Path(__file__).resolve().parent
MODELS = HERE.parents[1] / "public/modelica"
MODEL = "GouyuanLinear.FeedAxis"
SCRIPT = HERE / "check-feed.mos"
VERSIONS = "OpenModelica 1.27.2 / Modelica 4.0.0 / Gouyuan 1.0.0 / GouyuanLinear 1.0.0"
COMPONENT_FILES = {
    "Mechanics/Translational/Components/Mass.mo": "15a5d8b21338447c9ea1d21b695a20fadd3bf6fe529c05a98d6360811ac8be62",
    "Mechanics/Translational/Sensors/ForceSensor.mo": "c59737994efe42f741d33b0efdb5bf09bd55a37f7bcff4b3a3f67923247e823d",
    **{name: sha for name, sha in MSL_FILES.items() if name.startswith("Mechanics/Rotational/")},
}
NOMINAL = dict(targetMm=10, leadMmPerRev=5, tableMassKg=5, rotorInertiaKgM2=0.0000145,
               ratedTorqueNm=1.27, ratedPowerW=400, ratedSpeedRpm=3000, driveRatedCurrentA=2.8, motorRatedCurrentA=2.8)
CASES = {
    "normal": {}, "negative": {"targetMm": -10}, "zero": {"targetMm": 0},
    "lead-10": {"leadMmPerRev": 10}, "mass-25": {"tableMassKg": 25},
    "low-current": {"driveRatedCurrentA": 0.04},
    "power-limit": {"ratedPowerW": 4, "targetMm": 50},
    "speed-limit": {"ratedSpeedRpm": 60, "targetMm": 120},
    "other-motor": {"rotorInertiaKgM2": 0.000029, "ratedTorqueNm": 0.7, "motorRatedCurrentA": 1.4, "driveRatedCurrentA": 0.04},
}
OUTPUTS = ["positionMm", "velocityMmS", "motorTorqueNm", "axialForceN", "angleDeg", "speedRpm"]


def verify_case(name, work, out):
    p = {**NOMINAL, **CASES[name]}
    rows, report = simulate(MODEL, "feed-" + name, p, 8, 800, work, out)
    lead = p["leadMmPerRev"]
    mass, rotor = p["tableMassKg"], p["rotorInertiaKgM2"]
    metres_per_rad = lead / (1000*math.tau)
    reflected = mass*metres_per_rad**2
    target_deg = p["targetMm"]*360/lead
    cap = p["ratedTorqueNm"]*min(1, p["driveRatedCurrentA"]/p["motorRatedCurrentA"])
    max_residual, max_analytic = {}, {}
    max_power = max_torque = 0
    for s in rows:
        omega = s["speedRpm"]*math.tau/60
        alpha, acceleration = s["motor.rotor.a"], s["table.a"]
        tau, input_tau, force = s["motorTorqueNm"], s["screw.shaft.tau"], s["axialForceN"]
        velocity = s["velocityMmS"]/1000
        residuals = {
            "positionMm": s["positionMm"]-s["angleDeg"]*lead/360,
            "velocityMmS": s["velocityMmS"]-s["speedRpm"]*lead/60,
            "tableForceN": force-mass*acceleration,
            "tableAccelerationMS2": acceleration-metres_per_rad*alpha,
            "screwTorqueNm": input_tau-force*metres_per_rad,
            "rotorTorqueNm": tau-input_tau-rotor*alpha,
            "screwPowerW": input_tau*omega-force*velocity,
            "kineticPowerW": tau*omega-(rotor*omega*alpha + mass*velocity*acceleration),
        }
        for field, value in residuals.items():
            max_residual[field] = max(max_residual.get(field, 0), abs(value))
        max_power = max(max_power, abs(tau*omega))
        max_torque = max(max_torque, abs(tau))
        # With no active limits this is an independent closed-form rigid-body step response.
        if name in ("normal", "negative", "lead-10", "mass-25"):
            deg, rpm, torque = reference_step(s["time"], target_deg, reflected/rotor, rotor)
            expected = [deg*lead/360, rpm*lead/60, torque, mass*metres_per_rad*torque/(rotor+reflected), deg, rpm]
            for field, value in zip(OUTPUTS, expected):
                max_analytic[field] = max(max_analytic.get(field, 0), abs(s[field]-value))
    require(max(max_residual.values()) < 1e-8, f"{name}: mechanical transmission balance failed: {max_residual}")
    require(max_torque <= cap + 1e-8 and max_power <= p["ratedPowerW"] + 1e-6, f"{name}: torque or power exceeded")
    require(all(rows[0][key] == 0 for key in ["positionMm", "velocityMmS", "angleDeg", "speedRpm"]), f"{name}: initial state")
    report.update(parameters=p, atStart={k: rows[0][k] for k in OUTPUTS}, at100ms={k: rows[10][k] for k in OUTPUTS},
                  final={k: rows[-1][k] for k in OUTPUTS}, maxAbsMotorTorqueNm=max_torque, maxAbsPowerW=max_power,
                  maxAbsAxialForceN=max(abs(s["axialForceN"]) for s in rows),
                  reflectedInertiaKgM2=reflected, maxAbsMechanicalResidual=max_residual,
                  settledAtSampleS=settled_time(rows, target_deg))
    if max_analytic:
        allowed = dict(zip(OUTPUTS, [1e-5, 2e-4, 2e-6, 4e-4, 3e-4, 0.002]))
        require(all(v <= allowed[k] for k, v in max_analytic.items()), f"{name}: closed-form dynamics failed: {max_analytic}")
        report["analyticMaxAbsError"] = max_analytic
    if name == "zero":
        require(all(s[k] == 0 for s in rows for k in OUTPUTS), "Zero step generated motion or effort")
    elif name == "speed-limit":
        require(target_deg > 3600 and report["settledAtSampleS"] is None and
                abs(rows[-1]["speedRpm"]-p["ratedSpeedRpm"]) < 1e-4 and rows[-1]["positionMm"] < p["targetMm"],
                "Long travel should still be speed-limited at 8 s")
    else:
        require(report["settledAtSampleS"] is not None, f"{name}: failed to settle")
    if name == "power-limit":
        require(abs(max_power-p["ratedPowerW"]) < 1e-6, "Power limiter was not exercised")
    if name in ("low-current", "other-motor"):
        require(abs(rows[0]["motorTorqueNm"]-cap) < 1e-8, f"{name}: continuous current limit not exercised")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omc", default="omc")
    parser.add_argument("--out", type=Path, required=True, help="Directory for CSV, logs and feed-native-results.json")
    args = parser.parse_args()
    omc = shutil.which(args.omc)
    if not omc:
        parser.error("OpenModelica 1.27.2 is required.")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gouyuan-feed-build-") as tmp:
        work = Path(tmp)
        for source in ["Gouyuan.mo", "GouyuanLinear.mo"]:
            shutil.copyfile(MODELS/source, work/source)
        log = command([omc, str(SCRIPT)], work, out/"feed-build.log", 600)
        require("FEED_VERSIONS " + VERSIONS in log and f"Check of {MODEL} completed successfully" in log and
                "Error:" not in log and (work/MODEL).is_file(), f"Native build failed; see {out/'feed-build.log'}")
        msl_root = Path(next(s.removeprefix("FEED_MSL_FILE ") for s in log.splitlines() if s.startswith("FEED_MSL_FILE "))).parent
        for file, expected in COMPONENT_FILES.items():
            require(digest(msl_root/file) == expected, f"Unexpected source for {file}")
        cases = {name: verify_case(name, work, out) for name in CASES}
    base = cases["normal"]["at100ms"]
    require(cases["mass-25"]["at100ms"]["positionMm"] < base["positionMm"] and
            abs(cases["lead-10"]["at100ms"]["velocityMmS"] - base["velocityMmS"]) > 1 and
            cases["mass-25"]["atStart"]["axialForceN"] > cases["normal"]["atStart"]["axialForceN"],
            "Lead and moving mass must influence the dynamic response and force")
    require(all(abs(base[k]+cases["negative"]["at100ms"][k]) < 2e-4 for k in OUTPUTS), "Lost signed symmetry")
    report = {"passed": True, "toolchain": VERSIONS, "model": MODEL, "solver": "DASSL", "tolerance": 1e-8,
              "sourceSha256": digest(MODELS/"GouyuanLinear.mo"), "dependencySha256": digest(MODELS/"Gouyuan.mo"),
              "mosSha256": digest(SCRIPT), "verifierSha256": digest(Path(__file__)), "helpersSha256": digest(HERE/"verify.py"),
              "mslRevision": MSL_PIN, "verifiedMslFiles": COMPONENT_FILES,
              "compilerWarnings": [s.strip().strip('"') for s in log.splitlines() if "Warning:" in s],
              "buildLogSha256": digest(out/"feed-build.log"), "cases": cases}
    summary = out/"feed-native-results.json"
    summary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"PASS: {len(cases)} native feed cases x 801 samples with transmission and kinetic power balance. {summary}")


if __name__ == "__main__":
    main()
