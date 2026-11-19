"""Package the solved scalar C equations of the pinned ServoAxis for a web integrator.

The OpenModelica back end performs flattening, index reduction, alias elimination and
the symbolic solution of the small linear system. We keep its generated assignment
bodies, changing only their runtime storage/diagnostic ABI for freestanding wasm.
This adapter is for the audited two-state, continuous ServoAxis model only.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "public/modelica"
MODEL = MODEL_DIR / "Gouyuan.mo"
LIBRARY = MODEL_DIR / "library.json"
COMPILER = "OpenModelica 1.27.2"
FLAGS = "--postOptModules+=solveLinearSystem --maxSizeSolveLinearSystem=12"
PARAMETERS = ["targetDeg", "loadInertiaRatio", "rotorInertiaKgM2", "ratedTorqueNm",
              "ratedPowerW", "ratedSpeedRpm", "driveRatedCurrentA", "motorRatedCurrentA"]
OUTPUTS = ["angleDeg", "speedRpm", "torqueNm"]
PREFIX = "ServoWeb"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(command, cwd=None):
    return subprocess.run(command, cwd=cwd, check=True, capture_output=True,
                          text=True, encoding="utf-8", errors="replace").stdout.strip()


def executable(variable, command):
    name = os.environ.get(variable, command)
    path = shutil.which(name)
    if not path:
        raise ValueError(f"Missing {command}; set {variable} to its executable.")
    return path


def emit_kernel(directory):
    info = json.loads((directory / (PREFIX + "_info.json")).read_text())
    description = ET.parse(directory / (PREFIX + "_init.xml")).getroot()
    if info["info"]["name"] != "Gouyuan.ServoAxis" or description.get("modelName") != info["info"]["name"]:
        raise ValueError("Unexpected compiled model.")
    unsupported = ("numberOfEventIndicators", "numberOfTimeEvents", "numberOfInputVariables",
                   "numberOfExternalObjects", "numberOfFunctions")
    if any(description.get(key) != "0" for key in unsupported):
        raise ValueError("The two-state web integrator requires autonomous, continuous scalar equations.")
    variables = info["variables"]
    scalars = {v.get("name"): v for v in description.findall(".//ScalarVariable")}
    states = sorted((n for n, v in variables.items() if v["kind"] == "state"),
                    key=lambda n: variables[n]["index"])
    if len(states) != 2 or any(scalars[n][0].get("fixed") != "true" for n in states):
        raise ValueError("Expected exactly two fixed-initial-value continuous Modelica states.")
    for n in PARAMETERS:
        if variables[n]["kind"] != "parameter" or variables[n]["type"] != "Real":
            raise ValueError("Expected a tunable Real parameter: " + n)

    # OMC may evaluate a time-independent variable (e.g. an SI unit conversion)
    # in its parameter section by aliasing the same native initialization function.
    eqs = {q["eqIndex"]: q for q in info["equations"]}
    definitions = {}
    for eq in eqs.values():
        section = eq.get("section")
        if section == "regular" and eq["tag"] not in ("alias", "assign"):
            raise ValueError("Unsupported continuous equation: " + eq["tag"])
        if section not in ("parameter", "regular"):
            continue
        while eq["tag"] == "alias":
            eq = eqs[eq["equation"][0]]
        for name in eq.get("defines", []):
            definitions[name] = (section, eq)

    code = {}
    pattern = re.compile(r"\bvoid " + PREFIX + r"_eqFunction_(\d+)\(DATA \*data, threadData_t \*threadData\)\s*\{(.*?)^\}", re.M | re.S)
    for tail in (".c", "_08bnd.c", "_06inz.c"):
        for match in pattern.finditer((directory / (PREFIX + tail)).read_text()):
            code[int(match[1])] = match[2]

    schedule = {"parameter": [], "regular": []}
    visited = set(states + PARAMETERS)
    constants = {}

    def require(name, active):
        if name in visited:
            return
        if name in active:
            raise ValueError("Unsolved dependency cycle at " + name)
        if name not in definitions:
            field = scalars[name]
            if variables[name]["kind"] != "parameter" or field[0].get("start") is None:
                raise ValueError("Missing compiler equation for " + name)
            constants[name] = float(field[0].get("start"))
        else:
            section, eq = definitions[name]
            if eq["tag"] != "assign" or eq["defines"] != [name] or eq["eqIndex"] not in code:
                raise ValueError(f"Unsupported compiler equation for {name}: {eq['tag']}")
            for dependency in eq.get("uses", []):
                require(dependency, active | {name})
            schedule[section].append(eq["eqIndex"])
        visited.add(name)

    derivatives = ["der(" + n + ")" for n in states]
    for name in derivatives + OUTPUTS:
        require(name, set())

    def slot(name):
        variable = variables[name]
        if variable["type"] != "Real" and variable["type"] != "Real()":
            raise ValueError("The web adapter supports only Real variables: " + name)
        array = "p" if variable["kind"] == "parameter" else "v"
        return f"{array}[{variable['index']}]"

    def size(names):
        return 1 + max(variables[n]["index"] for n in names)

    pieces = [f"static double v[{size([n for n in visited if variables[n]['kind'] != 'parameter'])}];",
              f"static double p[{size([n for n in visited if variables[n]['kind'] == 'parameter'])}];"]

    def flatten_storage(body):
        body = re.sub(r"data->localData\[0\]->realVars\[data->simulationInfo->realVarsIndex\[(\d+)\]\]", r"v[\1]", body)
        body = re.sub(r"data->simulationInfo->realParameter\[data->simulationInfo->realParamsIndex\[(\d+)\]\]", r"p[\1]", body)
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        # Keep native arithmetic and guards. The native diagnostics ABI is reduced
        # to a trap; unsupported new runtime dependencies are compilation errors.
        body = re.sub(r"^\s*const int equationIndexes\[2\].*?;|^\s*threadData->lastEquationSolved = \d+;", "", body, flags=re.M)
        body = body.replace("data->simulationInfo->noThrowAsserts", "0").replace("data->simulationInfo->needToReThrow = 1;", "__builtin_trap();")
        return body

    for section, ids in schedule.items():
        pieces.append(f"static void {section}(void) {{")
        for i in ids:
            pieces += [f"  {{ /* OMC equation {i} */", flatten_storage(code[i]), "  }"]
        pieces.append("}")

    pieces.append("void reset(" + ", ".join("double " + n for n in PARAMETERS) + ") {")
    for name in PARAMETERS:
        pieces.append(f"  {slot(name)} = {name};")
    for name, value in constants.items():
        if not math.isfinite(value):
            raise ValueError("Non-finite compiler constant: " + name)
        pieces.append(f"  {slot(name)} = {value!r};")
    for name in states:
        value = float(scalars[name][0].get("start"))
        if not math.isfinite(value):
            raise ValueError("Non-finite initial state: " + name)
        pieces.append(f"  {slot(name)} = {value!r};")
    pieces += ["  parameter();", "  regular();", "}"]
    for name in OUTPUTS:
        pieces.append(f"double {name}(void) {{ return {slot(name)}; }}")
    pieces += [f"#define STATE_COUNT {len(states)}",
               "static const int state_index[] = {" + ",".join(str(variables[n]["index"]) for n in states) + "};",
               "static const int derivative_index[] = {" + ",".join(str(variables[n]["index"]) for n in derivatives) + "};"]
    return "\n".join(pieces) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="rebuild and compare the published files")
    args = parser.parse_args()
    omc = executable("OMC", "omc")
    clang = executable("CLANG", "clang-18")
    linker = executable("WASM_LD", "wasm-ld-18")
    if run([omc, "--version"]) != COMPILER:
        raise ValueError("The release kernel must use " + COMPILER)
    if not all("18.1.3" in run([tool, "--version"]) for tool in (clang, linker)):
        raise ValueError("The release kernel must use clang and LLD 18.1.3")
    library = json.loads(LIBRARY.read_text())
    version = library["uses"]["Modelica"]
    with tempfile.TemporaryDirectory(prefix="gouyuan-omc-web-") as temporary:
        work = Path(temporary)
        shutil.copyfile(MODEL, work / MODEL.name)
        script = (f'loadModel(Modelica, {{"{version}"}}, requireExactVersion=true); getErrorString();\n'
                  f'getVersion(Modelica);\nloadFile("{MODEL.name}"); getErrorString();\n'
                  f'setCommandLineOptions("{FLAGS}"); getErrorString();\n'
                  f'translateModel(Gouyuan.ServoAxis, fileNamePrefix="{PREFIX}"); getErrorString();\n')
        (work / "build.mos").write_text(script)
        log = run([omc, "build.mos"], work)
        if f'"{version}"' not in log.splitlines() or "false" in log.splitlines() or "Error:" in log:
            raise ValueError("Modelica translation failed:\n" + log)
        equations = emit_kernel(work)
        (work / "model-equations.h").write_text(equations)
        wrapper = Path(__file__).with_name("wasm-integrator.c")
        options = ["-O2", "--target=wasm32-unknown-unknown", "-ffreestanding", "-nostdlib",
                   "-fno-math-errno", "-ffp-contract=off", "-fno-ident", f"-fuse-ld={linker}",
                   "-Wl,--no-entry", "-Wl,--strip-all", "-Wl,--initial-memory=131072", "-Wl,--max-memory=131072"]
        options += ["-Wl,--export=" + n for n in ["reset", "step", *OUTPUTS]]
        subprocess.run([clang, *options, "-I", str(work), str(wrapper), "-o", "servo-axis.wasm"], cwd=work, check=True)
        wasm = (work / "servo-axis.wasm").read_bytes()
    manifest = {"model": library["assembly"]["id"], "version": library["version"], "msl": version,
                "parameters": PARAMETERS, "integrator": {"method": "RK4", "stepUs": 50},
                "compiler": COMPILER, "llvm": "18.1.3", "sourceSha256": digest(MODEL.read_bytes()),
                "librarySha256": digest(LIBRARY.read_bytes()), "equationsSha256": digest(equations.encode()),
                "wasmSha256": digest(wasm), "wasmBytes": len(wasm)}
    for filename, content in [("servo-axis.wasm", wasm),
                              ("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())]:
        output = MODEL_DIR / "runtime" / filename
        if args.check:
            if output.read_bytes() != content:
                raise ValueError(f"{output} differs from the freshly compiled model.")
        else:
            output.parent.mkdir(exist_ok=True)
            output.write_bytes(content)
    print(f"{COMPILER}, Modelica {version}, {len(wasm)} wasm bytes, sha256 {digest(wasm)}")


if __name__ == "__main__":
    main()
