import { describe, expect, it } from "vitest";
import { inspectLinearAssembly, LINEAR_ASSEMBLY_LIMITS, parseLinearAssembly, runLinearAssembly, upsertLinearAssembly, type LinearAssembly } from "../contracts/linear-assembly";
import { servoExampleDrive, servoExampleMotor } from "../contracts/servo-example";
import { simulateServoAxis } from "../contracts/servo-axis";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, parseWorkspace, type TwinWorkspace } from "../contracts/twin-simulation";
import type { MaterialRow } from "../contracts/import-catalog";

const linear: LinearAssembly = {
  schemaVersion: 1, kind: "linear-axis-assembly", id: "bench-A", name: "任意命名的直线平台",
  modules: [{ id: "feed", drive: "柜内驱动", motor: "motor-1", screw: "s5", leadMmPerRev: null, loadInertiaRatio: 1 }],
  axes: [{ id: "U", module: "feed", direction: [2, 0, 0], targetMm: 45 }, { id: "V", module: "feed", direction: [0, 3, 4], targetMm: -5 }],
};
function base(drive = servoExampleDrive, motor = servoExampleMotor): TwinWorkspace {
  const rows: MaterialRow[] = [
    { id: "drive-1", name: "柜内驱动", quantity: 2, model: drive.model, binding: { kind: "device", key: packageKey(drive) } },
    { id: "motor-1", name: "机架电机", quantity: 2, model: motor.model, binding: { kind: "device", key: packageKey(motor) } },
    { id: "s5", name: "精密丝杠", quantity: 2, unit: "件", source: "图册 A", leadMmPerRev: 5 },
    { id: "s10", name: "精密丝杠", quantity: 2, unit: "件", source: "图册 B", leadMmPerRev: 10 },
  ];
  return { ...emptyWorkspace(), packages: [drive, motor], catalog: { models: [], materials: rows } };
}
const moduleEdit = (edit: Partial<LinearAssembly["modules"][number]>): LinearAssembly =>
  ({ ...linear, modules: [{ ...linear.modules[0], ...edit }] });

describe("可复用线性模组的结构与库存", () => {
  it("空白物料引用、未到货的物料和未给出的导程可以保存，运行前有诊断", () => {
    const draft = moduleEdit({ drive: "", motor: "未到货的电机", screw: "", leadMmPerRev: null });
    const ws = upsertLinearAssembly(emptyWorkspace(), draft);
    expect(ws.assemblies).toEqual([draft]);
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
    expect(inspectLinearAssembly(ws, draft).join(" ")).toMatch(/驱动/);
    expect(inspectLinearAssembly(ws, draft).join(" ")).toContain("未到货的电机");
    expect(() => runLinearAssembly(ws, draft)).toThrow();
    expect(parseWorkspace(emptyWorkspace())).not.toHaveProperty("assemblies");
  });
  it("旧清单可以手填导程，同一 ID 修改保留其他装配及当前伺服轴", () => {
    const ws = base();
    const row = ws.catalog!.materials.find((r) => r.id === "s5")!;
    delete row.leadMmPerRev;
    expect(inspectLinearAssembly(ws, linear).join(" ")).toMatch(/导程/);
    const manual = moduleEdit({ leadMmPerRev: 5 });
    expect(inspectLinearAssembly(ws, manual)).toEqual([]);
    const other = { ...manual, id: "secondary", name: "第二工位" };
    const full = upsertLinearAssembly(upsertLinearAssembly(ws, manual), other);
    const edited = upsertLinearAssembly(full, { ...manual, name: "改名" });
    expect(edited.assemblies?.map((a) => a.name)).toEqual(["改名", other.name]);
    expect(full.assemblies?.[0].name).toBe(manual.name);
    expect(() => parseWorkspace({ ...ws, assemblies: [manual, manual] })).toThrow(/标识|重复/);
  });
  it.each([
    { id: "__proto__" }, { modules: [{ ...linear.modules[0], id: "constructor" }] },
    { modules: [linear.modules[0], linear.modules[0]] }, { axes: [linear.axes[0], linear.axes[0]] },
    { axes: [{ ...linear.axes[0], module: "lost" }] }, { axes: [{ ...linear.axes[0], direction: [0, 0, 0] }] },
    { axes: [{ ...linear.axes[0], direction: [0, NaN, 0] }] }, { modules: [{ ...linear.modules[0], leadMmPerRev: -1 }] },
    { modules: [{ ...linear.modules[0], loadInertiaRatio: 101 }] }, { axes: [{ ...linear.axes[0], targetMm: Infinity }] },
    { axes: [] }, { modules: [] },
  ])("无效结构不能进入存档 %#", (change) => expect(() => parseLinearAssembly({ ...linear, ...change })).toThrow());
  it("装配数量达到上限时仍能更新已存对象，越界的轴或装配列表会被拒绝", () => {
    const all = Array.from({ length: LINEAR_ASSEMBLY_LIMITS.assemblies }, (_, i) => ({ ...linear, id: "a" + i }));
    const ws = parseWorkspace({ ...emptyWorkspace(), assemblies: all });
    expect(upsertLinearAssembly(ws, { ...all[0], name: "已编辑" }).assemblies).toHaveLength(all.length);
    expect(() => upsertLinearAssembly(ws, linear)).toThrow(/最多/);
    expect(() => parseWorkspace({ ...ws, assemblies: [...all, linear] })).toThrow();
    const axes = Array.from({ length: LINEAR_ASSEMBLY_LIMITS.axes + 1 }, (_, i) => ({ ...linear.axes[0], id: "X" + i }));
    expect(() => parseLinearAssembly({ ...linear, axes })).toThrow();
  });
  it("同名不同来源用行 ID 消歧，不猜测设备绑定", () => {
    const ws = base();
    expect(inspectLinearAssembly(ws, moduleEdit({ screw: "精密丝杠" })).join(" ")).toMatch(/s5.*s10|s10.*s5/);
    expect(inspectLinearAssembly(ws, linear)).toEqual([]);
    ws.catalog!.materials[0] = { ...ws.catalog!.materials[0], binding: undefined };
    expect(inspectLinearAssembly(ws, linear).join(" ")).toMatch(/绑定/);
  });
  it("每轴占用一套物料，在模块之间按实际行 ID 合计，未实例化的模板不扣料", () => {
    const ws = base();
    const second = { ...linear.modules[0], id: "next", drive: "drive-1", motor: "机架电机" };
    const assembly = { ...linear, modules: [...linear.modules, second, { ...second, id: "unused", drive: "尚未采购" }],
      axes: [linear.axes[0], { ...linear.axes[1], module: "next" }] };
    expect(inspectLinearAssembly(ws, assembly)).toEqual([]);
    ws.catalog!.materials[0] = { ...ws.catalog!.materials[0], quantity: 1 };
    const issues = inspectLinearAssembly(ws, assembly).join(" ");
    expect(issues).toMatch(/柜内驱动.*2.*1/);
    expect(issues).not.toContain("尚未采购");
    expect(() => runLinearAssembly(ws, assembly)).toThrow(/柜内驱动/);
  });
  it("配套错误、角色混用、导程矛盾和超角度各自可定位", () => {
    const ws = base();
    expect(inspectLinearAssembly(ws, moduleEdit({ screw: "drive-1", leadMmPerRev: 5 })).join(" ")).toMatch(/角色|同时|兼作/);
    expect(inspectLinearAssembly(ws, moduleEdit({ leadMmPerRev: 8 })).join(" ")).toMatch(/导程.*(冲突|不一致)/);
    const far = { ...linear, axes: [{ ...linear.axes[0], targetMm: 501 }] };
    expect(upsertLinearAssembly(ws, far).assemblies![0].axes[0].targetMm).toBe(501);
    expect(inspectLinearAssembly(ws, far).join(" ")).toMatch(/U.*3600/);
    const wrong = { ...servoExampleMotor, manufacturer: "测试异厂" };
    expect(inspectLinearAssembly(base(servoExampleDrive, wrong), linear).join(" ")).toMatch(/配套|兼容/);
  });
  it("丝杠 BOM 行可保留自身机械设备包的安装资料", () => {
    const ws = base(), frame = { positionMm: [0, 0, 0], quatWxyz: [1, 0, 0, 0] };
    const screw = parseDevicePackage({ schemaVersion: 1, manufacturer: "测试", model: "螺杆", revision: "1",
      source: { kind: "local", url: "", title: "装配图", locator: "图1", excerpt: "端部测绘" }, ports: [], rules: [],
      mechanics: { kind: "part", input: frame, joint: { type: "fixed" }, outputs: [{ id: "end", ...frame }] } });
    ws.packages.push(screw);
    ws.catalog!.materials[2].binding = { kind: "device", key: packageKey(screw) };
    expect(inspectLinearAssembly(ws, linear)).toEqual([]);
  });
  it("手填的两个不同导程不能同时描述同一实际丝杠行", () => {
    const ws = base();
    delete ws.catalog!.materials[2].leadMmPerRev;
    const a = moduleEdit({ leadMmPerRev: 5 });
    a.modules.push({ ...a.modules[0], id: "left", leadMmPerRev: 10 });
    a.axes = [a.axes[0], { ...a.axes[1], module: "left" }];
    expect(inspectLinearAssembly(ws, a).join(" ")).toMatch(/同一.*丝杠.*导程/);
  });
});

describe("丝杠传动与多轴同步", () => {
  it("位置和速度按原伺服积分结果换算，末端是正规化轴向量的有符号和", () => {
    const ws = base(), result = runLinearAssembly(ws, linear);
    const native = (targetMm: number) => simulateServoAxis({ ...ws, servoAxis: {
      driveKey: packageKey(servoExampleDrive), motorKey: packageKey(servoExampleMotor), targetDeg: targetMm / 5 * 360, loadInertiaRatio: 1,
    } });
    const u = native(45), v = native(-5);
    expect(result.samples.map((s) => s.timeMs)).toEqual([...new Set([...u.samples, ...v.samples].map((s) => s.timeMs))].sort((a, b) => a-b));
    const mid = result.samples.find((s) => s.timeMs === 80)!, um = u.samples.find((s) => s.timeMs === 80)!;
    expect(mid.positionMm[0]).toBeCloseTo(um.positionDeg / 360 * 5, 10);
    expect(mid.velocityMmS[0]).toBeCloseTo(um.speedRpm / 60 * 5, 10);
    expect(mid.positionMm[1]).toBeLessThan(0);
    for (const s of result.samples) {
      expect(s.tipMm).toEqual([expect.closeTo(s.positionMm[0], 9), expect.closeTo(.6 * s.positionMm[1], 9), expect.closeTo(.8 * s.positionMm[1], 9)]);
    }
    const last = result.samples.at(-1)!;
    expect(result.settled).toBe(true);
    expect(last.velocityMmS[0]).toBeCloseTo(u.samples.at(-1)!.speedRpm / 60 * 5, 12);
    expect(last.velocityMmS[0]).toBeGreaterThan(0);
    expect(last.velocityMmS[1]).toBe(0);
    expect(last.positionMm[1]).toBeCloseTo(v.samples.at(-1)!.positionDeg / 360 * 5, 10);
    expect(last.positionMm[1]).not.toBe(-5);
    const stop = v.samples.at(-1)!.timeMs;
    const left = u.samples.filter((s) => s.timeMs <= stop).at(-1)!, right = u.samples.find((s) => s.timeMs > stop)!;
    expect(right.timeMs - left.timeMs).toBe(10);
    const expected = left.positionDeg + (right.positionDeg - left.positionDeg) * (stop - left.timeMs) / (right.timeMs - left.timeMs);
    expect(result.samples.find((s) => s.timeMs === stop)!.positionMm[0]).toBeCloseTo(expected * 5 / 360, 10);
    expect(result.samples.find((s) => s.timeMs === stop)!.velocityMmS[1]).toBeCloseTo(v.samples.at(-1)!.speedRpm / 60 * 5, 12);
    expect(result.samples.find((s) => s.timeMs === stop)!.velocityMmS[1]).toBeLessThan(0);
    expect(result.samples.filter((s) => s.timeMs > stop).every((s) => s.velocityMmS[1] === 0)).toBe(true);
    expect(ws.servoAxis).toBeUndefined();
  });
  it("只换丝杠 BOM 行引用即可改变同一 45 mm 指令的实际瞬态", () => {
    const ws = base();
    const slow = runLinearAssembly(ws, linear).samples.find((s) => s.timeMs === 80)!;
    const fast = runLinearAssembly(ws, moduleEdit({ screw: "s10" })).samples.find((s) => s.timeMs === 80)!;
    expect(fast.positionMm[0] - slow.positionMm[0]).toBeGreaterThan(5);
    expect(fast.velocityMmS[0] - slow.velocityMmS[0]).toBeGreaterThan(30);
  });
  it("在同一工程只换驱动器或电机的 BOM 行，保留两轴指令并得到不同响应", () => {
    const source = { title: "虚构回归夹具", url: "https://example.org/fixture", locator: "样本参数", excerpt: "以下额定值仅用于测试电流降额。" };
    const drive = (model: string, amps: number) => parseDevicePackage({ ...servoExampleDrive, manufacturer: "测试台", model, source,
      servo: { kind: "drive", ratedCurrentA: amps, peakCurrentA: amps * 2 } });
    const strong = drive("T-D2", 2), weak = drive("T-D0.1", .1);
    const motor: DevicePackage = parseDevicePackage({ ...servoExampleMotor, manufacturer: "测试台", model: "T-M2", source,
      servo: { ...servoExampleMotor.servo, ratedCurrentA: 2, compatibleDriveModels: [strong.model, weak.model] } });
    const smallMotor = parseDevicePackage({ ...motor, model: "T-M0.06", servo: { ...motor.servo,
      ratedPowerW: 18.85, ratedTorqueNm: .06, peakTorqueNm: .18, ratedCurrentA: .3, compatibleDriveModels: [strong.model] } });
    const ws = base(strong, motor);
    ws.packages.push(weak, smallMotor);
    ws.catalog!.materials.push(
      { id: "weak-drive", name: "低电流试验驱动", quantity: 2, binding: { kind: "device", key: packageKey(weak) } },
      { id: "small-motor", name: "低转矩试验电机", quantity: 2, binding: { kind: "device", key: packageKey(smallMotor) } },
    );
    const baseline = runLinearAssembly(ws, linear).samples.find((s) => s.timeMs === 40)!;
    for (const swapped of [moduleEdit({ drive: "weak-drive" }), moduleEdit({ motor: "small-motor" })]) {
      expect(swapped.axes.map((a) => a.targetMm)).toEqual([45, -5]);
      const actual = runLinearAssembly(ws, swapped).samples.find((s) => s.timeMs === 40)!;
      expect(actual.velocityMmS[0]).toBeLessThan(baseline.velocityMmS[0]);
      expect(actual.positionMm[0]).toBeLessThan(baseline.positionMm[0]);
    }
  });
  it("超时真实保留末位置与移动速度，零位轴保持静止", () => {
    const motor = parseDevicePackage({ ...servoExampleMotor, model: "超时回归夹具", servo: { ...servoExampleMotor.servo, ratedSpeedRpm: 1, maxSpeedRpm: 1 } });
    const result = runLinearAssembly(base(servoExampleDrive, motor), { ...linear, axes: [linear.axes[0], { ...linear.axes[1], targetMm: 0 }] });
    expect(result.settled).toBe(false);
    const last = result.samples.at(-1)!;
    expect(last.timeMs).toBe(8000);
    expect(last.positionMm[0]).toBeLessThan(1); expect(last.velocityMmS[0]).toBeGreaterThan(0);
    expect(last.velocityMmS[1]).toBe(0);
  });
});
