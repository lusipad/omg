import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelicaServoParameters } from "../contracts/modelica-servo";
import manifest from "../public/modelica/runtime/manifest.json";

const bytes = readFileSync(new URL("../public/modelica/runtime/servo-axis.wasm", import.meta.url));
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const nominal: ModelicaServoParameters = {
  targetDeg: 90, loadInertiaRatio: 1, rotorInertiaKgM2: 0.0000145, ratedTorqueNm: 1.27,
  ratedPowerW: 400, ratedSpeedRpm: 3000, driveRatedCurrentA: 2.8, motorRatedCurrentA: 2.8,
};
async function freshKernel(body: Uint8Array = bytes) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(body))));
  return (await import("../src/lib/modelica-servo-runtime")).runModelicaServo;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("Modelica 编译的浏览器伺服轴", () => {
  it("公开工件绑定可下载源和模型清单，WASM 中保留全部输出且没有外部导入", () => {
    expect(manifest.sourceSha256).toBe(digest(readFileSync(new URL("../public/modelica/Gouyuan.mo", import.meta.url))));
    expect(manifest.librarySha256).toBe(digest(readFileSync(new URL("../public/modelica/library.json", import.meta.url))));
    expect(manifest.wasmSha256).toBe(digest(bytes));
    expect(manifest.wasmBytes).toBe(bytes.length);
    const module = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).map(x => x.name)).toEqual(expect.arrayContaining(["reset", "step", "angleDeg", "speedRpm", "torqueNm"]));
    expect([...manifest.parameters].sort()).toEqual(Object.keys(nominal).sort());
  });
  it("运行真实工件，位置负反馈随目标、惯量和限流参数改变", async () => {
    const run = await freshKernel();
    const [forward, reverse, limited, zero] = await Promise.all([
      run(nominal), run({ ...nominal, targetDeg: -90, loadInertiaRatio: 5 }),
      run({ ...nominal, driveRatedCurrentA: 0.002 }), run({ ...nominal, targetDeg: 0 }),
    ]);
    expect(forward.settled).toBe(true);
    expect(forward.samples.find(s => s.timeMs === 100)?.positionDeg).toBeCloseTo(62.2403063, 5);
    expect(reverse.samples.find(s => s.timeMs === 100)?.positionDeg).toBeCloseTo(-46.9177231, 5);
    const currentLimited = limited.samples.find(s => s.timeMs === 100)!;
    expect(currentLimited.positionDeg).toBeGreaterThan(0);
    expect(currentLimited.positionDeg).toBeLessThan(15);
    expect(currentLimited.torqueNm).toBeCloseTo(1.27 * .002 / 2.8, 8);
    expect(zero.samples.at(-1)).toEqual({ timeMs: 50, positionDeg: 0, speedRpm: 0, torqueNm: 0 });
    expect(forward.samples.at(-1)!.timeMs).toBeGreaterThan(400);
  });
  it("对自选目标与负载从静止重新积分，在最大模拟时间结束时保留未到位状态", async () => {
    const run = await freshKernel();
    const result = await run({ ...nominal, targetDeg: -17.35, loadInertiaRatio: 2.75 });
    expect(result.settled).toBe(true);
    expect(result.samples[0].positionDeg).toBe(0);
    expect(Math.abs(result.samples.at(-1)!.positionDeg + 17.35)).toBeLessThanOrEqual(0.1);
    const slow = await run({ ...nominal, targetDeg: 3600, ratedSpeedRpm: 60 });
    expect(slow.settled).toBe(false);
    expect(slow.samples).toHaveLength(801);
    expect(slow.samples.at(-1)!.timeMs).toBe(8000);
    expect(slow.samples.at(-1)!.speedRpm).toBeCloseTo(60, 7);
  });
  it("损坏工件和取消都不会改用另一种求解器", async () => {
    const altered = new Uint8Array(bytes);
    altered[altered.length - 1] ^= 1;
    const run = await freshKernel(altered);
    await expect(run(nominal)).rejects.toThrow(/摘要/);
    vi.mocked(fetch).mockClear();
    await expect(run(nominal, AbortSignal.abort())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
