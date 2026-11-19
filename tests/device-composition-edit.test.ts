import { describe, expect, it } from "vitest";
import { createLocalLeaf, deriveDeviceComposition, nextStructureRevision } from "../contracts/device-composition-edit";
import { getDeviceParts, rollupDeviceParts } from "../contracts/device-composition";
import { getFactoryModel, resolveFactoryParameters } from "../contracts/factory";
import { inspectMechanicalAssembly } from "../contracts/mechanical-assembly";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";

const leaf = (model: string) => createLocalLeaf({ manufacturer: "测试件", model, revision: "1" });
const part = (id: string, pkg: DevicePackage, quantity = 1) => ({ id, label: id, quantity, packageKey: packageKey(pkg) });
const assembly = (model: string, parts: ReturnType<typeof part>[]) => parseDevicePackage({
  ...leaf(model), composition: { kind: "assembly", parts },
});
const installed = (...packages: DevicePackage[]) => packages.reduce(installPackage, emptyWorkspace());

describe("逐层另存设备组成", () => {
  it("沿选中路径派生版本，共用同种电机的另一槽位按原修订计数", () => {
    const ball = leaf("滚珠"), motor = assembly("电机", [part("balls", ball, 3)]);
    const cnc = assembly("机床", [part("x", motor), part("y", motor)]);
    const ws = installed(ball, motor, cnc), old = JSON.stringify(ws);
    const spec = { kind: "assembly" as const, parts: [part("balls", ball, 5)] };
    const result = deriveDeviceComposition(ws, packageKey(cnc), ["x"], spec, "2");
    const root = result.workspace.packages.find(p => packageKey(p) === result.rootKey)!;
    expect(JSON.stringify(ws)).toBe(old);
    expect(root.source).toEqual(cnc.source);
    expect(root.revision).toBe("2");
    expect(getDeviceParts(root)[0].packageKey).not.toBe(packageKey(motor));
    expect(getDeviceParts(root)[1].packageKey).toBe(packageKey(motor));
    expect(result.workspace.packages).toHaveLength(5);
    expect(rollupDeviceParts(result.workspace.packages, [{ packageKey: result.rootKey, quantity: 2 }]).leafQuantity).toBe("16");
    const retry = deriveDeviceComposition(result.workspace, packageKey(cnc), ["x"], spec, "2");
    expect(retry.workspace).toBe(result.workspace);
    expect(nextStructureRevision(ws, packageKey(cnc))).not.toBe(cnc.revision);
  });

  it("换直接子件时可以一起安装草稿基础件，删除过的临时零件不进入设备库", () => {
    const ring = leaf("环"), screw = assembly("丝杠", [part("nut", ring)]);
    const ws = installed(ring, screw), newNut = leaf("新螺母");
    const result = deriveDeviceComposition(ws, packageKey(screw), [], { kind: "assembly", parts: [part("nut", newNut)] },
      "新方案", [newNut, leaf("撤回的零件")]);
    expect(result.workspace.packages.map(p => p.model)).toEqual(expect.arrayContaining(["环", "丝杠", "新螺母"]));
    expect(result.workspace.packages.some(p => p.model === "撤回的零件")).toBe(false);
    expect(result.workspace.instances).toBe(ws.instances);
    expect(result.workspace.packages).toHaveLength(4);
  });

  it("相同根修订的内容冲突、缺件或递归都不给工程留下部分派生结果", () => {
    const p = leaf("滚珠"), cnc = assembly("轴承", [part("balls", p)]);
    const future = { ...cnc, revision: "2" };
    const ws = installed(cnc, p, future), snapshot = JSON.stringify(ws);
    expect(() => deriveDeviceComposition(ws, packageKey(cnc), [], { kind: "assembly", parts: [part("balls", p, 3)] }, "2")).toThrow(/修订/);
    expect(() => deriveDeviceComposition(ws, packageKey(cnc), [], { kind: "assembly", parts: [part("absent", leaf("缺件"))] }, "3")).toThrow(/缺少|未安装/);
    expect(() => deriveDeviceComposition(ws, packageKey(cnc), [], { kind: "assembly", parts: [part("cycle", { ...cnc, revision: "3" })] }, "3")).toThrow();
    expect(JSON.stringify(ws)).toBe(snapshot);
  });

  it("已占用的内部修订号会跳过，拆出的一件可单独换型且原槽仍保留", () => {
    const base = leaf("标准轴承"), alt = leaf("密封轴承");
    const spindle = assembly("主轴", [part("bearing", base, 2)]);
    const occupied = { ...spindle, revision: "1-1" }, machine = assembly("整机", [part("main", spindle)]);
    const ws = installed(base, alt, spindle, occupied, machine);
    const result = deriveDeviceComposition(ws, packageKey(machine), ["main"], { kind: "assembly", parts: [
      part("bearing", base), part("part1", alt),
    ] }, "现场配置");
    const root = result.workspace.packages.find(p => packageKey(p) === result.rootKey)!;
    const revised = result.workspace.packages.find(p => packageKey(p) === getDeviceParts(root)[0].packageKey)!;
    expect(revised.revision).toBe("1-2");
    expect(getDeviceParts(revised)).toEqual([part("bearing", base), part("part1", alt)]);
    expect(getDeviceParts(spindle)).toEqual([part("bearing", base, 2)]);
  });

  it("机械子装配只复制被选实例的包引用，保持父节点、安装点、观察点和关节指令", () => {
    const ring = leaf("轴承");
    const frame = { positionMm: [0, 0, 0], quatWxyz: [1, 0, 0, 0] };
    const moving = parseDevicePackage({ ...leaf("转子"), mechanics: { kind: "part", input: frame,
      joint: { type: "hinge", unit: "deg", axis: [0, 0, 1], range: [-180, 180] }, outputs: [{ id: "face", ...frame }] } });
    const mechanical = parseDevicePackage({ ...leaf("回转总成"), composition: undefined,
      mechanics: { kind: "assembly", assembly: { schemaVersion: 1, kind: "mechanical-assembly", id: "rotor", name: "回转",
        nodes: [{ id: "joint", packageKey: packageKey(moving), parent: null }], output: { node: "joint", mount: "face" }, commands: { joint: 25 } } } });
    const ws = installed(ring, moving, mechanical);
    expect(() => deriveDeviceComposition(ws, packageKey(mechanical), [], { kind: "leaf" }, "2")).toThrow(/安装点/);
    const result = deriveDeviceComposition(ws, packageKey(mechanical), ["joint"], { kind: "assembly", parts: [part("bearing", ring, 2)] }, "2");
    const root = result.workspace.packages.find(p => packageKey(p) === result.rootKey)!;
    if (root.mechanics?.kind !== "assembly" || mechanical.mechanics?.kind !== "assembly") throw new Error("机械结构丢失");
    const copy = root.mechanics.assembly, expected = mechanical.mechanics.assembly;
    expect(copy).toEqual({ ...expected, nodes: [{ ...expected.nodes[0], packageKey: packageKey({ ...moving, revision: "1-1" }) }] });
    expect(inspectMechanicalAssembly(result.workspace, copy)).toEqual([]);
    expect(rollupDeviceParts(result.workspace.packages, [{ packageKey: result.rootKey, quantity: 1 }]).leafQuantity).toBe("2");
  });

  it("只接受型号单位一致的显式额定路径，工艺参数仍可由实例单独补齐", () => {
    const cycle = (model: string, value: number, unit = "s") => createLocalLeaf({ manufacturer: "测试件", model, revision: "1",
      ratings: { period: { label: "夹紧时间", value, unit } } });
    const slow = cycle("夹紧执行器", 6), fast = cycle("快夹", 2), wrong = cycle("长度件", 5, "mm");
    const pkg = parseDevicePackage({ ...assembly("机床", [part("clamp", slow)]), factory: {
      modelRef: { id: "GouyuanFactory.FeedCNC", version: "1.0.0" }, parameters: {},
      partParameters: { clampS: { path: ["clamp"], rating: "period" } },
    } });
    const ws = installed(slow, fast, wrong, pkg);
    const replace = (p: DevicePackage) => deriveDeviceComposition(ws, packageKey(pkg), [],
      { kind: "assembly", parts: [part("clamp", p)] }, "2");
    expect(() => replace(wrong)).toThrow(/单位/);
    const result = replace(fast), map = new Map(result.workspace.packages.map(p => [packageKey(p), p]));
    const swapped = map.get(result.rootKey)!;
    const bound = resolveFactoryParameters(swapped, getFactoryModel(pkg.factory!.modelRef)!, map, {}, false);
    expect(bound.issues).toEqual([]);
    expect(bound.parameters.clampS).toBe(2);
    expect(ws.packages).toHaveLength(4);
  });

  it("支持64层逐级派生，旧版和新版各64个设备修订都能还原", () => {
    const chain = [leaf("最末件")];
    for (let i = 1; i < 64; i++) chain.push(assembly("层" + i, [part("sub", chain[i - 1])]));
    const ws = installed(...chain);
    const edited = deriveDeviceComposition(ws, packageKey(chain[63]), Array(63).fill("sub"), { kind: "leaf", note: "检修边界" }, "02");
    expect(edited.workspace.packages).toHaveLength(128);
    expect(rollupDeviceParts(edited.workspace.packages, [{ packageKey: edited.rootKey, quantity: 1 }]).leafQuantity).toBe("1");
    expect(ws.packages[0].composition?.note).toBeUndefined();
  });
});
