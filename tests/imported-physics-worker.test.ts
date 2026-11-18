import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedWorkerResponse } from "../contracts/imported-physics";
import { loadImportedPhysics } from "../src/lib/imported-physics";

class WorkerDouble {
  static last: WorkerDouble;
  onmessage?: (event: { data: ImportedWorkerResponse }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { WorkerDouble.last = this; }
}
const bundle = { entry: "a.xml", files: [{ path: "a.xml", data: new Uint8Array() }] };
const settings = { durationS: 1, controls: [], pointId: "body:0" };
const initial = { timeS: 0, qpos: [], qvel: [], pointM: [0, 0, 0] as [number, number, number], geomPoses: new Float32Array() };
const info = { timestepS: 0.002, gravity: initial.pointM, joints: [], actuators: [], positions: [], velocities: [], points: [], warnings: [],
  geometry: { geoms: [], meshes: [], centerM: initial.pointM, extentM: 1 }, initial };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("Worker", WorkerDouble);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("独立计算线程的生命周期", () => {
  it("编译中取消会回收线程并拒绝未完成的加载", async () => {
    const controller = new AbortController();
    const pending = loadImportedPhysics(bundle, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);
    expect(WorkerDouble.last.terminate).toHaveBeenCalledTimes(1);
  });
  it("运行超时会释放模型，避免界面永远等待", async () => {
    const pending = loadImportedPhysics(bundle);
    WorkerDouble.last.onmessage!({ data: { type: "loaded", info } });
    const engine = await pending;
    const failed = expect(engine.run(settings)).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    await expect(engine.run(settings)).rejects.toThrow(/关闭/);
    engine.dispose();
    expect(WorkerDouble.last.terminate).toHaveBeenCalledTimes(1);
  });
  it("计算中禁止重叠提交，普通参数错误后仍可在同一模型重试", async () => {
    const pending = loadImportedPhysics(bundle);
    const worker = WorkerDouble.last;
    worker.onmessage!({ data: { type: "loaded", info } });
    const engine = await pending, first = engine.run(settings);
    await expect(engine.run(settings)).rejects.toThrow(/进行/);
    worker.onmessage!({ data: { type: "error", message: "范围无效" } });
    await expect(first).rejects.toThrow(/范围无效/);
    const next = engine.run(settings);
    worker.onmessage!({ data: { type: "ran", samples: [initial] } });
    await expect(next).resolves.toEqual([initial]);
    engine.dispose();
  });
});
