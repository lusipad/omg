import { describe, expect, it } from "vitest";
import { parseImportText } from "../contracts/workbench-import";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { addInstance, emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { parseImportCatalog } from "../contracts/import-catalog";

const screw = {
  schemaVersion: 1, manufacturer: "试验台", model: "S-05", revision: "A",
  source: { kind: "local", title: "丝杠选取", url: "", locator: "装配图 1", excerpt: "导程 5 mm/rev" },
  ports: [], rules: [],
  feed: { kind: "lead-screw", leadMmPerRev: 5, modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" } },
};
const table = { ...screw, model: "T-05", feed: { kind: "moving-table", massKg: 5, modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" } } };

describe("进给部件设备包", () => {
  it("经统一设备入口、安装和工程归档保留物理参数与指定模型版本", () => {
    const future = { ...table, revision: "B", feed: { ...table.feed, modelRef: { ...table.feed.modelRef, version: "5.0.0" } } };
    let ws = emptyWorkspace();
    for (const input of [screw, table, future]) {
      const imported = parseImportText(JSON.stringify(input), input.model + ".device.json");
      if (imported.kind !== "device") throw new Error("未识别进给设备包");
      expect(imported.device).toEqual(input);
      ws = installPackage(ws, imported.device);
      expect(() => addInstance(ws, packageKey(input), "信号实例")).toThrow(/直线轴装配/);
      expect(() => parseWorkspace({ ...ws, instances: [{ id: "node-1", packageKey: packageKey(input), name: "误接", inputs: {} }] })).toThrow(/直线轴装配/);
    }
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
  });

  it("拒绝非正数、缺少版本、同包双重角色与伪造信号端口", () => {
    for (const massKg of [0, -1, Infinity, NaN, "5"]) {
      expect(() => parseDevicePackage({ ...table, feed: { ...table.feed, massKg } })).toThrow();
      expect(() => parseImportCatalog({ models: [], materials: [{ id: "r", name: "台", quantity: 1, massKg }] }, [])).toThrow();
    }
    expect(() => parseDevicePackage({ ...screw, feed: { ...screw.feed, leadMmPerRev: 0 } })).toThrow();
    expect(() => parseDevicePackage({ ...screw, feed: { ...screw.feed, modelRef: { id: "Gouyuan.IdealLeadScrew" } } })).toThrow();
    expect(() => parseDevicePackage({ ...screw, servo: { kind: "drive", ratedCurrentA: 2, peakCurrentA: 4 } })).toThrow(/伺服.*进给|进给.*伺服/);
    expect(() => parseDevicePackage({ ...screw, ports: [{ id: "x", direction: "input", label: "输入", type: "number" }] })).toThrow(/信号端口/);
  });
});
