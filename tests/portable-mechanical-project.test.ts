import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportMechanicalBundle, installMechanicalBundle, mechanicalSubassembly, resolveMechanicalAssembly, type MechanicalAssembly } from "../contracts/mechanical-assembly";
import { compileMechanicalModel } from "../contracts/mechanical-model";
import { emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";
import { compileImportedModel } from "../src/lib/imported-physics-model";
import { compileSo101Model } from "../src/lib/so101-physics-core";

const files = new URL("../public/assemblies/mounts/", import.meta.url);
const official = new URL("../public/models/so101/", import.meta.url);
let mj: MainModule;
let original: MjModel;

beforeAll(async () => {
  const wasm = await readFile(new URL(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
  original = await compileSo101Model(mj, path => readFile(new URL(path, official)));
}, 60_000);
afterAll(() => original?.delete());

async function openFile(name: string) {
  return parseImportText(await readFile(new URL(name, files), "utf8"), name);
}

async function openProject(name: string) {
  const input = await openFile(name);
  if (input.kind !== "project" || !input.workspace.mechanisms?.length) throw new Error(`缺少机械装配工程 ${name}`);
  return input.workspace;
}

async function compiledTarget(ws: TwinWorkspace, assembly: MechanicalAssembly) {
  const bundle = compileMechanicalModel(resolveMechanicalAssembly(ws, assembly));
  const model = await compileImportedModel(mj, bundle);
  const data = new mj.MjData(model);
  try {
    const key = mj.mj_name2id(model, mj.mjtObj.mjOBJ_KEY.value, "target");
    const site = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "assembly_output");
    expect(key).toBeGreaterThanOrEqual(0);
    expect(site).toBeGreaterThanOrEqual(0);
    mj.mj_resetDataKeyframe(model, data, key);
    mj.mj_forward(model, data);
    const pos: Float64Array = data.site_xpos;
    const mat: Float64Array = data.site_xmat;
    return { mm: Array.from(pos.subarray(3 * site, 3 * site + 3), n => n * 1000), mat: Array.from(mat.subarray(9 * site, 9 * site + 9)) };
  } finally { data.delete(); model.delete(); }
}

function distance(a: number[], b: number[]) {
  return Math.hypot(...a.map((value, i) => value - b[i]));
}

describe("可移植的机械安装点工程", () => {
  it("独立上传的三包、两份关系与发布工程一致，换父子顺序改变工具实测位置", async () => {
    let ws = emptyWorkspace();
    for (const file of ["turn.device.json", "slide.device.json", "tool.device.json"]) {
      const input = await openFile(file);
      if (input.kind !== "device") throw new Error(`未识别独立零件 ${file}`);
      ws = installPackage(ws, input.device);
    }
    const definitions: MechanicalAssembly[] = [];
    for (const file of ["turn-slide.assembly.json", "slide-turn.assembly.json"]) {
      const input = await openFile(file);
      if (input.kind !== "mechanism") throw new Error(`未识别装配关系 ${file}`);
      definitions.push(input.assembly);
    }
    ws = parseWorkspace({ ...ws, mechanisms: definitions });
    expect(await openProject("project.twin.json")).toEqual(ws);
    const expected = [[0, 60, 0], [40, 20, 0]];
    for (const [i, definition] of definitions.entries()) {
      expect(distance((await compiledTarget(ws, definition)).mm, expected[i])).toBeLessThan(0.0001);
    }
  });

  it("在新工程只导入转台和滑台工具子装配，保留内部工况，也可按路径覆盖", async () => {
    const ws = await openProject("project.twin.json");
    const chain = ws.mechanisms!.find(a => a.id === "turn-slide")!;
    const sub = mechanicalSubassembly(chain, "slide");
    const saved = exportMechanicalBundle(ws, sub, { manufacturer: "构元示教", model: "LX-T20-子装配", revision: "1.0" });
    const input = await openFile("slide-tool.package.json");
    if (input.kind !== "mechanical-bundle") throw new Error("发布的文件未被识别为子装配包");
    expect(input.bundle).toEqual(saved);
    expect(input.bundle.packages).toHaveLength(3);
    const turn = await openFile("turn.device.json");
    if (turn.kind !== "device") throw new Error("转台包未识别");
    const fresh = installMechanicalBundle(installPackage(emptyWorkspace(), turn.device), input.bundle);
    expect(fresh.packages).toHaveLength(4);
    expect(installMechanicalBundle(fresh, input.bundle)).toEqual(fresh);
    const mounted: MechanicalAssembly = {
      schemaVersion: 1, kind: "mechanical-assembly", id: "new-mount", name: "转台带子装配",
      nodes: [chain.nodes.find(node => node.id === "turn")!, { id: "unit", packageKey: input.bundle.rootKey, parent: { node: "turn", mount: "out" } }],
      output: { node: "unit", mount: "out" }, commands: { turn: 90 },
    };
    const restored = parseWorkspace(JSON.parse(JSON.stringify({ ...fresh, mechanisms: [mounted] })));
    expect(distance((await compiledTarget(restored, mounted)).mm, [0, 60, 0])).toBeLessThan(0.0001);
    expect(distance((await compiledTarget(restored, { ...mounted, commands: { turn: 90, "unit/slide": 0 } })).mm, [0, 20, 0])).toBeLessThan(0.0001);
  });

  it("通用装配的肘部观测点与完整 SO-101 六关节模型的原生 FK 在三种姿态相符", async () => {
    const xml = await readFile(new URL("so101_new_calib.xml", official));
    expect(createHash("sha256").update(xml).digest("hex")).toBe("d75253eb568e8a7214db9c631ab7bed4217f608a26f7276ebe9a7636cac82580");
    const ws = await openProject("so101.twin.json");
    const a = ws.mechanisms![0];
    const joint = (name: string) => mj.mj_name2id(original, mj.mjtObj.mjOBJ_JOINT.value, name);
    const pan = joint("shoulder_pan"), lift = joint("shoulder_lift"), elbow = joint("elbow_flex");
    const arm = mj.mj_name2id(original, mj.mjtObj.mjOBJ_BODY.value, "lower_arm");
    expect(original.nq).toBe(6);
    expect(Math.min(pan, lift, elbow, arm)).toBeGreaterThanOrEqual(0);
    for (const [index, node] of [[pan, "shoulder_pan"], [lift, "shoulder_lift"]] as const) {
      const j = ws.packages.find(pkg => pkg.model === `SO-101 ${node}`)?.mechanics;
      if (j?.kind !== "part" || j.joint.type !== "hinge") throw new Error(`缺少原模型铰链 ${node}`);
      expect(j.joint.axis).toEqual(Array.from((original.jnt_axis as Float64Array).subarray(3 * index, 3 * index + 3)));
      for (let end = 0; end < 2; end++) expect(j.joint.range[end]).toBeCloseTo(original.jnt_range[2 * index + end] * 180 / Math.PI, 8);
    }
    const data = new mj.MjData(original);
    try {
      for (const [panDeg, liftDeg] of [[0, 0], [30, -25], [-45, 35]]) {
        data.qpos.fill(0);
        data.qpos[original.jnt_qposadr[pan]] = panDeg * Math.PI / 180;
        data.qpos[original.jnt_qposadr[lift]] = liftDeg * Math.PI / 180;
        mj.mj_forward(original, data);
        const xyz = Array.from((data.xanchor as Float64Array).subarray(3 * elbow, 3 * elbow + 3), n => n * 1000);
        const rotation = Array.from((data.xmat as Float64Array).subarray(9 * arm, 9 * arm + 9));
        const actual = await compiledTarget(ws, { ...a, commands: { shoulder_pan: panDeg, shoulder_lift: liftDeg } });
        expect(distance(actual.mm, xyz)).toBeLessThan(0.0001);
        expect(distance(actual.mat, rotation)).toBeLessThan(1e-7);
      }
    } finally { data.delete(); }
  });
});
