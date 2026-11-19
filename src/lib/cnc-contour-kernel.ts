import { sampleContourCommand, type ContourPlan } from "@contracts/contour-plan";
import type { MiloMoveMode, MiloVec3 } from "@contracts/milo-motion";
import type { MotorAxisParameters } from "@contracts/motor-assembly";
import { motorSubsteps } from "@contracts/motor-integration.mjs";
import manifest from "../../public/modelica/runtime/contour-axis.json";

export interface CncContourSample {
  timeS: number; line: number | null; mode: MiloMoveMode | null;
  commandMm: MiloVec3; actualMm: MiloVec3; commandVelocityMmS: MiloVec3; actualVelocityMmS: MiloVec3;
  followingErrorMm: MiloVec3; errorMm: number;
}
export interface ContourNumerics {
  samples: CncContourSample[]; programEndS: number; endS: number;
  maxErrorMm: number; maxErrorTimeS: number; maxAxisErrorMm: MiloVec3; rmsErrorMm: number;
}
interface TrackingAxis extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  stepReference(seconds: number, fromMm: number, toMm: number): void;
  positionMm(): number; velocityMmS(): number;
}
const xyz = (value: (i: number) => number): MiloVec3 => [value(0), value(1), value(2)];

/** Each installation owns its winding current and rotor states for the entire program, including the final hold. */
export function integrateContour(parameters: readonly MotorAxisParameters[], contour: ContourPlan,
  module: WebAssembly.Module, signal?: AbortSignal): ContourNumerics {
  if (parameters.length !== 3) throw new Error("联动加工需要三个独立的实际电机安装位。");
  signal?.throwIfAborted();
  const baseS = manifest.integrator.stepUs / 1e6;
  const axes = parameters.map(p => {
    const model = new WebAssembly.Instance(module).exports as TrackingAxis;
    const args = manifest.parameters.map(key => p[key as keyof MotorAxisParameters]);
    if (!args.every(Number.isFinite)) throw new Error("装机输入缺少有限的物理参数。");
    const substeps = motorSubsteps(p, manifest.integrator.stepUs);
    model.reset(...args);
    return { model, substeps };
  });
  const { timesS, referenceMm, initialWorkMm } = contour;
  const boundaries = new Set(contour.plan.segments.map(s => s.endS));
  const samples: CncContourSample[] = [], maxAxisErrorMm: MiloVec3 = [0, 0, 0];
  let squaredIntegral = 0, maxErrorMm = 0, maxErrorTimeS = 0, lastGrid = -1;
  for (let i = 0; i < timesS.length; i++) {
    const t = timesS[i], row = 3 * i;
    if (i) {
      const dt = t - timesS[i - 1], ticks = Math.max(1, Math.ceil(dt / baseS - 1e-8));
      for (let k = 0; k < 3; k++) {
        const { model, substeps } = axes[k], n = ticks * substeps, h = dt / n;
        const prev = referenceMm[row - 3 + k] - initialWorkMm[k], next = referenceMm[row + k] - initialWorkMm[k];
        const change = next - prev;
        let from = prev;
        for (let j = 1; j <= n; j++) {
          const to = j === n ? next : prev + change * j / n;
          model.stepReference(h, from, to);
          from = to;
        }
      }
    }
    if (i % 128 === 0) signal?.throwIfAborted();
    const grid = Math.round(t * 100);
    const onGrid = Math.abs(t - grid / 100) <= 1e-12 && grid !== lastGrid;
    if (!onGrid && !boundaries.has(t) && t !== contour.programEndS && i !== timesS.length - 1) continue;
    if (onGrid) lastGrid = grid;
    const command = sampleContourCommand(contour, t);
    const commandMm = xyz(k => referenceMm[row + k]);
    const actualMm = xyz(k => initialWorkMm[k] + axes[k].model.positionMm());
    const actualVelocityMmS = xyz(k => axes[k].model.velocityMmS());
    const followingErrorMm = xyz(k => actualMm[k] - commandMm[k]), errorMm = Math.hypot(...followingErrorMm);
    if (!Number.isFinite(errorMm) || !actualVelocityMmS.every(Number.isFinite)) throw new Error(`三轴积分在 ${t.toFixed(4)} s 超出数值范围，请核对装机参数及单位。`);
    if (errorMm > maxErrorMm) { maxErrorMm = errorMm; maxErrorTimeS = t; }
    for (let k = 0; k < 3; k++) maxAxisErrorMm[k] = Math.max(maxAxisErrorMm[k], Math.abs(followingErrorMm[k]));
    const previous = samples.at(-1);
    if (previous) squaredIntegral += 0.5 * (previous.errorMm ** 2 + errorMm ** 2) * (t - previous.timeS);
    samples.push({ timeS: t, line: command.line, mode: command.mode, commandMm, actualMm,
      commandVelocityMmS: command.velocityMmS, actualVelocityMmS, followingErrorMm, errorMm });
  }
  return { samples, programEndS: contour.programEndS, endS: contour.endS,
    maxErrorMm, maxAxisErrorMm, maxErrorTimeS, rmsErrorMm: Math.sqrt(squaredIntegral / contour.endS) };
}
