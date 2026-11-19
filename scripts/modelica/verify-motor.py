#!/usr/bin/env python3
"""Exercise the assembled q-axis servomotor with native DASSL and independent physical oracles."""
import argparse
import json
import math
from pathlib import Path
import shutil
import tempfile

from verify import MSL_FILES, MSL_PIN, command, digest, require, settled_time, simulate


HERE = Path(__file__).resolve().parent
MODELS = HERE.parents[1] / "public/modelica"
MODEL = "GouyuanMotor.CncFeedAxis"
SCRIPT = HERE / "check-motor.mos"
VERSIONS = "OpenModelica 1.27.2 / Modelica 4.0.0 / Gouyuan 1.0.0 / GouyuanMotor 1.0.0"
CHECKED = ["StatorWinding", "PermanentMagnetRotor", "BearingSupport", "PMServoMotor", "CncFeedAxis"]
COMPONENT_FILES = {
    **{key: value for key, value in MSL_FILES.items() if key.startswith("Mechanics/Rotational/")},
    "Mechanics/Rotational/Components/Damper.mo": "542ded5573f877ae50c9ac408b3a0ef44ffc1e820c6a1b42bbd40ad71f0cd578",
    "Mechanics/Translational/Components/Mass.mo": "15a5d8b21338447c9ea1d21b695a20fadd3bf6fe529c05a98d6360811ac8be62",
}
NOMINAL = dict(targetMm=10, leadMmPerRev=5, tableMassKg=5, phaseResistanceOhm=2, qInductanceH=0.004,
               windingTurns=50, windingFactor=0.9, windingCurrentLimitA=4, polePairs=2, rotorFluxWb=0.001,
               rotorInertiaKgM2=0.00002, bearingViscousNmS=0.00012, bearingCount=2, driveVoltageLimitV=24,
               driveCurrentLimitA=4, driveSpeedLimitRpm=2500, driveReferenceInertiaKgM2=0.00004, currentGainOhm=8)
CASES = {
    "normal": {}, "negative": {"targetMm": -10}, "zero": {"targetMm": 0},
    "stator": {"qInductanceH": 0.012}, "rotor": {"rotorInertiaKgM2": 0.00006}, "bearing": {"bearingViscousNmS": 0.00036},
    "low-voltage": {"driveVoltageLimitV": 2}, "low-current": {"driveCurrentLimitA": 0.03}, "heavy-table": {"tableMassKg": 50},
    "high-resistance": {"phaseResistanceOhm": 4}, "weak-magnet": {"rotorFluxWb": 0.00025},
    "winding-limit": {"windingCurrentLimitA": 0.05}, "speed-limit": {"driveSpeedLimitRpm": 30, "targetMm": 50},
    "lead-10": {"leadMmPerRev": 10}, "stiff-winding": {"qInductanceH": 0.00005},
}
OUTPUTS = ["positionMm", "velocityMmS", "angleDeg", "speedRpm", "currentA", "motorTorqueNm"]
LINEAR_CASES = {"normal", "negative", "stator", "rotor", "bearing", "high-resistance", "heavy-table", "lead-10", "stiff-winding"}


def clamp(value, limit):
    return max(-limit, min(limit, value))


def matrix_product(left, right):
    return [[sum(a*b for a, b in zip(row, col)) for col in zip(*right)] for row in left]


def transition(p, metres_per_rad, kt, drag):
    """exp(A*0.01) for the unsaturated independent (angle error, speed, iq) solution."""
    inertia = p["rotorInertiaKgM2"] + p["tableMassKg"] * metres_per_rad**2
    gain = p["currentGainOhm"]
    inductance = p["qInductanceH"]
    reference = p["driveReferenceInertiaKgM2"]
    a = [[0, 1, 0], [0, -drag/inertia, kt/inertia],
         [-24**2*reference*gain/(kt*inductance), -48*reference*gain/(kt*inductance),
          -(p["phaseResistanceOhm"]+gain)/inductance]]
    # Scale to ||B||_inf <= 0.25; the 18th-degree Taylor tail is then below double precision.
    norm = 0.01 * max(sum(abs(value) for value in row) for row in a)
    squares = max(0, math.ceil(math.log2(norm/0.25)))
    b = [[value*0.01 / 2**squares for value in row] for row in a]
    term = result = [[float(i == j) for j in range(3)] for i in range(3)]
    for k in range(1, 19):
        term = [[value/k for value in row] for row in matrix_product(term, b)]
        result = [[x+y for x, y in zip(r, t)] for r, t in zip(result, term)]
    for _ in range(squares):
        result = matrix_product(result, result)
    return result


def verify_case(name, work, out):
    p = {**NOMINAL, **CASES[name]}
    rows, report = simulate(MODEL, "motor-" + name, p, 8, 800, work, out)
    r, inductance, gain = p["phaseResistanceOhm"], p["qInductanceH"], p["currentGainOhm"]
    metres_per_rad = p["leadMmPerRev"] / (1000*math.tau)
    target = p["targetMm"] / (1000*metres_per_rad)
    ke = p["polePairs"]*p["windingTurns"]*p["windingFactor"]*p["rotorFluxWb"]
    kt = 1.5*ke
    drag = p["bearingCount"]*p["bearingViscousNmS"]
    speed_limit = p["driveSpeedLimitRpm"]*math.tau/60
    current_limit = min(p["windingCurrentLimitA"], p["driveCurrentLimitA"])
    voltage_limit = p["driveVoltageLimitV"]
    step = transition(p, metres_per_rad, kt, drag) if name in LINEAR_CASES else None
    state = [-target, 0, 0]
    max_residual, max_analytic = {}, {}
    max_voltage = max_command = max_current = max_torque = 0
    for s in rows:
        theta, omega = math.radians(s["angleDeg"]), s["speedRpm"]*math.tau/60
        iq, slope, tau = s["currentA"], s["motor.stator.currentSlopeAS"], s["motorTorqueNm"]
        alpha, acceleration = s["motor.rotor.inertia.a"], s["table.a"]
        shaft, friction = s["screw.shaft.tau"], s["motor.bearings.shaft.tau"]
        command_a, voltage = s["drive.currentCommandA"], s["appliedVoltageV"]
        velocity = s["velocityMmS"]/1000
        speed_request = 12*(target-theta)
        torque_request = 48*p["driveReferenceInertiaKgM2"]*(clamp(speed_request, speed_limit)-omega)
        voltage_request = gain*(command_a-iq) + ke*omega
        electric_w = 1.5*voltage*iq
        copper_w, field_w = 1.5*r*iq**2, 1.5*inductance*iq*slope
        kinetic_w = p["rotorInertiaKgM2"]*omega*alpha + p["tableMassKg"]*velocity*acceleration
        residuals = {
            "commandA": command_a - clamp(torque_request/kt, current_limit),
            "requestedVoltageV": s["requestedVoltageV"] - voltage_request,
            "appliedVoltageV": voltage - clamp(voltage_request, voltage_limit),
            "windingVoltageV": voltage - r*iq - inductance*slope - ke*omega,
            "electromagneticTorqueNm": tau - kt*iq,
            "bearingTorqueNm": friction - drag*omega,
            "shaftTorqueNm": shaft - p["tableMassKg"]*acceleration*metres_per_rad,
            "rotorTorqueNm": tau - friction - shaft - p["rotorInertiaKgM2"]*alpha,
            "positionMm": s["positionMm"] - 1000*metres_per_rad*theta,
            "velocityMmS": s["velocityMmS"] - 1000*metres_per_rad*omega,
            "accelerationMS2": acceleration - metres_per_rad*alpha,
            "electricPowerW": electric_w - copper_w - field_w - tau*omega,
            "mechanicalPowerW": tau*omega - drag*omega**2 - kinetic_w,
            "wholeSystemPowerW": electric_w - copper_w - field_w - drag*omega**2 - kinetic_w,
        }
        for key, error in residuals.items():
            max_residual[key] = max(max_residual.get(key, 0), abs(error))
        max_voltage = max(max_voltage, abs(voltage))
        max_command = max(max_command, abs(command_a))
        max_current = max(max_current, abs(iq))
        max_torque = max(max_torque, abs(tau))
        if step is not None:
            require(abs(speed_request) < speed_limit and abs(torque_request/kt) < current_limit and
                    abs(voltage_request) < voltage_limit, f"{name}: analytic oracle entered a limiter")
            phi, w, current = state[0]+target, state[1], state[2]
            exact = [1000*metres_per_rad*phi, 1000*metres_per_rad*w, math.degrees(phi), w*60/math.tau, current, kt*current]
            for key, value in zip(OUTPUTS, exact):
                max_analytic[key] = max(max_analytic.get(key, 0), abs(s[key]-value))
            state = [sum(a*b for a, b in zip(row, state)) for row in step]
    require(max(max_residual.values()) < 1e-8, f"{name}: coupled electrical/mechanical balance failed: {max_residual}")
    if step is not None:
        tolerance = dict(zip(OUTPUTS, [2e-5, 5e-4, 0.0015, 0.006, 0.0001, 0.00003]))
        require(all(error <= tolerance[key] for key, error in max_analytic.items()),
                f"{name}: matrix-exponential response mismatch: {max_analytic}")
        report["analyticMaxAbsError"] = max_analytic
    require(all(rows[0][key] == 0 for key in OUTPUTS), name + ": not at rest with zero initial current")
    require(max_voltage <= voltage_limit + 1e-8 and max_command <= current_limit + 1e-8, name + ": drive limits")
    if name == "zero":
        require(all(s[key] == 0 for s in rows for key in OUTPUTS), "Zero step generated motion or current")
    if name == "low-voltage":
        require(rows[0]["requestedVoltageV"] > voltage_limit and rows[0]["appliedVoltageV"] == voltage_limit,
                "Voltage saturation not exercised")
    if name in ("low-current", "winding-limit", "weak-magnet"):
        require(abs(rows[0]["drive.currentCommandA"]-current_limit) < 1e-10, name + ": current clamp not exercised")
    settled = settled_time(rows, math.degrees(target))
    require((settled is None) == (name == "speed-limit"), name + ": unexpected settling outcome")
    report.update(parameters=p, atStart={key: rows[0][key] for key in OUTPUTS}, at10ms={key: rows[1][key] for key in OUTPUTS},
                  at100ms={key: rows[10][key] for key in OUTPUTS}, final={key: rows[-1][key] for key in OUTPUTS},
                  maxAbsVoltageV=max_voltage, maxAbsCurrentCommandA=max_command, maxAbsCurrentA=max_current,
                  maxAbsTorqueNm=max_torque, maxAbsBalanceResidual=max_residual, settledAtSampleS=settled)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omc", default="omc")
    parser.add_argument("--out", type=Path, required=True, help="Native CSV, log, and motor-native-results.json directory")
    args = parser.parse_args()
    omc = shutil.which(args.omc)
    if not omc:
        parser.error("OpenModelica 1.27.2 is required.")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gouyuan-motor-build-") as temp:
        work = Path(temp)
        for name in ("Gouyuan.mo", "GouyuanMotor.mo"):
            shutil.copyfile(MODELS/name, work/name)
        log = command([omc, str(SCRIPT)], work, out/"motor-build.log", 600)
        require("MOTOR_VERSIONS " + VERSIONS in log and (work/MODEL).is_file() and "Error:" not in log, "Native motor build failed")
        for name in CHECKED:
            require(f"Check of GouyuanMotor.{name} completed successfully" in log, "Missing native check for " + name)
        msl = Path(next(s.removeprefix("MOTOR_MSL_FILE ") for s in log.splitlines() if s.startswith("MOTOR_MSL_FILE "))).parent
        for file, expected in COMPONENT_FILES.items():
            require(digest(msl/file) == expected, "Unexpected MSL file: " + file)
        cases = {name: verify_case(name, work, out) for name in CASES}
    base = cases["normal"]
    require(cases["stator"]["at10ms"]["positionMm"] < base["at10ms"]["positionMm"] and
            cases["rotor"]["at100ms"]["positionMm"] < base["at100ms"]["positionMm"] and
            cases["bearing"]["at100ms"]["velocityMmS"] < base["at100ms"]["velocityMmS"], "Component substitutions have no effect")
    require(all(abs(base["at100ms"][key]+cases["negative"]["at100ms"][key]) < 1e-5 for key in OUTPUTS),
            "Positive and negative motion lost signed symmetry")
    report = {"passed": True, "toolchain": VERSIONS, "model": MODEL, "solver": "DASSL", "tolerance": 1e-8,
              "sourceSha256": digest(MODELS/"GouyuanMotor.mo"), "dependencySha256": digest(MODELS/"Gouyuan.mo"),
              "mosSha256": digest(SCRIPT), "verifierSha256": digest(Path(__file__)), "helpersSha256": digest(HERE/"verify.py"),
              "mslRevision": MSL_PIN, "verifiedMslFiles": COMPONENT_FILES, "checkedClasses": ["GouyuanMotor." + c for c in CHECKED],
              "compilerWarnings": [line.strip().strip('"') for line in log.splitlines() if "Warning:" in line],
              "buildLogSha256": digest(out/"motor-build.log"), "cases": cases}
    target = out/"motor-native-results.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"PASS: {len(cases)} native motor cases x 801 samples, electrical/mechanical balances and analytic step responses. {target}")


if __name__ == "__main__":
    main()
