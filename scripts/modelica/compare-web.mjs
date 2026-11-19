// Compare the released WASM with independent native DASSL runs on the same 10 ms grid.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const evidence = process.argv[2];
assert(evidence, "Usage: node scripts/modelica/compare-web.mjs <native verification directory>");
const assets = new URL("../../public/modelica/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("runtime/manifest.json", assets), "utf8"));
const wasm = readFileSync(new URL("runtime/servo-axis.wasm", assets));
const sha256 = data => createHash("sha256").update(data).digest("hex");
const native = JSON.parse(readFileSync(join(evidence, "native-results.json"), "utf8"));
assert.equal(native.passed, true, "Native validation failed");
assert.equal(native.solver, "DASSL");
assert.equal(native.servoTolerance, 1e-8);
assert.equal(native.sourceSha256, sha256(readFileSync(new URL("Gouyuan.mo", assets))));
assert.equal(native.sourceSha256, manifest.sourceSha256, "Native and browser models differ");
assert.equal(sha256(wasm), manifest.wasmSha256);
assert.equal(wasm.length, manifest.wasmBytes);

const requiredCases = ["normal", "negative", "load-5", "low-current", "zero", "zero-load",
  "speed-limit", "power-limit", "torque-limit", "double-rotor", "motor-current"];
for (const name of requiredCases) assert(name in native.servoCases, "Missing native case " + name);
const tolerance = { angleDeg: 0.005, speedRpm: 0.02, torqueNm: 0.00002 };
const outputs = Object.keys(tolerance);
const stepSeconds = manifest.integrator.stepUs / 1_000_000;
const stepsPerSample = 10_000 / manifest.integrator.stepUs;
assert(Number.isInteger(1_000 / manifest.integrator.stepUs), "Integration step must divide one millisecond");
const module = new WebAssembly.Module(wasm);
const results = {};
for (const [name, reference] of Object.entries(native.servoCases)) {
  assert.equal(reference.csv, `servo-${name}.csv`);
  const csv = readFileSync(join(evidence, reference.csv));
  assert.equal(sha256(csv), reference.csvSha256, "Native CSV digest mismatch: " + name);
  const [header, ...rows] = csv.toString("utf8").trimEnd().split(/\r?\n/);
  const columns = header.split(",").map(field => field.replace(/^"|"$/g, ""));
  assert.deepEqual(columns, ["time", ...outputs]);
  assert.equal(rows.length, 801, name + " must cover 0–8 seconds at 10 ms");
  assert.equal(rows.length, reference.samples);
  const args = manifest.parameters.map(key => reference.parameters[key]);
  assert(args.every(Number.isFinite), name + " has missing or non-numeric parameters");
  const axis = new WebAssembly.Instance(module).exports;
  axis.reset(...args);
  const maxAbsError = Object.fromEntries(outputs.map(key => [key, 0]));
  for (const [index, row] of rows.entries()) {
    const fields = row.split(",");
    assert(fields.length === columns.length && fields.every(x => x.trim().length), name + " has missing observations");
    const values = fields.map(Number);
    assert(values.every(Number.isFinite) && Math.abs(values[0] - index / 100) < 1e-9, name + " has an invalid sample");
    if (index) {
      for (let i = 0; i < stepsPerSample; i++) axis.step(stepSeconds);
    }
    for (const [j, key] of outputs.entries()) {
      const error = Math.abs(axis[key]() - values[j + 1]);
      assert(Number.isFinite(error), `${name} at ${values[0]} s: non-finite ${key}`);
      maxAbsError[key] = Math.max(maxAbsError[key], error);
    }
  }
  results[name] = { passed: outputs.every(key => maxAbsError[key] <= tolerance[key]), samples: rows.length, maxAbsError };
}
const wholeRun = Object.fromEntries(outputs.map(key => [key,
  Math.max(...Object.values(results).map(result => result.maxAbsError[key]))]));
const failures = Object.keys(results).filter(name => !results[name].passed);
const report = { passed: failures.length === 0, sourceSha256: native.sourceSha256, wasmSha256: manifest.wasmSha256,
  nativeSolver: native.solver, nativeTolerance: native.servoTolerance, webIntegrator: manifest.integrator.method,
  stepSeconds, outputPeriodSeconds: 0.01, maxAllowedAbsError: tolerance, maxAbsError: wholeRun, cases: results };
writeFileSync(join(evidence, "web-comparison.json"), JSON.stringify(report, null, 2) + "\n");
assert(report.passed, "Browser/native tolerance exceeded in " + failures.join(", ") + ". See web-comparison.json.");
console.log(`${Object.keys(results).length} browser/native comparisons × 801 samples × 3 signals passed. Maximum absolute errors:`, wholeRun);
