import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildServoMotor, installMotorOnFactoryAxis, resolveMotorAxis } from "../contracts/motor-assembly";
import { motorSubsteps } from "../contracts/motor-integration.mjs";
import { packageKey } from "../contracts/twin-device";
import { installPackage, parseWorkspace } from "../contracts/twin-simulation";
import manifest from "../public/modelica/runtime/motor-axis.json";
import project from "../public/assemblies/cnc-factory/project.twin.json";

const bytes = readFileSync(new URL("../public/modelica/runtime/motor-axis.wasm", import.meta.url));
async function runtime(body: Uint8Array = bytes) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(body))));
  return import("../src/lib/modelica-motor-runtime");
}
function mounted(rotor = "R40-STD") {
  const ws = parseWorkspace(project), key = (model: string) => packageKey(ws.packages.find(p => p.model === model)!);
  const motor = buildServoMotor(ws, { manufacturer: "测试工厂", model: "选件电机", revision: rotor,
    statorKey: key("S40-STD"), rotorKey: key(rotor), bearingKey: key("B08-STD") });
  return installMotorOnFactoryAxis(installPackage(ws, motor), ws.factories![0], "cnc-a", "x", packageKey(motor), "测试装机");
}
afterEach(() => vi.unstubAllGlobals());

it("相同轴、整定和毫米指令下，两份真实装机修订独立从静止求解，反向与零指令同样可运行", async () => {
  const { runMotorAxis } = await runtime(), a = mounted(), b = mounted("R40-HI");
  const base = await runMotorAxis(a.workspace, a.layout, "cnc-a", "x", 10);
  const [heavy, reverse, zero] = await Promise.all([
    runMotorAxis(b.workspace, b.layout, "cnc-a", "x", 10),
    runMotorAxis(a.workspace, a.layout, "cnc-a", "x", -10),
    runMotorAxis(a.workspace, a.layout, "cnc-a", "x", 0),
  ]);
  expect(base.samples[0]).toEqual({ timeMs: 0, positionMm: 0, velocityMmS: 0, angleDeg: 0, speedRpm: 0, currentA: 0, motorTorqueNm: 0 });
  const x = base.samples.find(s => s.timeMs === 100)!, y = heavy.samples.find(s => s.timeMs === 100)!;
  expect(x.positionMm).toBeCloseTo(6.41533193, 6); expect(x.velocityMmS).toBeCloseTo(44.18550088, 5);
  expect(y.positionMm).toBeCloseTo(5.68741768, 6); expect(y.velocityMmS).toBeCloseTo(61.05818373, 5);
  const back = reverse.samples.find(s => s.timeMs === 100)!;
  for (const key of manifest.outputs as (keyof typeof x)[]) expect(back[key]).toBeCloseTo(-x[key], 9);
  expect(zero.settled).toBe(true); expect(zero.samples.at(-1)).toEqual({ ...base.samples[0], timeMs: 50 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("旧结构电机、已取消的试跑和破损的工件都不能冒用另一种曲线", async () => {
  const damaged = new Uint8Array(bytes); damaged[damaged.length - 1] ^= 1;
  const { runMotorAxis } = await runtime(damaged), ws = parseWorkspace(project);
  await expect(runMotorAxis(ws, ws.factories![0], "cnc-a", "x", 10)).rejects.toThrow(/电机/);
  const m = mounted();
  await expect(runMotorAxis(m.workspace, m.layout, "cnc-a", "x", 10, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(runMotorAxis(m.workspace, m.layout, "cnc-a", "x", 10)).rejects.toThrow(/SHA-256/);
});

it("对低电感绕组采用足够细的子步，超出浏览器数值范围会提示原生复算", async () => {
  const m = mounted(), { parameters } = resolveMotorAxis(m.workspace, m.layout, "cnc-a", "x", 10);
  expect(motorSubsteps(parameters, manifest.integrator.stepUs)).toBe(1);
  const stiff = { ...parameters, qInductanceH: 0.00005 };
  expect(motorSubsteps(stiff, manifest.integrator.stepUs)).toBe(40);
  const { runMotorSamples } = await runtime();
  const response = await runMotorSamples(stiff, new WebAssembly.Module(bytes));
  expect(response.samples.find(s => s.timeMs === 100)?.positionMm).toBeCloseTo(6.411643231, 6);
  expect(() => motorSubsteps({ ...parameters, qInductanceH: 1e-12 }, manifest.integrator.stepUs)).toThrow(/原生/);
});
