import { describe, expect, it } from "vitest";
import { CONTOUR_REF, mountContourMotors, resolveContourAxes, resolveContourMount, setContourProgram } from "../contracts/cnc-contour";
import { parseFactoryLayout, replaceFactoryResourcePackage, upsertFactoryLayout } from "../contracts/factory";
import { buildServoMotor, installMotorOnFactoryAxis } from "../contracts/motor-assembly";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { packageKey, parseDevicePackage, type DevicePackage, type MotorAxisPort } from "../contracts/twin-device";
import kit from "../public/assemblies/motor-kit/components.library.json";

const library = kit.packages.reduce((w, d) => installPackage(w, d), emptyWorkspace());
const keyOf = (model: string) => packageKey(library.packages.find(p => p.model === model)!);
const selection = { manufacturer: "用户车间", model: "上次实际组装的电机", revision: "B", statorKey: keyOf("S40-STD"),
  rotorKey: keyOf("R40-HI"), bearingKey: keyOf("B08-STD") };
const motor = buildServoMotor(library, selection), other = buildServoMotor(library, { ...selection, revision: "A", rotorKey: keyOf("R40-STD") });
const baseDevice = (model: string) => ({
  schemaVersion: 1, manufacturer: "示教机床商", model, revision: "1", ports: [], rules: [],
  source: { kind: "local", url: "", title: "车间资料", locator: model, excerpt: "三轴端口与安装位置。" },
});
const part = (id: string, item: DevicePackage, quantity = 1) => ({ id, label: id, packageKey: packageKey(item), quantity });
const oldMotor = parseDevicePackage({ ...baseDevice("仅有组成的电机"), composition: { kind: "leaf" } });
const slide = parseDevicePackage({ ...baseDevice("共用轴定义"), composition: { kind: "assembly", parts: [part("shaft-slot", oldMotor)] } });
const feed = parseDevicePackage({ ...baseDevice("滑台组"), composition: { kind: "assembly", parts: ["cross", "long", "up"].map(id => part(id, slide)) } });
const port = (id: string, slot: string): MotorAxisPort => ({ id, name: id, fit: motor.motorPhysics!.fit,
  modelRef: { id: "GouyuanMotor.CncFeedAxis", version: "1.0.0" }, path: ["slide-unit", slot], motorSlot: "shaft-slot",
  leadMmPerRev: 5, tableMassKg: 5, driveVoltageLimitV: 24, driveCurrentLimitA: 4, driveSpeedLimitRpm: 2500,
  driveReferenceInertiaKgM2: .00004, currentGainOhm: 8, source: "教学工况" });
const px = port("u", "cross"), py = port("v", "long"), pz = port("w", "up");
const legacyX = { ...px, id: "commissioned", leadMmPerRev: 6, currentGainOhm: 7, source: "已有用户整定" };
const legacyRoot = parseDevicePackage({ ...baseDevice("C"), revision: "r3-user", composition: { kind: "assembly", parts: [part("slide-unit", feed)] },
  factory: { modelRef: { id: "GouyuanFactory.CycleCNC", version: "1.0.0" }, parameters: { cycleS: 72 } }, axisPorts: [legacyX] });
const root = parseDevicePackage({ ...legacyRoot, revision: "r4", axisPorts: [px, py, pz],
  contour: { modelRef: CONTOUR_REF, axes: { x: "u", y: "v", z: "w" }, minMm: [0, 0, -100], maxMm: [200, 200, 0],
    maxFeedMmMin: [1200, 1200, 800], accelerationMmS2: [100, 100, 80], workOriginMachineMm: [10, 10, -20],
    initialWorkMm: [0, 0, 5], source: "三轴试验行程、独立端口和装夹记录", zBalance: "counterbalanced" } });
const ws = [motor, other, oldMotor, slide, feed, legacyRoot, root].reduce(installPackage, library);
const layoutFor = (cnc: DevicePackage) => parseFactoryLayout({ schemaVersion: 1, kind: "factory-layout", id: "store", name: "厂房",
  resources: ["m1", "m2"].map(id => ({ id, name: id, packageKey: packageKey(cnc), positionM: [0, 1],
    parameters: { cycleS: 75 }, axisTargetsMm: { commissioned: -7 } })), lines: [] });

describe("真实槽位上的三轴电机装配", () => {
  it("在不同槽名的三条物理路径装入同一修订，冻结共享轴定义与另一台机床", () => {
    const layout = layoutFor(root), initial = JSON.stringify(ws);
    expect(resolveContourMount(ws, layout, "m1").recommendedMotorKey).toBeUndefined();
    expect(() => resolveContourAxes(ws, layout, "m1")).toThrow(/组装电机/);
    const next = mountContourMotors(ws, layout, "m1", packageKey(motor), "three-motors");
    const resolved = resolveContourAxes(next.workspace, next.layout, "m1");
    expect(resolved.recommendedMotorKey).toBe(packageKey(motor));
    expect(resolved.axes.map(a => a.sources.rotorInertiaKgM2.path)).toEqual(["cross", "long", "up"].map(id => ["slide-unit", id, "shaft-slot", "rotor"]));
    expect(resolved.axes.map(a => a.parameters.rotorInertiaKgM2)).toEqual([.00006, .00006, .00006]);
    expect(new Set(resolved.axes.map(a => a.axis.revision)).size).toBe(1);
    expect(next.workspace.packages).toHaveLength(ws.packages.length + 3); // axis, slide group, root
    expect(next.layout.resources[1]).toEqual(layout.resources[1]);
    expect(next.layout.resources[0].parameters).toEqual(layout.resources[0].parameters);
    expect(JSON.stringify(ws)).toBe(initial);
    expect(resolveContourMount(next.workspace, next.layout, "m2").mounts.map(m => m.motorKey)).toEqual(Array(3).fill(packageKey(oldMotor)));
    const repeat = mountContourMotors(next.workspace, next.layout, "m1", packageKey(motor), "three-motors");
    expect(repeat.workspace).toBe(next.workspace); expect(repeat.layout).toBe(next.layout);
    const retry = mountContourMotors(next.workspace, layout, "m1", packageKey(motor), "three-motors");
    expect(retry.workspace.packages).toHaveLength(next.workspace.packages.length);
  });

  it("旧 X 已装的确切修订优先于其它候选，模板只补缺少的声明并保留旧端口工况", () => {
    const layout = layoutFor(legacyRoot);
    const old = installMotorOnFactoryAxis(ws, layout, "m1", "commissioned", packageKey(motor), "上次装机");
    expect(() => resolveContourMount(old.workspace, old.layout, "m1")).toThrow(/三轴/);
    const preview = resolveContourMount(old.workspace, old.layout, "m1", root);
    expect(preview.requiresUpgrade).toBe(true);
    expect(preview.recommendedMotorKey).toBe(packageKey(motor));
    expect(preview.ports[0]).toEqual(legacyX);
    const next = mountContourMotors(old.workspace, old.layout, "m1", preview.recommendedMotorKey!, "三轴修订", root);
    const actual = resolveContourAxes(next.workspace, next.layout, "m1");
    expect(actual.contour.axes).toEqual({ x: "commissioned", y: "v", z: "w" });
    expect(actual.axes[0].parameters).toMatchObject({ leadMmPerRev: 6, currentGainOhm: 7 });
    expect(actual.axes[0].axis).toEqual(preview.mounts[0].axis);
    expect(actual.root.factory).toEqual(legacyRoot.factory);
    expect(next.layout.resources[0].axisTargetsMm).toEqual({ commissioned: -7 });
    expect(old.workspace.packages.find(p => packageKey(p) === old.layout.resources[0].packageKey)?.contour).toBeUndefined();
    expect(() => resolveContourMount(old.workspace, old.layout, "m1", { ...root, model: "不同机床" })).toThrow(/同一制造商|型号/);
    expect(() => resolveContourMount(old.workspace, old.layout, "m1", { ...root, axisPorts: [{ ...px, fit: "其它接口" }, py, pz] })).toThrow(/配合接口/);
    const conflicting = parseDevicePackage({ ...legacyRoot, revision: "旧的双轴", axisPorts: [legacyX, { ...py, id: "custom", motorSlot: "second-motor" }] });
    expect(() => resolveContourMount(installPackage(ws, conflicting), layoutFor(conflicting), "m1", root)).toThrow(/安装路径冲突/);
  });

  it("匹配的电机仅有一份时可以推荐，错位、成组、版本冲突和部分装配都不会被作为三轴运行", () => {
    const layout = layoutFor(root), only = { ...ws, packages: ws.packages.filter(p => packageKey(p) !== packageKey(other)) };
    expect(resolveContourMount(only, layout, "m1").recommendedMotorKey).toBe(packageKey(motor));
    expect(() => mountContourMotors(ws, layout, "m1", packageKey(motor), legacyRoot.revision)).toThrow(/不同内容/);
    const single = installMotorOnFactoryAxis(ws, layout, "m1", "u", packageKey(motor), "仅X");
    expect(() => resolveContourAxes(single.workspace, single.layout, "m1")).toThrow(/不一致/);
    const withPort = (change: Partial<MotorAxisPort>) => parseDevicePackage({ ...root, revision: "试验", axisPorts: [px, { ...py, ...change }, pz] });
    for (const [bad, reason] of [[withPort({ path: px.path }), /独立/], [withPort({ path: [...px.path, "shaft-slot"] }), /独立/],
      [withPort({ motorSlot: "wire" }), /缺少电机安装槽/], [withPort({ fit: "其它接口" }), /配合/],
      [withPort({ leadMmPerRev: 1e308 }), /数值范围/]] as const) {
      const incomplete = installPackage(ws, bad);
      expect(() => mountContourMotors(incomplete, layoutFor(bad), "m1", packageKey(motor), "不能发布")).toThrow(reason);
      expect(incomplete.packages.some(p => p.revision === "不能发布")).toBe(false);
    }
    const grouped = parseDevicePackage({ ...feed, revision: "pair", composition: { kind: "assembly", parts: [part("cross", slide), part("long", slide, 2), part("up", slide)] } });
    const machine = parseDevicePackage({ ...root, revision: "grouped", composition: { kind: "assembly", parts: [part("slide-unit", grouped)] } });
    expect(() => resolveContourMount([grouped, machine].reduce(installPackage, ws), layoutFor(machine), "m1")).toThrow(/成组/);
  });

  it("程序可独立保存、清空与恢复，换整机清除该机床的程序，未知模型只允许归档", () => {
    const layout = layoutFor(root), program = "G21 G17\nG3 X40 Y30 I5 J0";
    const draft = setContourProgram(layout, "m1", program), restored = parseWorkspace(upsertFactoryLayout(ws, draft));
    expect(restored.factories![0].resources[0].contourRun?.program).toBe(program);
    expect(setContourProgram(draft, "m1", "").resources[0].contourRun?.program).toBe("");
    expect(replaceFactoryResourcePackage(draft.resources[0], legacyRoot).contourRun).toBeUndefined();
    expect(draft.resources[1]).toEqual(layout.resources[1]);
    expect(() => setContourProgram(layout, "m1", " ".repeat(65537))).toThrow(/65,536/);
    const unknown = parseDevicePackage({ ...root, revision: "未安装", contour: { ...root.contour!, modelRef: { ...CONTOUR_REF, version: "9" } } });
    expect(() => resolveContourAxes(installPackage(ws, unknown), layoutFor(unknown), "m1")).toThrow(/9/);
    expect(() => parseDevicePackage({ ...root, contour: { ...root.contour!, axes: { x: "u", y: "u", z: "w" } } })).toThrow(/不同/);
    expect(() => parseDevicePackage({ ...root, contour: { ...root.contour!, axes: { x: "no", y: "v", z: "w" } } })).toThrow(/未声明/);
    expect(() => parseDevicePackage({ ...root, contour: { ...root.contour!, initialWorkMm: [300, 0, 5] } })).toThrow(/行程/);
  });
});
