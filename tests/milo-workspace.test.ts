import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMiloBom } from "../contracts/milo-bom";
import { initialMiloWorkspace, withMiloBom, type MiloWorkspaceState } from "../contracts/milo-workspace";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";

const source = readFileSync(new URL("../public/machines/milo-v1-5/bom-facts.md", import.meta.url), "utf8");
const bom = parseMiloBom(source);
const imported = withMiloBom(initialMiloWorkspace, bom, "sourcing_guide.md");

it("首次导入采购表只建立装配资料，程序来自用户导入或显式加入的示例", () => {
  expect(imported.program).toBe("");
  const saved = { ...imported, program: "G21 G90\nG0 Z7" };
  expect(withMiloBom(saved, bom, "复核.md").program).toBe(saved.program);
});

describe("Milo 工程导入和恢复", () => {
  it("旧工程仍可用，部分装配及编辑中的程序可独立往返 JSON", () => {
    const previous = emptyWorkspace();
    expect(parseWorkspace(previous)).toEqual(previous);
    const saved = { ...previous, milo: { ...imported, assembled: ["Z"], program: "G1 X" } };
    expect(parseWorkspace(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("重新导入先满足已装轴，缺料的轴退回待装，编辑中的程序继续保留", () => {
    const original: MiloWorkspaceState = { ...imported, assembled: ["Y", "X", "Z"], program: "G1 X11 F120" };
    expect(withMiloBom(original, bom, "副本.md")).toEqual({ ...original, bomSource: "副本.md" });
    const oneMotor = bom.map(row => row.name.includes("NEMA 23") ? { ...row, quantity: "1" } : row);
    const revised = withMiloBom(original, oneMotor, "库存修订.md");
    expect(revised.assembled).toEqual(["Y"]);
    expect(revised.program).toBe(original.program);
    expect(() => parseWorkspace({ ...emptyWorkspace(), milo: { ...revised, assembled: ["Y", "X"] } })).toThrow();
  });

  it("恢复时拒绝无 BOM、重复轴与不存在的轴", () => {
    for (const milo of [
      { ...initialMiloWorkspace, assembled: ["Z"] },
      { ...imported, assembled: ["X", "X"] },
      { ...imported, assembled: ["A"] },
    ]) expect(() => parseWorkspace({ ...emptyWorkspace(), milo })).toThrow();
  });
});
