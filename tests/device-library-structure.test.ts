import { describe, expect, it } from "vitest";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";
import { deviceLibraryGroups, exportDeviceLibrary, previewDevicePackages } from "../src/lib/device-library";

const identity = (model: string) => ({ manufacturer: "本地结构测试", model, revision: "1" });
const key = (model: string) => packageKey(identity(model));
const make = (model: string, children: string[] = []) => parseDevicePackage({
  ...identity(model), schemaVersion: 1, ports: [], rules: [],
  source: { kind: "local", title: "装配明细", url: "", locator: model, excerpt: "以此修订的装配记录为准。" },
  composition: children.length ? { kind: "assembly", parts: children.map((child, index) =>
    ({ id: "part" + index, label: child, quantity: 1, packageKey: key(child) })) } : { kind: "leaf" },
});

describe("设备库的部件结构预览与导出", () => {
  it("整机与子件分别呈现；已安装包和候选包可一同查验，确认前没有写入", () => {
    const table = make("工作台", ["传动", "轴承"]), drive = make("传动", ["轴承"]), bearing = make("轴承");
    const batch = [table, drive];
    const ws = installPackage(emptyWorkspace(), bearing), preview = previewDevicePackages(ws, batch);
    expect(deviceLibraryGroups(batch).roots).toEqual([table]);
    expect(deviceLibraryGroups(batch).parts).toEqual([drive]);
    expect(ws.packages).toEqual([bearing]);
    expect(preview.packages).toHaveLength(3);
    const alternative = { ...table, source: { ...table.source, title: "待核验的新资料" } };
    expect(previewDevicePackages(preview, [alternative]).packages.find(p => p.model === "工作台")).toEqual(alternative);
    expect(preview.packages.find(p => p.model === "工作台")).toEqual(table);
  });

  it("从选中修订导出全部可达包，在空工程重建并继续拆解", () => {
    const data = [make("独立备件"), make("工作台", ["传动", "轴承"]), make("传动", ["轴承"]), make("轴承")];
    const exported = exportDeviceLibrary(data, key("工作台"));
    expect(new Set(exported.packages.map(packageKey))).toEqual(new Set([key("轴承"), key("传动"), key("工作台")]));
    expect(exported.packages).toHaveLength(3);
    const read = parseImportText(JSON.stringify(exported), "工作台.device-library.json");
    if (read.kind !== "devices") throw new Error("应识别为增量设备库");
    expect(read.devices.reduce(installPackage, emptyWorkspace()).packages).toEqual(exported.packages);
    expect(() => exportDeviceLibrary(data.slice(0, -1), key("工作台"))).toThrow(/轴承/);
    expect(() => exportDeviceLibrary(data, [""])).toThrow(/未指定设备修订/);
    expect(() => exportDeviceLibrary(data, [])).toThrow(/请选择|请先选择/);
  });
});
