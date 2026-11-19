import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectFactoryLayout, replaceFactoryResourcePackage, resolveFactoryLayout, upsertFactoryLayout } from "../contracts/factory";
import { mergeImportedMaterials } from "../contracts/import-apply";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

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
    const library = open("devices.library.json"), bom = open("bom.csv"), factory = open("layout.factory.json");
    if (library.kind !== "devices" || bom.kind !== "materials" || factory.kind !== "factory") throw new Error("工厂资料未被统一导入入口识别");
    const individual = names.map(name => {
      const candidate = open("devices/" + name + ".device.json");
      if (candidate.kind !== "device") throw new Error("缺少独立设备包 " + name);
      return candidate.device;
    });
    expect(library.devices).toEqual(individual);
    const installed = individual.reduce(installPackage, emptyWorkspace());
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
    expect(workspace.packages.every(p => p.source.kind === "local" && p.factory?.modelRef.version === "1.0.0")).toBe(true);
  });
});
