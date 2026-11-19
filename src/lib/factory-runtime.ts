import { resolveFactoryLayout, type FactoryLayout, type FactoryRole, type ResolvedFactoryLayout } from "@contracts/factory";
import type { ModelReference } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import library from "../../public/modelica/factory-library.json";
import deviceManifest from "../../public/modelica/runtime/factory-models.json";
import scheduleManifest from "../../public/modelica/runtime/factory-scheduler.json";
import { factoryInputs, recordWidth, scheduleFactory, type FactoryInputs } from "./factory-kernel";
import { loadModelicaModule } from "./modelica-runtime";

export interface FactoryOperation {
  jobId: string; lineId: string; stageId: string; stationId: string;
  carrierId?: string; fromStationId?: string; carrierOriginId?: string;
  readyS: number; dispatchS: number; pickupStartS: number; loadedStartS: number; dropStartS: number; serviceStartS: number; finishS: number;
}
export interface FactoryRunResource {
  id: string; name: string; role: FactoryRole; modelRef: ModelReference; positionM: [number, number]; busyS: number; reservedS: number;
}
export interface FactoryJob { id: string; lineId: string; serial: number; releaseS: number; finishS: number }
export interface FactoryRunResult { operations: FactoryOperation[]; resources: FactoryRunResource[]; jobs: FactoryJob[]; makespanS: number }

function scheduleInBrowser(module: WebAssembly.Module, input: FactoryInputs, signal?: AbortSignal): Promise<Float64Array> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") return Promise.resolve(scheduleFactory(module, input));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./factory.worker.ts", import.meta.url), { type: "module" });
    function close() { worker.terminate(); signal?.removeEventListener("abort", abort); }
    function abort() { close(); reject(signal?.reason ?? new DOMException("仿真已取消", "AbortError")); }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<Float64Array | { error: string }>) => {
      close();
      if (event.data instanceof Float64Array) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = event => { close(); reject(new Error(event.message || "工厂仿真线程无法启动。")); };
    try { worker.postMessage({ module, input }); }
    catch (cause) { close(); reject(cause); }
  });
}

export function readFactoryRun(factory: ResolvedFactoryLayout, records: Float64Array): FactoryRunResult {
  const resources: FactoryRunResource[] = factory.resources.map(({ resource, device, model }) => ({
    id: resource.id, name: resource.name, positionM: resource.positionM, role: model.role, modelRef: device.factory!.modelRef, busyS: 0, reservedS: 0,
  }));
  const operations: FactoryOperation[] = [];
  const jobs = factory.jobs.map(({ line, serial, firstStage, lastStage, releaseS }, j) => {
    const jobId = `${line.id}/${serial}`;
    let finishS = releaseS;
    for (let s = firstStage - 1; s < lastStage; s++) {
      const at = (j * factory.stages.length + s) * recordWidth;
      const [station, carrier, from, origin, readyS, dispatchS, pickupStartS, loadedStartS, dropStartS, serviceStartS, end] = records.subarray(at, at + recordWidth);
      const work = resources[station - 1], vehicle = resources[carrier - 1];
      work.busyS += end - serviceStartS;
      work.reservedS += serviceStartS - dispatchS;
      if (vehicle) vehicle.busyS += serviceStartS - dispatchS;
      operations.push({ jobId, lineId: line.id, stageId: factory.stages[s].stage.id, stationId: work.id,
        carrierId: vehicle?.id, fromStationId: resources[from - 1]?.id, carrierOriginId: resources[origin - 1]?.id,
        readyS, dispatchS, pickupStartS, loadedStartS, dropStartS, serviceStartS, finishS: end });
      finishS = end;
    }
    return { id: jobId, lineId: line.id, serial, releaseS, finishS };
  });
  return { resources, jobs, operations, makespanS: Math.max(...jobs.map(job => job.finishS)) };
}

export async function runFactory(workspace: TwinWorkspace, layout: FactoryLayout, signal?: AbortSignal): Promise<FactoryRunResult> {
  signal?.throwIfAborted();
  const factory = resolveFactoryLayout(workspace, layout);
  const [deviceModule, scheduler] = await Promise.all([
    loadModelicaModule("factory-models.wasm", deviceManifest, { id: library.package, version: library.version }, signal),
    loadModelicaModule("factory-scheduler.wasm", scheduleManifest, { id: library.package + ".schedule", version: library.version }, signal),
  ]);
  signal?.throwIfAborted();
  const rows = await scheduleInBrowser(scheduler, factoryInputs(factory, deviceModule), signal);
  signal?.throwIfAborted();
  return readFactoryRun(factory, rows);
}

export function factoryTimelineCsv(result: FactoryRunResult) {
  const keys: (keyof FactoryOperation)[] = ["lineId", "jobId", "stageId", "stationId", "carrierId", "fromStationId", "carrierOriginId",
    "readyS", "dispatchS", "pickupStartS", "loadedStartS", "dropStartS", "serviceStartS", "finishS"];
  // Object identifiers use the same restricted alphabet as the workspace contract.
  return [keys.join(","), ...result.operations.map(op => keys.map(key => op[key] ?? "").join(","))].join("\r\n") + "\r\n";
}
