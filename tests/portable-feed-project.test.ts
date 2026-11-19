import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeImportedMaterials } from "../contracts/import-apply";
import { inspectLinearAssembly, resolveModelicaFeedAxes, upsertLinearAssembly } from "../contracts/linear-assembly";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

const folder = "assemblies/feed-axis/";
const files = [
  "modelica/devices/SV660NS2R8I-FS-INT.device.json",
  "modelica/devices/MS1H1-40B30CB-A331R-INT.device.json",
  ...["screw-5", "table-5", "screw-10", "table-20"].map(name => folder + name + ".device.json"),
];
const open = (path: string) => parseImportText(readFileSync(new URL("../public/" + path, import.meta.url), "utf8"), path.split("/").at(-1)!);
function project() {
  const full = open(folder + "project.twin.json");
  if (full.kind !== "project" || !full.workspace.assemblies?.length) throw new Error("示例工程缺少直线进给轴");
  return { workspace: full.workspace, assembly: full.workspace.assemblies[0] };
}

describe("可逐件装配的 Modelica 直线进给轴示例", () => {
  it("从公开的设备包、BOM 与装配关系复原整份下载工程，备用件也保留绑定", () => {
    const recipe = open(folder + "assembly.json"), bom = open(folder + "bom.csv");
    if (recipe.kind !== "assembly" || bom.kind !== "materials") throw new Error("未识别装配关系或 BOM");
    const withParts = files.reduce((workspace, filename) => {
      const resource = open(filename);
      if (resource.kind !== "device") throw new Error("未识别设备包 " + filename);
      return installPackage(workspace, resource.device);
    }, emptyWorkspace());
    const rebuilt = upsertLinearAssembly(mergeImportedMaterials(withParts, bom.rows), recipe.assembly);
    expect(rebuilt).toEqual(project().workspace);
    expect(rebuilt.catalog?.materials).toHaveLength(6);
    expect(rebuilt.catalog?.materials.every(row => row.binding?.kind === "device")).toBe(true);
    expect(inspectLinearAssembly(rebuilt, recipe.assembly)).toEqual([]);
  });

  it("同一台 X 轴从四种丝杠与台面组合读取实际额定值，也能保存反向指令", () => {
    const { workspace, assembly } = project();
    expect(assembly.modelRef).toEqual({ id: "GouyuanLinear.FeedAxis", version: "1.0.0" });
    expect(assembly.axes[0]).toMatchObject({ id: "X", module: "feed", targetMm: 10, direction: [1, 0, 0] });
    expect(assembly.modules[0].leadMmPerRev).toBeNull();
    for (const lead of [5, 10]) for (const mass of [5, 20]) {
      const next = { ...assembly, modules: [{ ...assembly.modules[0], screw: `${lead} mm 导程丝杠`, table: `${mass} kg 工作台` }],
        axes: [{ ...assembly.axes[0], targetMm: -10 }] };
      const saved = upsertLinearAssembly(workspace, next);
      const restored = parseImportText(JSON.stringify(saved), "另存的工程.json");
      if (restored.kind !== "project") throw new Error("未识别保存的工程");
      const [axis] = resolveModelicaFeedAxes(restored.workspace, restored.workspace.assemblies![0]);
      expect(axis.parameters).toMatchObject({ leadMmPerRev: lead, tableMassKg: mass, targetMm: -10,
        ratedPowerW: 400, ratedTorqueNm: 1.27, driveRatedCurrentA: 2.8 });
    }
  });
});
