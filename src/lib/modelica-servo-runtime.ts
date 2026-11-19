import { modelicaServoInfo, MODELICA_SERVO_REF, type ModelicaServoParameters } from "@contracts/modelica-servo";
import { SERVO_AXIS_MODEL, type ServoAxisResult, type ServoAxisSample } from "@contracts/servo-axis";
import manifest from "../../public/modelica/runtime/manifest.json";
import { loadModelicaModule, sampleModelicaMotion } from "./modelica-runtime";

interface CompiledAxis extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  step(seconds: number): void;
  angleDeg(): number;
  speedRpm(): number;
  torqueNm(): number;
}
type Sample = ServoAxisSample & { torqueNm: number };
type Result = Omit<ServoAxisResult, "samples"> & { samples: Sample[] };

export async function runModelicaServo(p: ModelicaServoParameters, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  const info = modelicaServoInfo(p);
  const module = await loadModelicaModule("servo-axis.wasm", manifest, MODELICA_SERVO_REF, signal);
  signal?.throwIfAborted();
  // Each experiment has its own initialized Modelica states and parameter bindings.
  const axis = new WebAssembly.Instance(module).exports as CompiledAxis;
  axis.reset(...manifest.parameters.map(name => p[name as keyof ModelicaServoParameters]));
  const trace = await sampleModelicaMotion(manifest.integrator.stepUs, axis.step, timeMs => {
    const positionDeg = axis.angleDeg(), speedRpm = axis.speedRpm(), torqueNm = axis.torqueNm();
    if (![positionDeg, speedRpm, torqueNm].every(Number.isFinite)) {
      throw new Error("Modelica 积分超出数值范围，请核对设备额定参数及负载。");
    }
    const inTolerance = Math.abs(positionDeg - p.targetDeg) <= SERVO_AXIS_MODEL.positionToleranceDeg && Math.abs(speedRpm) <= SERVO_AXIS_MODEL.speedToleranceRpm;
    return { sample: { timeMs, positionDeg, speedRpm, torqueNm }, inTolerance };
  }, signal);
  return { ...info, ...trace };
}
