import { describe, expect, it } from "vitest";
import { getFactoryModel, inspectFactoryLayout, parseFactoryLayout, replaceFactoryResourcePackage, resolveFactoryLayout, upsertFactoryLayout, type FactoryLayout } from "../contracts/factory";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { addInstance, emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "../contracts/twin-simulation";

function device(model: string, actualClass: string, parameters: Record<string, number>, version = "1.0.0") {
  return parseDevicePackage({ schemaVersion: 1, manufacturer: "测试工厂", model, revision: "A",
    source: { kind: "local", title: "设备节拍表", locator: model, url: "", excerpt: "测试工况" }, ports: [], rules: [],
    factory: { modelRef: { id: "GouyuanFactory." + actualClass, version }, parameters } });
}
function example() {
  const loader = device("上下料手", "PickPlace", { handlingS: 3 });
  const cnc = device("数控机床", "CycleCNC", { cycleS: 15 });
  const agv = device("周转车", "MobileRobot", { emptySpeedMps: 2, loadedSpeedMps: 1, pickTimeS: 0, dropTimeS: 0 });
  const belt = device("输送机", "BeltConveyor", { speedMps: 2.5 });
  const ws: TwinWorkspace = { ...emptyWorkspace(), packages: [loader, cnc, agv, belt] };
  const resource = (id: string, p: typeof cnc, x: number, y: number) => ({ id, name: id, packageKey: packageKey(p), positionM: [x, y] });
  const factory = parseFactoryLayout({ schemaVersion: 1, kind: "factory-layout", id: "shop", name: "机加车间",
    resources: [resource("load", loader, 0, 0), resource("m1", cnc, 5, 2), resource("m2", cnc, 5, -2), resource("agv", agv, 4, 3), resource("out", loader, 7, 2), resource("belt", belt, 6, 2)],
    lines: [{ id: "line1", name: "主线", batch: { quantity: 3, releaseIntervalS: 2 }, stages: [
      { id: "prep", name: "上料", operation: "handle", stations: ["load"], carriers: [] },
      { id: "mill", name: "铣削", operation: "machine", stations: ["m1", "m2"], carriers: ["agv"] },
      { id: "out", name: "下料", operation: "handle", stations: ["out"], carriers: ["agv"] },
    ] }] });
  return { ws, factory, cnc, loader };
}

describe("工厂装配合同", () => {
  it("多个产线和并行工位共享设备，按线展开工件并保留各自投料时间", () => {
    const { ws, factory } = example(), a = factory.lines[0];
    factory.lines.push({ ...a, id: "line2", name: "支线", batch: { quantity: 2, releaseIntervalS: 1.5 } });
    const result = resolveFactoryLayout(ws, factory);
    expect(result.resources.map(r => r.model.role)).toEqual(["handle", "machine", "machine", "mobile", "handle", "conveyor"]);
    expect(result.stages.map(item => item.stage.id)).toEqual(["prep", "mill", "out", "prep", "mill", "out"]);
    expect(result.jobs.map(job => [job.line.id, job.serial, job.firstStage, job.lastStage, job.releaseS])).toEqual([
      ["line1",1,1,3,0], ["line1",2,1,3,2], ["line1",3,1,3,4], ["line2",1,4,6,0], ["line2",2,4,6,1.5],
    ]);
    expect(parseWorkspace(JSON.parse(JSON.stringify(upsertFactoryLayout(ws, factory)))).factories).toEqual([factory]);
    expect(parseWorkspace(emptyWorkspace())).not.toHaveProperty("factories");
  });

  it("更换加工模板时保留实例的工序连接与位置，清除旧型号的参数和物料选择", () => {
    const { ws, factory } = example();
    const feed = device("加工中心B", "FeedCNC", { clampS: 0, cutLengthMm: 20, feedMmMin: 400 });
    const old = { ...factory.resources[1], parameters: { cycleS: 7 }, materialId: "old-cnc" };
    const next = replaceFactoryResourcePackage(old, feed);
    expect(next).toEqual({ ...factory.resources[1], packageKey: packageKey(feed) });
    factory.resources[1] = next; ws.packages.push(feed);
    const resolved = resolveFactoryLayout(ws, factory);
    expect(resolved.resources[1].parameters).toEqual(feed.factory!.parameters);
    expect(resolved.stages[1].stage.stations).toContain(next.id);
    next.parameters = { feedMmMin: 550 };
    expect(resolveFactoryLayout(ws, factory).resources[1].parameters).toMatchObject({ clampS: 0, feedMmMin: 550 });
    next.parameters = { cycleS: 4 };
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/m1.*cycleS/);
    next.parameters = { feedMmMin: 0 };
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/m1.*feedMmMin/);
  });

  it("按实体实例核对 BOM 库存和选定修订，工件批量不消耗机床数量", () => {
    const { ws, factory, cnc, loader } = example();
    const row = { id: "mill-row", name: "已采购数控机床", quantity: 2, unit: "台", binding: { kind: "device" as const, key: packageKey(cnc) } };
    ws.catalog = { models: [], materials: [row] };
    factory.resources[1].materialId = row.id; factory.resources[2].materialId = row.id;
    expect(inspectFactoryLayout(ws, factory)).toEqual([]);
    row.quantity = 1; expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/库存|数量不足/);
    row.quantity = 2; row.unit = "kg"; expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/件数|单位/);
    row.unit = "台"; row.binding.key = packageKey(loader);
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/绑定|修订/);
  });

  it("多目的地可用移动运输，固定带只能复用相同方向的物理端点，无载具交接需要共位", () => {
    const { ws, factory } = example();
    const [,mill,out] = factory.lines[0].stages;
    out.carriers = ["belt"];
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/固定输送|输送带/);
    factory.resources[2].positionM = [...factory.resources[1].positionM];
    expect(inspectFactoryLayout(ws, factory)).toEqual([]);
    factory.lines.push({ id: "reverse", name: "返线", batch: { quantity: 1, releaseIntervalS: 0 }, stages: [
      { ...out, id: "first", carriers: [] }, { ...mill, id: "return", carriers: ["belt"] },
    ] });
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/固定输送|输送带/);
    factory.lines.pop(); out.carriers = [];
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/共位|同一位置|运输/);
    factory.resources[4].positionM = [...factory.resources[1].positionM];
    expect(inspectFactoryLayout(ws, factory)).toEqual([]);
  });

  it("归档保留缺失引用或未来模型，运行诊断精确定位，工厂设备不能加入信号接线", () => {
    const { ws, factory, cnc } = example();
    const future = device("数控机床", "CycleCNC", { cycleS: 15 }, "1.2.0");
    ws.packages[1] = future;
    expect(getFactoryModel(future.factory!.modelRef)).toBeUndefined();
    expect(parseWorkspace({ ...ws, factories: [factory] }).packages[1]).toEqual(future);
    expect(() => resolveFactoryLayout(ws, factory)).toThrow(/CycleCNC.*1.2.0/);
    expect(() => addInstance(ws, packageKey(future), "假接线设备")).toThrow(/工厂/);
    expect(() => parseWorkspace({ ...ws, instances: [{ id: "fake", name: "假接线设备", packageKey: packageKey(future), inputs: {} }] })).toThrow(/工厂/);
    expect(() => parseDevicePackage({ ...cnc, ports: [{ id: "in", label: "脉冲", type: "boolean", direction: "input" }] })).toThrow(/端口/);
    factory.resources[0].packageKey = "";
    factory.lines[0].stages[0].stations = [];
    expect(upsertFactoryLayout(ws, factory).factories![0]).toEqual(factory);
    expect(inspectFactoryLayout(ws, factory).join(" ")).toMatch(/load.*设备|工位/);
  });

  it("厂家缺失的工时须显式补齐，同修订参数顺序变化不会产生新设备", () => {
    const { ws, factory } = example();
    const partial = device("资料待补", "FeedCNC", { clampS: 0, cutLengthMm: 20 });
    const reordered = { ...partial, factory: { ...partial.factory!, parameters: { cutLengthMm: 20, clampS: 0 } } };
    const installed = installPackage(ws, partial);
    expect(installPackage(installed, reordered)).toBe(installed);
    factory.resources[1] = replaceFactoryResourcePackage(factory.resources[1], partial);
    expect(() => resolveFactoryLayout(installed, factory)).toThrow(/m1.*feedMmMin/);
    factory.resources[1].parameters = { feedMmMin: 1200 };
    expect(resolveFactoryLayout(installed, factory).resources[1].parameters).toEqual({ clampS: 0, cutLengthMm: 20, feedMmMin: 1200 });
    expect(() => device("坏厂家值", "FeedCNC", { clampS: -1 })).toThrow(/clampS/);
    expect(() => device("错误单位名", "FeedCNC", { feedMmS: 20 })).toThrow(/feedMmS/);
  });

  it("区分工位与运输角色，拒绝重复标识、超限工况及不可表示的投料时刻", () => {
    const { ws, factory } = example();
    const alter = (modify: (f: FactoryLayout) => void) => { const f = structuredClone(factory); modify(f); return inspectFactoryLayout(ws,f).join(" "); };
    expect(alter(f => { f.lines[0].stages[0].carriers = ["agv"]; })).toMatch(/首|第一/);
    expect(alter(f => { f.lines[0].stages[1].stations = ["load"]; })).toMatch(/能力|加工/);
    expect(alter(f => { f.lines[0].stages[1].carriers = ["out"]; })).toMatch(/运输|搬运/);
    expect(alter(f => { f.lines[0].stages[1].stations = ["gone"]; })).toMatch(/gone/);
    expect(alter(f => { f.resources[1].id = f.resources[0].id; })).toMatch(/重复/);
    expect(alter(f => { f.lines[0].batch.quantity = 65; })).not.toBe("");
    expect(alter(f => { f.lines[0].batch.releaseIntervalS = Number.MAX_VALUE; })).not.toBe("");
  });
});
