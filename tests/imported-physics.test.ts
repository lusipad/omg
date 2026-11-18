import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseImportCatalog, type ModelBundle } from "../contracts/import-catalog";
import { IMPORTED_PHYSICS_LIMITS, type ImportedControlStage } from "../contracts/imported-physics";
import { createImportedPhysics } from "../src/lib/imported-physics-core";
import { compileImportedModel } from "../src/lib/imported-physics-model";

const encode = new TextEncoder();
const models: MjModel[] = [];
let mj: MainModule;
function bundle(xml: string, entry = "model.xml", assets: Record<string, string> = {}): ModelBundle {
  return { entry, files: Object.entries({ [entry]: xml, ...assets }).map(([path, text]) => ({ path, data: encode.encode(text) })) };
}
async function open(files: ModelBundle) {
  const model = await compileImportedModel(mj, files);
  models.push(model);
  return createImportedPhysics(mj, model);
}
beforeAll(async () => {
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
}, 20_000);
afterEach(() => { for (const model of models.splice(0)) model.delete(); });

const stagedProbe = `<mujoco><option gravity="0 0 0" timestep=".02"/><worldbody><body><joint name="lift" type="slide" axis="0 0 1"/>
  <geom type="box" size=".1 .1 .1" mass="1"/><site name="centre"/><site name="tool_tip" pos="0 0 .035"/></body>
  <body name="fixture" pos="0 0 .4"><site name="fixed_datum"/></body></worldbody>
  <actuator><motor joint="lift" ctrlrange="-10 10"/></actuator><keyframe><key name="raised" qpos=".3" ctrl="2"/></keyframe></mujoco>`;
const stageSettings = { durationS: .22, controls: [0], pointId: "site:0",
  sequence: [{ timeS: .08, controls: [8], label: "抬升" }, { timeS: .16, controls: [0], label: "释放" }] };

describe("实际积分的多阶段控制", () => {
  it("每个物理步按起始时刻计算平滑控制，在路标后保持末值", async () => {
    const engine = await open(bundle(stagedProbe));
    const frames = engine.run(stageSettings);
    const expectedForce = [0, 1.25, 4, 6.75, 8, 6.75, 4, 1.25, 0, 0, 0];
    expect(frames).toHaveLength(expectedForce.length + 1);
    // 无重力或阻尼的 1 kg 滑块，独立从速度增量还原 MuJoCo 实际施加的力。
    expectedForce.forEach((force, i) => expect((frames[i + 1].qvel[0] - frames[i].qvel[0]) / .02).toBeCloseTo(force, 9));
    expect(frames.at(-1)!.pointM[2]).toBeCloseTo(frames.at(-1)!.qpos[0], 12);
    expect(frames.at(-1)!.pointM[2]).toBeGreaterThan(.05);
    expect(engine.run(stageSettings)).toEqual(frames);
  });
  it("保持旧恒值行为，空序列等价；关键帧控制可由新工况起始值覆盖", async () => {
    const engine = await open(bundle(stagedProbe));
    const settings = { durationS: .08, controls: [-2], pointId: "site:0", keyframe: "raised" };
    const constant = engine.run(settings);
    expect(engine.run({ ...settings, sequence: [] })).toEqual(constant);
    expect(constant[0].qpos).toEqual([.3]);
    expect(constant.at(-1)!.qvel[0]).toBeCloseTo(-.16, 10);
    const moving = engine.run({ ...settings, sequence: [{ timeS: .08, controls: [4] }] });
    expect(moving[0].qpos).toEqual([.3]);
    expect(moving[1].qvel[0]).toBeCloseTo(-.04, 10);
    expect(moving.at(-1)!.qvel[0]).not.toBeCloseTo(constant.at(-1)!.qvel[0], 6);
  });
  it("在同一物理步读取可选参考坐标，可对比随动与固定物体，高度差不由指令推算", async () => {
    const engine = await open(bundle(stagedProbe));
    const tool = engine.info.points.find((point) => point.name === "tool_tip")!.id;
    const fixed = engine.info.points.find((point) => point.name === "fixed_datum")!.id;
    const paired = engine.run({ ...stageSettings, referencePointId: tool });
    for (const sample of paired) expect(sample.referenceM![2] - sample.pointM[2]).toBeCloseTo(.035, 12);
    const pair = engine.run({ ...stageSettings, pointId: fixed, referencePointId: stageSettings.pointId }).at(-1)!;
    expect(pair.pointM).toEqual([0, 0, .4]);
    expect(pair.referenceM![2]).toBeCloseTo(paired.at(-1)!.pointM[2], 12);
    expect(engine.run(stageSettings).every((sample) => !Object.hasOwn(sample, "referenceM"))).toBe(true);
    expect(() => engine.run({ ...stageSettings, referencePointId: "site:99999" })).toThrow(/参考点/);
  });
  it("拒绝越界时间、乱序、错误控制维数、非有限值和越量程序列", async () => {
    const engine = await open(bundle(stagedProbe));
    const run = (sequence: ImportedControlStage[]) => engine.run({ ...stageSettings, sequence });
    for (const t of [0, NaN, Infinity, -.01, .24]) expect(() => run([{ timeS: t, controls: [0] }])).toThrow(/到达时间/);
    for (const t of [.08, .03]) expect(() => run([stageSettings.sequence[0], { timeS: t, controls: [0] }])).toThrow(/第 2 阶段/);
    expect(() => run([{ timeS: .04, controls: [] }])).toThrow(/数量/);
    for (const c of [NaN, Infinity]) expect(() => run([{ timeS: .04, controls: [c] }])).toThrow(/有限/);
    expect(() => run([{ timeS: .04, controls: [11] }])).toThrow(/范围/);
    expect(() => run([{ timeS: .04, controls: [0], label: " ".repeat(2) }])).toThrow(/名称/);
    expect(() => run(Array(IMPORTED_PHYSICS_LIMITS.maxStages + 1).fill(stageSettings.sequence[0]))).toThrow(/最多/);
  });
  it("同一份工程记录往返保留全部阶段和名称，导入时拒绝损坏的阶段顺序或维数", () => {
    const parse = (sequence: ImportedControlStage[]) => parseImportCatalog(JSON.parse(JSON.stringify({
      models: [{ id: "b".repeat(64), name: "Lift", entry: "lift.xml", run: { ...stageSettings, referencePointId: "site:1", sequence } }], materials: [],
    })), []);
    expect(parse(stageSettings.sequence).models[0].run).toEqual({ ...stageSettings, referencePointId: "site:1" });
    expect(() => parse([...stageSettings.sequence].reverse())).toThrow(/到达时间/);
    expect(() => parse([{ timeS: .05, controls: [1, 2] }])).toThrow(/数量/);
  });
});

const framedSlide = `<mujoco><option gravity="0 0 0" timestep=".01"/><worldbody><body>
  <joint name="travel" type="slide" axis="1 0 0"/><geom type="box" size=".1 .1 .1" mass="1"/>
  <site name="probe" pos=".2 0 0"/><site name="back" pos="-.3 0 0"/></body></worldbody>
  <actuator><motor joint="travel" name="force" ctrlrange="-10 10"/></actuator>
  <keyframe><key/><key name="offset" time="7" qpos="1.5" qvel=".4" ctrl="3"/>
  <key name="reverse" time="9" qpos="-.5" qvel="-.2" ctrl="-2"/></keyframe></mujoco>`;

describe("模型命名关键帧", () => {
  it("按名称载入原始关节、控制和各观测点，保留模型默认状态", async () => {
    const engine = await open(bundle(framedSlide));
    expect(engine.info.keyframes).toEqual(["offset", "reverse"]);
    const offset = engine.previewKeyframe("offset");
    expect(offset.initial).toMatchObject({ timeS: 0, qpos: [1.5], qvel: [.4] });
    expect(offset.controls).toEqual([3]);
    expect(offset.pointsM.slice(0, 2)).toEqual([[1.7, 0, 0], [1.2, 0, 0]]);
    expect(engine.previewKeyframe("reverse").controls).toEqual([-2]);
    expect(engine.info.initial.qpos).toEqual([0]);
    expect(engine.info.actuators[0].initial).toBe(0);
    expect(() => engine.previewKeyframe("missing")).toThrow(/找不到初始关键帧/);
  });
  it("从同一上游姿态零时刻起步，恒定控制可覆盖 key_ctrl，旧工况仍从 qpos0 运行", async () => {
    const engine = await open(bundle(framedSlide));
    const settings = { durationS: .1, controls: [3], pointId: "site:1", keyframe: "offset" };
    const frames = engine.run(settings);
    expect(frames[0]).toMatchObject({ timeS: 0, qpos: [1.5], qvel: [.4], pointM: [1.2, 0, 0] });
    expect(frames.at(-1)!.timeS).toBeCloseTo(.1, 12);
    expect(frames.at(-1)!.qvel[0]).toBeCloseTo(.7, 10);
    const overridden = engine.run({ ...settings, controls: [0] });
    expect(overridden.at(-1)!.qvel[0]).toBeCloseTo(.4, 10);
    expect(overridden.at(-1)!.qpos[0]).toBeCloseTo(1.54, 10);
    expect(engine.run({ durationS: .1, controls: [0], pointId: "site:0" })[0].qpos).toEqual([0]);
    expect(() => engine.run({ ...settings, keyframe: "missing" })).toThrow(/找不到初始关键帧/);
  });
  it("工程记录按原名往返，旧版本没有关键帧字段时不补入推荐站姿", () => {
    const run = { durationS: .1, controls: [3], pointId: "site:0" };
    const model = { id: "a".repeat(64), name: "slide", entry: "slide.xml" };
    for (const settings of [run, { ...run, keyframe: "offset" }]) {
      const exported = JSON.stringify({ models: [{ ...model, run: settings }], materials: [] });
      expect(parseImportCatalog(JSON.parse(exported), []).models[0].run).toEqual(settings);
    }
  });
});

const falling = '<mujoco><worldbody><body name="落体" pos="0 0 2"><freejoint name="浮动"/><geom type="sphere" size=".04"/><site name="偏置标记" pos=".1 0 .02"/></body></worldbody></mujoco>';
const slider = '<mujoco><compiler angle="radian"/><option gravity="0 0 0"/><worldbody><body name="滑台"><joint type="slide" axis="1 0 0" name="行程" range="-.3 .3"/><geom type="box" size=".02 .03 .04" mass=".2"/><body><joint type="hinge" name="转轴" range="-1 1"/><geom type="sphere" size=".02" mass=".005"/></body></body></worldbody><actuator><position joint="行程" name="滑台指令" ctrlrange="-.2 .2" kp="100" kv="3"/><motor joint="转轴" name="转矩输入" ctrlrange="-1 1"/></actuator></mujoco>';
const tetra = "v 0 0 0\nv .1 0 0\nv 0 .1 0\nv 0 0 .1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n";

describe("通用导入的真实 MuJoCo 模型", () => {
  it("无驱动自由落体产生符合重力的位移，完整保留自由关节位姿与速度通道", async () => {
    const engine = await open(bundle(falling));
    const { info } = engine;
    expect(info.actuators).toEqual([]);
    expect(info.joints[0]).toMatchObject({ name: "浮动", kind: "free" });
    expect(info.positions.map((p) => p.unit)).toEqual(["m", "m", "m", "1", "1", "1", "1"]);
    expect(info.velocities.map((v) => v.unit)).toEqual(["m/s", "m/s", "m/s", "rad/s", "rad/s", "rad/s"]);
    expect(info.points[0]).toMatchObject({ name: "偏置标记", initialM: [0.1, 0, 2.02] });
    const p = info.points.find((p) => p.name === "落体")!;
    const req = { durationS: 0.1, controls: [], pointId: p.id };
    const trajectory = engine.run(req);
    expect(trajectory).toEqual(engine.run(req));
    expect(trajectory[0].pointM).toEqual(p.initialM);
    const last = trajectory.at(-1)!;
    expect(last.pointM[2]).toBeCloseTo(2 - 0.5 * 9.81 * 0.1 * (0.1 + info.timestepS), 8);
    expect(last.qvel[2]).toBeCloseTo(-0.981, 8);
    expect(last.qpos[2]).toBeCloseTo(last.geomPoses[2], 6);
  });
  it("滑台和铰链按原生执行器工作，角色和控制范围取自上传模型", async () => {
    const engine = await open(bundle(slider));
    expect(engine.info.joints.map((j) => j.kind)).toEqual(["slide", "hinge"]);
    expect(engine.info.actuators).toMatchObject([
      { name: "滑台指令", range: [-0.2, 0.2], unit: "m" }, { name: "转矩输入", range: [-1, 1], unit: "原生 ctrl" },
    ]);
    const pointId = engine.info.points[0].id;
    const req = { durationS: 0.4, controls: [0.1, 0], pointId };
    expect(engine.run(req).at(-1)!.qpos[0]).toBeCloseTo(0.1, 2);
    expect(() => engine.run({ ...req, controls: [1, 0] })).toThrow(/滑台指令/);
    expect(() => engine.run({ ...req, controls: [] })).toThrow(/数量/);
    expect(() => engine.run({ ...req, pointId: "site:999" })).toThrow(/观测点/);
  });
  it("悬臂单摆由惯性和重力运动，无需为铰链合成执行器", async () => {
    const engine = await open(bundle('<mujoco><worldbody><body pos="0 0 1"><joint name="摆轴" axis="0 1 0"/><geom type="capsule" fromto="0 0 0 .4 0 0" size=".025"/><site name="摆端" pos=".4 0 0"/></body></worldbody></mujoco>'));
    const req = { durationS: 0.2, controls: [], pointId: engine.info.points[0].id };
    const last = engine.run(req).at(-1)!;
    expect(last.qpos[0]).toBeGreaterThan(0.1);
    expect(last.pointM[2]).toBeLessThan(engine.info.initial.pointM[2]);
  });
  it("原生 VFS 解析嵌套入口、相对 include 与目录网格，并消除同位重复渲染", async () => {
    const xml = '<mujoco><include file="../parts/body.xml"/></mujoco>';
    const body = '<mujocoinclude><asset><mesh name="实体" file="../meshes/shape.obj"/></asset><worldbody><geom type="mesh" mesh="实体" group="3"/><geom type="mesh" mesh="实体" group="2" contype="0" conaffinity="0"/></worldbody></mujocoinclude>';
    const engine = await open(bundle(xml, "robot/scene.xml", { "parts/body.xml": body, "meshes/shape.obj": tetra }));
    expect(engine.info.geometry.meshes).toHaveLength(1);
    expect(engine.info.geometry.geoms).toHaveLength(1);
    expect(engine.info.geometry.geoms[0].kind).toBe("mesh");
    expect(engine.info.geometry.meshes[0].indices).toHaveLength(12);
    await expect(open(bundle(xml, "robot/scene.xml", { "parts/body.xml": body }))).rejects.toThrow(/shape.obj/);
  });
  it("直接编译 URDF，保留独立视觉网格、关节行程和本地 ROS 包引用", async () => {
    const urdf = '<robot name="装配"><link name="base"/><link name="slide"><inertial><mass value=".2"/><inertia ixx=".01" iyy=".01" izz=".01" ixy="0" ixz="0" iyz="0"/></inertial><visual><geometry><mesh filename="package://motion_demo/meshes/shape.obj"/></geometry></visual></link><joint name="travel" type="prismatic"><parent link="base"/><child link="slide"/><axis xyz="0 0 1"/><limit lower="-.3" upper=".3" effort="5" velocity="1"/></joint></robot>';
    const engine = await open(bundle(urdf, "motion_demo/urdf/axis.urdf", { "motion_demo/meshes/shape.obj": tetra }));
    expect(engine.info.geometry.meshes).toHaveLength(1);
    expect(engine.info.joints[0]).toMatchObject({ kind: "slide", name: "travel", range: [-0.3, 0.3] });
    expect(engine.info.actuators).toEqual([]);
  });
  it("内置形状保留类型、半尺寸和可观察的世界变换", async () => {
    const shapes = '<geom type="plane" size="1 2 .1"/><geom type="sphere" size=".2" pos="1 0 0"/><geom type="ellipsoid" size=".1 .2 .3" pos="0 1 0"/><geom type="capsule" size=".2 .4"/><geom type="cylinder" size=".2 .3"/><geom type="box" size=".2 .3 .4"/>';
    const { info } = await open(bundle('<mujoco><worldbody>' + shapes + '</worldbody></mujoco>'));
    expect(info.geometry.geoms.map((g) => g.kind)).toEqual(["plane", "sphere", "ellipsoid", "capsule", "cylinder", "box"]);
    expect(info.geometry.geoms[5].size).toEqual([0.2, 0.3, 0.4]);
    expect(info.initial.geomPoses).toHaveLength(6 * 7);
    expect(info.initial.geomPoses[7]).toBe(1);
    expect(info.initial.qpos).toEqual([]);
  });
  it("多入口包仅编译所选模型，另一个入口的扩展不阻碍运行", async () => {
    const engine = await open(bundle(falling, "falling.mjcf", { "other.xml": '<mujoco><extension><plugin plugin="third-party"/></extension></mujoco>' }));
    expect(engine.info.joints[0].kind).toBe("free");
  });
  it("球关节保留四元数，未绘制的高度场在界面警告中可追溯", async () => {
    const xml = '<mujoco><asset><hfield name="terrain" nrow="3" ncol="3" size="1 1 .1 .1"/></asset><worldbody><geom type="hfield" hfield="terrain"/><body pos="0 0 1"><joint type="ball" name="球铰"/><geom type="sphere" size=".1"/></body></worldbody></mujoco>';
    const engine = await open(bundle(xml));
    expect(engine.info.positions.map((p) => p.unit)).toEqual(["1", "1", "1", "1"]);
    expect(engine.info.initial.qpos).toEqual([1, 0, 0, 0]);
    expect(engine.info.warnings.join(" ")).toMatch(/省略 1 个/);
    expect(engine.run({ durationS: 0.1, controls: [], pointId: engine.info.points[0].id }).length).toBeGreaterThan(1);
  });
  it("本地输入边界和仿真预算失败时给出明确原因", async () => {
    await expect(open(bundle('<mujoco><include file="https://example.com/arm.xml"/></mujoco>'))).rejects.toThrow(/本地|包外|相对路径/);
    await expect(open(bundle('<mujoco><extension><plugin plugin="custom"/></extension></mujoco>'))).rejects.toThrow(/插件/);
    await expect(open(bundle('<mujoco><include file="../missing.xml"/></mujoco>'))).rejects.toThrow(/目录|包外|超出模型包/);
    const engine = await open(bundle('<mujoco><option timestep=".0001"/><worldbody><geom size=".1"/></worldbody></mujoco>'));
    expect(() => engine.run({ durationS: 10, controls: [], pointId: engine.info.points[0].id })).toThrow(/20000/);
  });
});
