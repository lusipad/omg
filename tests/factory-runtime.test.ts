import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { maxPackages, parseWorkspace } from "../contracts/twin-simulation";
import { replaceFactoryResourcePackage } from "../contracts/factory";
import { packageKey } from "../contracts/twin-device";
import { parseImportText } from "../contracts/workbench-import";
import project from "../public/assemblies/cnc-factory/project.twin.json";
import devices from "../public/modelica/runtime/factory-models.json";
import schedule from "../public/modelica/runtime/factory-scheduler.json";

const read = (path: string) => readFileSync(new URL("../public/modelica/" + path, import.meta.url));
function mockPublished(broken?: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async (source: string) => {
    const path = new URL(source, "https://studio.local").pathname.split("/modelica/")[1], data = Uint8Array.from(read(path));
    if (path === broken) data[data.length - 1] ^= 1;
    return new Response(data);
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("整厂工作台运行已编译的设备方程和同一调度核心", () => {
  it("设备库整体核对，只复用相同修订的相同内容", () => {
    const standard = project.packages.find(p => p.factory?.modelRef.id.endsWith(".PickPlace"))!;
    const open = (packages: unknown[]) => parseImportText(JSON.stringify({ schemaVersion: 1, kind: "device-library", packages }), "devices.library.json");
    expect(open([standard, standard])).toMatchObject({ kind: "devices", devices: [standard] });
    expect(() => open([standard, { ...standard, factory: { ...standard.factory, parameters: { handlingS: 999 } } }])).toThrow(/相同修订/);
    expect(() => open([])).toThrow(/设备库/);
    expect(() => open(Array(maxPackages + 1).fill(standard))).toThrow(String(maxPackages));
  });

  it("跟踪两条产线的全部工件、共用载具的空驶及并行加工，并导出同批事件", async () => {
    mockPublished();
    const { runFactory, factoryTimelineCsv } = await import("../src/lib/factory-runtime");
    const workspace = parseWorkspace(project), layout = workspace.factories![0];
    const result = await runFactory(workspace, layout);
    expect(result.makespanS).toBeCloseTo(324.499266257, 7);
    expect(result.jobs).toHaveLength(9);
    expect(result.operations).toHaveLength(33);
    const active = result.operations.filter(op => op.serviceStartS <= 30 && 30 < op.finishS && op.stationId.startsWith("cnc-"));
    expect(active.map(op => [op.stationId, op.jobId])).toEqual([["cnc-a", "main/1"], ["cnc-b", "aux/1"]]);
    const trips = result.operations.filter(op => op.carrierId === "amr").sort((a, b) => a.dispatchS - b.dispatchS);
    expect(trips[0].carrierOriginId).toBe("amr");
    for (let i = 1; i < trips.length; i++) {
      expect(trips[i].dispatchS).toBeGreaterThanOrEqual(trips[i - 1].serviceStartS);
      expect(trips[i].carrierOriginId).toBe(trips[i - 1].stationId);
    }
    expect(factoryTimelineCsv(result).trim().split("\r\n")).toHaveLength(34);
    const replacement = workspace.packages.find(p => p.model === "CELL-CNC-F900")!;
    const changed = { ...layout, resources: layout.resources.map(r => r.id === "cnc-a" ? replaceFactoryResourcePackage(r, replacement) : r) };
    const fast = await runFactory(workspace, changed);
    expect(fast.makespanS).toBeCloseTo(256.220657323, 7);
    expect(fast.jobs).toHaveLength(result.jobs.length);
    expect(layout.resources.find(r => r.id === "cnc-a")!.packageKey).not.toBe(packageKey(replacement));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("损坏模型或主动取消时不能产出改用其他节拍的结果", async () => {
    mockPublished("runtime/factory-models.wasm");
    const { runFactory } = await import("../src/lib/factory-runtime");
    const workspace = parseWorkspace(project), layout = workspace.factories![0];
    await expect(runFactory(workspace, layout, AbortSignal.abort())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(runFactory(workspace, layout)).rejects.toThrow(/SHA-256/);
  });

  it("导出可重算的原生 Modelica 全厂，依赖摘要与实际运行的工件一一对应", async () => {
    mockPublished();
    const { exportFactoryModelica } = await import("../src/lib/factory-export");
    const workspace = parseWorkspace(project), layout = workspace.factories![0];
    await expect(exportFactoryModelica(workspace, layout, AbortSignal.abort())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const blob = await exportFactoryModelica(workspace, layout);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const hash = (name: string) => createHash("sha256").update(files[name]).digest("hex");
    expect(hash("GouyuanFactory/package.mo")).toBe(devices.sourceSha256);
    expect(hash("GouyuanFactory/Resources/Include/factory_schedule.h")).toBe(schedule.sourceSha256);
    const model = new TextDecoder().decode(files["FactoryRun.mo"]);
    expect(model.match(/replaceable model Device\d+/g)).toHaveLength(8);
    expect(model).toContain("constrainedby GouyuanFactory.MachineStation;");
    expect(model).toContain("GouyuanFactory.schedule(nr,ns,nj,jobs,equipment,mask)");
    expect(JSON.parse(new TextDecoder().decode(files["layout.factory.json"]))).toEqual(layout);
  });
});
