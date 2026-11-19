import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parseWorkspace } from "../contracts/twin-simulation";
import project from "../public/assemblies/feed-axis/project.twin.json";

const bytes = readFileSync(new URL("../public/modelica/runtime/feed-axis.wasm", import.meta.url));
async function runtime(body: Uint8Array = bytes) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(body))));
  return (await import("../src/lib/modelica-feed-runtime")).runModelicaLinearAssembly;
}
afterEach(() => vi.unstubAllGlobals());

it("更换 BOM 部件后按同一目标重新积分，推出工作台的力与电机总转矩满足动力学平衡", async () => {
  const run = await runtime();
  const workspace = parseWorkspace(project), assembly = workspace.assemblies![0];
  for (const [lead, mass, position, speed] of [[5, 5, 7.03659346, 43.51835186], [10, 5, 6.94661192, 50.78752062], [5, 20, 6.94661191, 50.78752092]]) {
    const modules = [{ ...assembly.modules[0], screw: `${lead} mm 导程丝杠`, table: `${mass} kg 工作台` }];
    const forward = await run(workspace, { ...assembly, modules });
    expect(forward.settled).toBe(true);
    const sample = forward.samples.find(s => s.timeMs === 100)!;
    expect(sample.positionMm[0]).toBeCloseTo(position, 5);
    expect(sample.velocityMmS[0]).toBeCloseTo(speed, 4);
    const k = lead / (2000 * Math.PI);
    const rotor = workspace.packages.find(p => p.servo?.kind === "motor")!.servo!;
    if (rotor.kind !== "motor") throw new Error("工程未绑定电机");
    for (const s of forward.samples) {
      expect(s.motorTorqueNm![0]).toBeCloseTo(s.axialForceN![0] * (k + rotor.rotorInertiaKgM2 / (mass * k)), 10);
      expect(s.tipMm).toEqual([s.positionMm[0], 0, 0]);
    }
    const reverse = await run(workspace, { ...assembly, modules, axes: [{ ...assembly.axes[0], targetMm: -10 }] });
    const back = reverse.samples.find(s => s.timeMs === 100)!;
    for (const key of ["positionMm", "velocityMmS", "motorTorqueNm", "axialForceN"] as const) {
      expect(back[key]![0]).toBeCloseTo(-sample[key]![0], 9);
    }
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("多轴共用时钟，短行程轴在另一轴仍进给时继续输出真实的位移、速度和受力", async () => {
  const run = await runtime(), workspace = parseWorkspace(project), assembly = workspace.assemblies![0];
  workspace.catalog!.materials.forEach(row => { row.quantity = 2; });
  const single = await run(workspace, assembly);
  const long = { ...assembly.axes[0], id: "other", targetMm: 5000, direction: [0, -2, 0] as [number, number, number] };
  const multi = await run(workspace, { ...assembly, axes: [...assembly.axes, long] });
  expect(multi.settled).toBe(false);
  expect(multi.samples).toHaveLength(801);
  expect(multi.samples.at(-1)?.timeMs).toBe(8000);
  const stop = single.samples.at(-1)!;
  const later = multi.samples.find(s => s.timeMs >= stop.timeMs + 30)!;
  expect(later.positionMm[0]).not.toBe(stop.positionMm[0]);
  expect(later.velocityMmS[0]).not.toBe(0);
  expect(later.motorTorqueNm![0]).not.toBe(0);
  expect(later.tipMm).toEqual([later.positionMm[0], -later.positionMm[1], 0]);
});

it("取消和损坏工件都不会启动替代模型", async () => {
  const damaged = new Uint8Array(bytes); damaged[damaged.length - 1] ^= 1;
  const run = await runtime(damaged), workspace = parseWorkspace(project), assembly = workspace.assemblies![0];
  await expect(run(workspace, assembly, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(run(workspace, assembly)).rejects.toThrow(/SHA-256/);
});
