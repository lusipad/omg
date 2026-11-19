import { SERVO_AXIS_MODEL } from "@contracts/servo-axis";
import type { ModelReference } from "@contracts/twin-device";
import { sha256Hex } from "./model-files";

interface CompiledArtifact { model: string; version: string; wasmSha256: string; wasmBytes: number }
const compiled = new Map<string, WebAssembly.Module>();

export async function loadModelicaModule(filename: string, artifact: CompiledArtifact, ref: ModelReference, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (artifact.model !== ref.id || artifact.version !== ref.version) {
    throw new Error("浏览器工件与已绑定的 Modelica 模型版本不符。");
  }
  const url = import.meta.env.BASE_URL + "modelica/runtime/" + filename + "?sha256=" + artifact.wasmSha256;
  const cached = compiled.get(url);
  if (cached) return cached;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Modelica 编译工件读取失败（HTTP ${response.status}）。`);
  const data = await response.arrayBuffer();
  if (data.byteLength !== artifact.wasmBytes || await sha256Hex(new Uint8Array(data)) !== artifact.wasmSha256) {
    throw new Error("Modelica 浏览器工件的 SHA-256 摘要不符，请刷新后重试。");
  }
  signal?.throwIfAborted();
  const module = await WebAssembly.compile(data);
  signal?.throwIfAborted();
  compiled.set(url, module);
  return module;
}

/** 机器的所有轴用同一时钟积分，达到稳态的轴也继续施力，直到整机完成本次指令。 */
export async function sampleModelicaMotion<T>(stepUs: number, advance: (seconds: number) => void,
  observe: (timeMs: number) => { sample: T; inTolerance: boolean }, signal?: AbortSignal) {
  const stepsPerMs = 1000 / stepUs, seconds = stepUs / 1_000_000;
  if (!Number.isInteger(stepsPerMs) || stepsPerMs <= 0) throw new Error("Modelica 工件声明的积分步长无效。");
  const { maxTimeMs, settleHoldMs, samplePeriodMs } = SERVO_AXIS_MODEL;
  const samples: T[] = [];
  let stableSince: number | undefined, lastYield = performance.now();
  for (let timeMs = 0; timeMs <= maxTimeMs; timeMs++) {
    signal?.throwIfAborted();
    if (timeMs) for (let i = 0; i < stepsPerMs; i++) advance(seconds);
    const { sample, inTolerance } = observe(timeMs);
    if (inTolerance) stableSince ??= timeMs;
    else stableSince = undefined;
    const settled = stableSince !== undefined && timeMs - stableSince >= settleHoldMs;
    if (timeMs % samplePeriodMs === 0 || settled || timeMs === maxTimeMs) samples.push(sample);
    if (settled) return { samples, settled };
    if (timeMs % 16 === 0 && performance.now() - lastYield > 12) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  return { samples, settled: false };
}
