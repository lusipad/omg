"""Build/check the browser event scheduler from the same C header used by GouyuanFactory.schedule."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HEADER = ROOT / "public/modelica/GouyuanFactory/Resources/Include/factory_schedule.h"
WRAPPER = Path(__file__).with_name("factory-scheduler-wasm.c")
RUNTIME = ROOT / "public/modelica/runtime"
EXPORTS = ["factory_resources_ptr", "factory_mask_ptr", "factory_jobs_ptr", "factory_records_ptr", "factory_run"]


def tool(variable, default):
    name = os.environ.get(variable, default)
    path = shutil.which(name)
    if not path or "18.1.3" not in subprocess.check_output([path, "--version"], text=True):
        raise SystemExit(f"{variable} must point to LLVM {default} version 18.1.3.")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare rebuilt files with release assets")
    args = parser.parse_args()
    clang = tool("CLANG", "clang-18")
    linker = tool("WASM_LD", "wasm-ld-18")
    with tempfile.TemporaryDirectory(prefix="gouyuan-factory-scheduler-") as tmp:
        output = Path(tmp) / "scheduler.wasm"
        command = [clang, "--target=wasm32-unknown-unknown", "-std=c11", "-Wall", "-Wextra", "-Werror",
                   "-O2", "-ffreestanding", "-nostdlib", "-mbulk-memory", "-fno-ident", "-fno-math-errno",
                   "-ffp-contract=off", f"-fuse-ld={linker}", "-Wl,--no-entry", "-Wl,--strip-all",
                   "-Wl,--initial-memory=196608", "-Wl,--max-memory=196608", "-I", str(HEADER.parent)]
        subprocess.run(command + ["-Wl,--export=" + symbol for symbol in EXPORTS] +
                       [str(WRAPPER), "-o", str(output)], check=True)
        wasm = output.read_bytes()
    sha = lambda data: hashlib.sha256(data).hexdigest()
    manifest = {
        "model": "GouyuanFactory.schedule", "version": "1.0.0", "llvm": "18.1.3",
        "sourceSha256": sha(HEADER.read_bytes()), "wrapperSha256": sha(WRAPPER.read_bytes()),
        "wasmBytes": len(wasm), "wasmSha256": sha(wasm),
        "limits": {"resources": 32, "stages": 16, "jobs": 64},
        "jobColumns": ["firstStage", "lastStage", "releaseS"],
        "resourceColumns": ["role", "xM", "yM", "serviceS", "emptySPerM", "loadedSPerM", "pickS", "dropS"],
        "recordColumns": ["station", "carrier", "fromStation", "carrierOrigin", "readyS", "dispatchS",
                          "pickupStartS", "loadedStartS", "dropStartS", "serviceStartS", "finishS"],
    }
    files = {"factory-scheduler.wasm": wasm, "factory-scheduler.json": (json.dumps(manifest, indent=2) + "\n").encode()}
    for filename, content in files.items():
        path = RUNTIME / filename
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                raise SystemExit(f"Factory scheduler release artifact differs: {filename}")
        else:
            path.write_bytes(content)
    print(f"Factory scheduler 1.0.0: {len(wasm)} bytes, sha256 {manifest['wasmSha256']}")


if __name__ == "__main__":
    main()
