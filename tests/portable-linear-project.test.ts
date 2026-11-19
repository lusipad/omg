import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeImportedMaterials } from "../contracts/import-apply";
import { inspectLinearAssembly, runLinearAssembly, upsertLinearAssembly } from "../contracts/linear-assembly";
import { getWorkbenchTargets } from "../contracts/studio-navigation";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const folder = "../public/assemblies/xy-stage/";

describe("可移植的定位台装配资料", () => {
  it("从独立 BOM、设备包与装配关系建起的系统与发布的整工程一致", () => {
    const recipe = parseImportText(file(folder + "assembly.json"), "自定义装配.json");
    const bom = parseImportText(file(folder + "bom.csv"), "bom.csv");
    const full = parseImportText(file(folder + "project.twin.json"), "工程.json");
    if (recipe.kind !== "assembly" || bom.kind !== "materials" || full.kind !== "project") throw new Error("发布资料未被正常入口识别");
    const pending = upsertLinearAssembly(emptyWorkspace(), recipe.assembly);
    expect(inspectLinearAssembly(pending, recipe.assembly).length).toBeGreaterThan(0);
    const withParts = ["SV660NS2R8I-FS-INT", "MS1H1-40B30CB-A331R-INT"].reduce((ws, model) => {
      const filename = model + ".device.json";
      const released = file("../public/devices/inovance/" + filename);
      expect(JSON.parse(released)).toEqual(JSON.parse(file("../examples/" + filename)));
      const candidate = parseImportText(released, filename);
      if (candidate.kind !== "device") throw new Error("发布的设备包未被识别");
      return installPackage(ws, candidate.device);
    }, pending);
    const ready = mergeImportedMaterials(withParts, bom.rows);
    expect(ready).toEqual(full.workspace);
    expect(getWorkbenchTargets(ready)).toContainEqual({ id: `assembly:${recipe.assembly.id}`, name: recipe.assembly.name });
    expect(inspectLinearAssembly(ready, recipe.assembly)).toEqual([]);
  });

  it("只换 BOM 中的丝杠即可改变同一条指令的响应，两轴仍到达相同的终点", () => {
    const full = parseImportText(file(folder + "project.twin.json"), "工程.json");
    if (full.kind !== "project" || !full.workspace.assemblies?.length) throw new Error("发布工程缺少装配");
    const assembly = full.workspace.assemblies[0];
    expect(assembly.modules[0].leadMmPerRev).toBeNull();
    for (const [screw, positionAt100Ms, peakSpeed] of [
      ["5 mm 导程丝杠", 23.249, 250],
      ["10 mm 导程丝杠", 27.813, 355.932],
    ] as const) {
      const result = runLinearAssembly(full.workspace, { ...assembly, modules: [{ ...assembly.modules[0], screw }] });
      expect(result.settled).toBe(true);
      expect(result.samples.find(point => point.timeMs === 100)?.positionMm[0]).toBeCloseTo(positionAt100Ms, 3);
      expect(Math.max(...result.samples.map(point => point.velocityMmS[0]))).toBeCloseTo(peakSpeed, 3);
      const tip = result.samples.at(-1)!.tipMm;
      expect(tip[0]).toBeCloseTo(40, 2);
      expect(tip[1]).toBeCloseTo(-10, 2);
      expect(tip[2]).toBe(0);
    }
  });
});
