/** Materialize the same editable Modelica source as the browser download and its independently executed WASM results. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { parseWorkspace } from "../../contracts/twin-simulation";
import { replaceFactoryResourcePackage, resolveFactoryLayout } from "../../contracts/factory";
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
const ws = parseWorkspace(JSON.parse(bytes("assemblies/cnc-factory/project.twin.json").toString("utf8")));
const wasm = (name: string) => {
  const base = "modelica/runtime/factory-" + name;
  const body = bytes(base + ".wasm"), manifest = JSON.parse(bytes(base + ".json").toString("utf8"));
  if (digest(body) !== manifest.wasmSha256) throw new Error("Mismatched WASM: " + name);
  return new WebAssembly.Module(body);
};
const device = wasm("models"), scheduler = wasm("scheduler");
for (const scenario of ["baseline", "fast-amr", "alternate-cnc", "single-cnc"]) {
  const layout = structuredClone(ws.factories![0]);
  if (scenario === "fast-amr" || scenario === "alternate-cnc") {
    const mobile = scenario === "fast-amr", id = mobile ? "amr" : "cnc-a";
    const file = mobile ? "amr-fast" : "cnc-feed";
    const replacement = JSON.parse(bytes("assemblies/cnc-factory/devices/" + file + ".device.json").toString("utf8"));
    const key = packageKey(replacement), row = ws.catalog!.materials.find(r => r.binding?.key === key)!;
    layout.resources = layout.resources.map(r => r.id === id ? { ...replaceFactoryResourcePackage(r, replacement), materialId: row.id } : r);
  } else if (scenario === "single-cnc") {
    layout.resources = layout.resources.filter(r => r.id !== "cnc-b");
    for (const line of layout.lines) for (const stage of line.stages) stage.stations = stage.stations.filter(id => id !== "cnc-b");
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
    schedulerSha256: digest(bytes("modelica/GouyuanFactory/Resources/Include/factory_schedule.h")) }));
  console.log(`${scenario}: ${result.jobs.length} jobs, ${result.operations.length} operations, ${result.makespanS.toFixed(6)} s`);
}
