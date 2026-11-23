import { parseMechanicalAssembly, type MechanicalAssembly } from "./mechanical-assembly";
import { buildPrimitivePartPackage, packageKey } from "./twin-device";
import { emptyWorkspace, installPackage, type TwinWorkspace } from "./twin-simulation";

export type UniversalArchetypeId =
  | "four-wheel-rover"
  | "gripper-pick-arm"
  | "four-bar-linkage"
  | "spring-suspension-rig";

export interface UniversalArchetypeDef {
  readonly id: UniversalArchetypeId;
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly physicsHighlights: string;
}

export const UNIVERSAL_ARCHETYPES: readonly UniversalArchetypeDef[] = [
  {
    id: "four-wheel-rover",
    badge: "移动载具",
    title: "四轮差速越障探索车",
    subtitle: "6-DOF 自由刚体底盘 + 四驱高摩擦橡胶胎，在 -9.81 m/s² 重力下自动落地并冲上 10° 坡道",
    physicsHighlights: "freejoint 自由落地 · 轮胎库仑静摩擦推进 · 质心稳定爬坡",
  },
  {
    id: "gripper-pick-arm",
    badge: "接触操作",
    title: "二指摩擦夹爪取物机械臂",
    subtitle: "Z 向伺服升降臂 + 对夹同步防滑橡胶手指，纯粹依靠接触摩擦力夹起 80g 自由方块",
    physicsHighlights: "多阶段轨迹序列 · 对夹多项式耦合 · 非固定物体摩擦抓取",
  },
  {
    id: "four-bar-linkage",
    badge: "闭链机构",
    title: "闭链四连杆曲柄摇杆机构",
    subtitle: "严格 Grashof 曲柄摇杆 + <connect> 球铰闭环约束，连续 360° 整周转动驱动摇杆摆动",
    physicsHighlights: "树状拓扑跨枝闭环 · 主动速度曲柄 + 双无源随动铰链",
  },
  {
    id: "spring-suspension-rig",
    badge: "弹性悬架",
    title: "弹簧减震摆臂测试台",
    subtitle: "无源铰链摆臂 + 配重轮 + 斜置空间弹簧阻尼器 <tendon>，重现真实欠阻尼弹性振荡衰减",
    physicsHighlights: "空间肌腱弹簧阻尼 · 重力下垂受迫响应 · 可调刚度与阻尼系数",
  },
];

const Q_ID: [number, number, number, number] = [1, 0, 0, 0];

/**
 * 样机①：四轮差速越障探索车（freejoint 自由底盘 + 4× 橡胶驱动轮）
 */
export function buildFourWheelRoverTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgChassis = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "全铝机动探索底盘",
    revision: "R1",
    primitive: { shape: "box", widthMm: 190, depthMm: 120, heightMm: 18, finish: "aluminum" },
    extraOutputs: [
      { id: "fl_axle", positionMm: [68, 74, -12], quatWxyz: Q_ID },
      { id: "fr_axle", positionMm: [68, -74, -12], quatWxyz: Q_ID },
      { id: "rl_axle", positionMm: [-68, 74, -12], quatWxyz: Q_ID },
      { id: "rr_axle", positionMm: [-68, -74, -12], quatWxyz: Q_ID },
      { id: "mast_mount", positionMm: [55, 0, 9], quatWxyz: Q_ID },
    ],
  });

  const pkgWheel = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "Ø84 高摩擦橡胶驱动轮",
    revision: "R1",
    primitive: { shape: "cylinder", radiusMm: 42, lengthMm: 24, axis: "y", finish: "rubber_grip" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-36000, 36000] },
  });

  const pkgMast = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "车头导航感知雷达",
    revision: "R1",
    primitive: { shape: "cylinder", radiusMm: 16, lengthMm: 22, axis: "z", finish: "sensor_amber" },
    input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
  });

  const ws = [pkgChassis, pkgWheel, pkgMast].reduce(installPackage, emptyWorkspace());
  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-four-wheel-rover",
    name: "四轮差速越障探索车",
    baseMobility: "free",
    nodes: [
      { id: "chassis", label: "机动底盘主框", packageKey: packageKey(pkgChassis), parent: null, explodeStep: 0 },
      { id: "wheel_fl", label: "左前驱动轮", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "fl_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, 50, 0] },
      { id: "wheel_fr", label: "右前驱动轮", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "fr_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, -50, 0] },
      { id: "wheel_rl", label: "左后驱动轮", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "rl_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, 50, 0] },
      { id: "wheel_rr", label: "右后驱动轮", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "rr_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, -50, 0] },
      { id: "nav_sensor", label: "车头视觉感知头", packageKey: packageKey(pkgMast), parent: { node: "chassis", mount: "mast_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 45] },
    ],
    output: { node: "nav_sensor", mount: "top" },
    commands: { wheel_fl: 0, wheel_fr: 0, wheel_rl: 0, wheel_rr: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * 样机②：二指摩擦夹爪取物机械臂（Z 向升降臂 + 对夹同步防滑胶指）
 */
export function buildGripperPickArmTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "重型稳固底座板",
    revision: "G2",
    primitive: { shape: "box", widthMm: 120, depthMm: 140, heightMm: 18, finish: "anodized_black" },
    extraOutputs: [{ id: "col_mount", positionMm: [0, 0, 9], quatWxyz: Q_ID }],
  });

  const pkgCol = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "4040 龙门立柱",
    revision: "G2",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 240, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -120], quatWxyz: Q_ID },
    extraOutputs: [{ id: "z_carriage_mount", positionMm: [40, 0, 52], quatWxyz: Q_ID }],
  });

  const pkgZCarriage = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "Z 向精密升降滑座",
    revision: "G2",
    primitive: { shape: "box", widthMm: 36, depthMm: 46, heightMm: 38, finish: "steel" },
    input: { positionMm: [-18, 0, 0], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 0, 1], unit: "mm", range: [-95, 55] },
    extraOutputs: [{ id: "boom_mount", positionMm: [18, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgBoom = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "前伸刚性臂梁",
    revision: "G2",
    primitive: { shape: "box", widthMm: 82, depthMm: 44, heightMm: 16, finish: "aluminum" },
    input: { positionMm: [-41, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "palm_mount", positionMm: [41, 0, -8], quatWxyz: Q_ID }],
  });

  const pkgPalm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "平行二指夹爪基座",
    revision: "G2",
    primitive: { shape: "plate", widthMm: 32, depthMm: 94, thicknessMm: 12, finish: "anodized_black" },
    input: { positionMm: [0, 0, 6], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "jaw_l_mount", positionMm: [0, 30, -6], quatWxyz: Q_ID },
      { id: "jaw_r_mount", positionMm: [0, -30, -6], quatWxyz: Q_ID },
    ],
  });

  const pkgJawLeft = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "左防滑橡胶夹指",
    revision: "G2",
    primitive: { shape: "box", widthMm: 26, depthMm: 12, heightMm: 54, finish: "rubber_grip" },
    input: { positionMm: [0, 0, 27], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, -1, 0], unit: "mm", range: [-8, 22] },
  });

  const pkgJawRight = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "右防滑橡胶夹指",
    revision: "G2",
    primitive: { shape: "box", widthMm: 26, depthMm: 12, heightMm: 54, finish: "rubber_grip" },
    input: { positionMm: [0, 0, 27], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-8, 22] },
  });

  const ws = [pkgBase, pkgCol, pkgZCarriage, pkgBoom, pkgPalm, pkgJawLeft, pkgJawRight].reduce(
    installPackage,
    emptyWorkspace(),
  );
  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-gripper-pick-arm",
    name: "二指摩擦夹爪取物机械臂",
    baseMobility: "fixed",
    nodes: [
      { id: "arm_base", label: "稳固安装底板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "arm_col", label: "垂直立柱", packageKey: packageKey(pkgCol), parent: { node: "arm_base", mount: "col_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 60] },
      { id: "z_lift", label: "Z 轴升降滑座", packageKey: packageKey(pkgZCarriage), parent: { node: "arm_col", mount: "z_carriage_mount" }, jointMode: "actuated", explodeStep: 2, explodeVectorMm: [50, 0, 0] },
      { id: "arm_boom", label: "前伸悬臂梁", packageKey: packageKey(pkgBoom), parent: { node: "z_lift", mount: "boom_mount" }, explodeStep: 3, explodeVectorMm: [55, 0, 0] },
      { id: "gripper_palm", label: "平行夹爪掌座", packageKey: packageKey(pkgPalm), parent: { node: "arm_boom", mount: "palm_mount" }, explodeStep: 4, explodeVectorMm: [0, 0, -40] },
      { id: "jaw_left", label: "左防滑橡胶夹指", packageKey: packageKey(pkgJawLeft), parent: { node: "gripper_palm", mount: "jaw_l_mount" }, jointMode: "actuated", explodeStep: 5, explodeVectorMm: [0, 35, -35] },
      {
        id: "jaw_right",
        label: "右防滑橡胶夹指 (耦合)",
        packageKey: packageKey(pkgJawRight),
        parent: { node: "gripper_palm", mount: "jaw_r_mount" },
        jointMode: "actuated",
        coupledTo: { path: "jaw_left", ratio: 1 },
        explodeStep: 5,
        explodeVectorMm: [0, -35, -35],
      },
    ],
    output: { node: "gripper_palm", mount: "bottom" },
    commands: { z_lift: 0, jaw_left: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * 样机③：闭链四连杆曲柄摇杆机构（满足 Grashof 整周曲柄条件 + connect 球铰闭环）
 */
export function buildFourBarLinkageTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "双立柱实验底板",
    revision: "L1",
    primitive: { shape: "plate", widthMm: 260, depthMm: 110, thicknessMm: 20, finish: "anodized_black" },
    extraOutputs: [
      { id: "mount_a", positionMm: [-90, 0, 10], quatWxyz: Q_ID },
      { id: "mount_d", positionMm: [70, 0, 10], quatWxyz: Q_ID },
    ],
  });

  const pkgPostA = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "曲柄侧高支座",
    revision: "L1",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 120, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -60], quatWxyz: Q_ID },
  });

  const pkgPostD = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "摇杆侧矮支座",
    revision: "L1",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 70, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -35], quatWxyz: Q_ID },
  });

  const pkgCrankPin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "主动曲柄驱动轴 A",
    revision: "L1",
    primitive: { shape: "cylinder", radiusMm: 15, lengthMm: 26, axis: "y", finish: "spindle_red" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-36000, 36000] },
  });

  const pkgCrankBar = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "主动曲柄杆 (50mm)",
    revision: "L1",
    primitive: { shape: "box", widthMm: 16, depthMm: 14, heightMm: 50, finish: "spindle_red" },
    input: { positionMm: [0, 0, -25], quatWxyz: Q_ID },
  });

  const pkgPassivePin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "无源随动铰链销",
    revision: "L1",
    primitive: { shape: "cylinder", radiusMm: 12, lengthMm: 24, axis: "y", finish: "brass" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-180, 180] },
  });

  const pkgCouplerRod = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "连杆臂 B-C (160mm)",
    revision: "L1",
    primitive: { shape: "box", widthMm: 160, depthMm: 16, heightMm: 16, finish: "aluminum" },
    input: { positionMm: [-80, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "pin_c", positionMm: [80, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgRockerArm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "从动摇杆 D-C (100mm)",
    revision: "L1",
    primitive: { shape: "box", widthMm: 18, depthMm: 16, heightMm: 100, finish: "steel" },
    input: { positionMm: [0, 0, -50], quatWxyz: Q_ID },
  });

  const ws = [
    pkgBase,
    pkgPostA,
    pkgPostD,
    pkgCrankPin,
    pkgCrankBar,
    pkgPassivePin,
    pkgCouplerRod,
    pkgRockerArm,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-four-bar-linkage",
    name: "闭链四连杆曲柄摇杆机构",
    baseMobility: "fixed",
    nodes: [
      { id: "base_plate", label: "机架底板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "post_a", label: "A点主支座", packageKey: packageKey(pkgPostA), parent: { node: "base_plate", mount: "mount_a" }, explodeStep: 1, explodeVectorMm: [0, 0, 45] },
      { id: "crank_hinge", label: "A 曲柄马达轴", packageKey: packageKey(pkgCrankPin), parent: { node: "post_a", mount: "top" }, jointMode: "velocity", explodeStep: 2, explodeVectorMm: [0, 0, 45] },
      { id: "crank_bar", label: "曲柄臂 a=50mm", packageKey: packageKey(pkgCrankBar), parent: { node: "crank_hinge", mount: "center" }, explodeStep: 3, explodeVectorMm: [0, 0, 50] },
      { id: "coupler_hinge", label: "B 随动铰链", packageKey: packageKey(pkgPassivePin), parent: { node: "crank_bar", mount: "top" }, jointMode: "passive", explodeStep: 4, explodeVectorMm: [0, 0, 45] },
      { id: "coupler_rod", label: "连杆臂 b=160mm", packageKey: packageKey(pkgCouplerRod), parent: { node: "coupler_hinge", mount: "center" }, explodeStep: 5, explodeVectorMm: [45, 0, 45] },
      { id: "post_d", label: "D点副支座", packageKey: packageKey(pkgPostD), parent: { node: "base_plate", mount: "mount_d" }, explodeStep: 1, explodeVectorMm: [0, 0, 45] },
      { id: "rocker_hinge", label: "D 摇杆自由铰链", packageKey: packageKey(pkgPassivePin), parent: { node: "post_d", mount: "top" }, jointMode: "passive", explodeStep: 2, explodeVectorMm: [0, 0, 45] },
      { id: "rocker_arm", label: "摇杆臂 c=100mm", packageKey: packageKey(pkgRockerArm), parent: { node: "rocker_hinge", mount: "center" }, explodeStep: 3, explodeVectorMm: [0, 0, 50] },
    ],
    closures: [
      {
        id: "loop_c",
        kind: "connect",
        nodeA: "coupler_rod",
        mountA: "pin_c",
        nodeB: "rocker_arm",
        mountB: "top",
      },
    ],
    output: { node: "coupler_rod", mount: "center" },
    commands: { crank_hinge: 0, coupler_hinge: 0, rocker_hinge: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * 样机④：弹簧减震摆臂测试台（无源摇臂 + 斜拉空间弹簧阻尼器）
 */
export function buildSpringSuspensionTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "悬架测试平台基座",
    revision: "S1",
    primitive: { shape: "plate", widthMm: 260, depthMm: 130, thicknessMm: 20, finish: "anodized_black" },
    extraOutputs: [
      { id: "pivot_mount", positionMm: [-85, 0, 10], quatWxyz: Q_ID },
      { id: "tower_mount", positionMm: [-15, 0, 10], quatWxyz: Q_ID },
    ],
  });

  const pkgPivotPost = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "摆臂铰链立柱",
    revision: "S1",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 160, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -80], quatWxyz: Q_ID },
  });

  const pkgSpringTower = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "减震器上拉塔架",
    revision: "S1",
    primitive: { shape: "extrusion_profile", series: "2040", lengthMm: 230, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, -115], quatWxyz: Q_ID },
  });

  const pkgSwingPin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "悬架低阻尼摆轴",
    revision: "S1",
    primitive: { shape: "cylinder", radiusMm: 14, lengthMm: 24, axis: "y", finish: "brass" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-75, 75] },
  });

  const pkgSwingArm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "铝合金下摆臂",
    revision: "S1",
    primitive: { shape: "box", widthMm: 165, depthMm: 22, heightMm: 18, finish: "aluminum" },
    input: { positionMm: [-82.5, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "spring_eye", positionMm: [30, 0, 9], quatWxyz: Q_ID },
      { id: "wheel_end", positionMm: [82.5, 0, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgHubWheel = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "悬架配重测试轮",
    revision: "S1",
    primitive: { shape: "cylinder", radiusMm: 38, lengthMm: 26, axis: "y", finish: "rubber_grip" },
    behavior: { kind: "moving_table", massKg: 0.65 },
  });

  const ws = [pkgBase, pkgPivotPost, pkgSpringTower, pkgSwingPin, pkgSwingArm, pkgHubWheel].reduce(
    installPackage,
    emptyWorkspace(),
  );

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-spring-suspension",
    name: "弹簧减震摆臂测试台",
    baseMobility: "fixed",
    nodes: [
      { id: "rig_base", label: "试验台底板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "pivot_post", label: "主铰链立柱", packageKey: packageKey(pkgPivotPost), parent: { node: "rig_base", mount: "pivot_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 40] },
      { id: "spring_tower", label: "减震弹簧塔架", packageKey: packageKey(pkgSpringTower), parent: { node: "rig_base", mount: "tower_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
      { id: "swing_hinge", label: "无源摆臂旋转轴", packageKey: packageKey(pkgSwingPin), parent: { node: "pivot_post", mount: "top" }, jointMode: "passive", explodeStep: 2, explodeVectorMm: [0, 0, 40] },
      { id: "swing_arm", label: "悬架铝合金摆臂", packageKey: packageKey(pkgSwingArm), parent: { node: "swing_hinge", mount: "center" }, explodeStep: 3, explodeVectorMm: [50, 0, 0] },
      { id: "hub_wheel", label: "悬架末端配重轮", packageKey: packageKey(pkgHubWheel), parent: { node: "swing_arm", mount: "wheel_end" }, explodeStep: 4, explodeVectorMm: [45, 0, 0] },
    ],
    closures: [
      {
        id: "coilover_spring",
        kind: "spring",
        nodeA: "spring_tower",
        mountA: "top",
        nodeB: "swing_arm",
        mountB: "spring_eye",
        stiffnessNpm: 260,
        dampingNsPm: 5.5,
      },
    ],
    output: { node: "hub_wheel", mount: "center" },
    commands: { swing_hinge: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

export function loadUniversalArchetype(id: UniversalArchetypeId): {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
} {
  switch (id) {
    case "four-wheel-rover":
      return buildFourWheelRoverTemplate();
    case "gripper-pick-arm":
      return buildGripperPickArmTemplate();
    case "four-bar-linkage":
      return buildFourBarLinkageTemplate();
    case "spring-suspension-rig":
      return buildSpringSuspensionTemplate();
  }
}
