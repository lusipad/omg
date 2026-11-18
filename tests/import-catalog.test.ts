import { describe, expect, it } from "vitest";
import { parseImportCatalog } from "../contracts/import-catalog";
import { makeStaticMeshBundle } from "../contracts/mesh-model";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { generateDevicePackage, inovanceSource } from "../contracts/twin-extract";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";

const model = { id: "b".repeat(64), name: "重力滑块", entry: "models/slide.xml" };
const row = { id: "item-1", name: "测试工件", quantity: 1, notes: "  自测记录\n量程待补充\n" };

describe("导入中心的工程契约", () => {
  it("原样保留本地资料与跨物料绑定，旧工程可独立还原", () => {
    const ws = emptyWorkspace();
    const catalog = { models: [model], materials: [{ ...row, binding: { kind: "physics", key: model.id } }] };
    expect(parseWorkspace({ ...ws, catalog }).catalog).toEqual(catalog);
    expect(parseWorkspace(ws)).not.toHaveProperty("catalog");
    const pkg = generateDevicePackage(inovanceSource);
    expect(parseImportCatalog({ ...catalog, materials: [{ ...row, binding: { kind: "device", key: packageKey(pkg) } }] }, [pkg]).materials).toHaveLength(1);
  });
  it("拒绝丢失引用、重复 ID、越界模型入口和无效数量", () => {
    for (const bad of [
      { models: [], materials: [{ ...row, binding: { kind: "physics", key: model.id } }] },
      { models: [], materials: [{ ...row, binding: { kind: "device", key: "unknown" } }] },
      { models: [model, model], materials: [] }, { models: [], materials: [row, row] },
      { models: [{ ...model, entry: "../model.xml" }], materials: [] },
      { models: [], materials: [{ ...row, quantity: 0 }] },
    ]) expect(() => parseImportCatalog(bad, [])).toThrow();
  });
  it("保存每个模型自己的运行时长、控制值和观测点", () => {
    const run = { durationS: 0.6, controls: [-2], pointId: "site:0" };
    const saved = { models: [{ ...model, run }], materials: [] };
    expect(parseImportCatalog(saved, [])).toEqual(saved);
    expect(() => parseImportCatalog({ ...saved, models: [{ ...model, run: { ...run, durationS: -1 } }] }, [])).toThrow();
  });

  it("本地手册的数字输入提取保留来源身份，不需要公网资料地址", () => {
    const pkg = generateDevicePackage({ ...inovanceSource, url: "" }, true);
    expect(pkg.source.kind).toBe("local");
    expect(pkg.source.url).toBe("");
    expect(() => parseDevicePackage({ ...pkg, source: { ...pkg.source, url: "https://example.org" } })).toThrow();
  });
  it("单独网格保留原字节，按用户选择的单位生成固定几何", () => {
    const mesh = { path: "parts/A&B.stl", data: new Uint8Array([1, 2]) };
    const draft = makeStaticMeshBundle([mesh], mesh.path, "mm");
    const xml = new TextDecoder().decode(draft.files.at(-1)!.data);
    expect(draft.files[0]).toBe(mesh);
    expect(xml).toContain('file="parts/A&amp;B.stl" scale="0.001 0.001 0.001"');
    expect(xml).not.toContain("<joint");
    expect(() => makeStaticMeshBundle([mesh], "missing.obj", "m")).toThrow();
  });
});
