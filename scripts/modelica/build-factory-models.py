#!/usr/bin/env python3
"""Compile the registered factory devices' scalar OpenModelica C equations to WebAssembly."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


ASSETS = Path(__file__).resolve().parents[2] / "public/modelica"
REGISTRY = ASSETS / "factory-library.json"
COMPILER = "OpenModelica 1.27.2"
OUTPUT_UNITS = {"serviceS": "s", "emptySPerM": "s/m", "loadedSPerM": "s/m", "pickS": "s", "dropS": "s"}
ROLE_CODES = {"handle": 1, "machine": 2, "conveyor": 3, "mobile": 4}
PARAM_SLOTS = 4
FLAGS = "--preOptModules-=removeSimpleEquations --postOptModules-=removeSimpleEquations"

# Keep the native assignment functions intact. Only the flat real-variable storage and
# the checked division diagnostic need an ABI for these stateless, closed-form models.
PRELUDE = r"""
typedef struct { double realVars[5]; } LocalData;
typedef struct { const int *realVarsIndex, *realParamsIndex; double realParameter[4]; int noThrowAsserts, needToReThrow; } Info;
typedef struct { LocalData *localData[1]; Info *simulationInfo; } DATA;
typedef struct { int lastEquationSolved; } threadData_t;
typedef struct { const char *file; int line, column, endLine, endColumn, readonly; } FILE_INFO;
typedef int modelica_boolean;
#define MMC_DEFSTRINGLIT(name,size,text) char name[] = text
#define Greater(a,b) ((a) > (b))
#define GreaterEq(a,b) ((a) >= (b))
#define Less(a,b) ((a) < (b))
#define LessEq(a,b) ((a) <= (b))
#define infoStreamPrintWithEquationIndexes(...) ((void)0)
#define omc_assert_withEquationIndexes(...) (data->simulationInfo->needToReThrow = 1)
static double divide(DATA *data, double a, double b) {
    if (b == 0.0) { data->simulationInfo->needToReThrow = 1; return 0; }
    return a/b;
}
#define DIVISION_SIM(a,b,...) divide(data,(a),(b))
static double result[5];
static const int slots[5] = {0, 1, 2, 3, 4};
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(cmd, cwd=None):
    result = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            encoding="utf-8", errors="replace", timeout=300)
    require(result.returncode == 0, f"{cmd[0]} failed:\n{result.stdout}")
    return result.stdout


def native_device(work, spec):
    prefix = "Device" + str(spec["code"])
    info = json.loads((work / (prefix + "_info.json")).read_text(encoding="utf-8"))
    xml = ET.parse(work / (prefix + "_init.xml")).getroot()
    require(info["info"]["name"] == spec["id"] == xml.get("modelName"), "Compiler model ID differs")
    for count in ("numberOfContinuousStates", "numberOfEventIndicators", "numberOfTimeEvents",
                  "numberOfInputVariables", "numberOfExternalObjects", "numberOfFunctions"):
        require(xml.get(count) == "0", f"{spec['id']}: static device ABI cannot represent {count}")
    variables = info["variables"]
    scalars = {v.get("name"): v for v in xml.findall(".//ScalarVariable")}
    params = spec["parameters"]
    names = {p["key"] for p in params}
    role = spec["role"] + "Role"
    require(role in variables and variables[role]["kind"] == "constant" and variables[role]["type"] == "Integer",
            "Device does not implement its registered role: " + spec["id"])
    require(len(names) == len(params) <= PARAM_SLOTS and set(scalars) == names | set(OUTPUT_UNITS)
            and set(variables) == set(scalars) | {role},
            f"{spec['id']}: the registry and the compiler must describe exactly the same scalar interface")
    require({variables[n]["index"] for n in OUTPUT_UNITS} == set(range(5)), "Unexpected native output slots")
    require({variables[n]["index"] for n in names} == set(range(len(names))), "Unexpected native parameter slots")
    for name, unit in OUTPUT_UNITS.items():
        scalar = scalars[name]
        require(scalar.get("causality") == "output" and scalar[0].tag == "Real" and scalar[0].get("unit") == unit,
                "Output unit or type differs: " + name)
    setup = []
    for i, p in enumerate(params):
        name = p["key"]
        scalar = scalars[name]
        require(scalar.get("causality") == "parameter" and scalar[0].tag == "Real" and scalar[0].get("unit") == p["unit"]
                and float(scalar[0].get("start")) == p["default"], "Parameter or default differs: " + name)
        operator = ">" if p["positive"] else ">="
        setup.append(f"if (!__builtin_isfinite(a{i}) || !(a{i} {operator} 0.0)) return 2;")
        for bound, compare in (("min", "<"), ("max", ">")):
            if bound in scalar[0].attrib:
                setup.append(f"if (a{i} {compare} {float(scalar[0].get(bound))!r}) return 2;")
        setup.append(f"info.realParameter[{variables[name]['index']}] = a{i};")
    equations = [eq for eq in info["equations"] if eq.get("section") == "regular"]
    native = (work / (prefix + ".c")).read_text(encoding="utf-8")
    bodies, calls, assigned = [], [], []
    def add_function(eq, code):
        function = prefix + "_eqFunction_" + str(eq["eqIndex"])
        body = re.search(r"^void " + function + r"\(DATA \*data, threadData_t \*threadData\)\s*\{.*?^\}", code, re.S | re.M)
        require(body, "Missing native C function " + function)
        # FILE_INFO diagnostics include the per-build scratch path.
        bodies.append("static " + body[0].replace(str(work) + "/", ""))
        calls.append(function + "(&data, &thread);")

    for eq in equations:
        require(eq["tag"] == "assign" and len(eq["defines"]) == 1 and eq["defines"][0] in OUTPUT_UNITS
                and set(eq.get("uses", [])) <= names, "Expected a pure scalar output assignment to device parameters")
        add_function(eq, native)
        assigned.extend(eq["defines"])
    require(sorted(assigned) == sorted(OUTPUT_UNITS), "Each device output must have one native equation")
    initial = (work / (prefix + "_06inz.c")).read_text(encoding="utf-8")
    for eq in info["equations"]:
        if eq.get("section") == "initial" and eq["tag"] != "alias":
            require(eq["tag"] == "algorithm" and all(s.startswith("assert(") for s in eq["equation"]),
                    "Static devices may initialise with assertions only")
            add_function(eq, initial)
    calls.append("if (info.needToReThrow) return 2;")
    copy = [f"result[{i}] = local.realVars[{variables[name]['index']}];" for i, name in enumerate(OUTPUT_UNITS)]
    return "\n".join(bodies), "\n".join([f"case {spec['code']}:", *setup, *calls, *copy, "break;"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    omc = os.environ.get("OMC", "omc")
    clang = os.environ.get("CLANG", "clang-18")
    linker = shutil.which(os.environ.get("WASM_LD", "wasm-ld-18"))
    require(linker and all("18.1.3" in run([tool, "--version"]) for tool in (clang, linker)), "Need Clang and LLD 18.1.3")
    require(run([omc, "--version"]).strip() == COMPILER, "Need " + COMPILER)
    catalog = json.loads(REGISTRY.read_text(encoding="utf-8"))
    models, outputs = catalog["models"], list(OUTPUT_UNITS)
    codes, ids = [m["code"] for m in models], [m["id"] for m in models]
    require(all(type(code) is int and code > 0 for code in codes) and len(set(codes)) == len(set(ids)) == len(models),
            "Device codes and qualified names must be unique")
    require(outputs == catalog["outputs"], "Output ABI differs from the registry")
    source = ASSETS / catalog["source"]
    with tempfile.TemporaryDirectory(prefix="gouyuan-factory-models-") as tmp:
        work = Path(tmp)
        local_source = work / catalog["source"]
        local_source.parent.mkdir()
        shutil.copyfile(source, local_source)
        msl = catalog["uses"]["Modelica"]
        mos = [f'loadModel(Modelica, {{"{msl}"}}, requireExactVersion=true);',
               f'loadFile("{catalog["source"]}"); getErrorString();',
               f'if getVersion(Modelica) <> "{msl}" or getVersion(GouyuanFactory) <> "{catalog["version"]}" then exit(1); end if;',
               f'setCommandLineOptions("{FLAGS}");']
        for m in models:
            mos += [f'if {m["id"]}.{m["role"]}Role <> {ROLE_CODES[m["role"]]} then exit(1); end if;',
                    f'translateModel({m["id"]}, fileNamePrefix="Device{m["code"]}"); getErrorString();']
        (work / "compile.mos").write_text("\n".join(mos) + "\n", encoding="utf-8")
        log = run([omc, "compile.mos"], work)
        require("false" not in log.splitlines() and "Error:" not in log, log)
        devices = [native_device(work, m) for m in models]
        parts = [PRELUDE, *(functions for functions, _ in devices),
                 "int evaluate(int code, double a0, double a1, double a2, double a3) {",
                 "LocalData local; Info info; info.realVarsIndex = slots; info.realParamsIndex = slots;",
                 "info.noThrowAsserts = 1; info.needToReThrow = 0;",
                 "threadData_t thread = {0}; DATA data = {{&local}, &info};",
                 "for (int i = 0; i < 5; i++) result[i] = 0.0;", "switch(code) {",
                 *(case for _, case in devices), "default: return 1; }",
                 "for (int i = 0; i < 5; i++) if (!__builtin_isfinite(result[i]) || result[i] < 0.0) return 3;",
                 "return 0; }",
                 *(f"double {name}(void) {{ return result[{i}]; }}" for i, name in enumerate(outputs))]
        kernel = "\n".join(parts) + "\n"
        (work / "devices.c").write_text(kernel, encoding="utf-8")
        flags = ["-O2", "--target=wasm32-unknown-unknown", "-ffreestanding", "-nostdlib", "-ffp-contract=off",
                 "-fno-ident", f"-fuse-ld={linker}", "-Wl,--no-entry", "-Wl,--strip-all"]
        exports = ["-Wl,--export=" + symbol for symbol in ["evaluate", *outputs]]
        run([clang, *flags, *exports, "devices.c", "-o", "devices.wasm"], work)
        wasm = (work / "devices.wasm").read_bytes()
    manifest = {"model": catalog["package"], "version": catalog["version"], "compiler": COMPILER, "llvm": "18.1.3",
                "msl": msl, "parameterSlots": PARAM_SLOTS, "outputs": outputs, "sourceSha256": digest(source.read_bytes()),
                "librarySha256": digest(REGISTRY.read_bytes()), "equationsSha256": digest(kernel.encode()),
                "wasmSha256": digest(wasm), "wasmBytes": len(wasm)}
    for name, data in [("factory-models.wasm", wasm), ("factory-models.json", (json.dumps(manifest, indent=2) + "\n").encode())]:
        path = ASSETS / "runtime" / name
        if args.check:
            require(path.read_bytes() == data, f"Recompiled artifact differs: {name}")
        else:
            path.write_bytes(data)
    print(f"{len(models)} OpenModelica device models, {len(wasm)} wasm bytes, SHA-256 {digest(wasm)}")


if __name__ == "__main__":
    main()
