import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleMiloAxis, getMiloAxisRequirements, miloAxisIds, miloBomSchema, parseMiloBom, validateMiloAssembly, type MiloAxisId } from "../contracts/milo-bom";

const markdown = readFileSync(new URL("../public/machines/milo-v1-5/bom-facts.md", import.meta.url), "utf8");
const bom = parseMiloBom(markdown);
const axis = (id: MiloAxisId) => getMiloAxisRequirements(bom, id);
const find = (id: MiloAxisId, name: string) => axis(id).find(row => row.name.startsWith(name));

describe("Milo v1.5 分项采购表", () => {
  it("保留 81 件不同物料的 7 个类别、标准和原始数量", () => {
    expect(bom).toHaveLength(81);
    expect(new Set(bom.map(row => row.category)).size).toBe(7);
    expect(bom.find(row => row.name === "M5x10 BHCS")).toMatchObject({ category: "Fasteners", standard: "ISO 7380-1", quantity: "6 / 74 (FMJ)" });
    expect(bom.find(row => row.name === "Ferrule Connectors")?.quantity).toBe("N/A");
    expect(bom.find(row => row.name === "Epoxy Resin")?.quantity).toBe("1L");
    expect(miloBomSchema.parse(JSON.parse(JSON.stringify(bom)))).toEqual(bom);
  });

  it("只选 Individual Parts，表头可带采购链接且数量可以有长度单位", () => {
    const prefix = "# Sourcing Guide\n## Kits\n### Motion\n| Component | QTY |\n|---|---|\n| 套件 | 1 |\n";
    const suffix = "\n## Notes\n### Motion\n| Component | QTY |\n|---|---|\n| 重复说明 | 12 |";
    const modified = markdown.replace(/(\|\s*Granite Sand\s*\|[^\r\n]*?\|)\s*1\s*\|/i, "$1 2.5 m |");
    const parts = parseMiloBom("\uFEFF" + (prefix + modified + suffix).replaceAll("\n", "\r\n"));
    expect(parts).toHaveLength(81);
    expect(parts.find(row => row.name === "Granite Sand")?.quantity).toBe("2.5 m");
  });

  it("拒绝通用采购表、重复行、非法库存和损坏的工程清单", () => {
    expect(() => parseMiloBom(markdown.replace("Milo v1.5 BOM", "Milo v1.4 BOM"))).toThrow(/v1\.4.*v1\.5/);
    expect(() => parseMiloBom("## Kits\n| Component | QTY |\n|---|---|\n| Motor | 3 |")).toThrow(/Individual Parts/);
    expect(() => parseMiloBom("## Individual Parts\n### Motion\n| Component | QTY |\n|---|---|\n| Motor | 3 |")).toThrow(/未识别 Milo/);
    expect(miloBomSchema.safeParse([...bom, bom[0]]).success).toBe(false);
    expect(miloBomSchema.safeParse(bom.map(row => row.name === "Motor Drivers" ? { ...row, quantity: "0.5m" } : row)).success).toBe(false);
    expect(miloBomSchema.safeParse(bom.map(row => row.name === "Motor Drivers" ? { ...row, quantity: -1 } : row)).success).toBe(false);
  });
});

describe("Milo 分轴装配和共享库存", () => {
  it("分清三种导轨/丝杠，三轴各用四滑块、两螺母及一电机一驱动", () => {
    for (const [index, id] of miloAxisIds.entries()) {
      expect(find(id, "MGN15 Rail")).toMatchObject({ name: `MGN15 Rail ${[500, 350, 250][index]}mm`, required: 2 });
      expect(find(id, "TR8x8 4-Start Lead-screw")?.name).toContain(String([550, 535, 300][index]));
      expect(find(id, "MGN15C")?.required).toBe(4);
      expect(find(id, "TR8x8 4-Start Brass")?.required).toBe(2);
      expect(find(id, "NEMA 23")?.required).toBe(1);
      expect(find(id, "Motor Drivers")?.required).toBe(1);
      expect(find(id, "608 2Z")?.required).toBe([1, 4, 3][index]);
    }
    expect(find("X", "Spider")?.required).toBe(1);
    expect(find("Y", "Spider")?.required).toBe(1);
    expect(find("Z", "Spider")).toBeUndefined();
    for (const name of ["200mm GT2", "GT2 20T", "GT2 40T"]) expect(find("Z", name)?.required).toBe(1);
    expect(find("X", "GT2 20T")).toBeUndefined();
  });

  it("共享一块 XY 滑台板，三轴可任意顺序装配且重复添加幂等", () => {
    for (const order of [["X", "Y", "Z"], ["Z", "Y", "X"]] as const) {
      let installed: MiloAxisId[] = [];
      for (const id of order) installed = assembleMiloAxis(bom, installed, id);
      expect(installed).toEqual(order);
      expect(assembleMiloAxis(bom, installed, order[0])).toEqual(order);
      expect(getMiloAxisRequirements(bom, "Y", installed).find(p => p.name === "XY gantry plate"))
        .toMatchObject({ stock: 1, reserved: 1, required: 0, available: 0, shortfall: 0 });
      expect(getMiloAxisRequirements(bom, "Y", installed).find(p => p.name === "MGN15C Rail Carriage"))
        .toMatchObject({ stock: 12, reserved: 8, required: 4, available: 4, shortfall: 0 });
    }
  });

  it("缺驱动的修改版可导入，第三轴装配与超配的存档恢复都会报告差额", () => {
    const short = parseMiloBom(markdown.replace(/(\|\s*Motor Drivers\s*\|[^\r\n]*?\|)\s*3\s*\|/i, "$1 2 |"));
    expect(assembleMiloAxis(short, ["Y"], "X")).toEqual(["Y", "X"]);
    expect(() => assembleMiloAxis(short, ["X", "Y"], "Z")).toThrow(/Z 轴缺料.*驱动器还差 1 件/);
    expect(() => validateMiloAssembly(short, ["Z", "Y", "X"])).toThrow(/X 轴缺料/);
    expect(() => validateMiloAssembly(bom, ["X", "X"])).toThrow(/重复/);
  });

  it("缺行或数量未知的清单可导入，按可用的真实数量装轴", () => {
    const partial = parseMiloBom(markdown.split("\n").filter(line => !line.includes("550mm (min - X-Axis)")).join("\n"));
    expect(() => assembleMiloAxis(partial, [], "X")).toThrow(/550 mm.*还差 1 件/);
    expect(assembleMiloAxis(partial, [], "Y")).toEqual(["Y"]);
    const unknown = miloBomSchema.parse(bom.map(row => row.name === "Motor Drivers" ? { ...row, quantity: "N/A" } : row));
    expect(getMiloAxisRequirements(unknown, "Z").find(row => row.name === "Motor Drivers")).toMatchObject({ stock: 0, shortfall: 1 });
  });

  it("相近丝杠规格与错误分类不能补足实际缺件", () => {
    const wrong = miloBomSchema.parse(bom.map(row => row.name.includes("550mm (min") ? { ...row, name: row.name.replace("TR8x8", "TR8x2") }
      : row.name === "MGN15 Rail 500mm" ? { ...row, category: "Frame" } : row));
    expect(() => assembleMiloAxis(wrong, [], "X")).toThrow(/丝杠.*1 件.*导轨.*2 件/);
    expect(assembleMiloAxis(wrong, [], "Z")).toEqual(["Z"]);
  });
});
