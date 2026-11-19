import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getFactoryModel, inspectFactoryLayout, parseFactoryLayout, resolveFactoryLayout, resolveFactoryParameters } from "../contracts/factory";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { factoryInputs, scheduleFactory } from "../src/lib/factory-kernel";
import { factoryModelicaFiles } from "../src/lib/factory-modelica";
import { readFactoryRun } from "../src/lib/factory-runtime";

const body = (model: string, revision = "1") => ({
  schemaVersion: 1, manufacturer: "工厂试件", model, revision, ports: [], rules: [],
  source: { kind: "local", title: "装配和测试额定表", locator: model, url: "", excerpt: "受控样例参数" },
});
const slot = (id: string, part: DevicePackage, quantity: number) => ({ id, label: id, packageKey: packageKey(part), quantity });
const binding = { path: ["feed", "drive"], rating: "feedRate" };
function drive(model: string, value: number, unit: string) {
  return parseDevicePackage({ ...body(model), composition: { kind: "leaf", ratings: { feedRate: { label: "标定进给速度", value, unit } } } });
}
function setup() {
  const normal = drive("额定驱动", 600, "mm/min"), faster = drive("高速驱动", 1200, "mm/min");
  const bearing = parseDevicePackage({ ...body("轴承"), composition: { kind: "leaf" } });
  const module = (motor: DevicePackage, qty: number, rev: string) =>
    parseDevicePackage({ ...body("传动总成", rev), composition: { kind: "assembly", parts: [slot("drive", motor, 2), slot("bearing", bearing, qty)] } });
  const normalModule = module(normal, 4, "1"), fastModule = module(faster, 4, "fast"), moreBearings = module(normal, 6, "more");
  const machine = (head: DevicePackage, rev: string) =>
    parseDevicePackage({ ...body("加工中心", rev), composition: { kind: "assembly", parts: [slot("feed", head, 3)] },
      factory: { modelRef: { id: "GouyuanFactory.FeedCNC", version: "1.0.0" }, parameters: { clampS: 2, cutLengthMm: 200 },
        partParameters: { feedMmMin: binding } } });
  const root = machine(normalModule, "1"), changed = machine(fastModule, "fast"), spare = machine(moreBearings, "more");
  const workspace = parseWorkspace({ ...emptyWorkspace(), packages: [normal, faster, bearing, normalModule, fastModule, moreBearings, root, changed, spare] });
  const layout = parseFactoryLayout({ schemaVersion: 1, kind: "factory-layout", id: "shop", name: "两台加工中心",
    resources: ["A", "B"].map(id => ({ id, name: id, packageKey: packageKey(root), positionM: [0, 0] })),
    lines: [{ id: "line", name: "试制线", batch: { quantity: 5, releaseIntervalS: 0 }, stages: [
      { id: "cut", name: "加工", operation: "machine", stations: ["A", "B"], carriers: [] },
    ] }] });
  return { normal, normalModule, bearing, root, changed, spare, workspace, layout };
}
const wasm = (name: string) => new WebAssembly.Module(readFileSync(new URL("../public/modelica/runtime/factory-" + name + ".wasm", import.meta.url)));
const devices = wasm("models"), scheduler = wasm("scheduler");

describe("工厂从多级部件的额定参数运行", () => {
  it("每个工位的目标参数记录实际部件、路径和修订，多件用量不会放大单件额定值", () => {
    const { workspace, layout, root, normalModule, normal } = setup();
    layout.resources[0].parameters = { clampS: 1 };
    const factory = resolveFactoryLayout(workspace, layout), atA = factory.resources[0];
    expect(atA.parameters).toEqual({ clampS: 1, cutLengthMm: 200, feedMmMin: 600 });
    expect(atA.parameterSources.clampS).toMatchObject({ kind: "instance", value: 1, unit: "s" });
    expect(atA.parameterSources.cutLengthMm).toMatchObject({ kind: "device", packageKey: packageKey(root), value: 200, unit: "mm" });
    expect(atA.parameterSources.feedMmMin).toEqual({ kind: "part", packageKey: packageKey(normal), path: binding.path,
      packagePath: [root, normalModule, normal].map(packageKey), rating: "feedRate", label: "标定进给速度", value: 600, unit: "mm/min" });
    const native = factoryModelicaFiles(factory, 65);
    expect(native["FactoryRun.mo"]).toContain("GouyuanFactory.FeedCNC(clampS = 1, cutLengthMm = 200, feedMmMin = 600)");
    expect(JSON.parse(native["factory-map.json"]).resources[0].parameterSources).toEqual(atA.parameterSources);
  });

  it("仅选中的机床换部件后按新速度调度，改变未绑定的轴承用量可保留同一工艺轨迹", () => {
    const { workspace, layout, root, changed, spare } = setup();
    const run = (replacement: DevicePackage) => {
      const revision = { ...layout, resources: [{ ...layout.resources[0], packageKey: packageKey(replacement) }, layout.resources[1]] };
      const factory = resolveFactoryLayout(workspace, revision), inputs = factoryInputs(factory, devices);
      return { factory, result: readFactoryRun(factory, scheduleFactory(scheduler, inputs)) };
    };
    const old = run(root), fast = run(changed), stockOnly = run(spare);
    expect(old.result.makespanS).toBe(66);
    expect(fast.result.makespanS).toBe(44);
    expect(fast.factory.resources.map(r => r.parameters.feedMmMin)).toEqual([1200, 600]);
    expect(stockOnly.result.operations).toEqual(old.result.operations);
  });

  it("未安装、槽位、额定名和单位错误给出整条路径，并能区分主动指定的实例数值", () => {
    const { workspace, layout, root, normal } = setup();
    const model = getFactoryModel(root.factory!.modelRef)!;
    const installed = new Map(workspace.packages.map(p => [packageKey(p), p]));
    installed.delete(packageKey(normal));
    const missing = resolveFactoryParameters(root, model, installed);
    expect(missing.issues.join(" ")).toMatch(/feedMmMin.*feed.*drive.*额定驱动/);
    const override = resolveFactoryParameters(root, model, installed, { feedMmMin: 500 });
    expect(override.issues).toEqual([]);
    expect(override.parameterSources.feedMmMin).toMatchObject({ kind: "instance", value: 500, overridesPart: binding });
    installed.set(packageKey(normal), drive(normal.model, 2, "m/s"));
    expect(resolveFactoryParameters(root, model, installed).issues.join(" ")).toMatch(/feed.*drive.*m\/s.*mm\/min/);
    installed.set(packageKey(normal), drive(normal.model, -1, "mm/min"));
    expect(resolveFactoryParameters(root, model, installed).issues.join(" ")).toMatch(/feed.*drive.*正/);
    for (const bad of [{ path: ["feed", "wrong"], rating: "feedRate" }, { path: binding.path, rating: "wrong" }]) {
      const device = parseDevicePackage({ ...root, factory: { ...root.factory, partParameters: { feedMmMin: bad } } });
      const issues = inspectFactoryLayout({ ...workspace, packages: workspace.packages.map(p => packageKey(p) === packageKey(root) ? device : p) }, layout);
      expect(issues.join(" ")).toMatch(/feed.*wrong/);
    }
  });

  it("旧修订仍从原参数运行，拒绝同一参数同时使用整机固定值和部件来源", () => {
    const { workspace, layout, root } = setup();
    const original = { ...root, revision: "old", composition: undefined, factory: { modelRef: root.factory!.modelRef,
      parameters: { ...root.factory!.parameters, feedMmMin: 450 } } };
    const old = parseDevicePackage(JSON.parse(JSON.stringify(original)));
    const snapshot = parseWorkspace({ ...workspace, packages: [...workspace.packages, old] });
    const archive = { ...layout, resources: layout.resources.map(r => ({ ...r, packageKey: packageKey(old) })) };
    expect(resolveFactoryLayout(snapshot, archive).resources[0].parameterSources.feedMmMin).toMatchObject({ kind: "device", value: 450 });
    expect(() => parseDevicePackage({ ...root, factory: { ...root.factory, parameters: original.factory.parameters } })).toThrow(/feedMmMin/);
  });

  it("编辑含部件绑定的设备时允许非绑定参数待补，运行时再要求实例补齐", () => {
    const { workspace, layout, root } = setup();
    const partial = parseDevicePackage({ ...root, factory: { ...root.factory, parameters: { cutLengthMm: 200 } } });
    const model = getFactoryModel(root.factory!.modelRef)!;
    const installed = new Map(workspace.packages.map(p => [packageKey(p), p]));
    expect(resolveFactoryParameters(partial, model, installed, {}, false).issues).toEqual([]);
    expect(resolveFactoryParameters(partial, model, installed).issues.join(" ")).toContain("clampS");
    const withPartial = { ...workspace, packages: workspace.packages.map(p => packageKey(p) === packageKey(root) ? partial : p) };
    for (const r of layout.resources) r.parameters = { clampS: 2 };
    expect(resolveFactoryLayout(withPartial, layout).resources[0].parameters).toEqual({ clampS: 2, cutLengthMm: 200, feedMmMin: 600 });
  });
});
