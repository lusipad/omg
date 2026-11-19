import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getFactoryModel, inspectFactoryLayout, replaceFactoryResourcePackage, resolveFactoryLayout, resolveFactoryParameters, upsertFactoryLayout } from "../contracts/factory";
import { mergeImportedMaterials } from "../contracts/import-apply";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";
import { prepareStudioExampleJoin } from "../src/lib/studio-example-workspace";

const names = ["handler-standard", "handler-fast", "belt-standard", "belt-fast", "amr-standard", "amr-fast", "cnc-cycle", "cnc-feed"];
const asset = (name: string) => readFileSync(new URL("../public/assemblies/cnc-factory/" + name, import.meta.url), "utf8");
const open = (name: string) => parseImportText(asset(name), name);
function example() {
  const project = open("project.twin.json");
  if (project.kind !== "project" || !project.workspace.factories?.length) throw new Error("示例工程缺少工厂布局");
  return { workspace: project.workspace, layout: project.workspace.factories[0] };
}

describe("可移植的双线数控车间", () => {
  it("整库与独立设备包完全相同，安装后用 BOM 和布局复原下载工程", () => {
    const library = open("devices.library.json"), children = open("parts.library.json");
    const bom = open("bom.csv"), factory = open("layout.factory.json");
    if (library.kind !== "devices" || children.kind !== "devices" || bom.kind !== "materials" || factory.kind !== "factory") {
      throw new Error("工厂资料未被统一导入入口识别");
    }
    const individual = names.map(name => {
      const candidate = open("devices/" + name + ".device.json");
      if (candidate.kind !== "device") throw new Error("缺少独立设备包 " + name);
      return candidate.device;
    });
    expect(individual.every(device => device.revision === "2" && device.composition?.kind === "assembly")).toBe(true);
    expect(children.devices.every(device => !device.factory)).toBe(true);
    expect(library.devices).toEqual([...individual, ...children.devices]);
    const installed = [...individual, ...children.devices].reduce(installPackage, emptyWorkspace());
    const restored = upsertFactoryLayout(mergeImportedMaterials(installed, bom.rows), factory.layout);
    expect(restored).toEqual(example().workspace);
    const materials = restored.catalog!.materials;
    expect(materials).toHaveLength(8);
    expect(materials.every(row => row.binding?.kind === "device")).toBe(true);
    for (const resource of factory.layout.resources) {
      expect(materials.find(row => row.id === resource.materialId)?.binding).toEqual({ kind: "device", key: resource.packageKey });
    }
    expect(inspectFactoryLayout(restored, factory.layout)).toEqual([]);
  });

  it("每个角色均可选择另一份修订，两条线继续共享原实例和同一台移动机器人", () => {
    const { layout, workspace } = example();
    const alternatives = [
      ["load", "CELL-HANDLER-2S", "GouyuanFactory.PickPlace"],
      ["belt", "CELL-BELT-200", "GouyuanFactory.BeltConveyor"],
      ["amr", "CELL-AMR-180", "GouyuanFactory.MobileRobot"],
      ["cnc-a", "CELL-CNC-F900", "GouyuanFactory.FeedCNC"],
    ] as const;
    for (const [id, sku, model] of alternatives) {
      const device = workspace.packages.find(pkg => pkg.model === sku)!;
      const material = workspace.catalog!.materials.find(row => row.binding?.key === packageKey(device))!;
      const updated = { ...layout, resources: layout.resources.map(r => r.id === id
        ? { ...replaceFactoryResourcePackage(r, device), materialId: material.id } : r) };
      const saved = parseImportText(JSON.stringify(upsertFactoryLayout(workspace, updated)), "换型后.twin.json");
      if (saved.kind !== "project") throw new Error("换型后的工程未被识别");
      const restored = saved.workspace.factories![0];
      const resolved = resolveFactoryLayout(saved.workspace, restored);
      expect(restored.lines).toEqual(layout.lines);
      expect(resolved.resources.find(r => r.resource.id === id)?.model.id).toBe(model);
      expect(resolved.resources.find(r => r.resource.id === id)?.resource.positionM).toEqual(layout.resources.find(r => r.id === id)?.positionM);
      expect(resolved.jobs).toHaveLength(9);
      expect(restored.lines.map(line => line.stages.filter(stage => stage.carriers.includes("amr")).length)).toEqual([2, 2]);
    }
    expect(workspace.packages.every(p => p.source.kind === "local")).toBe(true);
    expect(workspace.packages.filter(p => p.factory?.modelRef.version === "1.0.0")).toHaveLength(8);
  });

  it("旧车间采购记录与结构修订 2 的采购记录各自保持原绑定", () => {
    const { workspace, layout } = example();
    const catalog = new Map(workspace.packages.map(p => [packageKey(p), p]));
    const older = workspace.packages.filter(p => p.factory).map(root => {
      const modelRef = root.factory!.modelRef;
      const { parameters } = resolveFactoryParameters(root, getFactoryModel(modelRef)!, catalog);
      const old = { ...root, revision: "1", factory: { modelRef, parameters } };
      delete old.composition;
      return old;
    });
    const oldCsv = asset("bom.csv").replaceAll("双线数控车间教学设计 · 整机修订 2", "双线数控车间教学设计");
    const oldBom = parseImportText(oldCsv, "bom.csv"), currentBom = open("bom.csv");
    if (oldBom.kind !== "materials" || currentBom.kind !== "materials") throw new Error("缺少可核对的采购行");
    const prior = mergeImportedMaterials(older.reduce(installPackage, emptyWorkspace()), oldBom.rows);
    const noChoice = mergeImportedMaterials(workspace.packages.reduce(installPackage, prior), currentBom.rows);
    const unbound = noChoice.catalog!.materials.filter(row => !row.binding);
    expect(unbound.map(row => row.id)).toEqual(currentBom.rows.map(row => row.id));
    const oldLayout = { ...layout, resources: layout.resources.map(r => {
      const old = older.find(p => p.model === catalog.get(r.packageKey)?.model)!;
      return { ...r, packageKey: packageKey(old), materialId: oldBom.rows.find(row => row.model === old.model)!.id };
    }) };
    const change = prepareStudioExampleJoin("factory", upsertFactoryLayout(prior, oldLayout), workspace);
    expect(change.replacement).toContain(layout.name);
    const mixed = change.next;
    const rows = new Map(mixed.catalog!.materials.map(row => [row.id, row]));
    expect(rows.size).toBe(16);
    for (const row of oldBom.rows) expect(JSON.parse(rows.get(row.id)!.binding!.key)[2]).toBe("1");
    for (const row of currentBom.rows) expect(JSON.parse(rows.get(row.id)!.binding!.key)[2]).toBe("2");
    expect(inspectFactoryLayout(mixed, layout)).toEqual([]);
  });
});
