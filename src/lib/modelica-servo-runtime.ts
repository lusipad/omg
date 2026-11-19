import { modelicaServoInfo, MODELICA_SERVO_REF, type ModelicaServoParameters } from "@contracts/modelica-servo";
import { SERVO_AXIS_MODEL, type ServoAxisResult, type ServoAxisSample } from "@contracts/servo-axis";
import manifest from "../../public/modelica/runtime/manifest.json";
import { sha256Hex } from "./model-files";

interface CompiledAxis extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  step(seconds: number): void;
  angleDeg(): number;
  speedRpm(): number;
  torqueNm(): number;
}
type Sample = ServoAxisSample & { torqueNm: number };
type Result = Omit<ServoAxisResult, "samples"> & { samples: Sample[] };
let compiled: WebAssembly.Module | undefined;

async function getModule(signal?: AbortSignal) {
  if (compiled) return compiled;
  if (manifest.model !== MODELICA_SERVO_REF.id || manifest.version !== MODELICA_SERVO_REF.version) {
    throw new Error("浏览器工件与已绑定的 Modelica 模型版本不符。");
  }
  const url = import.meta.env.BASE_URL + "modelica/runtime/servo-axis.wasm?sha256=" + manifest.wasmSha256;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Modelica 编译工件读取失败（HTTP ${response.status}）。`);
  const data = await response.arrayBuffer();
  if (data.byteLength !== manifest.wasmBytes || await sha256Hex(new Uint8Array(data)) !== manifest.wasmSha256) {
    throw new Error("Modelica 浏览器工件的 SHA-256 摘要不符，请刷新后重试。");
  }
  signal?.throwIfAborted();
  const module = await WebAssembly.compile(data);
  signal?.throwIfAborted();
  compiled = module;
  return module;
}

export async function runModelicaServo(p: ModelicaServoParameters, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  const info = modelicaServoInfo(p);
  const module = await getModule(signal);
  signal?.throwIfAborted();
  // Each experiment has its own initialized Modelica states and parameter bindings.
  const axis = new WebAssembly.Instance(module).exports as CompiledAxis;
  axis.reset(...manifest.parameters.map(name => p[name as keyof ModelicaServoParameters]));
  const stepsPerMs = 1000 / manifest.integrator.stepUs;
  const stepSeconds = manifest.integrator.stepUs / 1_000_000;
  const settings = SERVO_AXIS_MODEL;
  const samples: Sample[] = [];
  let settled = false, stableSince: number | undefined, lastYield = performance.now();
  for (let timeMs = 0; timeMs <= settings.maxTimeMs; timeMs++) {
    if (timeMs) {
      for (let substep = 0; substep < stepsPerMs; substep++) axis.step(stepSeconds);
    }
    const positionDeg = axis.angleDeg(), speedRpm = axis.speedRpm(), torqueNm = axis.torqueNm();
    if (![positionDeg, speedRpm, torqueNm].every(Number.isFinite)) {
      throw new Error("Modelica 积分超出数值范围，请核对设备额定参数及负载。");
    }
    if (Math.abs(positionDeg - p.targetDeg) <= settings.positionToleranceDeg && Math.abs(speedRpm) <= settings.speedToleranceRpm) {
      stableSince ??= timeMs;
      settled = timeMs - stableSince >= settings.settleHoldMs;
    } else stableSince = undefined;
    if (timeMs % settings.samplePeriodMs === 0 || settled) samples.push({ timeMs, positionDeg, speedRpm, torqueNm });
    if (settled) break;
    if (timeMs % 32 === 0 && performance.now() - lastYield > 12) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      lastYield = performance.now();
    }
  }
  return { ...info, samples, settled };
}
