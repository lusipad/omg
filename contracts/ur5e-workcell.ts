import { MODEL_LIMITS, type ModelBundle, type ModelFile } from "./import-catalog";
import type { ImportedModelInfo, ImportedRunSettings } from "./imported-physics";

export const UR5E_WORKCELL_POINTS = { tool: "grip_pinch", object: "part_cube" } as const;
export const UR5E_WORKCELL_KEYFRAME = "pick_ready";
export const UR5E_WORKPIECE_XML = `<mujoco model="30 mm pick block">
  <worldbody>
    <geom name="support" type="plane" size="0.12 0.12 0.01" rgba="0.28 0.35 0.38 1"/>
    <body name="cube" pos="0 0 0.015">
      <freejoint name="floating"/>
      <geom name="block" type="box" size="0.015 0.015 0.015" mass="0.027" friction="0.8 0.005 0.0001" rgba="0.93 0.36 0.07 1"/>
      <site name="center" size="0.0015" rgba="1 1 1 0"/>
    </body>
  </worldbody>
</mujoco>
`;

const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
const marker = "ur5e-2f85-pick-place-v1";
const modelName = "UR5e 2F-85 pick and place";
const armJoints = ["shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"];
const actuatorNames = ["shoulder_pan", "shoulder_lift", "elbow", "wrist_1", "wrist_2", "wrist_3", "grip_fingers_actuator"];
const handJoints = ["right_driver_joint", "right_coupler_joint", "right_spring_link_joint", "right_follower_joint",
  "left_driver_joint", "left_coupler_joint", "left_spring_link_joint", "left_follower_joint"];
const pickCenter = [-0.135, 0.480, 0.195];
const xmlEscape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

// 卸载状态下的数值 IK 解。ctrl 同时计入手臂和所装夹爪的静态重力补偿 qfrc_bias / Kp。
const readyQ = [-1.568711641, -1.582162606, 1.769929591, -1.758566977, -1.570800008, 0.002088359];
const targets = {
  ready: [-1.568711641, -1.592228068, 1.759623612, -1.763394259, -1.570798546, 0.002088359],
  pick:  [-1.568711641, -1.554116939, 1.879979317, -1.921902624, -1.570798546, 0.002088359],
  lift:  [-1.568711642, -1.587483025, 1.780955068, -1.789475927, -1.570798546, 0.002088359],
  carry: [-1.737745644, -1.624773442, 1.817965035, -1.788394126, -1.570797937, -0.166945644],
  place: [-1.737745644, -1.589801855, 1.920911595, -1.926350370, -1.570797937, -0.166945644],
  away:  [-1.737745644, -1.633650429, 1.774437748, -1.735980189, -1.570797937, -0.166945644],
};
const stages: [number, keyof typeof targets, number, string][] = [
  [0.75, "pick", 0, "下降到取件位"], [1.15, "pick", 0, "张爪等待"],
  [1.60, "pick", 200, "闭合夹爪"], [2.00, "pick", 200, "夹紧保持"],
  [3.10, "lift", 200, "上举 50 mm"], [4.00, "lift", 200, "悬空保持"],
  [5.10, "carry", 200, "横移 80 mm"], [5.65, "carry", 200, "横移到位保持"],
  [6.80, "place", 200, "下降放件"], [7.40, "place", 200, "台面支撑"],
  [7.90, "place", 0, "张开夹爪"], [8.30, "place", 0, "松开等待"],
  [9.40, "away", 0, "向上退让"], [10.00, "away", 0, "退让后保持"],
];

export function makeUr5eWorkcellTrial(info: ImportedModelInfo): ImportedRunSettings {
  const object = info.points.find((p) => p.kind === "body" && p.name === UR5E_WORKCELL_POINTS.object);
  const tool = info.points.find((p) => p.kind === "site" && p.name === UR5E_WORKCELL_POINTS.tool);
  const ordering = info.actuators.map((a) => actuatorNames.indexOf(a.name));
  if (!object || !tool || !info.keyframes.includes(UR5E_WORKCELL_KEYFRAME) || ordering.includes(-1) ||
    ordering.length !== actuatorNames.length || new Set(ordering).size !== actuatorNames.length) {
    throw new Error("此模型缺少取放工位的工件、初始姿态或七路执行器。");
  }
  const controls = (pose: keyof typeof targets, grip: number) => ordering.map((axis) => axis === 6 ? grip : targets[pose][axis]);
  return { durationS: 10, controls: controls("ready", 0), pointId: object.id, referencePointId: tool.id, keyframe: UR5E_WORKCELL_KEYFRAME,
    sequence: stages.map(([timeS, pose, grip, label]) => ({ timeS, label, controls: controls(pose, grip) })) };
}

function tags(xml: string, name: string) {
  const matches = xml.matchAll(new RegExp(`<${name}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, "g"));
  return Array.from(matches, ([raw]) => ({ raw, attrs: Object.fromEntries(
    Array.from(raw.matchAll(/\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g), (m) => [m[1], m[2] ?? m[3]]),
  ) as Record<string, string> }));
}

function withAttributes(tag: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const field = new RegExp(`\\s${key}\\s*=\\s*(?:"[^"]*"|'[^']*')`), attr = ` ${key}="${xmlEscape(value)}"`;
    tag = field.test(tag) ? tag.replace(field, () => attr) : tag.replace(/\/?>$/, (end) => attr + end);
  }
  return tag;
}

function parentBody(xml: string, child: string): string | undefined {
  const stack: string[] = [];
  for (const [tag, closing] of xml.slice(0, xml.indexOf(child)).matchAll(/<(\/?)body(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    if (closing) stack.pop();
    else if (!tag.endsWith("/>")) stack.push(tags(tag, "body")[0].attrs.name);
  }
  return stack.at(-1);
}

function localPath(base: string, ref: string): string {
  if (ref.startsWith("/") || ref.includes(":") || ref.includes("\\")) throw new Error("装配资源须使用包内相对路径。");
  const path = base.split("/").slice(0, -1);
  for (const part of ref.split("/")) {
    if (part === "..") { if (!path.length) throw new Error("装配资源越出源模型包。"); path.pop(); }
    else if (part && part !== ".") path.push(part);
  }
  return path.join("/");
}

function findPart(bundle: ModelBundle, kind: "arm" | "hand" | "part") {
  const files = new Map(bundle.files.map((f) => [f.path, f]));
  const queue = [bundle.entry], visited = new Set<string>();
  for (const path of queue) {
    if (visited.has(path)) continue;
    visited.add(path);
    const f = files.get(path);
    if (!f) throw new Error(`源包缺少模型文件 ${path}`);
    const xml = decode.decode(f.data).replace(/<!--[\s\S]*?-->/g, "");
    const root = tags(xml, "mujoco")[0]?.attrs.model;
    const matches = kind === "arm" ? root === "ur5e" : kind === "hand" ? root === "robotiq_2f85" :
      tags(xml, "body").some((b) => b.attrs.name === "cube");
    if (matches) return { path, xml, files };
    for (const t of [...tags(xml, "include"), ...tags(xml, "model")]) if (t.attrs.file) queue.push(localPath(path, t.attrs.file));
  }
  throw new Error(`所选入口没有引用兼容的${kind === "arm" ? " UR5e 机械臂" : kind === "hand" ? " Robotiq 2F-85 夹爪" : "自由方块工件"}。`);
}

type Part = ReturnType<typeof findPart>;
function sourceFiles(part: Part, namespace: string): ModelFile[] {
  const paths = new Set([part.path]);
  const compiler = tags(part.xml, "compiler")[0]?.attrs ?? {};
  for (const type of ["mesh", "texture", "hfield", "skin"]) {
    const dir = (type === "texture" ? compiler.texturedir : compiler.meshdir) ?? compiler.assetdir ?? ".";
    for (const { attrs } of tags(part.xml, type)) {
      if (attrs.file) paths.add(localPath(part.path, `${dir}/${attrs.file}`));
    }
  }
  for (const path of part.files.keys()) {
    if (/(?:^|\/)(?:licen[cs]e[^/]*|notice[^/]*|copying[^/]*|attribution[^/]*|upstream\.[^/]+|source\.md|readme\.md)$/i.test(path)) paths.add(path);
  }
  return [...paths].map((path) => {
    const file = part.files.get(path);
    if (!file) throw new Error(`源模型缺少装配需要的资源 ${path}`);
    return { path: `${namespace}/${path}`, data: file.data };
  });
}

function workpiecePosition(part: Part) {
  const body = tags(part.xml, "body");
  if (body.length !== 1 || body[0].attrs.name !== "cube") throw new Error("工件模型须提供单个名为 cube 的刚体。");
  const begin = part.xml.indexOf(body[0].raw) + body[0].raw.length;
  const interior = part.xml.slice(begin, part.xml.indexOf("</body>", begin));
  const geoms = tags(interior, "geom");
  const geom = geoms[0]?.attrs;
  const sizes = (geom?.size ?? "").trim().split(/\s+/).map(Number);
  const joints = tags(interior, "joint"), free = tags(interior, "freejoint").length + joints.filter((j) => j.attrs.type === "free").length;
  const collides = ((Number(geom?.contype ?? 1) | Number(geom?.conaffinity ?? 1)) & 1) !== 0;
  const inertials = tags(interior, "inertial");
  const mass = Number(inertials[0]?.attrs.mass ?? geom?.mass);
  if (["true", "1"].includes(body[0].attrs.mocap) || Number(body[0].attrs.gravcomp ?? 0) !== 0 ||
    free !== 1 || joints.some((j) => j.attrs.type !== "free") || /<(?:equality|actuator|tendon|frame|default|include|attach)\b/.test(part.xml) ||
    geoms.length !== 1 || geom.name !== "block" || geom.type !== "box" || !collides ||
    inertials.length > 1 || !Number.isFinite(mass) || mass <= 0 || sizes.length !== 3 ||
    sizes.some((v) => !Number.isFinite(v) || Math.abs(v - 0.015) > 1e-8)) {
    throw new Error("工件须为名为 cube 的独立自由刚体，含名为 block 的 30 mm 可碰撞方块和显式正质量，且仅由物理接触驱动。");
  }
  const aligned = (attrs: Record<string, string>) => {
    const quat = (attrs.quat ?? "1 0 0 0").trim().split(/\s+/).map(Number);
    const euler = (attrs.euler ?? "0 0 0").trim().split(/\s+/).map(Number);
    return !attrs.axisangle && !attrs.xyaxes && !attrs.zaxis && quat.length === 4 && Math.abs(quat[0]) === 1 &&
      quat.slice(1).every((v) => v === 0) && euler.length === 3 && euler.every((v) => v === 0);
  };
  const offset = (body[0].attrs.pos ?? "0 0 0").trim().split(/\s+/).map(Number);
  const shapeOffset = (geom.pos ?? "0 0 0").trim().split(/\s+/).map(Number);
  if (!aligned(body[0].attrs) || !aligned(geom) || offset.length !== 3 || offset.some((v) => !Number.isFinite(v)) || shapeOffset.length !== 3 || shapeOffset.some((v) => v !== 0)) {
    throw new Error("工件接口要求碰撞盒居中，且源刚体与碰撞盒初始坐标轴对齐。");
  }
  return pickCenter.map((v, i) => v - offset[i]).join(" ");
}

export function isUr5eWorkcell(bundle: ModelBundle): boolean {
  const entry = bundle.files.find((f) => f.path === bundle.entry);
  if (!entry) return false;
  try {
    const xml = decode.decode(entry.data).replace(/<!--[\s\S]*?-->/g, "");
    return tags(xml, "mujoco")[0]?.attrs.model === modelName &&
      tags(xml, "text").some((t) => t.attrs.name === "gouyuan_workcell" && t.attrs.data === marker);
  } catch { return false; }
}

export function composeUr5eWorkcell(arm: ModelBundle, gripper: ModelBundle, workpiece?: ModelBundle): ModelBundle {
  const a = findPart(arm, "arm"), h = findPart(gripper, "hand");
  const p = findPart(workpiece ?? { entry: "workpiece.xml", files: [{ path: "workpiece.xml", data: encode.encode(UR5E_WORKPIECE_XML) }] }, "part");
  const flange = tags(a.xml, "site").find((s) => s.attrs.name === "attachment_site");
  const jointNames = (part: Part) => tags(part.xml.split("<actuator")[0], "joint").map((j) => j.attrs.name).filter(Boolean);
  const motorNames = (part: Part) => tags(/<actuator\s*>([\s\S]*?)<\/actuator\s*>/.exec(part.xml)?.[1] ?? "", "[\\w-]+").map((t) => t.attrs.name);
  if (!flange?.attrs.pos || !flange.attrs.quat || parentBody(a.xml, flange.raw) !== "wrist_3_link" ||
    jointNames(a).join() !== armJoints.join() || jointNames(h).join() !== handJoints.join() ||
    motorNames(a).join() !== actuatorNames.slice(0, 6).join() || motorNames(h).join() !== "fingers_actuator" ||
    tags(h.xml, "body")[0]?.attrs.name !== "base_mount" || !tags(h.xml, "site").some((s) => s.attrs.name === "pinch")) {
    throw new Error("该机械臂或夹爪的关节顺序及法兰接口与当前取放工况不兼容。");
  }
  const partPos = workpiecePosition(p);
  const compiler = tags(a.xml, "compiler")[0], option = tags(a.xml, "option")[0], root = tags(a.xml, "mujoco")[0];
  if (!compiler?.attrs.meshdir) throw new Error("UR5e 源模型缺少网格目录。");
  const solver = withAttributes(option?.raw ?? "<option/>", { integrator: "implicitfast", cone: "elliptic", impratio: "10", timestep: "0.002" });
  const base = option ? a.xml.replace(option.raw, () => solver) : a.xml.replace(compiler.raw, () => compiler.raw + "\n  " + solver);
  const assembly = base
    .replace(root.raw, () => withAttributes(root.raw, { model: modelName }))
    .replace(compiler.raw, () => withAttributes(compiler.raw, { meshdir: "arm/" + localPath(a.path, compiler.attrs.meshdir) }))
    .replace(/<asset\s*>/, () => `<asset>\n    <model name="hand_src" file="hand/${xmlEscape(h.path)}"/>\n    <model name="piece_src" file="part/${xmlEscape(p.path)}"/>`)
    .replace(flange.raw, `${flange.raw}\n                  <frame pos="${xmlEscape(flange.attrs.pos)}" quat="${xmlEscape(flange.attrs.quat)}"><attach model="hand_src" body="base_mount" prefix="grip_"/></frame>`)
    .replace("</worldbody>", `  <geom name="floor" type="plane" size="1 1 0.05" rgba=".16 .20 .20 1"/>
    <geom name="table" type="box" pos="-.095 .480 .09" size=".17 .15 .09" rgba=".30 .40 .44 1"/>
    <frame pos="${partPos}"><attach model="piece_src" body="cube" prefix="part_"/></frame>
  </worldbody>`)
    .replace(/<keyframe\s*>[\s\S]*?<\/keyframe\s*>/, "")
    .replace("</mujoco>", `  <custom><text name="gouyuan_workcell" data="${marker}"/></custom>
  <keyframe><key name="${UR5E_WORKCELL_KEYFRAME}" qpos="${[...readyQ, ...handJoints.map(() => 0), ...pickCenter, 1, 0, 0, 0].join(" ")}" ctrl="${[...targets.ready, 0].join(" ")}"/></keyframe>
</mujoco>`);
  const recipe = {
    model: modelName, entry: "workcell.xml", keyframe: UR5E_WORKCELL_KEYFRAME, durationS: 10,
    adaptation: {
      author: "构元设备仿真工作台",
      changes: "构元生成 workcell.xml，在源法兰处安装夹爪，添加台面、独立自由工件和 pick_ready 姿态。arm/ 与 hand/ 中保留输入的源模型及其归属文件。",
      solver: "MuJoCo implicitfast，2 ms 物理步，椭圆摩擦锥，impratio=10。工件由指垫摩擦传力。",
      procedure: "从 pick_ready 读取初始状态，以 controls 为 t=0 指令，按绝对时间 sequence 在每个物理步插值，结束后维持末指令。",
      calibrationSource: "https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4",
      armSourceDirectory: "universal_robots_ur5e", gripperSourceDirectory: "robotiq_2f85",
    },
    components: {
      arm: { entry: "arm/" + a.path, body: "wrist_3_link", flangeSite: "attachment_site" },
      gripper: { entry: "hand/" + h.path, mountingBody: "base_mount", prefix: "grip_" },
      workpiece: { entry: "part/" + p.path, freeBody: "cube", prefix: "part_", startCenterM: pickCenter },
    },
    nominalLiftM: 0.05, nominalTransferM: 0.08, interpolation: "cubic smoothstep, 3u^2 - 2u^3",
    objectBody: UR5E_WORKCELL_POINTS.object, referenceSite: UR5E_WORKCELL_POINTS.tool,
    actuatorNames, controls: [...targets.ready, 0],
    sequence: stages.map(([timeS, pose, grip, label]) => ({ timeS, label, controls: [...targets[pose], grip] })),
  };
  const files = [
    { path: "workcell.xml", data: encode.encode(assembly) },
    { path: "pick-place.json", data: encode.encode(JSON.stringify(recipe, null, 2) + "\n") },
    ...sourceFiles(a, "arm"), ...sourceFiles(h, "hand"), ...sourceFiles(p, "part"),
  ];
  if (files.length > MODEL_LIMITS.maxFiles || files.some((f) => f.data.byteLength > MODEL_LIMITS.maxFileBytes) ||
    files.reduce((sum, f) => sum + f.data.byteLength, 0) > MODEL_LIMITS.maxBundleBytes) throw new Error("装配后的资源超过单模型包的容量。");
  return { entry: "workcell.xml", files };
}
