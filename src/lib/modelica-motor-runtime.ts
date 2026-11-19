import type { FactoryLayout } from "@contracts/factory";
import { resolveMotorAxis, type MotorAxisParameters } from "@contracts/motor-assembly";
import { motorSubsteps } from "@contracts/motor-integration.mjs";
import { SERVO_AXIS_MODEL } from "@contracts/servo-axis";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import library from "../../public/modelica/motor-library.json";
import manifest from "../../public/modelica/runtime/motor-axis.json";
import { loadModelicaModule, sampleModelicaMotion } from "./modelica-runtime";

interface MotorAxis extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  step(seconds: number): void;
  positionMm(): number; velocityMmS(): number; angleDeg(): number; speedRpm(): number;
  currentA(): number; motorTorqueNm(): number;
}
export interface MotorAxisSample {
  timeMs: number; positionMm: number; velocityMmS: number; angleDeg: number; speedRpm: number; currentA: number; motorTorqueNm: number;
}
export interface MotorAxisResult { samples: MotorAxisSample[]; settled: boolean }

export async function runMotorSamples(p: MotorAxisParameters, module: WebAssembly.Module, signal?: AbortSignal): Promise<MotorAxisResult> {
  signal?.throwIfAborted();
  const args = manifest.parameters.map(key => p[key as keyof MotorAxisParameters]);
  if (!args.every(Number.isFinite)) throw new Error("装机参数缺失或超出数值范围，请核对电机和轴工况。");
  const targetDeg = p.targetMm / p.leadMmPerRev * 360;
  const substeps = motorSubsteps(p, manifest.integrator.stepUs);
  const axis = new WebAssembly.Instance(module).exports as MotorAxis;
  axis.reset(...args);
  return sampleModelicaMotion(manifest.integrator.stepUs, seconds => {
    const dt = seconds / substeps;
    for (let i = 0; i < substeps; i++) axis.step(dt);
  }, timeMs => {
    const sample = { timeMs, positionMm: axis.positionMm(), velocityMmS: axis.velocityMmS(), angleDeg: axis.angleDeg(),
      speedRpm: axis.speedRpm(), currentA: axis.currentA(), motorTorqueNm: axis.motorTorqueNm() };
    if (!Object.values(sample).every(Number.isFinite)) throw new Error("电机轴积分超出数值范围，请核对零件额定值或使用原生求解器。");
    const inTolerance = Math.abs(targetDeg - sample.angleDeg) <= SERVO_AXIS_MODEL.positionToleranceDeg &&
      Math.abs(sample.speedRpm) <= SERVO_AXIS_MODEL.speedToleranceRpm;
    return { sample, inTolerance };
  }, signal);
}

export async function runMotorAxis(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string, targetMm?: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { parameters } = resolveMotorAxis(workspace, layout, resourceId, axisId, targetMm);
  const model = await loadModelicaModule("motor-axis.wasm", manifest, { id: library.assembly.id, version: library.version }, signal);
  return runMotorSamples(parameters, model, signal);
}
