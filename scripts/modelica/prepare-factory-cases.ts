/** Materialize the same editable Modelica source as the browser download and its independently executed WASM results. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import process from "node:process";
import { parseWorkspace, type TwinWorkspace } from "../../contracts/twin-simulation";
import { replaceFactoryResourcePackage, resolveFactoryLayout, type FactoryLayout } from "../../contracts/factory";
import { compositionPath, deriveDeviceComposition } from "../../contracts/device-composition-edit";
import { applyFactoryStructureRevision } from "../../contracts/factory-structure";
import { packageKey } from "../../contracts/twin-device";
import { factoryInputs, scheduleFactory } from "../../src/lib/factory-kernel";
import { factoryModelicaFiles } from "../../src/lib/factory-modelica";
import { readFactoryRun } from "../../src/lib/factory-runtime";

const evidence = process.argv[2];
if (!evidence) throw new Error("Usage: tsx scripts/modelica/prepare-factory-cases.ts <verification-directory>");
const root = fileURLToPath(new URL("../../public/", import.meta.url));
const path = (asset: string) => join(root, asset);
const bytes = (asset: string) => readFileSync(path(asset));
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const original = parseWorkspace(JSON.parse(bytes("assemblies/cnc-factory/project.twin.json").toString("utf8")));
const wasm = (name: string) => {
  const base = "modelica/runtime/factory-" + name;
  const body = bytes(base + ".wasm"), manifest = JSON.parse(bytes(base + ".json").toString("utf8"));
  if (digest(body) !== manifest.wasmSha256) throw new Error("Mismatched WASM: " + name);
  return new WebAssembly.Module(body);
};
const device = wasm("models"), scheduler = wasm("scheduler");

function reduceCncFeed(workspace: TwinWorkspace, layout: FactoryLayout) {
  const machine = layout.resources.find(r => r.id === "cnc-b")!;
  const parentPath = ["feed"], partPath = [...parentPath, "x"];
  const originalParts = compositionPath(workspace.packages, machine.packageKey, partPath);
  const feed = originalParts[1].composition;
  assert(feed?.kind === "assembly" && originalParts[2].model === "FEED-AXIS-900");
  const slow = packageKey({ manufacturer: "构元教学件", model: "FEED-AXIS-600", revision: "1" });
  const changed = { ...feed, parts: feed.parts.map(p => p.id === "x" ? { ...p, packageKey: slow } : p) };
  const edit = deriveDeviceComposition(workspace, machine.packageKey, parentPath, changed, "2-reduced-feed");
  const applied = applyFactoryStructureRevision(workspace, layout, machine.id, machine.packageKey, edit.workspace, edit.rootKey);
  assert.deepEqual(applied.layout.lines, layout.lines);
  assert.deepEqual(applied.layout.resources.filter(r => r.id !== machine.id), layout.resources.filter(r => r.id !== machine.id));
  const newParts = compositionPath(applied.workspace.packages, edit.rootKey, partPath);
  assert.notEqual(packageKey(newParts[1]), packageKey(originalParts[1]));
  assert.equal(packageKey(newParts[2]), slow);
  return applied;
}

for (const scenario of ["baseline", "fast-amr", "alternate-cnc", "single-cnc", "reduced-feed-part"]) {
  let ws = original, layout = structuredClone(original.factories![0]);
  if (scenario === "fast-amr" || scenario === "alternate-cnc") {
    const mobile = scenario === "fast-amr", id = mobile ? "amr" : "cnc-a";
    const file = mobile ? "amr-fast" : "cnc-feed";
    const replacement = JSON.parse(bytes("assemblies/cnc-factory/devices/" + file + ".device.json").toString("utf8"));
    const key = packageKey(replacement), row = ws.catalog!.materials.find(r => r.binding?.key === key)!;
    layout.resources = layout.resources.map(r => r.id === id ? { ...replaceFactoryResourcePackage(r, replacement), materialId: row.id } : r);
  } else if (scenario === "single-cnc") {
    layout.resources = layout.resources.filter(r => r.id !== "cnc-b");
    for (const line of layout.lines) for (const stage of line.stages) stage.stations = stage.stations.filter(id => id !== "cnc-b");
  } else if (scenario === "reduced-feed-part") {
    ({ workspace: ws, layout } = reduceCncFeed(ws, layout));
  }
  const factory = resolveFactoryLayout(ws, layout), input = factoryInputs(factory, device);
  const records = scheduleFactory(scheduler, input), result = readFactoryRun(factory, records);
  const dest = resolve(evidence, "factory-cases", scenario);
  mkdirSync(dest, { recursive: true });
  const files = factoryModelicaFiles(factory, result.makespanS);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dest, name), text);
  for (const name of ["GouyuanFactory/package.mo", "GouyuanFactory/Resources/Include/factory_schedule.h"]) {
    mkdirSync(dirname(join(dest, name)), { recursive: true });
    copyFileSync(path("modelica/" + name), join(dest, name));
  }
  const { nr, ns, nj } = input;
  writeFileSync(join(dest, "expected.json"), JSON.stringify({ nr, ns, nj, jobs: [...input.releases],
    resources: [...input.coefficients], mask: [...input.mask], records: [...records], makespanS: result.makespanS,
    sourceSha256: digest(Buffer.from(files["FactoryRun.mo"])), modelSha256: digest(bytes("modelica/GouyuanFactory/package.mo")),
    mapSha256: digest(Buffer.from(files["factory-map.json"])),
    schedulerSha256: digest(bytes("modelica/GouyuanFactory/Resources/Include/factory_schedule.h")) }));
  console.log(`${scenario}: ${result.jobs.length} jobs, ${result.operations.length} operations, ${result.makespanS.toFixed(6)} s`);
}
