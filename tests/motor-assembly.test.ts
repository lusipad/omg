import { describe, expect, it } from "vitest";
import registry from "../public/modelica/motor-library.json";
import { getDeviceParts } from "../contracts/device-composition";
import { parseFactoryLayout, replaceFactoryResourcePackage, upsertFactoryLayout } from "../contracts/factory";
import { buildServoMotor, factoryMotorMount, installMotorOnFactoryAxis, resolveMotorAxis, resolveServoMotor, setMotorAxisTarget } from "../contracts/motor-assembly";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";

const version = registry.version, fit = "自有教学机座";
const empty = (model: string) => ({
  schemaVersion: 1, manufacturer: "测试工程", model, revision: "1", ports: [], rules: [],
  source: { kind: "local", url: "", title: "测试规格", locator: model, excerpt: "带单位的测试工况。" },
});
function component(kind: "stator" | "rotor" | "bearing", model: string, values: Record<string, number>): DevicePackage {
  const ref = registry.components[kind];
  const ratings = Object.fromEntries(Object.entries(ref.parameters).map(([key, spec]) => [spec.field, { label: key, value: values[key], unit: spec.unit }]));
  return parseDevicePackage({ ...empty(model), composition: { kind: "leaf", ratings }, motorPhysics: { kind, fit, modelRef: { id: ref.id, version } } });
}
const stator = component("stator", "S", { phaseResistanceOhm: 2, qInductanceH: .004, windingTurns: 50, windingFactor: .9, windingCurrentLimitA: 4, polePairs: 2, statorBoreMm: 24 });
const rotor = component("rotor", "R", { rotorFluxWb: .001, rotorInertiaKgM2: .00002, polePairs: 2, rotorDiameterMm: 23, bearingSeatMm: 8 });
const bearing = component("bearing", "B", { bearingViscousNmS: .00012, boreMm: 8 });
const part = (id: string, p: DevicePackage, quantity = 1) => ({ id, label: id, quantity, packageKey: packageKey(p) });
const assembly = (name: string, parts: ReturnType<typeof part>[]) => parseDevicePackage({ ...empty(name), composition: { kind: "assembly", parts } });
const oldMotor = parseDevicePackage({ ...empty("原结构电机"), composition: { kind: "leaf" } });
const linear = assembly("通用轴", [part("coupledMotor", oldMotor)]);
const slide = assembly("进给单元", [part("u", linear), part("v", linear)]);
const port = { id: "testPort", name: "U轴", path: ["slides", "u"], motorSlot: "coupledMotor", fit,
  modelRef: { id: registry.assembly.id, version }, leadMmPerRev: 5, tableMassKg: 5, driveVoltageLimitV: 24,
  driveCurrentLimitA: 4, driveSpeedLimitRpm: 2500, driveReferenceInertiaKgM2: .00004, currentGainOhm: 8, source: "测试记录 #3",
};
const cnc = parseDevicePackage({ ...empty("同型加工设备"), factory: { modelRef: { id: "GouyuanFactory.CycleCNC", version: "1.0.0" }, parameters: { cycleS: 60 } },
  composition: { kind: "assembly", parts: [part("slides", slide)] }, axisPorts: [port] });
const ws = [stator, rotor, bearing, oldMotor, linear, slide, cnc].reduce(installPackage, emptyWorkspace());
const plan = parseFactoryLayout({ schemaVersion: 1, kind: "factory-layout", id: "workshop", name: "测试车间", lines: [], resources: ["a", "b"].map(id => ({
  id, name: id, packageKey: packageKey(cnc), positionM: [0, 0], axisTargetsMm: { testPort: 10 },
})) });
const select = { manufacturer: "我的设备库", model: "自组伺服", revision: "A", statorKey: packageKey(stator), rotorKey: packageKey(rotor), bearingKey: packageKey(bearing) };

describe("按电机部件建模与装入实际 CNC 槽位", () => {
  it("定、转子各一与一对轴承形成可独立安装的修订，参数由原件读取", () => {
    const motor = buildServoMotor(ws, select);
    expect(motor).toMatchObject({ manufacturer: select.manufacturer, model: select.model, revision: "A", motorPhysics: { kind: "motor", fit, modelRef: { id: registry.components.motor.id, version } } });
    expect(motor).not.toHaveProperty("servo");
    expect(getDeviceParts(motor).map(p => [p.packageKey, p.quantity])).toEqual([[packageKey(stator), 1], [packageKey(rotor), 1], [packageKey(bearing), 2]]);
    const installed = installPackage(ws, motor);
    const resolved = resolveServoMotor(installed, packageKey(motor));
    expect(resolved.parameters).toEqual({ phaseResistanceOhm: 2, qInductanceH: .004, windingTurns: 50, windingFactor: .9, windingCurrentLimitA: 4,
      polePairs: 2, rotorFluxWb: .001, rotorInertiaKgM2: .00002, bearingViscousNmS: .00012, bearingCount: 2 });
    expect(installPackage(installed, buildServoMotor(installed, select))).toBe(installed);
    expect(ws.packages).toHaveLength(7);
  });

  it("只替换数据指定的 U 轴与设备实例，来源随归档复原、重复运行保持工艺", () => {
    const motor = buildServoMotor(ws, select), key = packageKey(motor), installed = installPackage(ws, motor);
    expect(factoryMotorMount(installed, plan, "a", "testPort").motorKey).toBe(packageKey(oldMotor));
    expect(() => resolveMotorAxis(installed, plan, "a", "testPort")).toThrow(/电机/);
    const change = installMotorOnFactoryAxis(installed, plan, "a", "testPort", key, "自组轴");
    const next = setMotorAxisTarget(change.layout, "a", "testPort", -17.5);
    const restored = parseWorkspace(JSON.parse(JSON.stringify(upsertFactoryLayout(change.workspace, next))));
    const result = resolveMotorAxis(restored, restored.factories![0], "a", "testPort");
    expect(result.parameters.targetMm).toBe(-17.5);
    expect(Object.keys(result.parameters).sort()).toEqual(Object.keys(registry.assembly.parameters).sort());
    expect(result.sources.qInductanceH).toMatchObject({ packageKey: packageKey(stator), path: ["slides", "u", "coupledMotor", "stator"], value: .004, unit: "H" });
    expect(result.sources.bearingCount).toMatchObject({ packageKey: packageKey(bearing), value: 2 });
    expect(result.sources.tableMassKg.packageKey).toBe(packageKey(result.root));
    expect(result.root.factory).toEqual(cnc.factory);
    expect(change.layout.resources[1]).toEqual(plan.resources[1]);
    expect(plan.resources[0].axisTargetsMm?.testPort).toBe(10);
    expect(factoryMotorMount(restored, next, "b", "testPort").motorKey).toBe(packageKey(oldMotor));
    const newSlideKey = getDeviceParts(result.root)[0].packageKey, newSlide = restored.packages.find(p => packageKey(p) === newSlideKey)!;
    expect(getDeviceParts(newSlide).find(s => s.id === "v")!.packageKey).toBe(packageKey(linear));
    expect(replaceFactoryResourcePackage(next.resources[0], cnc)).not.toHaveProperty("axisTargetsMm");
  });

  it("缺测量值、错误单位、角色或版本不匹配都在组装时给出诊断", () => {
    function attempt(update: (copy: typeof rotor) => void) {
      const bad = structuredClone(rotor); bad.revision = "changed"; update(bad);
      return () => buildServoMotor(installPackage(ws, bad), { ...select, rotorKey: packageKey(bad) });
    }
    expect(attempt(b => { delete b.composition!.ratings!.rotorFluxWb; })).toThrow(/rotorFluxWb/);
    expect(attempt(b => { b.composition!.ratings!.rotorInertiaKgM2.unit = "g.cm2"; })).toThrow(/kg.m2/);
    expect(attempt(b => { b.composition!.ratings!.polePairs.value = 3; })).toThrow(/极对/);
    expect(attempt(b => { b.composition!.ratings!.rotorDiameterMm.value = 24; })).toThrow(/内径|气隙/);
    expect(attempt(b => { b.composition!.ratings!.bearingSeatMm.value = 9; })).toThrow(/轴承内径|轴颈/);
    expect(attempt(b => { b.motorPhysics!.modelRef.version = "99"; })).toThrow(/99/);
    expect(attempt(b => { b.motorPhysics!.fit = "不同接口"; })).toThrow(/接口|配合/);
    expect(() => buildServoMotor(ws, { ...select, statorKey: packageKey(bearing) })).toThrow(/定子/);
  });

  it("声明的装配路径可穿过支承子总成，轴承数量按安装支路相乘", () => {
    const motor = buildServoMotor(ws, select), housing = assembly("单端支承", [part("seat", bearing)]);
    const built = parseDevicePackage({ ...motor, revision: "B",
      composition: { kind: "assembly", parts: [part("s", stator), part("r", rotor), part("h", housing, 2)] },
      motorPhysics: { ...motor.motorPhysics, statorPath: ["s"], rotorPath: ["r"], bearingPath: ["h", "seat"] },
    });
    const installed = [housing, built].reduce(installPackage, ws);
    const result = resolveServoMotor(installed, packageKey(built));
    expect(result.parameters.bearingCount).toBe(2);
    expect(result.sources.bearingCount.slotQuantities).toEqual([
      { parentKey: packageKey(built), slotId: "h", quantity: 2 }, { parentKey: packageKey(housing), slotId: "seat", quantity: 1 },
    ]);
    expect(result.sources.bearingViscousNmS.packagePath).toEqual([packageKey(built), packageKey(housing), packageKey(bearing)]);
  });

  it("旧归档和未知模型版本可查看；成组安装位与同修订冲突不会写入工程", () => {
    const motor = buildServoMotor(ws, select), installed = installPackage(ws, motor);
    const grouped = assembly("成组进给", [part("u", linear, 2)]);
    const cnc2 = parseDevicePackage({ ...cnc, model: "三轴组", composition: { kind: "assembly", parts: [part("slides", grouped)] } });
    const withGroup = [grouped, cnc2].reduce(installPackage, installed);
    const groupLayout = { ...plan, resources: [{ ...plan.resources[0], packageKey: packageKey(cnc2) }] };
    expect(() => installMotorOnFactoryAxis(withGroup, groupLayout, "a", "testPort", packageKey(motor), "2")).toThrow(/成组槽位/);
    const unknown = parseDevicePackage({ ...cnc, model: "待升级", axisPorts: [{ ...port, modelRef: { ...port.modelRef, version: "9.9" } }] });
    const pending = installPackage(ws, unknown);
    const oldLayout = { ...plan, resources: [{ ...plan.resources[0], packageKey: packageKey(unknown) }] };
    expect(parseWorkspace(upsertFactoryLayout(pending, oldLayout)).factories).toEqual([oldLayout]);
    expect(() => resolveMotorAxis(pending, oldLayout, "a", "testPort")).toThrow(/9.9/);
    const different = { ...rotor, revision: "较重" };
    const newer = installPackage(installed, different);
    expect(() => buildServoMotor(newer, { ...select, rotorKey: packageKey(different) })).toThrow(/相同修订/);
    expect(newer.packages.filter(p => p.model === select.model)).toEqual([motor]);
    expect(() => setMotorAxisTarget(plan, "a", "testPort", Infinity)).toThrow();
  });
});
