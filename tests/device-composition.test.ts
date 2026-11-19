import { describe, expect, it } from "vitest";
import { compositionKind, compositionRollupCsv, deviceCompositionClosure, getDeviceParts, rollupDeviceParts, type DevicePart } from "../contracts/device-composition";
import { bundleMechanicalDevice, installMechanicalBundle, parseMechanicalBundle } from "../contracts/mechanical-assembly";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { addInstance, emptyWorkspace, installPackage, maxPackages, parseWorkspace } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

const identity = (model: string) => ({ manufacturer: "结构试验", model, revision: "1" });
const key = (model: string) => packageKey(identity(model));
const bare = (model: string) => ({ ...identity(model), schemaVersion: 1, ports: [], rules: [],
  source: { kind: "local", title: "结构测试图", locator: model, excerpt: "数量为测试设计。", url: "" } });
const part = (id: string, model: string, quantity = 1): DevicePart => ({ id, label: id, packageKey: key(model), quantity });
const leaf = (model: string) => parseDevicePackage({ ...bare(model), composition: { kind: "leaf" } });
const assembly = (model: string, parts: DevicePart[]) => parseDevicePackage({ ...bare(model), composition: { kind: "assembly", parts } });
const demand = (model: string, quantity = 1) => ({ packageKey: key(model), quantity });
const frame = { positionMm: [0, 0, 0], quatWxyz: [1, 0, 0, 0] };
const mount = { kind: "part", input: frame, joint: { type: "fixed" }, outputs: [{ id: "out", ...frame }] };
const mechanical = (model: string, id: string, child: string) => parseDevicePackage({ ...bare(model), mechanics: {
  kind: "assembly", assembly: { schemaVersion: 1, kind: "mechanical-assembly", id: "m", name: "机械试件",
    nodes: [{ id, packageKey: key(child), parent: null }], output: { node: id, mount: "out" }, commands: {} },
} });

describe("设备组成与多级用量", () => {
  it("共享件按各条路径和父件数量累计，未知结构和待安装修订列为缺口", () => {
    const ring = leaf("圈"), empty = parseDevicePackage({ ...bare("采购件"), ports: [{ id: "p", label: "输入", direction: "input", type: "number" }] });
    const middle = assembly("支承", [part("rings", "圈", 2), part("purchase", "采购件")]);
    const motor = assembly("电机", [part("upper", "支承"), part("lower", "支承"), part("extra", "圈"), part("missing", "未装")]);
    const pkgs = [ring, middle, motor, empty], roots = [demand("电机", 3), demand("支承"), demand("电机")];
    expect(rollupDeviceParts(pkgs, roots)).toEqual({ complete: false, leafQuantity: "22", rows: [
      { packageKey: key("圈"), status: "leaf", quantity: "22" },
      { packageKey: key("采购件"), status: "unknown", quantity: "9" },
      { packageKey: key("未装"), status: "missing", quantity: "4" },
    ] });
    const closure = deviceCompositionClosure(pkgs, [key("电机"), key("支承")]);
    expect(closure.packages.map(p => p.model)).toEqual(["电机", "支承", "圈", "采购件"]);
    expect(closure.missing).toEqual([key("未装")]);
    expect(compositionKind(empty)).toBe("unknown");
    expect(() => addInstance(pkgs.reduce(installPackage, emptyWorkspace()), key("圈"), "误用")).toThrow(/端口|结构/);
  });

  it("100 层复用同一子件仍只访问设备定义，累计数量超过安全整数时逐位准确", () => {
    const packages = [leaf("0")];
    for (let i = 1; i <= 100; i++) packages.push(assembly(String(i), [part("a", String(i-1), 10), part("b", String(i-1), 5)]));
    const expected = String(15n ** 100n);
    expect(deviceCompositionClosure(packages, [key("100")]).packages.length).toBe(101);
    expect(rollupDeviceParts(packages, [demand("100")])).toEqual({ complete: true, leafQuantity: expected,
      rows: [{ packageKey: key("0"), status: "leaf", quantity: expected }] });
  });

  it("完整设备目录可保存 512 个相互引用的修订，超过容量时导入与安装均明确拒绝", () => {
    const packages = [leaf("0")];
    for (let i = 1; i < 512; i++) packages.push(assembly(String(i), [part("a", String(i - 1)), part("b", String(i - 1))]));
    const ws = parseWorkspace({ ...emptyWorkspace(), packages: [...packages].reverse() });
    expect(maxPackages).toBe(512);
    expect(rollupDeviceParts(ws.packages, [demand("511")]).leafQuantity).toBe(String(2n ** 511n));
    expect(() => installPackage(ws, leaf("满容量后的新件"))).toThrow(/512/);
    expect(() => parseWorkspace({ ...ws, packages: [...ws.packages, leaf("多余件")] })).toThrow(/512/);
  });

  it("CSV 原样写入大整数，对型号和修订中的逗号、引号、换行与公式前缀做转义", () => {
    const unusual = parseDevicePackage({ ...leaf('圈,"A"\nB'), manufacturer: "=3+2", revision: "＠SUM" });
    const parent = assembly("分组", [{ ...part("item", "任意", Number.MAX_SAFE_INTEGER), packageKey: packageKey(unusual) }]);
    const csv = compositionRollupCsv(rollupDeviceParts([unusual, parent], [demand("分组", 2), demand("未装")]));
    expect(csv).toBe('manufacturer,model,revision,status,quantity\r\n\'=3+2,"圈,""A""\nB",\'＠SUM,leaf,18014398509481982\r\n结构试验,未装,1,missing,1\r\n');
  });

  it("重导同一修订时忽略额定值字典的键顺序，保留真实数值差异", () => {
    const rpm = { label: "转速", value: 1000, unit: "rpm" }, torque = { label: "转矩", value: 2, unit: "N.m" };
    const declared = parseDevicePackage({ ...bare("电机属性"), composition: { kind: "leaf", ratings: { torque, rpm } } });
    const ws = { ...emptyWorkspace(), packages: [{ ...declared, composition: {
      kind: "leaf" as const, ratings: { torque, rpm },
    } }] };
    expect(installPackage(ws, declared)).toBe(ws);
    expect(() => installPackage(ws, { ...declared, composition: { kind: "leaf", ratings: { torque: { ...torque, value: 3 }, rpm } } })).toThrow(/不同内容/);
  });

  it("可先装父级，补件形成已知引用环时整笔拒绝，旧存档没有隐含叶件", () => {
    const a = assembly("甲", [part("b", "乙")]), b = assembly("乙", [part("a", "甲")]);
    const partial = installPackage(emptyWorkspace(), a);
    expect(parseWorkspace(JSON.parse(JSON.stringify(partial)))).toEqual(partial);
    expect(() => installPackage(partial, b)).toThrow(/循环.*甲.*乙|递归.*甲.*乙|循环.*乙.*甲|递归.*乙.*甲/);
    expect(partial.packages).toEqual([a]);
    expect(() => parseWorkspace({ ...partial, packages: [a, b] })).toThrow(/循环|递归/);
    expect(() => parseImportText(JSON.stringify({ kind: "device-library", schemaVersion: 1, packages: [a, b] }), "设备库.json")).toThrow(/循环|递归/);
    expect(() => assembly("甲", [part("own", "甲")])).toThrow(/引用|递归|循环/);
    expect(rollupDeviceParts([a, leaf("乙")], [demand("甲")]).complete).toBe(true);
  });

  it("拒绝不完整修订、重复槽位、不安全数量和对额定参数的重复或非法声明", () => {
    const valid = part("slot", "子件");
    for (const malformed of ["仅有型号", '["厂","子件"]', '["厂", "子件","1"]', '["厂","子件",""]']) {
      expect(() => assembly("父件", [{ ...valid, packageKey: malformed }])).toThrow(/修订/);
    }
    for (const quantity of [0, -1, 1.5, 2**53]) expect(() => assembly("父件", [{ ...valid, quantity }])).toThrow();
    expect(() => assembly("父件", [valid, valid])).toThrow(/槽位|重复/);
    expect(() => assembly("父件", [])).toThrow();
    expect(() => parseDevicePackage({ ...bare("子件"), composition: { kind: "leaf", parts: [valid] } })).toThrow();
    const spec = { kind: "leaf", ratings: JSON.parse('{"__proto__":{"label":"额定","value":1,"unit":"m/s"}}') };
    expect(() => parseDevicePackage({ ...bare("子件"), composition: spec })).toThrow();
    const factory = { modelRef: { id: "GouyuanFactory.BeltConveyor", version: "1.0.0" }, parameters: {},
      partParameters: { speedMps: { path: ["drive"], rating: "speed" } } };
    expect(parseDevicePackage({ ...bare("带"), factory }).factory).toEqual(factory);
    expect(() => parseDevicePackage({ ...bare("带"), factory: { ...factory, parameters: { speedMps: 1 } } })).toThrow(/重复|同时/);
    expect(() => parseDevicePackage({ ...bare("带"), factory: { ...factory, partParameters: { invalid: factory.partParameters.speedMps } } })).toThrow(/未声明/);
    expect(() => parseDevicePackage({ ...bare("带"), factory: { ...factory, partParameters: { speedMps: { path: [], rating: "speed" } } } })).toThrow();
  });

  it("机械装配复用已封装节点，机械部件的通用物料依赖随机械包完整导入导出", () => {
    const screw = leaf("紧固件"), bed = parseDevicePackage({ ...assembly("底座", [part("bolts", "紧固件", 4)]), mechanics: mount });
    const fixture = mechanical("已封装夹具", "base", "底座"), ws = [screw, bed, fixture].reduce(installPackage, emptyWorkspace());
    expect(getDeviceParts(fixture)).toEqual([part("base", "底座")]);
    expect(compositionKind(parseDevicePackage({ ...bare("未详述安装件"), mechanics: mount }))).toBe("unknown");
    expect(() => parseDevicePackage({ ...fixture, composition: { kind: "leaf" } })).toThrow(/机械|组成/);
    const bundle = bundleMechanicalDevice(ws, fixture);
    expect(bundle.packages.map(p => p.model)).toEqual(["已封装夹具", "底座", "紧固件"]);
    const fresh = installMechanicalBundle(emptyWorkspace(), JSON.parse(JSON.stringify(bundle)));
    expect(rollupDeviceParts(fresh.packages, [demand("已封装夹具")]).leafQuantity).toBe("4");
    expect(() => parseMechanicalBundle({ ...bundle, packages: [fixture, bed] })).toThrow(/缺少|未安装/);
    const rebound = assembly("紧固件", [part("illegal", "已封装夹具")]);
    expect(() => parseMechanicalBundle({ ...bundle, packages: [fixture, bed, rebound] })).toThrow(/循环|递归/);
  });

  it("一个安装件可带上超过 128 种纯结构叶件，原运动学包的独立容量仍生效", () => {
    const leaves = Array.from({ length: 129 }, (_, i) => leaf("采购" + i));
    const root = parseDevicePackage({ ...assembly("平台", leaves.map((r, i) => part("part" + i, r.model))), mechanics: mount });
    const raw = { schemaVersion: 1, kind: "mechanical-package", rootKey: packageKey(root), packages: [root, ...leaves] };
    expect(parseMechanicalBundle(raw).packages).toHaveLength(130);
    const kinematic = leaves.map(p => parseDevicePackage({ ...p, mechanics: mount }));
    expect(() => parseMechanicalBundle({ ...raw, packages: [root, ...kinematic] })).toThrow(/128/);
  });
});
