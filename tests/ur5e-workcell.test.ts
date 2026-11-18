import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import type { ModelBundle } from "../contracts/import-catalog";
import type { ImportedSample } from "../contracts/imported-physics";
import { composeUr5eWorkcell, isUr5eWorkcell, makeUr5eWorkcellTrial, UR5E_WORKCELL_POINTS, UR5E_WORKPIECE_XML } from "../contracts/ur5e-workcell";
import { compileImportedModel } from "../src/lib/imported-physics-model";
import { createImportedPhysics } from "../src/lib/imported-physics-core";
import { describeModel, exportModelBundle, readModelFiles } from "../src/lib/model-files";

const encode = new TextEncoder();
const standalone = async (id: string) => {
  const bytes = await readFile(new URL(`../public/robots/${id}/model.zip`, import.meta.url));
  return { entry: "scene.xml", files: (await readModelFiles([new File([bytes], "model.zip")])).files };
};
const piece = (xml: string): ModelBundle => ({ entry: "test.xml", files: [{ path: "test.xml", data: encode.encode(xml) }] });
let arm: ModelBundle, hand: ModelBundle, scene: ModelBundle;
let mj: MainModule, model: MjModel;
let normal: ImportedSample[], open: ImportedSample[], tool: ImportedSample[];
let trial: ReturnType<typeof makeUr5eWorkcellTrial>;
const at = (samples: ImportedSample[], t: number) => samples.find((s) => Math.abs(s.timeS - t) < 1e-7)!;
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]));

beforeAll(async () => {
  [arm, hand] = await Promise.all([standalone("ur5e"), standalone("robotiq-2f85")]);
  scene = composeUr5eWorkcell(arm, hand);
  // 经过浏览器通用导入器相同的 ZIP 解包、选择入口、描述和编译流程。
  const zip = await exportModelBundle(scene).arrayBuffer();
  const imported = { entry: scene.entry, files: (await readModelFiles([new File([zip], "workcell.zip")])).files };
  expect((await describeModel(imported)).name).toBe("UR5e 2F-85 pick and place");
  mj = await loadMujoco();
  model = await compileImportedModel(mj, imported);
  const physics = createImportedPhysics(mj, model);
  trial = makeUr5eWorkcellTrial(physics.info);
  normal = physics.run(trial);
  const tip = physics.info.points.find((p) => p.kind === "site" && p.name === UR5E_WORKCELL_POINTS.tool)!;
  tool = physics.run({ ...trial, pointId: tip.id, referencePointId: undefined });
  const finger = physics.info.actuators.findIndex((a) => a.name === "grip_fingers_actuator");
  const keepOpen = (controls: number[]) => controls.map((v, i) => i === finger ? 0 : v);
  open = physics.run({ ...trial, controls: keepOpen(trial.controls),
    sequence: trial.sequence!.map((s) => ({ ...s, controls: keepOpen(s.controls) })) });
}, 120_000);
afterAll(() => model?.delete());

describe("两个已安装模块与自由方块的真实取放", () => {
  it("保留未修改的源模块、独立许可证和原始归属，并接受独立下载的工件", async () => {
    const xml = await readFile(new URL("../public/workcells/ur5e-pick-place/workpiece.xml", import.meta.url), "utf8");
    expect(xml).toBe(UR5E_WORKPIECE_XML);
    const uploaded = composeUr5eWorkcell(arm, hand, piece(xml));
    expect(isUr5eWorkcell(uploaded)).toBe(true);
    const changedMass = xml.replace('mass="0.027"', '').replace('<freejoint', '<inertial pos="0 0 0" mass="0.054" diaginertia="0.0000081 0.0000081 0.0000081"/><freejoint');
    const customPart = composeUr5eWorkcell(arm, hand, piece(changedMass));
    expect(new TextDecoder().decode(customPart.files.find((f) => f.path === "part/test.xml")!.data)).toBe(changedMass);
    const heavier = await compileImportedModel(mj, piece(changedMass));
    try { expect(heavier.body_mass[mj.mj_name2id(heavier, mj.mjtObj.mjOBJ_BODY.value, "cube")]).toBeCloseTo(0.054, 10); }
    finally { heavier.delete(); }
    expect(isUr5eWorkcell(arm)).toBe(false);
    for (const [prefix, src, filename] of [["arm", arm, "ur5e.xml"], ["hand", hand, "2f85.xml"]] as const) {
      for (const name of [filename, "LICENSE", "ATTRIBUTION.md"]) {
        expect(scene.files.find((f) => f.path === `${prefix}/${name}`)?.data).toBe(src.files.find((f) => f.path === name)!.data);
      }
    }
    expect(scene.files.filter((f) => /\.(obj|stl)$/i.test(f.path))).toHaveLength(28);
    expect(scene.files.some((f) => f.path === "pick-place.json")).toBe(true);
  });
  it("夹爪通过指定法兰相接，方块保有六个自由度", () => {
    const d = new mj.MjData(model), obj = mj.mjtObj;
    try {
      mj.mj_kinematics(model, d);
      const wrist = mj.mj_name2id(model, obj.mjOBJ_BODY.value, "wrist_3_link");
      const mount = mj.mj_name2id(model, obj.mjOBJ_BODY.value, "grip_base_mount");
      const flange = mj.mj_name2id(model, obj.mjOBJ_SITE.value, "attachment_site");
      const cube = mj.mj_name2id(model, obj.mjOBJ_BODY.value, "part_cube");
      expect(model.body_parentid[mount]).toBe(wrist);
      for (let i = 0; i < 3; i++) expect(d.xpos[3 * mount + i]).toBeCloseTo(d.site_xpos[3 * flange + i] + .007 * d.site_xmat[9 * flange + 3 * i + 2], 9);
      expect(model.body_parentid[cube]).toBe(0);
      expect(model.jnt_type[model.body_jntadr[cube]]).toBe(mj.mjtJoint.mjJNT_FREE.value);
      expect(model.body_mass[cube]).toBeCloseTo(0.027, 10);
      expect(model.nu).toBe(7);
    } finally { d.delete(); }
  });
  it("上传的两个部件可来自不同相对目录，装配包保留各自资源闭包", async () => {
    const nested = (src: ModelBundle, folder: string): ModelBundle => ({
      entry: folder + "/" + src.entry, files: src.files.map((f) => ({ path: folder + "/" + f.path, data: f.data })),
    });
    const assembled = composeUr5eWorkcell(nested(arm, "机器人 R&D"), nested(hand, "夹持器"));
    expect((await describeModel(assembled)).entry).toBe("workcell.xml");
    const recipeFile = assembled.files.find((f) => f.path === "pick-place.json")!;
    const recipe = JSON.parse(new TextDecoder().decode(recipeFile.data));
    expect(recipe.components.arm.entry).toBe("arm/机器人 R&D/ur5e.xml");
    expect(recipe.components.gripper.entry).toBe("hand/夹持器/2f85.xml");
  });
  it("闭合后双侧指垫施加正法向力，工件与工具从夹紧到悬空均实际升高约 50 mm", () => {
    const grasp = at(normal, 2), raised = at(normal, 4);
    const cubeLift = raised.pointM[2] - grasp.pointM[2];
    const toolLift = at(tool, 4).pointM[2] - at(tool, 2).pointM[2];
    expect(Math.abs(cubeLift - .05)).toBeLessThan(.001);
    expect(Math.abs(toolLift - .05)).toBeLessThan(.001);
    expect(raised.referenceM).toEqual(at(tool, 4).pointM);
    const item = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, "part_block");
    const data = new mj.MjData(model);
    try {
      data.qpos.set(raised.qpos); data.qvel.set(raised.qvel);
      data.ctrl.set(trial.sequence!.find((stage) => stage.timeS === 4)!.controls);
      mj.mj_forward(model, data);
      const active = new Set<string>(), contacts = data.contact;
      try {
        for (let i = 0; i < data.ncon; i++) {
          const c = contacts.get(i)!;
          try {
            if (c.efc_address < 0 || data.efc_force[c.efc_address] <= 0) continue;
            const [a, b] = c.geom as Int32Array;
            if (a === item || b === item) active.add(mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, a === item ? b : a));
          } finally { c.delete(); }
        }
      } finally { contacts.delete(); }
      expect([...active].some((g) => g.startsWith("grip_left_pad"))).toBe(true);
      expect([...active].some((g) => g.startsWith("grip_right_pad"))).toBe(true);
      expect(active.has("table")).toBe(false);
    } finally { data.delete(); }
  });
  it("悬空和横移期间，工件中心在夹爪坐标系中的漂移小于 0.5 mm", () => {
    const tip = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, UR5E_WORKCELL_POINTS.tool), d = new mj.MjData(model);
    try {
      const local = (s: ImportedSample) => {
        d.qpos.set(s.qpos); mj.mj_kinematics(model, d);
        const v = s.pointM.map((p, i) => p - d.site_xpos[3 * tip + i]);
        return [0, 1, 2].map((c) => v.reduce((sum, x, r) => sum + x * d.site_xmat[9 * tip + 3 * r + c], 0));
      };
      const reference = local(at(normal, 2));
      const slips = normal.filter((s) => s.timeS >= 2 - 1e-8 && s.timeS <= 5.65).map((s) => dist(local(s), reference));
      expect(Math.max(...slips)).toBeLessThan(0.0005);
    } finally { d.delete(); }
  });
  it("松开后方块保留在横移后的桌面位置，夹爪独立退让", () => {
    const start = normal[0], last = normal.at(-1)!;
    expect(last.pointM[0] - start.pointM[0]).toBeCloseTo(0.080, 3);
    expect(last.pointM[2]).toBeCloseTo(0.195, 3);
    expect(dist(last.pointM, at(normal, 8.3).pointM)).toBeLessThan(0.0001);
    expect(tool.at(-1)!.pointM[2] - at(tool, 8.3).pointM[2]).toBeGreaterThan(0.065);
  });
  it("同一手臂轨迹全程张爪时，方块留在取件位置", () => {
    expect(Math.max(...open.map((s) => dist(s.pointM, open[0].pointM)))).toBeLessThan(0.0005);
    expect(dist(open.at(-1)!.pointM, normal.at(-1)!.pointM)).toBeGreaterThan(0.078);
  });
  it("拒绝错误角色、约束到世界的工件和尺寸错误的方块", () => {
    expect(() => composeUr5eWorkcell(hand, arm)).toThrow(/机械臂/);
    expect(() => composeUr5eWorkcell(arm, hand, piece(UR5E_WORKPIECE_XML.replace("</mujoco>", '<equality><weld body1="cube"/></equality></mujoco>')))).toThrow(/自由刚体/);
    expect(() => composeUr5eWorkcell(arm, hand, piece(UR5E_WORKPIECE_XML.replace("0.015 0.015 0.015", "0.06 0.06 0.06")))).toThrow(/30 mm/);
  });
});
