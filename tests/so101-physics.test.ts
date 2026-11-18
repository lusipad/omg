import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SO101_JOINTS } from "../contracts/so101";
import { compileSo101Model, createSo101Physics, type So101Physics } from "../src/lib/so101-physics-core";

let mj: MainModule;
let model: MjModel;
let engine: So101Physics;
const zero = [0, 0, 0, 0, 0, 0];
const motion = [
  { timeS: 0.4, anglesDeg: [30, -20, 35, 15, -25, 40] },
  { timeS: 0.9, anglesDeg: [5, 12, -20, 20, 15, 10] },
];
const toRad = Math.PI / 180;

beforeAll(async () => {
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
  model = await compileSo101Model(mj, (path) => readFile(new URL(`../public/models/so101/${path}`, import.meta.url)));
  engine = createSo101Physics(mj, model);
}, 60_000);
afterAll(() => model?.delete());

describe("SO-101 Follower 原版 MuJoCo 模型", () => {
  it("使用原模型重力、限力执行器和 2 ms 积分，零指令保持时有重力静差", () => {
    const options = model.opt;
    try {
      expect(Array.from(options.gravity)).toEqual([0, 0, -9.81]);
      expect(options.timestep).toBe(0.002);
    } finally { options.delete(); }
    expect(model.nu).toBe(6);
    expect(Array.from(model.actuator_forcelimited)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Array.from(model.actuator_forcerange)).toEqual(Array.from({ length: 6 }, () => [-3.35, 3.35]).flat());
    const end = engine.run([{ timeS: 0.3, anglesDeg: zero }]).at(-1)!;
    expect(end.targetDeg).toEqual(zero);
    expect(Math.abs(end.positionDeg[1])).toBeGreaterThan(0.001);
    expect(Math.abs(end.tipMm[2] - engine.initial.tipMm[2])).toBeGreaterThan(0.01);
  });

  it("几何网格索引有效，输出只包含原模型的可视材料和几何", () => {
    const { meshes, geoms } = engine.geometry;
    expect(meshes).toHaveLength(13);
    expect(geoms).toHaveLength(17);
    expect(engine.initial.geomPoses).toHaveLength(17 * 7);
    for (const mesh of meshes) {
      expect(mesh.vertices).toBeInstanceOf(Float32Array);
      expect(mesh.indices).toBeInstanceOf(Uint32Array);
      expect(mesh.indices.every((v) => v < mesh.vertices.length / 3)).toBe(true);
      expect(mesh.vertices.every((v) => Number.isFinite(v) && Math.abs(v) < 1)).toBe(true);
    }
    expect(geoms.some((g) => g.color[0] === 1 && g.color[1] > 0.8)).toBe(true);
  });

  it("与本时刻关节状态重新计算的原生 site/世界网格姿态一致，夹爪张角不改变夹爪固定参考系", () => {
    const point = engine.run(motion)[8];
    const d = new mj.MjData(model);
    const siteId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "gripperframe");
    try {
      SO101_JOINTS.forEach(({ id }, i) => {
        const joint = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, id);
        d.qpos[model.jnt_qposadr[joint]] = point.positionDeg[i] * toRad;
      });
      mj.mj_forward(model, d);
      for (let i = 0; i < 3; i++) expect(point.tipMm[i]).toBeCloseTo(d.site_xpos[3 * siteId + i] * 1000, 8);
      let slot = 0;
      for (let id = 0; id < model.ngeom; id++) {
        if (model.geom_group[id] !== 2) continue;
        for (let i = 0; i < 3; i++) expect(point.geomPoses[7 * slot + i]).toBeCloseTo(d.geom_xpos[3 * id + i], 9);
        const xyz = point.geomPoses.slice(7 * slot + 3, 7 * slot + 6);
        const w = point.geomPoses[7 * slot + 6];
        expect(Math.hypot(...xyz, w)).toBeCloseTo(1, 9);
        // 第一列是该网格局部 X 轴在世界坐标系的方向。
        expect([1 - 2 * (xyz[1] ** 2 + xyz[2] ** 2), 2 * (xyz[0] * xyz[1] + w * xyz[2]), 2 * (xyz[0] * xyz[2] - w * xyz[1])])
          .toEqual([0, 3, 6].map((i) => expect.closeTo(d.geom_xmat[9 * id + i], 9)));
        slot++;
      }
      const jaw = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, "gripper");
      d.qpos[model.jnt_qposadr[jaw]] += 0.5;
      mj.mj_forward(model, d);
      for (let i = 0; i < 3; i++) expect(d.site_xpos[3 * siteId + i] * 1000).toBeCloseTo(point.tipMm[i], 8);
    } finally { d.delete(); }
    expect(engine.initial.tipMm).toEqual([expect.closeTo(391.3619, 4), expect.closeTo(-0.0112553, 5), expect.closeTo(226.468745, 4)]);
  });

  it("隔离每次运行，记录平滑关节指令、反馈、速度和 0.5 s 保持段", () => {
    const results = engine.run(motion);
    expect(results).toEqual(engine.run(motion));
    expect(results[0]).toEqual(engine.initial);
    expect(results.at(-1)!.timeS).toBeCloseTo(1.4, 8);
    expect(results.at(-1)!.targetDeg).toEqual(motion.at(-1)!.anglesDeg);
    expect(results[1].timeS).toBeCloseTo(0.02, 8);
    expect(results[1].targetDeg[0]).toBeCloseTo(30 * (3 * 0.05 ** 2 - 2 * 0.05 ** 3), 7);
    expect(results.some((s) => Math.abs(s.velocityDegS[1]) > 1)).toBe(true);
    expect(results.some((s) => Math.abs(s.positionDeg[0] - s.targetDeg[0]) > 0.1)).toBe(true);
    expect(results.at(-1)!.positionDeg).not.toEqual(results.at(-1)!.targetDeg);
  });

  it("接受校准区间的边界工况，拒绝超限、缺轴和时间倒序输入", () => {
    expect(() => engine.run([{ timeS: 1, anglesDeg: SO101_JOINTS.map((j) => j.minDeg) }])).not.toThrow();
    expect(() => engine.run([{ timeS: 1, anglesDeg: [120, 0, 0, 0, 0, 0] }])).toThrow();
    expect(() => engine.run([{ timeS: 1, anglesDeg: [2] }])).toThrow();
    expect(() => engine.run([...motion].reverse())).toThrow();
  });
});
