import { readFile } from "node:fs/promises";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileMechanicalModel } from "../contracts/mechanical-model";
import type { resolveMechanicalAssembly } from "../contracts/mechanical-assembly";
import { compileImportedModel } from "../src/lib/imported-physics-model";
import { createImportedPhysics } from "../src/lib/imported-physics-core";

type Resolved = ReturnType<typeof resolveMechanicalAssembly>;
type Node = Resolved["nodes"][number];
type Frame = Node["part"]["input"];
type Joint = Node["part"]["joint"];
const frame = (positionMm: Frame["positionMm"] = [0, 0, 0], quatWxyz: Frame["quatWxyz"] = [1, 0, 0, 0]): Frame => ({ positionMm, quatWxyz });
const parent = (path: string, mount = "out") => ({ path, mount });
function body(path: string, attached: Node["parent"], joint: Joint, tip: Frame, value = 0, input = frame()): Node {
  return { path, parent: attached, part: { kind: "part", joint, input, outputs: [{ id: "out", ...tip }] }, value };
}
const hinge: Joint = { type: "hinge", axis: [0, 0, 1], range: [-120, 120], unit: "deg" };
const slide: Joint = { type: "slide", axis: [1, 0, 0], range: [-100, 100], unit: "mm" };
const fixed: Joint = { type: "fixed" };
let mj: MainModule;
const models: MjModel[] = [];
beforeAll(async () => { mj = await loadMujoco({ wasmBinary: await readFile(new URL(import.meta.resolve("@mujoco/mujoco/mujoco.wasm"))) }); }, 20_000);
afterEach(() => { for (const model of models.splice(0)) model.delete(); });
async function measured(nodes: Node[], outputPath: string) {
  const bundle = compileMechanicalModel({ nodes, output: parent(outputPath) });
  const model = await compileImportedModel(mj, bundle);
  models.push(model);
  const engine = createImportedPhysics(mj, model);
  const index = engine.info.points.findIndex(p => p.name === "assembly_output" && p.kind === "site");
  expect(index).toBeGreaterThanOrEqual(0);
  const xyz = (name: string) => engine.previewKeyframe(name).pointsM[index].map(v => v * 1000);
  return { model, engine, xyz };
}

describe("由安装关系编译的真实 MuJoCo 运动学", () => {
  it("交换同一转轴与滑台的上下游顺序改变末端位姿", async () => {
    const turn = body("turn", null, hinge, frame([20, 0, 0]), 90);
    const rail = body("slide", parent("turn"), slide, frame(), 40);
    const first = await measured([turn, rail], "slide");
    expect(first.xyz("target")).toEqual([expect.closeTo(0, 9), expect.closeTo(60, 9), 0]);
    const second = await measured([{ ...turn, parent: parent("slide") }, { ...rail, parent: null }], "turn");
    expect(second.xyz("target")).toEqual([expect.closeTo(40, 9), expect.closeTo(20, 9), 0]);
    expect(first.engine.info.joints.map(j => j.kind)).toEqual(["hinge", "slide"]);
    expect(second.engine.info.joints.map(j => j.kind)).toEqual(["slide", "hinge"]);
    expect(first.xyz("start")).toEqual([20, 0, 0]);
  });
  it("子件输入端有平移及旋转时按其逆变换安装，输出姿态也随任意轴运动", async () => {
    const h = Math.SQRT1_2;
    const base = body("base", null, fixed, frame([10, 20, 30], [h, 0, 0, h]));
    const item = body("child", parent("base"), { ...slide, axis: [1, 2, -2] },
      frame([5, -1, 4], [h, 0, h, 0]), 6, frame([0, 10, 0], [h, h, 0, 0]));
    const { xyz, model } = await measured([base, item], "child");
    expect(xyz("target")).toEqual([10, 27, 37].map(v => expect.closeTo(v, 9)));
    const data = new mj.MjData(model);
    try {
      mj.mj_resetDataKeyframe(model, data, mj.mj_name2id(model, mj.mjtObj.mjOBJ_KEY.value, "target"));
      mj.mj_kinematics(model, data);
      const site = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "assembly_output");
      expect(Array.from((data.site_xmat as Float64Array).slice(9 * site, 9 * site + 9))).toEqual([1, 0, 0, 0, 0, 1, 0, -1, 0].map(v => expect.closeTo(v, 9)));
    } finally { data.delete(); }
  });
  it("重复使用同一部件时各实例有独立关节，且输入端偏置不会移动本地转轴原点", async () => {
    const root = body("fixture", null, fixed, frame());
    const left = body("view/left", parent("fixture"), { ...hinge, axis: [1, 1, 0], range: [-180, 180] }, frame([10, 0, 0]), 180, frame([5, 0, 0]));
    const right = { ...left, path: "view/right", value: 0 };
    const { xyz, engine } = await measured([right, left, root], "view/left");
    expect(new Set(engine.info.joints.map(j => j.name)).size).toBe(2);
    expect(xyz("target")).toEqual([-5, 10, 0].map(v => expect.closeTo(v, 9)));
    expect(engine.previewKeyframe("target").initial.qpos).toEqual([0, Math.PI]);
  });
  it("以最接近零的合法值起步，内建参考姿态和目标关键帧均采用原生单位", async () => {
    const turn = body("turn", null, { ...hinge, range: [15, 75] }, frame([10, 0, 0]), 45);
    const rail = body("rail", parent("turn"), { ...slide, range: [-25, -10] }, frame(), -20);
    const { engine, xyz } = await measured([turn, rail], "rail");
    expect(engine.info.initial.qpos).toEqual([expect.closeTo(Math.PI / 12, 10), -0.01]);
    expect(engine.previewKeyframe("start").initial.qpos).toEqual(engine.info.initial.qpos);
    expect(engine.previewKeyframe("target").initial.qpos).toEqual([expect.closeTo(Math.PI / 4, 10), -0.02]);
    expect(xyz("target")).toEqual([-Math.sqrt(50), -Math.sqrt(50), 0].map(v => expect.closeTo(v, 9)));
  });
  it("全固定部件可计算同一个起点和目标，根输入也对齐世界原点", async () => {
    const { engine, xyz } = await measured([body("plate", null, fixed, frame([2, 4, 9]), 0, frame([2, 4, 5]))], "plate");
    expect(engine.info.joints).toHaveLength(0);
    expect(xyz("target")).toEqual([0, 0, expect.closeTo(4, 10)]);
    expect(xyz("start")).toEqual(xyz("target"));
  });
  it("只绘实际连接和观测的接口，带大量备用端口的装配仍可编译", async () => {
    const nodes = Array.from({ length: 512 }, (_, i) => {
      const n = body("n" + i, i ? parent("n" + Math.floor((i - 1) / 4)) : null, fixed, frame([1, 0, 0]));
      for (let port = 1; port < 32; port++) n.part.outputs.push({ id: "spare" + port, ...frame([0, port, 0]) });
      return n;
    });
    const { model, xyz } = await measured(nodes, "n511");
    expect(model.nsite).toBe(129);
    expect(model.ngeom).toBeLessThanOrEqual(nodes.length * 4);
    expect(xyz("target")).toEqual([expect.closeTo(6, 9), 0, 0]);
  });
  it("非零轴和四元数可缩放，不影响世界输出", async () => {
    const root = body("root", null, fixed, frame([0, 0, 0], [1e200, 0, 0, 1e200]));
    const tool = body("tool", parent("root"), { ...slide, axis: [1e200, 0, 0] }, frame(), 9);
    const { xyz } = await measured([root, tool], "tool");
    expect(xyz("target")).toEqual([0, 9, 0].map(v => expect.closeTo(v, 9)));
  });
});
