import { resolveContourAxes } from "@contracts/cnc-contour";
import { planContourProgram, type ContourPlan } from "@contracts/contour-plan";
import type { FactoryLayout } from "@contracts/factory";
import type { MotorAxisParameters } from "@contracts/motor-assembly";
import type { DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import registry from "../../public/modelica/contour-library.json";
import manifest from "../../public/modelica/runtime/contour-axis.json";
import { integrateContour, type ContourNumerics } from "./cnc-contour-kernel";
import { loadModelicaModule } from "./modelica-runtime";

export type { CncContourSample } from "./cnc-contour-kernel";
export interface CncContourResult extends ContourNumerics {
  program: string; plan: ContourPlan; machineName: string; motor: Pick<DevicePackage, "manufacturer" | "model" | "revision">;
}
function runAxes(parameters: MotorAxisParameters[], plan: ContourPlan, module: WebAssembly.Module, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") return Promise.resolve(integrateContour(parameters, plan, module, signal));
  return new Promise<ContourNumerics>((resolve, reject) => {
    const worker = new Worker(new URL("./contour.worker.ts", import.meta.url), { type: "module" });
    function close() { worker.terminate(); signal?.removeEventListener("abort", abort); }
    function abort() { close(); reject(signal?.reason ?? new DOMException("仿真已取消", "AbortError")); }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ result: ContourNumerics } | { error: string }>) => {
      close();
      if ("result" in event.data) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = e => { close(); reject(new Error(e.message || "三轴仿真线程无法启动。")); };
    try { worker.postMessage({ parameters, plan, module }); }
    catch (cause) { close(); reject(cause); }
  });
}

export async function runCncContour(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, program: string, signal?: AbortSignal): Promise<CncContourResult> {
  signal?.throwIfAborted();
  const bound = resolveContourAxes(workspace, layout, resourceId);
  const plan = planContourProgram(program, bound.contour);
  const module = await loadModelicaModule("contour-axis.wasm", manifest, { id: registry.assembly.id, version: registry.version }, signal);
  const trace = await runAxes(bound.axes.map(axis => axis.parameters), plan, module, signal);
  signal?.throwIfAborted();
  const { manufacturer, model, revision } = bound.motor;
  return { ...trace, plan, program, machineName: bound.resource.name, motor: { manufacturer, model, revision } };
}

export function contourTraceCsv(result: CncContourResult) {
  const columns = ["time_s", "line", "mode", ...["command_mm", "actual_mm", "command_mm_s", "actual_mm_s", "error_mm"]
    .flatMap(metric => ["x", "y", "z"].map(axis => axis + "_" + metric)), "tip_error_mm"];
  const rows = result.samples.map(s => [s.timeS, s.line ?? "", s.mode ?? "", ...s.commandMm, ...s.actualMm,
    ...s.commandVelocityMmS, ...s.actualVelocityMmS, ...s.followingErrorMm, s.errorMm].join(","));
  return [columns.join(","), ...rows].join("\r\n") + "\r\n";
}
