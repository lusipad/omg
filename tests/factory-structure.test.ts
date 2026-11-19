import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { getDeviceParts, rollupDeviceParts } from "../contracts/device-composition";
import { deriveDeviceComposition } from "../contracts/device-composition-edit";
import { resolveFactoryLayout } from "../contracts/factory";
import { applyFactoryStructureRevision, factoryStructureRoots, factoryStructureSnapshot } from "../contracts/factory-structure";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { readStudioRoute, studioHref } from "../contracts/studio-navigation";
import { prepareStudioExampleJoin } from "../src/lib/studio-example-workspace";
import project from "../public/assemblies/cnc-factory/project.twin.json";

afterEach(() => vi.unstubAllGlobals());

function editedBelt() {
  const original = parseWorkspace(project), layout = original.factories![0], machine = layout.resources.find(r => r.id === "belt")!;
  const base = original.packages.find(p => packageKey(p) === machine.packageKey)!;
  const fast = original.packages.find(p => p.model === "BELT-DRIVE-200")!;
  if (base.composition?.kind !== "assembly") throw new Error("输送带缺少装配定义。");
  const composition = { ...base.composition, parts: getDeviceParts(base).map(part => part.id === "drive" ? { ...part, packageKey: packageKey(fast) } : part) };
  const derived = deriveDeviceComposition(original, machine.packageKey, [], composition, "2-test");
  return { original, layout, machine, derived, changed: applyFactoryStructureRevision(original, layout, machine.id, machine.packageKey, derived.workspace, derived.rootKey) };
}

describe("工厂实例、结构修订和可移植工程", () => {
  it("换驱动后保留原采购行与其他设备，示例加入和工程恢复都带全实际依赖", () => {
    const { original, layout, machine, derived, changed } = editedBelt();
    const next = { ...changed.workspace, factories: [changed.layout] };
    expect(changed.layout.resources.filter(r => r.id !== machine.id)).toEqual(layout.resources.filter(r => r.id !== machine.id));
    expect(original.catalog?.materials.find(row => row.id === machine.materialId)?.binding).toEqual({ kind: "device", key: machine.packageKey });
    expect(changed.layout.resources.find(r => r.id === machine.id)).toMatchObject({ id: machine.id, packageKey: derived.rootKey });
    expect(changed.layout.resources.find(r => r.id === machine.id)).not.toHaveProperty("materialId");
    const after = resolveFactoryLayout(next, changed.layout).resources.find(r => r.resource.id === machine.id)!;
    expect(after.parameters.speedMps).toBe(2);
    expect(after.parameterSources.speedMps).toMatchObject({ kind: "part", path: ["drive"], rating: "lineSpeed", unit: "m/s" });
    expect(resolveFactoryLayout(original, layout).resources.find(r => r.resource.id === machine.id)!.parameters.speedMps).toBe(1);
    const installed = prepareStudioExampleJoin("factory", emptyWorkspace(), next).next;
    const restored = parseWorkspace(JSON.parse(JSON.stringify(installed)));
    expect(restored.packages).toHaveLength(next.packages.length);
    expect(rollupDeviceParts(restored.packages, factoryStructureRoots(restored.factories![0]))).toEqual(factoryStructureSnapshot(next, changed.layout).report);
    expect(() => applyFactoryStructureRevision(changed.workspace, changed.layout, machine.id, machine.packageKey, derived.workspace, derived.rootKey)).toThrow(/已经改变/);
  });

  it("可一键打开某台设备的装配树，其他类型的示例仍按原路由打开", () => {
    const route = { view: "workbench", exampleId: "cnc-factory", structure: "cnc-a" } as const;
    expect(readStudioRoute(studioHref(route))).toEqual(route);
    expect(readStudioRoute("?view=workbench&example=inovance-servo&structure=cnc-a")).toEqual({ view: "workbench", exampleId: "inovance-servo" });
  });

  it("从导出的 Modelica ZIP 原样恢复装机结构、改过的额定值与派工结果", async () => {
    const { changed, derived } = editedBelt();
    const assets = new URL("../public/", import.meta.url);
    vi.stubGlobal("fetch", async (path: string) => new Response(Uint8Array.from(readFileSync(new URL(new URL(path, "https://test.local").pathname.slice(1), assets)))));
    const { exportFactoryModelica } = await import("../src/lib/factory-export");
    const { inspectWorkbenchFiles } = await import("../src/lib/workbench-import");
    const { runFactory } = await import("../src/lib/factory-runtime");
    const zip = await exportFactoryModelica(changed.workspace, changed.layout);
    const candidate = await inspectWorkbenchFiles([new File([zip], "装机工厂-Modelica.zip")], {});
    if (candidate.kind !== "project") throw new Error("没有识别可还原的工厂工程。");
    const snapshot = factoryStructureSnapshot(changed.workspace, changed.layout);
    expect(candidate.workspace).toEqual(snapshot.workspace);
    expect(snapshot.report.complete).toBe(true);
    expect(candidate.workspace.packages.some(pkg => packageKey(pkg) === derived.rootKey)).toBe(true);
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const map = JSON.parse(new TextDecoder().decode(files["factory-map.json"]));
    expect(map.resources.find((r: { id: string }) => r.id === "belt").parameterSources.speedMps).toMatchObject({ value: 2, path: ["drive"] });
    expect(new TextDecoder().decode(files["parts-bom.csv"])).toContain("BALL-4");
    expect((await runFactory(candidate.workspace, candidate.workspace.factories![0])).makespanS).toBeCloseTo(328.0831416, 6);
  });
});
