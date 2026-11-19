/** Build and install actual catalog parts, then exercise the same archive and integration functions used by the workbench. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { buildServoMotor, installMotorOnFactoryAxis, resolveMotorAxis, setMotorAxisTarget } from "../../contracts/motor-assembly";
import { upsertFactoryLayout } from "../../contracts/factory";
import { installPackage, parseWorkspace } from "../../contracts/twin-simulation";
import { packageKey } from "../../contracts/twin-device";
import { exportMotorAxis } from "../../src/lib/motor-axis-export";
import { runMotorSamples, type MotorAxisSample } from "../../src/lib/modelica-motor-runtime";
import manifest from "../../public/modelica/runtime/motor-axis.json";

if (!process.argv[2]) throw new Error("Usage: tsx scripts/modelica/prepare-motor-assemblies.ts <verification-directory>");
const out = resolve(process.argv[2], "motor-assemblies");
const publicRoot = new URL("../../public/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, publicRoot));
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const original = parseWorkspace(JSON.parse(read("assemblies/cnc-factory/project.twin.json").toString("utf8")));
const layout = original.factories![0], resourceId = "cnc-a", axisId = "x";
const findPart = (model: string) => {
  const part = original.packages.find(p => p.manufacturer === "构元教学件" && p.model === model && p.revision === "1");
  assert(part, "Uninstalled test part: " + model);
  return packageKey(part);
};
const wasm = read("modelica/runtime/motor-axis.wasm");
assert.equal(digest(wasm), manifest.wasmSha256);
const kernel = new WebAssembly.Module(wasm);
const cases = [
  { id: "standard", stator: "S40-STD", rotor: "R40-STD", bearing: "B08-STD", target: 10 },
  { id: "high-inductance", stator: "S40-HL", rotor: "R40-STD", bearing: "B08-STD", target: 10 },
  { id: "high-inertia", stator: "S40-STD", rotor: "R40-HI", bearing: "B08-STD", target: 10 },
  { id: "high-damping", stator: "S40-STD", rotor: "R40-STD", bearing: "B08-HI", target: 10 },
  { id: "reverse", stator: "S40-STD", rotor: "R40-STD", bearing: "B08-STD", target: -10 },
];

// Supply the published same-origin files to the real download entry point under Node.
globalThis.fetch = async input => {
  const path = new URL(String(input), "https://studio.local").pathname;
  if (path !== "/modelica/Gouyuan.mo" && path !== "/modelica/GouyuanMotor.mo") throw new Error("Unexpected source " + path);
  return new Response(Uint8Array.from(read(path.slice(1))));
};

for (const test of cases) {
  const selection = { statorKey: findPart(test.stator), rotorKey: findPart(test.rotor), bearingKey: findPart(test.bearing) };
  const motor = buildServoMotor(original, { manufacturer: "装配试验", model: "自组伺服电机", revision: test.id, ...selection });
  const installed = installMotorOnFactoryAxis(installPackage(original, motor), layout, resourceId, axisId, packageKey(motor), "motor-" + test.id);
  const edited = setMotorAxisTarget(installed.layout, resourceId, axisId, test.target);
  const workspace = parseWorkspace(JSON.parse(JSON.stringify(upsertFactoryLayout(installed.workspace, edited))));
  const experiment = workspace.factories!.find(f => f.id === layout.id)!;
  assert.deepEqual(experiment.resources.filter(r => r.id !== resourceId), layout.resources.filter(r => r.id !== resourceId));
  const axis = resolveMotorAxis(workspace, experiment, resourceId, axisId);
  assert.equal(axis.parameters.targetMm, test.target);
  assert.equal(axis.motorKey, packageKey(motor));
  const archive = new Uint8Array(await (await exportMotorAxis(workspace, experiment, resourceId, axisId, test.target)).arrayBuffer());
  const { samples, settled } = await runMotorSamples(axis.parameters, kernel);
  const fields = ["timeMs", ...manifest.outputs] as (keyof MotorAxisSample)[];
  const csv = [fields.join(","), ...samples.map(row => fields.map(key => row[key]).join(","))].join("\n") + "\n";
  const dir = join(out, test.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "experiment.zip"), archive);
  writeFileSync(join(dir, "browser.csv"), csv);
  writeFileSync(join(dir, "expected.json"), JSON.stringify({ case: test.id, axisId, resourceId, targetMm: test.target,
    motorKey: packageKey(motor), selection, settled, samples: samples.length, archiveSha256: digest(archive),
    browserCsvSha256: digest(csv), wasmSha256: manifest.wasmSha256 }, null, 2) + "\n");
  console.log(`${test.id}: ${samples.length} samples to ${samples.at(-1)!.timeMs} ms, settled=${settled}`);
}
