// Compare the released WASM with independent native DASSL runs on the same 10 ms grid.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const evidence = process.argv[2], model = process.argv[3] ?? "servo";
assert(evidence && ["servo", "feed"].includes(model), "Usage: node scripts/modelica/compare-web.mjs <native verification directory> [servo|feed]");
const profiles = {
  servo: {
    registry: "library.json", manifest: "manifest.json", nativeReport: "native-results.json", report: "web-comparison.json",
    required: ["normal", "negative", "load-5", "low-current", "zero", "zero-load", "speed-limit", "power-limit", "torque-limit", "double-rotor", "motor-current"],
    tolerance: { angleDeg: 0.005, speedRpm: 0.02, torqueNm: 0.00002 },
  },
  feed: {
    registry: "linear-library.json", manifest: "feed-axis.json", nativeReport: "feed-native-results.json", report: "feed-web-comparison.json",
    required: ["normal", "negative", "zero", "lead-10", "mass-25", "low-current", "power-limit", "speed-limit", "other-motor"],
    tolerance: { positionMm: 0.0005, velocityMmS: 0.01, motorTorqueNm: 0.00002, axialForceN: 0.01, angleDeg: 0.005, speedRpm: 0.02 },
  },
};
const profile = profiles[model];
const assets = new URL("../../public/modelica/", import.meta.url);
const asset = name => readFileSync(new URL(name, assets));
const registry = JSON.parse(asset(profile.registry));
const manifest = JSON.parse(asset("runtime/" + profile.manifest));
const wasm = asset(`runtime/${model}-axis.wasm`);
const sha256 = data => createHash("sha256").update(data).digest("hex");
const native = JSON.parse(readFileSync(join(evidence, profile.nativeReport), "utf8"));
const cases = model === "servo" ? native.servoCases : native.cases;
const nativeTolerance = model === "servo" ? native.servoTolerance : native.tolerance;
const tolerance = profile.tolerance, outputs = Object.keys(tolerance);
assert.equal(native.passed, true, "Native validation failed");
assert.equal(native.solver, "DASSL");
assert.equal(nativeTolerance, 1e-8);
assert.equal(manifest.model, registry.assembly.id);
assert.equal(manifest.version, registry.version);
assert.equal(manifest.librarySha256, sha256(asset(profile.registry)));
assert.equal(native.sourceSha256, sha256(asset(registry.source)));
assert.equal(native.sourceSha256, manifest.sourceSha256, "Native and browser models differ");
if (model === "feed") {
  assert.equal(native.model, manifest.model);
  assert.deepEqual(manifest.outputs, outputs);
  assert.deepEqual(manifest.dependencySha256, { "Gouyuan.mo": sha256(asset("Gouyuan.mo")) });
  assert.equal(native.dependencySha256, manifest.dependencySha256["Gouyuan.mo"]);
}
assert.equal(sha256(wasm), manifest.wasmSha256);
assert.equal(wasm.length, manifest.wasmBytes);

for (const name of profile.required) assert(Object.hasOwn(cases, name), "Missing native case " + name);
const stepSeconds = manifest.integrator.stepUs / 1_000_000;
const stepsPerSample = 10_000 / manifest.integrator.stepUs;
assert(stepSeconds > 0 && Number.isInteger(1_000 / manifest.integrator.stepUs), "Positive integration step must divide one millisecond");
const module = new WebAssembly.Module(wasm);
const results = {};
for (const [name, reference] of Object.entries(cases)) {
  assert.match(name, /^[a-z0-9-]+$/);
  assert.equal(reference.csv, `${model}-${name}.csv`);
  const csv = readFileSync(join(evidence, reference.csv));
  assert.equal(sha256(csv), reference.csvSha256, "Native CSV digest mismatch: " + name);
  const [header, ...rows] = csv.toString("utf8").trimEnd().split(/\r?\n/);
  const columns = header.split(",").map(field => field.replace(/^"|"$/g, ""));
  if (model === "servo") assert.deepEqual(columns, ["time", ...outputs]);
  // The feed benchmark retains acceleration and shaft channels for its independent
  // force/power balance. OMC chooses the order of its native output columns.
  assert.equal(columns[0], "time");
  assert.equal(new Set(columns).size, columns.length, "Duplicate native column");
  const outputColumns = outputs.map(key => columns.indexOf(key));
  assert(outputColumns.every(index => index > 0), "Missing output column in " + name);
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
      const error = Math.abs(axis[key]() - values[outputColumns[j]]);
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
  nativeSolver: native.solver, nativeTolerance, webIntegrator: manifest.integrator.method,
  stepSeconds, outputPeriodSeconds: 0.01, maxAllowedAbsError: tolerance, maxAbsError: wholeRun, cases: results };
writeFileSync(join(evidence, profile.report), JSON.stringify(report, null, 2) + "\n");
assert(report.passed, "Browser/native tolerance exceeded in " + failures.join(", ") + ". See " + profile.report);
console.log(`${Object.keys(results).length} browser/native comparisons × 801 samples × ${outputs.length} signals passed. Maximum absolute errors:`, wholeRun);
