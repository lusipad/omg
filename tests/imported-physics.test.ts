import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelBundle } from "../contracts/import-catalog";
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
