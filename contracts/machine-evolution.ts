import { Matrix4, Quaternion, Vector3 } from "three";
import {
  buildComposableMiloMillTemplate,
  solveArticulatedAssembly,
  type ArticulatedSolveResult,
} from "./articulated-kinematics";
import { createFeedbackStockPlayback, type MiloStockState } from "./milo-stock";
import type { MiloVec3 } from "./milo-motion";
import { mechanicalSubassembly, parseMechanicalAssembly, type MechanicalAssembly } from "./mechanical-assembly";
import { primitiveBoundingBoxMm } from "./primitive-parts";
import {
  createChallengeSolution,
  createZeroBlankSandbox,
  matingInputAndExplode,
  placeRootBlockInSandbox,
  SANDBOX_BLOCKS,
  snapBlockOntoAssembly,
  updateSandboxNode,
} from "./sandbox-challenges";
import {
  buildPrimitivePartPackage,
  packageKey,
  parseDevicePackage,
  type DevicePackage,
} from "./twin-device";
import { emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "./twin-simulation";

const Q_ID: [number, number, number, number] = [1, 0, 0, 0];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function pickUniquePkg(existing: readonly DevicePackage[], candidate: DevicePackage): DevicePackage {
  const byKey = new Map(existing.map((p) => [packageKey(p), p]));
  const first = byKey.get(packageKey(candidate));
  if (!first) return candidate;
  if (JSON.stringify(first) === JSON.stringify(candidate)) return first;
  for (let i = 2; i <= 128; i++) {
    const bumped = parseDevicePackage({ ...candidate, revision: `${candidate.revision}-${i}` });
    const hit = byKey.get(packageKey(bumped));
    if (!hit) return bumped;
    if (JSON.stringify(hit) === JSON.stringify(bumped)) return hit;
  }
  return candidate;
}

// ==========================================
// 1. 旗舰原理展馆展品（C型立柱铣床 / 双柱龙门铣床 / 同源机械臂）
// ==========================================

export type ShowroomExhibitId = "c-frame-mill" | "gantry-mill" | "articulated-arm";

export interface ShowroomExhibitDef {
  readonly id: ShowroomExhibitId;
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly simMode: "milling-pocket" | "arm-orbit";
  readonly takeaway: string;
}

export const SHOWROOM_EXHIBITS: readonly ShowroomExhibitDef[] = [
  {
    id: "c-frame-mill",
    badge: "展品 ①",
    title: "C型单立柱三轴铣床",
    subtitle: "经典悬臂结构：床身占地小、上下料方便，重切时悬臂立柱承压",
    simMode: "milling-pocket",
    takeaway: "观察滑台移动如何带动铝合金毛坯走位，丝杠跟随电机旋转，悬臂主轴承受切削反力。",
  },
  {
    id: "gantry-mill",
    badge: "展品 ②",
    title: "龙门双立柱高刚性铣床",
    subtitle: "对称双柱闭合框架：牺牲少许占地换取 2.5 倍以上抗让刀刚度",
    simMode: "milling-pocket",
    takeaway: "对比展品①：把单立柱悬臂改成双立柱横梁门架后，同样进给速度下刀尖让刀变形大幅缩小。",
  },
  {
    id: "articulated-arm",
    badge: "展品 ③",
    title: "同源三自由度机械臂",
    subtitle: "同一套物理与积木引擎：仅把直线滑台换成旋转铰链，即诞生机器人",
    simMode: "arm-orbit",
    takeaway: "机床与机器人底层同源——串联旋转副以小体积换大工作空间，但肩关节承受显著重力力矩。",
  },
];

/**
 * 构建带对称双立柱与横梁的龙门式高刚性三轴数控铣床模板（零件接口毫米级齐平）。
 */
export function buildGantryMillTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    model: "龙门重型平板床身",
    revision: "G1",
    title: "龙门加工中心一体床身基座（380×440×20 mm）",
    primitive: { shape: "plate", widthMm: 380, depthMm: 440, thicknessMm: 20, finish: "anodized_black" },
    extraOutputs: [
      { id: "y_rail_mount", positionMm: [0, -10, 10], quatWxyz: Q_ID },
      { id: "y_screw_mount", positionMm: [54, -10, 22], quatWxyz: Q_ID },
      { id: "y_motor_mount", positionMm: [54, -238, 22], quatWxyz: Q_ID },
      { id: "left_col_mount", positionMm: [-160, 147, 10], quatWxyz: Q_ID },
      { id: "right_col_mount", positionMm: [160, 147, 10], quatWxyz: Q_ID },
      { id: "left_gusset_mount", positionMm: [-132, 147, 10], quatWxyz: Q_ID },
      { id: "right_gusset_mount", positionMm: [132, 147, 10], quatWxyz: Q_ID },
    ],
  });

  const pkgYRail = buildPrimitivePartPackage({
    model: "龙门Y轴直线导轨副",
    revision: "G1",
    primitive: { shape: "linear_rail_block", railLengthMm: 360, railWidthMm: 16, blockLengthMm: 64, blockWidthMm: 46, heightMm: 22, axis: "y", finish: "steel" },
    input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
  });

  const pkgYTable = buildPrimitivePartPackage({
    model: "龙门Y向载物工作台",
    revision: "G1",
    primitive: { shape: "plate", widthMm: 220, depthMm: 160, thicknessMm: 14, holeDiameterMm: 6, holeInsetMm: 14, finish: "aluminum" },
    input: { positionMm: [0, 0, -7], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-100, 100] },
    behavior: { kind: "moving_table", massKg: 7.2 },
  });

  const pkgYScrew = buildPrimitivePartPackage({
    model: "龙门Y轴滚珠丝杠",
    revision: "G1",
    primitive: { shape: "lead_screw", diameterMm: 14, lengthMm: 360, leadMm: 8, axis: "y", finish: "steel" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgYMotor = buildPrimitivePartPackage({
    model: "龙门Y轴伺服电机",
    revision: "G1",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "y", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgWorkpiece = buildPrimitivePartPackage({
    model: "6061铝合金毛坯件",
    revision: "G1",
    primitive: { shape: "box", widthMm: 110, depthMm: 90, heightMm: 26, finish: "workpiece_alloy" },
    input: { positionMm: [0, 0, -13], quatWxyz: Q_ID },
  });

  const pkgColumn = buildPrimitivePartPackage({
    model: "4080重型龙门立柱",
    revision: "G1",
    primitive: { shape: "extrusion_profile", series: "4080", lengthMm: 340, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -170], quatWxyz: Q_ID },
    extraOutputs: [{ id: "beam_mount", positionMm: [160, 0, 170], quatWxyz: Q_ID }],
  });

  const pkgGusset = buildPrimitivePartPackage({
    model: "立柱加强铸铝角件",
    revision: "G1",
    primitive: { shape: "angle_bracket", widthMm: 28, legAMm: 75, legBMm: 85, thicknessMm: 10, finish: "steel" },
    input: { positionMm: [0, 0, -42.5], quatWxyz: Q_ID },
  });

  const pkgCrossbeam = buildPrimitivePartPackage({
    model: "4080龙门桥式横梁",
    revision: "G1",
    primitive: { shape: "extrusion_profile", series: "4080", lengthMm: 400, axis: "x", finish: "anodized_black" },
    input: { positionMm: [0, 0, -20], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "x_rail_mount", positionMm: [0, -40, 0], quatWxyz: Q_ID },
      { id: "x_screw_mount", positionMm: [0, -52, 32], quatWxyz: Q_ID },
      { id: "x_motor_mount", positionMm: [215, -52, 32], quatWxyz: Q_ID },
    ],
  });

  const pkgXRail = buildPrimitivePartPackage({
    model: "龙门X轴重型导轨",
    revision: "G1",
    primitive: { shape: "linear_rail_block", railLengthMm: 300, railWidthMm: 16, blockLengthMm: 62, blockWidthMm: 46, heightMm: 22, axis: "x", finish: "steel" },
    input: { positionMm: [0, 11, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "carriage_front", positionMm: [0, -11, 0], quatWxyz: Q_ID }],
  });

  const pkgXScrew = buildPrimitivePartPackage({
    model: "龙门X轴滚珠丝杠",
    revision: "G1",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 300, leadMm: 8, axis: "x", finish: "steel" },
    joint: { type: "hinge", axis: [1, 0, 0], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgXMotor = buildPrimitivePartPackage({
    model: "龙门X轴伺服电机",
    revision: "G1",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 58, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgXSaddle = buildPrimitivePartPackage({
    model: "横梁X向溜板",
    revision: "G1",
    primitive: { shape: "box", widthMm: 92, depthMm: 16, heightMm: 130, finish: "aluminum" },
    input: { positionMm: [0, 8, 0], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-120, 120] },
    behavior: { kind: "moving_table", massKg: 4.5 },
    extraOutputs: [
      { id: "z_rail_mount", positionMm: [0, -8, 0], quatWxyz: Q_ID },
      { id: "z_screw_mount", positionMm: [42, -20, 0], quatWxyz: Q_ID },
      { id: "z_motor_mount", positionMm: [42, -20, 115], quatWxyz: Q_ID },
    ],
  });

  const pkgZRail = buildPrimitivePartPackage({
    model: "龙门Z轴升降导轨",
    revision: "G1",
    primitive: { shape: "linear_rail_block", railLengthMm: 220, railWidthMm: 16, blockLengthMm: 60, blockWidthMm: 44, heightMm: 22, axis: "z", finish: "steel" },
    input: { positionMm: [0, 11, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "carriage_front", positionMm: [0, -11, 0], quatWxyz: Q_ID }],
  });

  const pkgZScrew = buildPrimitivePartPackage({
    model: "龙门Z轴滚珠丝杠",
    revision: "G1",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 220, leadMm: 8, axis: "z", finish: "steel" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgZMotor = buildPrimitivePartPackage({
    model: "龙门Z轴伺服电机",
    revision: "G1",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 58, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "z", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgZCarriage = buildPrimitivePartPackage({
    model: "龙门Z向主轴滑枕",
    revision: "G1",
    primitive: { shape: "box", widthMm: 86, depthMm: 16, heightMm: 140, finish: "aluminum" },
    input: { positionMm: [0, 8, 45], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 0, 1], unit: "mm", range: [-110, 60] },
    extraOutputs: [{ id: "spindle_seat", positionMm: [0, -39, -115], quatWxyz: Q_ID }],
  });

  const pkgSpindle = buildPrimitivePartPackage({
    model: "ER16高速电主轴与立铣刀",
    revision: "G1",
    primitive: { shape: "spindle_cutter", bodyDiameterMm: 62, bodyLengthMm: 135, toolDiameterMm: 10, toolStickoutMm: 38, finish: "spindle_red" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
  });

  const pkgs = [
    pkgBase, pkgYRail, pkgYTable, pkgYScrew, pkgYMotor, pkgWorkpiece,
    pkgColumn, pkgGusset, pkgCrossbeam, pkgXRail, pkgXScrew, pkgXMotor,
    pkgXSaddle, pkgZRail, pkgZScrew, pkgZMotor, pkgZCarriage, pkgSpindle,
  ];

  const assembly: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "composable-gantry-mill",
    name: "双立柱龙门高刚性三轴铣床",
    nodes: [
      { id: "gantry_base", label: "一体式重型床身", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "y_rail", label: "Y 轴线性导轨", packageKey: packageKey(pkgYRail), parent: { node: "gantry_base", mount: "y_rail_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
      { id: "y_screw", label: "Y 轴滚珠丝杠", packageKey: packageKey(pkgYScrew), parent: { node: "gantry_base", mount: "y_screw_mount" }, explodeStep: 1, explodeVectorMm: [60, 0, 35], coupledTo: { path: "y_table", ratio: 45 } },
      { id: "y_motor", label: "Y 轴伺服电机", packageKey: packageKey(pkgYMotor), parent: { node: "gantry_base", mount: "y_motor_mount" }, explodeStep: 2, explodeVectorMm: [0, -80, 0] },
      { id: "y_table", label: "Y 轴载物工作台", packageKey: packageKey(pkgYTable), parent: { node: "y_rail", mount: "carriage_top" }, explodeStep: 2, explodeVectorMm: [0, 0, 65] },
      { id: "workpiece", label: "铝合金待铣毛坯", packageKey: packageKey(pkgWorkpiece), parent: { node: "y_table", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 85] },

      { id: "left_col", label: "左侧重型立柱 4080", packageKey: packageKey(pkgColumn), parent: { node: "gantry_base", mount: "left_col_mount" }, explodeStep: 1, explodeVectorMm: [-70, 50, 55] },
      { id: "right_col", label: "右侧重型立柱 4080", packageKey: packageKey(pkgColumn), parent: { node: "gantry_base", mount: "right_col_mount" }, explodeStep: 1, explodeVectorMm: [70, 50, 55] },
      { id: "left_gusset", label: "左立柱角件", packageKey: packageKey(pkgGusset), parent: { node: "gantry_base", mount: "left_gusset_mount" }, explodeStep: 1, explodeVectorMm: [-45, -40, 35] },
      { id: "right_gusset", label: "右立柱角件", packageKey: packageKey(pkgGusset), parent: { node: "gantry_base", mount: "right_gusset_mount" }, explodeStep: 1, explodeVectorMm: [45, -40, 35] },

      { id: "crossbeam", label: "龙门桥式横梁 4080", packageKey: packageKey(pkgCrossbeam), parent: { node: "left_col", mount: "beam_mount" }, explodeStep: 2, explodeVectorMm: [0, 0, 85] },
      { id: "x_rail", label: "X 轴线性导轨", packageKey: packageKey(pkgXRail), parent: { node: "crossbeam", mount: "x_rail_mount" }, explodeStep: 3, explodeVectorMm: [0, -55, 0] },
      { id: "x_screw", label: "X 轴滚珠丝杠", packageKey: packageKey(pkgXScrew), parent: { node: "crossbeam", mount: "x_screw_mount" }, explodeStep: 3, explodeVectorMm: [0, -45, 55], coupledTo: { path: "x_saddle", ratio: 45 } },
      { id: "x_motor", label: "X 轴伺服电机", packageKey: packageKey(pkgXMotor), parent: { node: "crossbeam", mount: "x_motor_mount" }, explodeStep: 3, explodeVectorMm: [85, 0, 0] },
      { id: "x_saddle", label: "横梁 X 向溜板", packageKey: packageKey(pkgXSaddle), parent: { node: "x_rail", mount: "carriage_front" }, explodeStep: 4, explodeVectorMm: [0, -65, 0] },

      { id: "z_rail", label: "Z 轴线性导轨", packageKey: packageKey(pkgZRail), parent: { node: "x_saddle", mount: "z_rail_mount" }, explodeStep: 5, explodeVectorMm: [0, -50, 0] },
      { id: "z_screw", label: "Z 轴滚珠丝杠", packageKey: packageKey(pkgZScrew), parent: { node: "x_saddle", mount: "z_screw_mount" }, explodeStep: 5, explodeVectorMm: [55, -35, 0], coupledTo: { path: "z_carriage", ratio: 45 } },
      { id: "z_motor", label: "Z 轴伺服电机", packageKey: packageKey(pkgZMotor), parent: { node: "x_saddle", mount: "z_motor_mount" }, explodeStep: 5, explodeVectorMm: [0, 0, 80] },
      { id: "z_carriage", label: "Z 向主轴滑枕", packageKey: packageKey(pkgZCarriage), parent: { node: "z_rail", mount: "carriage_front" }, explodeStep: 6, explodeVectorMm: [0, -60, 0] },
      { id: "spindle_unit", label: "ER16 电主轴与立铣刀", packageKey: packageKey(pkgSpindle), parent: { node: "z_carriage", mount: "spindle_seat" }, explodeStep: 6, explodeVectorMm: [0, -55, -55] },
    ],
    output: { node: "spindle_unit", mount: "tool_tip" },
    commands: { y_table: 0, x_saddle: 0, z_carriage: 0, spindle_unit: 0 },
  };

  let ws = parseWorkspace({ schemaVersion: 1, packages: [], instances: [], connections: [] });
  for (const pkg of pkgs) ws = installPackage(ws, pkg);
  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

export function loadShowroomExhibit(id: ShowroomExhibitId): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  if (id === "gantry-mill") return buildGantryMillTemplate();
  if (id === "articulated-arm") return createChallengeSolution("level-4-robot-arm");
  return buildComposableMiloMillTemplate();
}

// ==========================================
// 2. 四层功能解剖透视（用来点击分离并讲清楚物理角色）
// ==========================================

export type FunctionalLayerId = "skeleton" | "guide" | "transmission" | "actuator";

export interface FunctionalLayerDef {
  readonly id: FunctionalLayerId;
  readonly name: string;
  readonly badge: string;
  readonly roleSummary: string;
  readonly formulaText: string;
}

export const FUNCTIONAL_LAYERS: readonly FunctionalLayerDef[] = [
  {
    id: "skeleton",
    name: "刚性床身与支撑骨架",
    badge: "基础层",
    roleSummary: "承载一切静动态载荷，闭合门式（龙门）比悬臂式（C型）抗让刀变形能力高 2.5 倍以上。",
    formulaText: "δ = F_cut / k_frame",
  },
  {
    id: "guide",
    name: "导轨与运动副约束层",
    badge: "约束层",
    roleSummary: "用高刚性钢轨把运动自由度严格约束在单向直线或单轴回转，同时决定下游惯量负载。",
    formulaText: "自由度 DOF = ∑ 滑动副 + ∑ 旋转副",
  },
  {
    id: "transmission",
    name: "滚珠丝杠传动换算层",
    badge: "换算层",
    roleSummary: "导程 p 决定“旋转→直线”机械杠杆：导程越小推力越猛但速度上限降低；导程翻倍扭矩需求翻倍。",
    formulaText: "x = (θ / 360°) × p ,  F = 2π·η·T / p",
  },
  {
    id: "actuator",
    name: "伺服动力与主轴执行层",
    badge: "驱动层",
    roleSummary: "把电脉冲转化成电磁转矩，若负载惯量比 λ_J 过大或力矩超过额定值，就会产生显著过冲与拐角失圆。",
    formulaText: "λ_J = J_load / J_motor ,  T_req ≤ T_rated",
  },
];

export function classifyNodeFunctionalLayer(pkg?: DevicePackage): FunctionalLayerId {
  const shape = pkg?.primitive?.shape;
  if (shape === "linear_rail_block") return "guide";
  if (shape === "lead_screw") return "transmission";
  if (shape === "servo_motor_body" || shape === "spindle_cutter" || pkg?.primitive?.finish === "sensor_amber") {
    return "actuator";
  }
  if (pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type !== "fixed") {
    return "guide";
  }
  return "skeleton";
}

// ==========================================
// 3. 真实物理载荷、伺服匹配、刚度与 BOM 评估引擎
// ==========================================

export interface PhysicsWhatIfParams {
  readonly payloadMassKg?: number;
  readonly screwLeadOverrideMm?: number;
  readonly feedRateMmS?: number;
  readonly cuttingForceN?: number;
}

export interface AxisPhysicsStatus {
  readonly nodeId: string;
  readonly label: string;
  readonly axisKind: "x" | "y" | "z" | "hinge";
  readonly jointType: "slide" | "hinge";
  readonly carriedMassKg: number;
  readonly screwLeadMm: number;
  readonly hasMotor: boolean;
  readonly hasScrew: boolean;
  readonly motorRatedTorqueNm: number;
  readonly motorInertiaKgM2: number;
  readonly inertiaRatio: number;
  readonly requiredTorqueNm: number;
  readonly torqueUtilizationPct: number;
  readonly overloaded: boolean;
}

export interface MachinePhysicsReport {
  readonly totalMassKg: number;
  readonly totalCostCny: number;
  readonly axes: readonly AxisPhysicsStatus[];
  readonly peakTorquePct: number;
  readonly maxInertiaRatio: number;
  readonly thrustForceN: number;
  readonly cuttingForceN: number;
  readonly columnDeflectionUm: number;
  readonly columnCount: number;
  readonly gussetCount: number;
  readonly hasSpindle: boolean;
  readonly hasSensor: boolean;
  readonly hasWorkpiece: boolean;
  readonly overloadedNodeIds: readonly string[];
  readonly warnings: readonly string[];
}

function numericParam(pkg: DevicePackage | undefined, key: string): number | undefined {
  const entry = pkg?.parameters?.[key];
  return entry && entry.status !== "pending" && typeof entry.value === "number" ? entry.value : undefined;
}

export function estimatePartMassAndCost(pkg: DevicePackage | undefined): { massKg: number; costCny: number } {
  const paramMass = numericParam(pkg, "massKg");
  const spec = pkg?.primitive;
  if (!spec) {
    return { massKg: paramMass ?? 1.8, costCny: pkg?.modelBindings?.length ? 620 : 280 };
  }

  let volCm3 = 180;
  let densityGcm3 = spec.finish === "steel" || spec.finish === "brass" ? 7.8 : 2.7;
  let costCny = 120;

  switch (spec.shape) {
    case "extrusion_profile": {
      const secAreaMm2 = spec.series.startsWith("4080")
        ? 1120
        : spec.series === "4040" || spec.series === "2080"
          ? 640
          : 220;
      volCm3 = (secAreaMm2 * spec.lengthMm) / 1000;
      costCny = 35 + spec.lengthMm * (spec.series.startsWith("40") ? 0.38 : 0.24);
      break;
    }
    case "plate":
    case "box": {
      const [dx, dy, dz] = primitiveBoundingBoxMm(spec);
      volCm3 = (dx * dy * dz) / 1000;
      costCny = spec.finish === "sensor_amber" ? 95 : spec.finish === "workpiece_alloy" ? 45 : 40 + volCm3 * 0.19;
      if (spec.finish === "sensor_amber") {
        densityGcm3 = 1.4;
      }
      break;
    }
    case "angle_bracket":
      volCm3 = 120;
      costCny = 48;
      break;
    case "cylinder":
    case "tube": {
      const [dx, dy, dz] = primitiveBoundingBoxMm(spec);
      volCm3 = (Math.PI * (Math.min(dx, dy) / 2) ** 2 * Math.max(dx, dy, dz)) / 2000;
      costCny = 65 + Math.max(dx, dy, dz) * 0.35;
      break;
    }
    case "linear_rail_block":
      densityGcm3 = 7.8;
      volCm3 = (spec.railLengthMm * 14 * 12) / 1000 + 85;
      costCny = 180 + spec.railLengthMm * 0.72;
      break;
    case "lead_screw":
      densityGcm3 = 7.8;
      volCm3 = (Math.PI * (spec.diameterMm / 2) ** 2 * spec.lengthMm) / 1000;
      costCny = 160 + spec.lengthMm * 0.58;
      break;
    case "servo_motor_body":
      densityGcm3 = 5.2;
      volCm3 = 420;
      costCny = pkg?.modelBindings?.length ? 780 : 540;
      break;
    case "spindle_cutter":
      densityGcm3 = 6.2;
      volCm3 = 560;
      costCny = 1180;
      break;
    case "bearing_pillow":
      volCm3 = 75;
      costCny = 65;
      break;
    case "sphere":
      densityGcm3 = spec.finish === "pearl_crimson" ? 2.4 : 2.7;
      volCm3 = ((4 / 3) * Math.PI * spec.radiusMm ** 3) / 1000;
      costCny = 95 + volCm3 * 0.28;
      break;
    case "cone":
      densityGcm3 = spec.finish === "aerospace_white" ? 1.95 : 2.7;
      volCm3 = (Math.PI * spec.lengthMm * (spec.radiusBottomMm ** 2 + spec.radiusBottomMm * spec.radiusTopMm + spec.radiusTopMm ** 2)) / 3000;
      costCny = 110 + volCm3 * 0.3;
      break;
    case "external_mesh":
      volCm3 = 300;
      costCny = 260;
      break;
  }

  return {
    massKg: Number((paramMass ?? clamp((volCm3 * densityGcm3) / 1000, 0.15, 65)).toFixed(2)),
    costCny: Math.round(costCny),
  };
}

export function analyzeMachinePhysics(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  params?: PhysicsWhatIfParams,
): MachinePhysicsReport {
  if (assembly.nodes.length === 0) {
    return {
      totalMassKg: 0,
      totalCostCny: 0,
      axes: [],
      peakTorquePct: 0,
      maxInertiaRatio: 1,
      thrustForceN: 0,
      cuttingForceN: 0,
      columnDeflectionUm: 0,
      columnCount: 0,
      gussetCount: 0,
      hasSpindle: false,
      hasSensor: false,
      hasWorkpiece: false,
      overloadedNodeIds: [],
      warnings: [],
    };
  }
  const pkgByKey = new Map(ws.packages.map((p) => [packageKey(p), p]));
  const childrenMap = new Map<string, string[]>();
  const massById = new Map<string, number>();

  let totalMassKg = 0;
  let totalCostCny = 0;
  let columnCount = 0;
  let columnStiffnessSum = 0;
  let gussetCount = 0;
  let hasSpindle = false;
  let hasSensor = false;
  let hasWorkpiece = false;

  for (const node of assembly.nodes) {
    const pkg = pkgByKey.get(node.packageKey);
    const est = estimatePartMassAndCost(pkg);
    const idLow = node.id.toLowerCase();
    const label = (node.label ?? "").toLowerCase();
    const isPayloadCarrier =
      pkg?.primitive?.finish === "workpiece_alloy" ||
      idLow.includes("workpiece") ||
      label.includes("毛坯") ||
      node.id === assembly.output.node;
    const extraMass = isPayloadCarrier && params?.payloadMassKg ? params.payloadMassKg : 0;
    const nodeMass = est.massKg + extraMass;

    massById.set(node.id, nodeMass);
    totalMassKg += nodeMass;
    totalCostCny += est.costCny;

    if (node.parent) {
      const arr = childrenMap.get(node.parent.node);
      if (arr) arr.push(node.id);
      else childrenMap.set(node.parent.node, [node.id]);
    }

    const spec = pkg?.primitive;
    if (spec?.shape === "spindle_cutter") hasSpindle = true;
    if (spec?.finish === "sensor_amber" || idLow.includes("limit") || label.includes("限位")) hasSensor = true;
    if (spec?.finish === "workpiece_alloy" || idLow.includes("workpiece") || label.includes("毛坯")) hasWorkpiece = true;
    if (spec?.shape === "angle_bracket") gussetCount++;
    if (spec?.shape === "extrusion_profile" && spec.axis === "z") {
      columnCount++;
      const seriesFactor =
        spec.series === "4080" ? 2.1 : spec.series === "4040" ? 1.4 : spec.series === "2080" ? 1.1 : 0.72;
      columnStiffnessSum += seriesFactor * (380 / Math.max(200, spec.lengthMm));
    }
  }

  function subtreeMass(rootId: string): number {
    let sum = massById.get(rootId) ?? 1;
    const stack = [...(childrenMap.get(rootId) ?? [])];
    const seen = new Set([rootId]);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      sum += massById.get(cur) ?? 0.5;
      for (const ch of childrenMap.get(cur) ?? []) stack.push(ch);
    }
    return sum;
  }

  const feedRateMmS = clamp(params?.feedRateMmS ?? 28, 4, 180);
  const cuttingForceN = params?.cuttingForceN ?? (hasSpindle ? clamp(16 + feedRateMmS * 0.48, 12, 190) : 14);

  const motorNodes = assembly.nodes.filter((n) => pkgByKey.get(n.packageKey)?.primitive?.shape === "servo_motor_body");
  const screwNodes = assembly.nodes.filter((n) => pkgByKey.get(n.packageKey)?.primitive?.shape === "lead_screw");

  const axes: AxisPhysicsStatus[] = [];
  const overloadedNodeIds: string[] = [];

  for (const node of assembly.nodes) {
    if (node.coupledTo) continue;
    const pkg = pkgByKey.get(node.packageKey);
    const joint = pkg?.mechanics?.kind === "part" ? pkg.mechanics.joint : undefined;
    if (!joint || joint.type === "fixed") continue;
    if (pkg?.primitive?.shape === "spindle_cutter") continue;

    const axisKind: AxisPhysicsStatus["axisKind"] =
      joint.type === "hinge"
        ? "hinge"
        : Math.abs(joint.axis[0]) > 0.5
          ? "x"
          : Math.abs(joint.axis[1]) > 0.5
            ? "y"
            : "z";

    const carriedMassKg = Number(subtreeMass(node.id).toFixed(2));
    const coupledScrew = screwNodes.find((s) => s.coupledTo?.path === node.id);
    const matchingMotor = motorNodes.find((m) => {
      const mp = pkgByKey.get(m.packageKey);
      const ax = mp?.primitive && "axis" in mp.primitive ? mp.primitive.axis : undefined;
      return m.parent?.node === node.parent?.node || ax === axisKind;
    });

    const screwPkg = coupledScrew ? pkgByKey.get(coupledScrew.packageKey) : undefined;
    const screwLeadRaw =
      params?.screwLeadOverrideMm ??
      numericParam(screwPkg, "leadMmPerRev") ??
      (screwPkg?.primitive?.shape === "lead_screw" ? screwPkg.primitive.leadMm : 8);
    const screwLeadMm = clamp(screwLeadRaw, 2, 40);

    const hasMotor = Boolean(matchingMotor) || motorNodes.length > 0;
    const motorPkg = matchingMotor ? pkgByKey.get(matchingMotor.packageKey) : motorNodes[0] ? pkgByKey.get(motorNodes[0].packageKey) : undefined;
    const motorRatedTorqueNm =
      numericParam(motorPkg, "ratedTorqueNm") ??
      (joint.type === "hinge" ? 3.8 : hasMotor ? 1.27 : 0.52);
    const motorInertiaKgM2 = numericParam(motorPkg, "rotorInertiaKgM2") ?? 0.000026;

    const leadM = screwLeadMm / 1000;
    const peakAccelMs2 = clamp(feedRateMmS * 0.068, 0.9, 8.5);

    let inertiaRatio: number;
    let requiredTorqueNm: number;
    if (joint.type === "slide") {
      const jLoad = carriedMassKg * (leadM / (2 * Math.PI)) ** 2 + 0.000009;
      inertiaRatio = jLoad / motorInertiaKgM2;
      const gravityN = axisKind === "z" ? carriedMassKg * 9.81 : carriedMassKg * 9.81 * 0.06;
      const fThrust = carriedMassKg * peakAccelMs2 + gravityN + 0.65 * cuttingForceN;
      const angularAccelRadS2 = (peakAccelMs2 * 2 * Math.PI) / leadM;
      requiredTorqueNm = (fThrust * leadM) / (2 * Math.PI * 0.9) + (motorInertiaKgM2 + jLoad) * angularAccelRadS2;
    } else {
      const jArm = carriedMassKg * 0.14 * 0.14 + 0.00018;
      inertiaRatio = (jArm / 50) / motorInertiaKgM2;
      const isVerticalPitch = Math.abs(joint.axis[0]) > 0.3 || Math.abs(joint.axis[1]) > 0.3;
      const gravityTorque = isVerticalPitch ? carriedMassKg * 9.81 * 0.12 : 0.08;
      requiredTorqueNm = gravityTorque + jArm * 2.2;
    }

    const torqueUtilizationPct = Number(((requiredTorqueNm / motorRatedTorqueNm) * 100).toFixed(1));
    const overloaded = torqueUtilizationPct > 100;
    if (overloaded) {
      overloadedNodeIds.push(matchingMotor?.id ?? node.id);
    }

    axes.push({
      nodeId: node.id,
      label: node.label ?? node.id,
      axisKind,
      jointType: joint.type,
      carriedMassKg,
      screwLeadMm,
      hasMotor,
      hasScrew: Boolean(coupledScrew),
      motorRatedTorqueNm,
      motorInertiaKgM2,
      inertiaRatio: Number(inertiaRatio.toFixed(1)),
      requiredTorqueNm: Number(requiredTorqueNm.toFixed(2)),
      torqueUtilizationPct,
      overloaded,
    });
  }

  // Portal closed frame multiplies stiffness strongly compared with single cantilever column
  const gantryFactor = columnCount >= 2 ? 2.6 : columnCount === 1 ? 1.0 : 0.55;
  const effectiveStiffnessNPerMm = Math.max(160, (columnStiffnessSum || 1.1) * 420 * gantryFactor * (1 + gussetCount * 0.28));
  const columnDeflectionUm = Number(((cuttingForceN / effectiveStiffnessNPerMm) * 1000).toFixed(1));

  const peakTorquePct = axes.length ? Math.max(...axes.map((a) => a.torqueUtilizationPct)) : 0;
  const maxInertiaRatio = axes.length ? Math.max(...axes.map((a) => a.inertiaRatio)) : 1;
  const thrustForceN = Number((cuttingForceN + (totalMassKg * feedRateMmS) / 40).toFixed(1));

  const warnings: string[] = [];
  if (peakTorquePct > 100) {
    warnings.push(`电机过载报警（峰值转矩负荷 ${peakTorquePct.toFixed(0)}%）：建议减小丝杠导程、降低配重或升级高功率电机。`);
  }
  if (maxInertiaRatio > 8) {
    warnings.push(`负载惯量比过高 (${maxInertiaRatio.toFixed(1)} : 1)，高速拐角易出现显著过冲与失圆。`);
  }
  if (hasSpindle && columnDeflectionUm > 48) {
    warnings.push(`立柱悬臂让刀变形偏大 (${columnDeflectionUm} μm)：建议增加 L 型角件或改为双立柱龙门结构。`);
  }

  return {
    totalMassKg: Number(totalMassKg.toFixed(2)),
    totalCostCny,
    axes,
    peakTorquePct: Number(peakTorquePct.toFixed(1)),
    maxInertiaRatio: Number(maxInertiaRatio.toFixed(1)),
    thrustForceN,
    cuttingForceN: Number(cuttingForceN.toFixed(1)),
    columnDeflectionUm,
    columnCount,
    gussetCount,
    hasSpindle,
    hasSensor,
    hasWorkpiece,
    overloadedNodeIds,
    warnings,
  };
}

// ==========================================
// 4. 时域闭环动力学试切 + 三维毛坯真削模拟与验收分级
// ==========================================

export type TrialMode = "milling-pocket" | "xy-circle" | "step-axis" | "arm-orbit";
export type TrialGrade = "S" | "A" | "B" | "FAIL";

export interface TrialFrame {
  readonly timeS: number;
  readonly commands: Record<string, number>;
  readonly tipWorldMm: readonly [number, number, number];
  readonly tipWorkpieceMm: readonly [number, number, number];
  readonly trackingErrorMm: number;
}

export interface TrialVerdict {
  readonly passed: boolean;
  readonly grade: TrialGrade;
  readonly headline: string;
  readonly maxContourErrorMm: number;
  readonly peakTorquePct: number;
  readonly deflectionUm: number;
  readonly costCny: number;
  readonly checks: ReadonlyArray<{ readonly label: string; readonly passed: boolean; readonly valueText: string }>;
  readonly diagnosis: string;
}

export interface MachineTrialSimulation {
  readonly mode: TrialMode;
  readonly durationS: number;
  readonly frames: readonly TrialFrame[];
  readonly idealTrailMm: readonly (readonly [number, number, number])[];
  readonly actualTrailMm: readonly (readonly [number, number, number])[];
  readonly trailInWorkpieceFrame: boolean;
  readonly workpieceCutSamples: readonly { readonly timeS: number; readonly actualMm: MiloVec3 }[];
  readonly stockStates: readonly MiloStockState[];
  readonly physics: MachinePhysicsReport;
  readonly verdict: TrialVerdict;
}

function buildAncestorSet(assembly: MechanicalAssembly, targetId: string | undefined): Set<string> {
  const out = new Set<string>();
  const byId = new Map(assembly.nodes.map((n) => [n.id, n]));
  let cur = targetId;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = byId.get(cur)?.parent?.node;
  }
  return out;
}

function findWorkpieceTopMatrix(ws: TwinWorkspace, solved: ArticulatedSolveResult, assembly: MechanicalAssembly): Matrix4 | null {
  const wpSolved = solved.nodes.find((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    const idL = n.id.toLowerCase();
    const lbL = n.label.toLowerCase();
    return pkg?.primitive?.finish === "workpiece_alloy" || idL.includes("workpiece") || lbL.includes("毛坯") || lbL.includes("工件");
  });
  if (!wpSolved) return null;
  const raw = assembly.nodes.find((n) => n.id === wpSolved.id);
  const pkg = raw ? ws.packages.find((p) => packageKey(p) === raw.packageKey) : undefined;
  const top = pkg?.mechanics?.kind === "part" ? pkg.mechanics.outputs.find((o) => o.id === "top") : undefined;
  const mat = wpSolved.assembledMatrix.clone();
  if (!top) return mat;
  const [tw, tx, ty, tz] = top.quatWxyz;
  return mat.multiply(
    new Matrix4().compose(new Vector3(...top.positionMm), new Quaternion(tx, ty, tz, tw).normalize(), new Vector3(1, 1, 1)),
  );
}

/**
 * 依据当前物理结构实时运行完整闭环轨迹与 3D 铝坯切削，输出高精度几何反馈及工程验收等级（S/A/B/FAIL）。
 */
export function simulateMachineTrial(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  mode: TrialMode,
  params?: PhysicsWhatIfParams,
): MachineTrialSimulation {
  const physics = analyzeMachinePhysics(ws, assembly, params);
  const homeSolved = solveArticulatedAssembly(ws, assembly, { commandOverrides: {} });

  const slideX = homeSolved.activeControls.find((c) => c.joint.type === "slide" && Math.abs(c.joint.axis[0]) > 0.5);
  const slideY = homeSolved.activeControls.find((c) => c.joint.type === "slide" && Math.abs(c.joint.axis[1]) > 0.5);
  const slideZ = homeSolved.activeControls.find((c) => c.joint.type === "slide" && Math.abs(c.joint.axis[2]) > 0.5);
  const hinges = homeSolved.activeControls.filter((c) => {
    const p = ws.packages.find((pkg) => packageKey(pkg) === assembly.nodes.find((n) => n.id === c.path)?.packageKey);
    return c.joint.type === "hinge" && p?.primitive?.shape !== "spindle_cutter";
  });
  const spindleCtrl = homeSolved.activeControls.find((c) => {
    const p = ws.packages.find((pkg) => packageKey(pkg) === assembly.nodes.find((n) => n.id === c.path)?.packageKey);
    return p?.primitive?.shape === "spindle_cutter";
  });

  const wpNode = assembly.nodes.find((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    return pkg?.primitive?.finish === "workpiece_alloy" || n.id.toLowerCase().includes("workpiece");
  });
  const wpPkg = wpNode ? ws.packages.find((p) => packageKey(p) === wpNode.packageKey) : undefined;
  const wpDims = wpPkg?.primitive ? primitiveBoundingBoxMm(wpPkg.primitive) : ([110, 90, 26] as const);
  const wpAncestors = buildAncestorSet(assembly, wpNode?.id);

  const wpHomeMatrix = findWorkpieceTopMatrix(ws, homeSolved, assembly);
  const wpHomeOrigin = wpHomeMatrix ? new Vector3().setFromMatrixPosition(wpHomeMatrix) : new Vector3(0, 0, 50);
  const tipHomeOrigin = new Vector3(...homeSolved.observationPointMm);
  const homeDelta = tipHomeOrigin.clone().sub(wpHomeOrigin);

  const statFor = (path?: string) => physics.axes.find((a) => a.nodeId === path);
  const xStat = statFor(slideX?.path);
  const yStat = statFor(slideY?.path);
  const zStat = statFor(slideZ?.path);

  // Servo lag grows naturally with reflected inertia & overload saturation
  const tauOf = (st?: AxisPhysicsStatus) => {
    if (!st) return 0.015;
    const base = 0.014 + 0.018 * Math.max(0, st.inertiaRatio - 1.5);
    const sat = st.torqueUtilizationPct > 100 ? 0.085 * ((st.torqueUtilizationPct - 100) / 40) : 0;
    return clamp(base + sat, 0.012, 0.24);
  };

  const durationS = mode === "step-axis" ? 3.2 : 6.4;
  const dt = 0.05;
  const nSteps = Math.round(durationS / dt);
  const feedRate = clamp(params?.feedRateMmS ?? 28, 8, 160);
  const angularFreq = clamp(1.15 * (feedRate / 28), 0.55, 3.6);
  const cutDepthMm = clamp(Math.min(5.5, wpDims[2] * 0.42), 2.5, 5.5);
  const deflMm = physics.columnDeflectionUm / 1000;

  let curX = 0;
  let curY = 0;
  let curZ = 0;
  let curH = hinges.map(() => 0);

  const xSign = slideX && wpAncestors.has(slideX.path) ? -1 : 1;
  const ySign = slideY && wpAncestors.has(slideY.path) ? -1 : 1;
  const zSign = slideZ && wpAncestors.has(slideZ.path) ? -1 : 1;

  const idealTrailMm: [number, number, number][] = [];
  const actualTrailMm: [number, number, number][] = [];
  const workpieceCutSamples: { timeS: number; actualMm: MiloVec3 }[] = [];
  const frames: TrialFrame[] = [];

  const circleRadiiErrs: number[] = [];
  let maxReachX = 0;
  const armPoints: Vector3[] = [];

  for (let i = 0; i <= nSteps; i++) {
    const t = Number((i * dt).toFixed(3));
    let targetRel: [number, number, number] = [0, 0, 0];
    let targetHinges = curH.map(() => 0);

    if (mode === "step-axis") {
      const targetX = t < 0.25 ? 0 : 100;
      targetRel = [targetX, 0, 0];
      idealTrailMm.push([targetX, 0, wpHomeOrigin.z]);
    } else if (mode === "xy-circle") {
      const R = 28;
      const theta = angularFreq * t * 1.45;
      targetRel = [R * Math.cos(theta), R * Math.sin(theta), 0];
      idealTrailMm.push([targetRel[0], targetRel[1], wpHomeOrigin.z + 2]);
    } else if (mode === "milling-pocket") {
      const plungeEnd = 1.4;
      const innerEnd = 3.2;
      const outerEnd = 5.6;
      const speedMul = clamp(feedRate / 28, 0.7, 2.2);
      const tEff = Math.min(durationS, t * (0.85 + 0.15 * speedMul));
      if (tEff < plungeEnd) {
        const u = tEff / plungeEnd;
        const r = 4 * u;
        const ang = u * Math.PI * 3;
        targetRel = [r * Math.cos(ang), r * Math.sin(ang), -cutDepthMm * u];
      } else if (tEff < innerEnd) {
        const u = (tEff - plungeEnd) / (innerEnd - plungeEnd);
        const r = 4 + 5 * u;
        const ang = u * Math.PI * 2;
        targetRel = [r * Math.cos(ang), r * Math.sin(ang), -cutDepthMm];
      } else if (tEff < outerEnd) {
        const u = (tEff - innerEnd) / (outerEnd - innerEnd);
        const r = 16;
        const ang = u * Math.PI * 2.15;
        targetRel = [r * Math.cos(ang), r * Math.sin(ang), -cutDepthMm];
      } else {
        const u = (tEff - outerEnd) / Math.max(0.4, durationS - outerEnd);
        targetRel = [16, 0, -cutDepthMm * (1 - clamp(u, 0, 1)) + 12 * clamp(u, 0, 1)];
      }
      idealTrailMm.push([targetRel[0], targetRel[1], targetRel[2]]);
    } else {
      // arm-orbit
      targetHinges = hinges.map((_h, idx) => {
        if (idx === 0) return Math.sin(t * 0.95) * 65;
        if (idx === 1) return 28 + 18 * Math.cos(t * 1.25);
        return 35 + 22 * Math.sin(t * 1.5);
      });
    }

    // Sub-step first-order + inertia-induced oscillatory lag integration
    const tauX = tauOf(xStat);
    const tauY = tauOf(yStat);
    const tauZ = tauOf(zStat);

    const desCmdX = slideX ? xSign * (targetRel[0] - homeDelta.x) : 0;
    const desCmdY = slideY ? ySign * (targetRel[1] - homeDelta.y) : 0;
    const desCmdZ = slideZ ? zSign * (targetRel[2] - homeDelta.z) : 0;

    // Steady deflection shifts tool slightly opposite cutting motion
    const vxSign = mode === "milling-pocket" && targetRel[2] < -0.2 ? Math.sign(-Math.sin(t * 2.2)) : 0;
    const vySign = mode === "milling-pocket" && targetRel[2] < -0.2 ? Math.sign(Math.cos(t * 2.2)) : 0;

    const alphaX = clamp(dt / tauX, 0.08, 0.96);
    const alphaY = clamp(dt / tauY, 0.08, 0.96);
    const alphaZ = clamp(dt / tauZ, 0.12, 0.96);

    curX += (desCmdX - curX) * alphaX + deflMm * 1.15 * vxSign;
    curY += (desCmdY - curY) * alphaY + deflMm * 1.15 * vySign;
    curZ += (desCmdZ - curZ) * alphaZ;
    curH = curH.map((val, idx) => {
      const st = statFor(hinges[idx]?.path);
      const a = clamp(dt / tauOf(st), 0.1, 0.96);
      return val + (targetHinges[idx]! - val) * a;
    });

    const cmds: Record<string, number> = {};
    if (slideX) cmds[slideX.path] = clamp(curX, slideX.joint.range[0], slideX.joint.range[1]);
    if (slideY) cmds[slideY.path] = clamp(curY, slideY.joint.range[0], slideY.joint.range[1]);
    if (slideZ) cmds[slideZ.path] = clamp(curZ, slideZ.joint.range[0], slideZ.joint.range[1]);
    hinges.forEach((h, idx) => {
      cmds[h.path] = clamp(curH[idx]!, h.joint.range[0], h.joint.range[1]);
    });
    if (spindleCtrl) cmds[spindleCtrl.path] = t * 1440;

    const solved = solveArticulatedAssembly(ws, assembly, { commandOverrides: cmds });
    const tipWorld = new Vector3(...solved.observationPointMm);
    const curWpMat = findWorkpieceTopMatrix(ws, solved, assembly);
    const tipWp = curWpMat ? tipWorld.clone().applyMatrix4(curWpMat.clone().invert()) : tipWorld.clone().sub(wpHomeOrigin);

    if (mode === "milling-pocket") {
      actualTrailMm.push([tipWp.x, tipWp.y, tipWp.z]);
      const sx = 37.5 + (tipWp.x * 75) / wpDims[0];
      const sy = 30 + (tipWp.y * 60) / wpDims[1];
      const sz = (tipWp.z * 10) / wpDims[2];
      workpieceCutSamples.push({ timeS: t, actualMm: [sx, sy, sz] });
      if (t >= 3.4 && t <= 5.5) {
        circleRadiiErrs.push(Math.abs(Math.hypot(tipWp.x, tipWp.y) - 16));
      }
    } else if (mode === "xy-circle") {
      actualTrailMm.push([tipWp.x, tipWp.y, wpHomeOrigin.z + 2]);
      if (i > 12) {
        circleRadiiErrs.push(Math.abs(Math.hypot(tipWp.x, tipWp.y) - 28));
      }
    } else if (mode === "step-axis") {
      const primaryVal = (slideX ? cmds[slideX.path] : slideY ? cmds[slideY.path] : 0) ?? 0;
      maxReachX = Math.max(maxReachX, Math.abs(primaryVal));
      actualTrailMm.push([primaryVal, 0, wpHomeOrigin.z]);
    } else {
      idealTrailMm.push([tipWorld.x, tipWorld.y, tipWorld.z]);
      actualTrailMm.push([tipWorld.x, tipWorld.y, tipWorld.z]);
      armPoints.push(tipWorld);
    }

    const err = Math.hypot(tipWp.x - targetRel[0], tipWp.y - targetRel[1]);
    frames.push({
      timeS: t,
      commands: cmds,
      tipWorldMm: [tipWorld.x, tipWorld.y, tipWorld.z],
      tipWorkpieceMm: [tipWp.x, tipWp.y, tipWp.z],
      trackingErrorMm: Number(err.toFixed(3)),
    });
  }

  // Compute real 3D voxel milling states at key steps + sample indices
  const stockStates: MiloStockState[] = [];
  if (mode === "milling-pocket" && workpieceCutSamples.length >= 2) {
    const pb = createFeedbackStockPlayback(workpieceCutSamples);
    for (const f of frames) {
      stockStates.push(pb.seek(f.timeS));
    }
  }

  const maxContourErrorMm =
    circleRadiiErrs.length > 0 ? Number(Math.max(...circleRadiiErrs).toFixed(2)) : Number((deflMm * 4).toFixed(2));

  // Grade trial using physics + real trajectory errors
  const checks: Array<{ readonly label: string; readonly passed: boolean; readonly valueText: string }> = [];
  let passed = false;
  let grade: TrialGrade = "FAIL";
  let headline = "";
  let diagnosis = "";

  if (mode === "step-axis") {
    const hasSlide = Boolean(slideX || slideY || slideZ);
    const reached100 = maxReachX >= 96;
    const noOverload = physics.peakTorquePct <= 100;
    const hasProtection = physics.hasSensor;
    checks.push(
      { label: "配置直线进给导轨与滑台", passed: hasSlide, valueText: hasSlide ? "已装配" : "缺失" },
      { label: "行程精准抵达 ≥ +96 mm", passed: reached100, valueText: `${maxReachX.toFixed(1)} mm` },
      { label: "伺服扭矩未过载 (≤ 100%)", passed: noOverload, valueText: `${physics.peakTorquePct.toFixed(0)}%` },
      { label: "装配限位接近开关安全保护", passed: hasProtection, valueText: hasProtection ? "正常接入" : "缺限位开关" },
    );
    passed = hasSlide && reached100 && noOverload && hasProtection;
    grade = !passed ? "FAIL" : physics.peakTorquePct <= 55 ? "S" : physics.peakTorquePct <= 82 ? "A" : "B";
    headline = passed
      ? `单轴进给测试通过（评级 ${grade}）：已封装解锁【📦 直线进给模组】`
      : "单轴试机未达标：请补齐直线滑台、伺服电机或限位开关并确保电机未过载";
    diagnosis = physics.warnings[0] || (passed ? "结构刚性良好、限位信号就绪，可直接把当前单轴封装为可复用模块化积木！" : checks.find((c) => !c.passed)!.label);
  } else if (mode === "xy-circle") {
    const hasXY = Boolean(slideX && slideY);
    const circleOk = hasXY && maxContourErrorMm <= 2.4;
    const inertiaOk = physics.maxInertiaRatio <= 10;
    checks.push(
      { label: "X / Y 双向直线导轨正交齐备", passed: hasXY, valueText: hasXY ? "双轴就绪" : "缺X或Y轴" },
      { label: "圆弧插补最大轮廓误差 ≤ 2.4 mm", passed: circleOk, valueText: `±${maxContourErrorMm} mm` },
      { label: "两轴峰值扭矩负荷 ≤ 100%", passed: physics.peakTorquePct <= 100, valueText: `${physics.peakTorquePct.toFixed(0)}%` },
      { label: "负载惯量比抑制过冲 (≤ 10:1)", passed: inertiaOk, valueText: `${physics.maxInertiaRatio}:1` },
    );
    passed = hasXY && circleOk && physics.peakTorquePct <= 100;
    grade = !passed ? "FAIL" : maxContourErrorMm <= 0.65 && inertiaOk ? "S" : maxContourErrorMm <= 1.35 ? "A" : "B";
    headline = passed
      ? `平面插补圆度验证通过（评级 ${grade}）：解锁【📦 十字工作台总成】及立柱主轴！`
      : "平面圆弧插补不合格：存在缺失轴或惯量过载导致画圆严重失真";
    diagnosis = physics.warnings[0] || (passed ? "X/Y 两轴动态响应同步性优异，圆度精度满足机床底座标准。" : "检查 X/Y 是否各带滚珠丝杠与伺服电机，避免高惯量比。");
  } else if (mode === "milling-pocket") {
    const hasXYZ = Boolean(slideX && slideY && slideZ);
    const hasCutters = physics.hasSpindle && physics.hasWorkpiece;
    const removedMm3 = stockStates.at(-1)?.removedVolumeMm3 ?? 0;
    const contourOk = maxContourErrorMm <= 1.65 && removedMm3 >= 400;
    const stiffnessOk = physics.columnDeflectionUm <= 55;
    checks.push(
      { label: "X / Y / Z 三轴运动链完整", passed: hasXYZ, valueText: hasXYZ ? "三轴联动" : "轴数不足" },
      { label: "装配电主轴铣刀与铝合金毛坯", passed: hasCutters, valueText: hasCutters ? `切屑去除 ${Math.round(removedMm3)} mm³` : "缺主轴或毛坯" },
      { label: "立柱让刀弹性变形 ≤ 55 μm", passed: stiffnessOk, valueText: `${physics.columnDeflectionUm} μm` },
      { label: "圆槽轮廓加工误差 ≤ 1.65 mm", passed: contourOk, valueText: `±${maxContourErrorMm} mm` },
    );
    passed = hasXYZ && hasCutters && stiffnessOk && contourOk && physics.peakTorquePct <= 100;
    grade = !passed
      ? "FAIL"
      : maxContourErrorMm <= 0.55 && physics.columnDeflectionUm <= 12 && physics.totalCostCny <= 8500
        ? "S"
        : maxContourErrorMm <= 0.95
          ? "A"
          : "B";
    headline = passed
      ? `实切铝合金毛坯验收通过（评级 ${grade}）：切出 ${Math.round(removedMm3)} mm³ 精密圆槽！`
      : "试切验收未通过：未能有效切削毛坯，或立柱让刀 / 轮廓精度超差";
    diagnosis =
      physics.warnings[0] ||
      (passed
        ? `当前构型下立柱变形仅 ${physics.columnDeflectionUm} μm，物料成本 ¥${physics.totalCostCny}。加装双立柱或 L 型加强筋可冲刺 S 级刚度！`
        : checks.find((c) => !c.passed)!.label);
  } else {
    // arm-orbit
    let spanMm = 0;
    for (let a = 0; a < armPoints.length; a += 4) {
      for (let b = a + 4; b < armPoints.length; b += 4) {
        spanMm = Math.max(spanMm, armPoints[a]!.distanceTo(armPoints[b]!));
      }
    }
    const hingeCount = hinges.length;
    passed = hingeCount >= 2 && spanMm >= 140 && physics.peakTorquePct <= 105;
    grade = !passed ? "FAIL" : hingeCount >= 3 && spanMm >= 220 && physics.peakTorquePct <= 75 ? "S" : "A";
    checks.push(
      { label: "串联 ≥ 2 个可动关节 (机械臂/复合多轴)", passed: hingeCount >= 2, valueText: `${hingeCount} 轴` },
      { label: "空间可达包络跨度 ≥ 140 mm", passed: spanMm >= 140, valueText: `${Math.round(spanMm)} mm` },
      { label: "重力臂平衡与扭矩余量", passed: physics.peakTorquePct <= 105, valueText: `${physics.peakTorquePct.toFixed(0)}%` },
    );
    headline = passed
      ? `万物同源多轴机构验收通过（评级 ${grade}）：已验证空间扫掠范围 ${Math.round(spanMm)} mm`
      : "多轴机构包络范围不足或关节力矩过载";
    diagnosis = passed
      ? "已彻底解锁全部高阶组件，可自由创造任意不存在的专机与机器人！"
      : "尝试在底座叠加回转关节与两段臂杆以扩展作业空间。";
  }

  return {
    mode,
    durationS,
    frames,
    idealTrailMm,
    actualTrailMm,
    trailInWorkpieceFrame: mode === "milling-pocket" || mode === "xy-circle",
    workpieceCutSamples,
    stockStates,
    physics,
    verdict: {
      passed,
      grade,
      headline,
      maxContourErrorMm,
      peakTorquePct: physics.peakTorquePct,
      deflectionUm: physics.columnDeflectionUm,
      costCny: physics.totalCostCny,
      checks,
      diagnosis,
    },
  };
}

// ==========================================
// 5. 《图灵完备》式模块化封装与演进委托定义
// ==========================================

export interface ModuleBlueprintDef {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly unlockedBy?: CommissionId;
  readonly buildFn: () => { workspace: TwinWorkspace; assembly: MechanicalAssembly };
}

export interface CustomModuleRecord {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly nodeCount: number;
  readonly workspace: TwinWorkspace;
  readonly assembly: MechanicalAssembly;
}

export type CommissionId = "comm-1-axis" | "comm-2-xy" | "comm-3-mill" | "comm-4-omni";

export interface EvolutionCommissionDef {
  readonly id: CommissionId;
  readonly badge: string;
  readonly title: string;
  readonly clientBrief: string;
  readonly trialMode: TrialMode;
  readonly trialButtonLabel: string;
  readonly rewardText: string;
  readonly unlockedBlockIds: readonly string[];
  readonly unlockedModuleIds: readonly string[];
  readonly stepsHint: readonly string[];
}

function makeLinearAxisModule(axis: "x" | "y" | "z"): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const isZ = axis === "z";
  const baseSeries = isZ ? "4080" : "2080";
  const pkgBase = buildPrimitivePartPackage({
    model: `${axis.toUpperCase()}轴进给基梁 (${baseSeries})`,
    revision: "M1",
    primitive: { shape: "extrusion_profile", series: baseSeries, lengthMm: isZ ? 280 : 340, axis, finish: "anodized_black" },
    extraOutputs: isZ
      ? [
          { id: "rail_seat", positionMm: [0, -20, 0], quatWxyz: Q_ID },
          { id: "screw_seat", positionMm: [42, -32, 0], quatWxyz: Q_ID },
          { id: "motor_seat", positionMm: [42, -32, 162], quatWxyz: Q_ID },
        ]
      : [
          { id: "rail_seat", positionMm: [0, 0, 10], quatWxyz: Q_ID },
          { id: "screw_seat", positionMm: axis === "x" ? [0, -44, 20] : [44, 0, 20], quatWxyz: Q_ID },
          {
            id: "motor_seat",
            positionMm: axis === "x" ? [-195, -44, 20] : [44, -195, 20],
            quatWxyz: Q_ID,
          },
        ],
  });

  const pkgRail = buildPrimitivePartPackage({
    model: `${axis.toUpperCase()}轴重型直线导轨`,
    revision: "M1",
    primitive: {
      shape: "linear_rail_block",
      railLengthMm: isZ ? 240 : 300,
      railWidthMm: 16,
      blockLengthMm: 60,
      blockWidthMm: 44,
      heightMm: 22,
      axis,
      finish: "steel",
    },
    input: { positionMm: isZ ? [0, 11, 0] : [0, 0, -11], quatWxyz: Q_ID },
    extraOutputs: isZ ? [{ id: "carriage_front", positionMm: [0, -11, 0], quatWxyz: Q_ID }] : [],
  });

  const jointVec: [number, number, number] = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const pkgCarriage = buildPrimitivePartPackage({
    model: `${axis.toUpperCase()}轴进给滑台`,
    revision: "M1",
    primitive: isZ
      ? { shape: "box", widthMm: 95, depthMm: 16, heightMm: 120, finish: "aluminum" }
      : { shape: "plate", widthMm: 130, depthMm: 110, thicknessMm: 14, holeDiameterMm: 6, holeInsetMm: 12, finish: "aluminum" },
    input: { positionMm: isZ ? [0, 8, 0] : [0, 0, -7], quatWxyz: Q_ID },
    joint: { type: "slide", axis: jointVec, unit: "mm", range: isZ ? [-95, 55] : [-120, 120] },
    behavior: { kind: "moving_table", massKg: axis === "y" ? 6.5 : 4.5 },
  });

  const pkgScrew = buildPrimitivePartPackage({
    model: `${axis.toUpperCase()}轴滚珠丝杠 SFU1208`,
    revision: "M1",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: isZ ? 240 : 300, leadMm: 8, axis, finish: "steel" },
    joint: { type: "hinge", axis: jointVec, unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgMotor = buildPrimitivePartPackage({
    model: `${axis.toUpperCase()}轴 400W 伺服电机`,
    revision: "M1",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis, finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const assembly: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: `module-feed-${axis}`,
    name: `${axis.toUpperCase()}向直线进给模组总成`,
    nodes: [
      { id: `${axis}_beam`, label: `${axis.toUpperCase()}模组基梁`, packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: `${axis}_rail`, label: `${axis.toUpperCase()}线性导轨`, packageKey: packageKey(pkgRail), parent: { node: `${axis}_beam`, mount: "rail_seat" }, explodeStep: 1, explodeVectorMm: isZ ? [0, -50, 0] : [0, 0, 48] },
      { id: `${axis}_screw`, label: `${axis.toUpperCase()}滚珠丝杠`, packageKey: packageKey(pkgScrew), parent: { node: `${axis}_beam`, mount: "screw_seat" }, explodeStep: 1, coupledTo: { path: `${axis}_slide`, ratio: 45 } },
      { id: `${axis}_motor`, label: `${axis.toUpperCase()}伺服电机`, packageKey: packageKey(pkgMotor), parent: { node: `${axis}_beam`, mount: "motor_seat" }, explodeStep: 2 },
      { id: `${axis}_slide`, label: `${axis.toUpperCase()}轴进给滑台`, packageKey: packageKey(pkgCarriage), parent: { node: `${axis}_rail`, mount: isZ ? "carriage_front" : "carriage_top" }, explodeStep: 2, explodeVectorMm: isZ ? [0, -60, 0] : [0, 0, 65] },
    ],
    output: { node: `${axis}_slide`, mount: isZ ? "neg_y" : "top" },
    commands: { [`${axis}_slide`]: 0 },
  };

  const ws = [pkgBase, pkgRail, pkgCarriage, pkgScrew, pkgMotor].reduce(installPackage, emptyWorkspace());
  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

function makeXyStageModule(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const sol = createChallengeSolution("level-2-xy-stage");
  return sol;
}

function makeEpumpTvcEngineModule(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const zero = createZeroBlankSandbox();
  const s1 = placeRootBlockInSandbox(zero.workspace, zero.assembly, "gimbal_yoke");
  const s2 = snapBlockOntoAssembly(s1.workspace, s1.assembly, "bldc_motor", s1.addedNodeId, "pump_bay");
  const s3 = snapBlockOntoAssembly(s2.workspace, s2.assembly, "pump_impeller", s2.addedNodeId, "shaft_tip");
  const s4 = snapBlockOntoAssembly(s3.workspace, s3.assembly, "gimbal_servo", s1.addedNodeId, "bottom");
  const s5 = snapBlockOntoAssembly(s4.workspace, s4.assembly, "laval_nozzle", s4.addedNodeId, "bottom");

  const taggedNodes = s5.assembly.nodes.map((n) =>
    n.id === s5.addedNodeId && n.thruster
      ? { ...n, thruster: { ...n.thruster, sourceNodePath: s2.addedNodeId } }
      : n,
  );
  const finalAsm = parseMechanicalAssembly({
    ...s5.assembly,
    id: "mod_epump_tvc_engine",
    name: "电泵矢量火箭发动机总成",
    nodes: taggedNodes,
    output: { node: s1.addedNodeId, mount: "top" },
  });
  return { workspace: { ...s5.workspace, mechanisms: [finalAsm] }, assembly: finalAsm };
}

function makeWheelDrivePodModule(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const zero = createZeroBlankSandbox();
  const s1 = placeRootBlockInSandbox(zero.workspace, zero.assembly, "hub_motor_y");
  const s2 = snapBlockOntoAssembly(s1.workspace, s1.assembly, "passive_wheel", s1.addedNodeId, "pos_y");
  const finalAsm = parseMechanicalAssembly({
    ...s2.assembly,
    id: "mod_wheel_drive_pod",
    name: "轮毂电驱车轮总成",
    output: { node: s1.addedNodeId, mount: "top" },
  });
  return { workspace: { ...s2.workspace, mechanisms: [finalAsm] }, assembly: finalAsm };
}

function makeCoaxialRotorHeadModule(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const zero = createZeroBlankSandbox();
  const s1 = placeRootBlockInSandbox(zero.workspace, zero.assembly, "gimbal_yoke");
  const m1 = snapBlockOntoAssembly(s1.workspace, s1.assembly, "bldc_motor", s1.addedNodeId, "pump_bay");
  const b1 = snapBlockOntoAssembly(m1.workspace, m1.assembly, "passive_blade", m1.addedNodeId, "shaft_tip");
  const m2 = snapBlockOntoAssembly(b1.workspace, b1.assembly, "bldc_motor", s1.addedNodeId, "top");
  const b2 = snapBlockOntoAssembly(m2.workspace, m2.assembly, "passive_blade", m2.addedNodeId, "shaft_tip");
  const coupled = updateSandboxNode(b2.workspace, b2.assembly, m2.addedNodeId, {
    coupledTo: { path: m1.addedNodeId, ratio: -1 },
  });
  const finalAsm = parseMechanicalAssembly({
    ...coupled.assembly,
    id: "mod_coaxial_rotor_head",
    name: "共轴反扭双电机旋翼头",
    output: { node: s1.addedNodeId, mount: "top" },
  });
  return { workspace: { ...coupled.workspace, mechanisms: [finalAsm] }, assembly: finalAsm };
}

export const MODULE_BLUEPRINTS: readonly ModuleBlueprintDef[] = [
  {
    id: "mod_feed_x",
    name: "📦 直线进给模组 (X向)",
    subtitle: "你已封装的 5 合 1 进给总成：基梁+导轨+滑块+丝杠+电机",
    unlockedBy: "comm-1-axis",
    buildFn: () => makeLinearAxisModule("x"),
  },
  {
    id: "mod_feed_y",
    name: "📦 直线进给模组 (Y向)",
    subtitle: "可直接铺在床身上的 Y 向直线模组总成",
    unlockedBy: "comm-1-axis",
    buildFn: () => makeLinearAxisModule("y"),
  },
  {
    id: "mod_feed_z",
    name: "📦 垂直升降模组 (Z向)",
    subtitle: "可挂在立柱前方的 Z 轴主轴升降模组",
    unlockedBy: "comm-2-xy",
    buildFn: () => makeLinearAxisModule("z"),
  },
  {
    id: "mod_xy_stage",
    name: "📦 十字双轴工作台总成",
    subtitle: "已校准过圆弧插补的双轴精密滑台总成（直接放上就能载物！）",
    unlockedBy: "comm-2-xy",
    buildFn: makeXyStageModule,
  },
  {
    id: "mod_epump_tvc_engine",
    name: "📦 电泵矢量火箭发动机总成",
    subtitle: "5 原子件子总成：承力环 + 高速无刷电机 + 离心泵叶轮 + TVC 舵机 + 纯拉瓦尔喷管",
    unlockedBy: "comm-4-omni",
    buildFn: makeEpumpTvcEngineModule,
  },
  {
    id: "mod_wheel_drive_pod",
    name: "📦 轮毂电驱车轮总成",
    subtitle: "2 原子件子总成：Y 轴轮毂驱动电机 + 纯高摩擦橡胶轮胎（自动适配左右对称轮距）",
    unlockedBy: "comm-4-omni",
    buildFn: makeWheelDrivePodModule,
  },
  {
    id: "mod_coaxial_rotor_head",
    name: "📦 共轴反扭双电机旋翼头",
    subtitle: "5 原子件子总成：承力毂 + 双无刷电机 (ratio=-1 反扭抵消) + 上下双气动桨叶",
    unlockedBy: "comm-4-omni",
    buildFn: makeCoaxialRotorHeadModule,
  },
];

export const EVOLUTION_COMMISSIONS: readonly EvolutionCommissionDef[] = [
  {
    id: "comm-1-axis",
    badge: "委托一",
    title: "直线之始 · 第一根可控进给轴",
    clientBrief:
      "在 2080 铝型材基梁上装配直线滑台、承载板、驱动电机与限位接近开关，在不触发电机过载前提下精准抵达 +100 mm。",
    trialMode: "step-axis",
    trialButtonLabel: "⚡ 通电测试单轴进给",
    rewardText: "通关奖励：把单轴封装为【📦 X/Y 直线进给模组】积木，随时一步调用！",
    unlockedBlockIds: ["beam_2080", "table_plate", "slide_x", "ball_screw", "servo_motor", "limit_switch"],
    unlockedModuleIds: [],
    stepsHint: [
      "1. 吸上「X 轴直线导轨滑台」与「带孔铝合金工作台板」",
      "2. 挂载「400W 伺服电机」与「限位接近开关」（可加「滚珠丝杠」看联动）",
      "3. 点下方「⚡ 通电测试单轴进给」运行闭环验收，解锁封装模组",
    ],
  },
  {
    id: "comm-2-xy",
    badge: "委托二",
    title: "平面插补 · 正交十字滑台画正圆",
    clientBrief:
      "用你刚刚解锁的【📦 直线进给模组】或导轨积木正交叠出 X/Y 双轴。通电后机器将高速跑 Ø56 mm 正圆——如果一轴惯量过大，画出的圆会严重失圆！",
    trialMode: "xy-circle",
    trialButtonLabel: "⚡ 通电画圆检验插补精度",
    rewardText: "通关奖励：解锁【📦 十字双轴总成】以及 4080 立柱、L角件、电主轴与铝毛坯！",
    unlockedBlockIds: ["beam_2080", "table_plate", "slide_x", "slide_y", "ball_screw", "servo_motor", "limit_switch"],
    unlockedModuleIds: ["mod_feed_x", "mod_feed_y"],
    stepsHint: [
      "1. 在底座吸上一套「Y 轴直线进给模组」（场景已预设或从上方模组区一键装上）",
      "2. 在 Y 轴滑台上再正交叠加「X 轴直线导轨滑台 / X向模组」与台板",
      "3. 点「⚡ 通电画圆检验插补精度」，确保圆度误差与惯量比达标",
    ],
  },
  {
    id: "comm-3-mill",
    badge: "委托三",
    title: "第一台机床 · 真铣铝合金圆槽",
    clientBrief:
      "把十字滑台放上铝合金毛坯，再竖起立柱、Z 轴升降副和高速电主轴！你可以做 C 型单柱，也可以拼高刚性双柱龙门（加 L 型角件减震冲刺 S 级评价）。",
    trialMode: "milling-pocket",
    trialButtonLabel: "⚡ 通电试切铝合金毛坯",
    rewardText: "通关奖励：解锁旋转铰链与机械臂全套积木（万物同源），开启无限创造！",
    unlockedBlockIds: [
      "beam_2080", "column_4080", "table_plate", "gusset_l",
      "slide_x", "slide_y", "slide_z", "ball_screw",
      "servo_motor", "spindle_head", "limit_switch", "workpiece_block",
    ],
    unlockedModuleIds: MODULE_BLUEPRINTS.map((m) => m.id),
    stepsHint: [
      "1. 用已解锁模组或快速样本搭出 X/Y 载物台 + 立柱 Z 轴 + 电主轴",
      "2. 多加 L 型角件或双立柱横梁可大幅降低切削让刀变形 δ",
      "3. 点「⚡ 通电试切铝合金毛坯」观看 3D 实时铣出圆槽并获取 S/A/B 评级",
    ],
  },
  {
    id: "comm-4-omni",
    badge: "委托四",
    title: "万物同源 · 旋转关节与异形专机",
    clientBrief:
      "机床与机器人共用同一套力学法则。改用「水平回转」与「俯仰摆臂」搭出大空间机械臂，或混搭出一台全新专机，完成后导出采购 BOM！",
    trialMode: "arm-orbit",
    trialButtonLabel: "⚡ 通电运行空间包络测试",
    rewardText: "全部组件与模块化封装能力全面解锁！自由前往「自由创造与 BOM」创造新物种。",
    unlockedBlockIds: SANDBOX_BLOCKS.map((b) => b.id),
    unlockedModuleIds: MODULE_BLUEPRINTS.map((m) => m.id),
    stepsHint: [
      "1. 底座叠加回转 Z → 俯仰 Y → 刚性臂杆 → 俯仰 Y → 臂杆 → 末端抓手",
      "2. 点「⚡ 通电运行空间包络测试」验证 3D 扫掠空间与肩部重力力矩",
      "3. 切到「现实 BOM」即可换配松下/汇川型号并导出采购清单",
    ],
  },
];

/**
 * 将高阶封装模组（内置模组或用户自创封装模块）完整嫁接到当前机械装配的指定父安装点上。
 */
export function snapModuleOntoAssembly(
  hostWs: TwinWorkspace,
  assembly: MechanicalAssembly,
  moduleData: { workspace: TwinWorkspace; assembly: MechanicalAssembly },
  parentNodeId: string,
  parentMountId: string,
): { workspace: TwinWorkspace; assembly: MechanicalAssembly; addedRootId: string; outputNodeId: string } {
  const parentNode = assembly.nodes.find((n) => n.id === parentNodeId);
  if (!parentNode) throw new Error(`找不到父装配节点：${parentNodeId}`);

  const modAsm = moduleData.assembly;
  const modPkgs = new Map(moduleData.workspace.packages.map((p) => [packageKey(p), p]));
  let nextWs = parseWorkspace(hostWs);

  const idMap = new Map<string, string>();
  const usedIds = new Set(assembly.nodes.map((n) => n.id));
  const allocId = (rawId: string) => {
    const clean = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "mod_node";
    if (!usedIds.has(clean)) {
      usedIds.add(clean);
      return clean;
    }
    let idx = 2;
    while (usedIds.has(`${clean}_${idx}`)) idx++;
    const cand = `${clean}_${idx}`.slice(0, 78);
    usedIds.add(cand);
    return cand;
  };
  for (const mn of modAsm.nodes) {
    idMap.set(mn.id, allocId(mn.id));
  }

  const modRoot = modAsm.nodes.find((n) => n.parent === null) ?? modAsm.nodes[0]!;
  const newRootId = idMap.get(modRoot.id)!;
  const baseStep = parentNode.explodeStep ?? 0;

  // Detect any internal motor+impeller pair inside the module so nozzles pair with their own pod's pump motor
  const modPumpMotor = modAsm.nodes.find((mn) => {
    const pkg = modPkgs.get(mn.packageKey);
    const isHinge = pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "hinge";
    if (!isHinge) return false;
    return modAsm.nodes.some((c) => {
      if (c.parent?.node !== mn.id) return false;
      const cPkg = modPkgs.get(c.packageKey);
      const txt = `${c.id} ${c.label ?? ""} ${cPkg?.model ?? ""}`.toLowerCase();
      return txt.includes("impeller") || txt.includes("叶轮");
    });
  });
  const mappedPumpMotorId = modPumpMotor ? idMap.get(modPumpMotor.id) : undefined;
  const flipWheelOutwardToNegY = parentMountId.startsWith("neg_y");

  const pkgKeyMap = new Map<string, string>();
  for (const mn of modAsm.nodes) {
    const origPkg = modPkgs.get(mn.packageKey);
    if (!origPkg) continue;
    let candidate = origPkg;
    if (mn.id === modRoot.id && origPkg.mechanics?.kind === "part") {
      const bounds = origPkg.primitive ? primitiveBoundingBoxMm(origPkg.primitive) : ([80, 80, 20] as const);
      const { inputPosMm } = matingInputAndExplode(parentMountId, bounds);
      const revBump = `${origPkg.revision}_${parentMountId}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "M2";
      candidate = parseDevicePackage({
        ...origPkg,
        revision: revBump,
        mechanics: {
          ...origPkg.mechanics,
          input: { positionMm: inputPosMm, quatWxyz: origPkg.mechanics.input.quatWxyz },
        },
      });
    } else if (
      flipWheelOutwardToNegY &&
      mn.parent?.node === modRoot.id &&
      mn.parent.mount === "pos_y" &&
      origPkg.primitive?.finish === "rubber_grip" &&
      origPkg.mechanics?.kind === "part"
    ) {
      const bounds = primitiveBoundingBoxMm(origPkg.primitive);
      const { inputPosMm } = matingInputAndExplode("neg_y", bounds);
      const revBump = `${origPkg.revision}_ny`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "M2";
      candidate = parseDevicePackage({
        ...origPkg,
        revision: revBump,
        mechanics: {
          ...origPkg.mechanics,
          input: { positionMm: inputPosMm, quatWxyz: origPkg.mechanics.input.quatWxyz },
        },
      });
    }
    const installed = pickUniquePkg(nextWs.packages, candidate);
    if (!nextWs.packages.some((p) => packageKey(p) === packageKey(installed))) {
      nextWs = installPackage(nextWs, installed);
    }
    pkgKeyMap.set(mn.packageKey, packageKey(installed));
  }

  const graftedNodes: MechanicalAssembly["nodes"][number][] = modAsm.nodes.map((mn) => {
    const newId = idMap.get(mn.id)!;
    const isRoot = mn.id === modRoot.id;
    const remappedParent = isRoot
      ? { node: parentNodeId, mount: parentMountId }
      : {
          node: idMap.get(mn.parent!.node)!,
          mount:
            flipWheelOutwardToNegY &&
            mn.parent?.node === modRoot.id &&
            mn.parent.mount === "pos_y" &&
            modPkgs.get(mn.packageKey)?.primitive?.finish === "rubber_grip"
              ? "neg_y"
              : mn.parent!.mount,
        };
    const remappedCoupled = mn.coupledTo
      ? { ...mn.coupledTo, path: idMap.get(mn.coupledTo.path) ?? mn.coupledTo.path }
      : undefined;
    const nextThruster = mn.thruster
      ? {
          ...mn.thruster,
          ...(mn.thruster.coupleMode === "pump_speed"
            ? (() => {
                const resolvedSource = mn.thruster.sourceNodePath
                  ? (idMap.get(mn.thruster.sourceNodePath) ?? mn.thruster.sourceNodePath)
                  : mappedPumpMotorId;
                return resolvedSource ? { sourceNodePath: resolvedSource } : {};
              })()
            : {}),
        }
      : undefined;

    return {
      id: newId,
      label: mn.label,
      packageKey: pkgKeyMap.get(mn.packageKey) ?? mn.packageKey,
      parent: remappedParent,
      explodeStep: baseStep + 1 + (mn.explodeStep ?? 0),
      ...(mn.explodeVectorMm ? { explodeVectorMm: mn.explodeVectorMm } : { explodeVectorMm: [0, 0, 55] as [number, number, number] }),
      ...(mn.jointMode ? { jointMode: mn.jointMode } : {}),
      ...(nextThruster ? { thruster: nextThruster } : {}),
      ...(remappedCoupled ? { coupledTo: remappedCoupled } : {}),
    };
  });

  const mappedOutputId = idMap.get(modAsm.output.node) ?? newRootId;
  const keepSpindleOut = assembly.output.mount === "tool_tip" || assembly.output.node.startsWith("gripper_tip");
  const isPodOrSubMount =
    parentMountId === "bottom" ||
    parentMountId === "neg_z" ||
    parentMountId === "pump_bay" ||
    parentMountId.startsWith("pos_y_") ||
    parentMountId.startsWith("neg_y_") ||
    parentMountId.startsWith("rim_") ||
    modAsm.nodes.some((n) => Boolean(n.thruster) || modPkgs.get(n.packageKey)?.primitive?.finish === "rubber_grip");
  const nextOutput = keepSpindleOut || isPodOrSubMount ? assembly.output : { node: mappedOutputId, mount: modAsm.output.mount };

  const nextCommands: Record<string, number> = { ...assembly.commands };
  for (const [k, v] of Object.entries(modAsm.commands)) {
    const mapped = idMap.get(k);
    if (mapped) nextCommands[mapped] = v;
  }

  const nextClosures = [
    ...(assembly.closures ?? []),
    ...(modAsm.closures ?? []).map((c) => ({
      ...c,
      id: allocId(`cl_${c.id}`),
      nodeA: idMap.get(c.nodeA) ?? c.nodeA,
      nodeB: idMap.get(c.nodeB) ?? c.nodeB,
    })),
  ];

  const nextAssembly = parseMechanicalAssembly({
    ...assembly,
    nodes: [...assembly.nodes, ...graftedNodes],
    output: nextOutput,
    commands: nextCommands,
    ...(nextClosures.length > 0 ? { closures: nextClosures } : {}),
  });

  if (nextWs.mechanisms?.some((m) => m.id === nextAssembly.id)) {
    nextWs = {
      ...nextWs,
      mechanisms: nextWs.mechanisms.map((m) => (m.id === nextAssembly.id ? nextAssembly : m)),
    };
  }

  return {
    workspace: nextWs,
    assembly: nextAssembly,
    addedRootId: newRootId,
    outputNodeId: mappedOutputId,
  };
}

/** 将当前装配封装为可随时重复调用的高阶积木模块（类似《图灵完备》自定义子电路） */
export function encapsulateUserModule(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  customName: string,
): CustomModuleRecord {
  const needed = new Set(assembly.nodes.map((n) => n.packageKey));
  let modWs = emptyWorkspace();
  for (const p of ws.packages) {
    if (needed.has(packageKey(p))) modWs = installPackage(modWs, p);
  }
  const cleanName = customName.trim() || assembly.name;
  const cleanAsm = parseMechanicalAssembly({
    ...assembly,
    id: `custom_mod_${Date.now()}`.slice(0, 64),
    name: cleanName,
  });
  modWs = { ...modWs, mechanisms: [cleanAsm] };

  return {
    id: cleanAsm.id,
    name: `📦 ${cleanName}`,
    subtitle: `自定义封装模块 · 共 ${cleanAsm.nodes.length} 个零件`,
    nodeCount: cleanAsm.nodes.length,
    workspace: modWs,
    assembly: cleanAsm,
  };
}

/** 从当前装配中提取指定子树根节点及其全部下级零件，封装为可复用子总成模块 */
export function encapsulateSubtreeModule(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  rootNodeId: string,
  customName: string,
): CustomModuleRecord {
  const keep = new Set([rootNodeId]);
  for (const parent of keep) {
    for (const child of assembly.nodes) {
      if (child.parent?.node === parent) keep.add(child.id);
    }
  }
  const outInSub = keep.has(assembly.output.node)
    ? assembly.output
    : { node: rootNodeId, mount: "top" };
  const prepared = parseMechanicalAssembly({
    ...assembly,
    output: outInSub,
  });
  const subAsm = mechanicalSubassembly(prepared, rootNodeId);
  return encapsulateUserModule(ws, subAsm, customName);
}

export function createCommissionStarter(commissionId: CommissionId): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  if (commissionId === "comm-1-axis") {
    const basePkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "2080 铝型材主梁",
      revision: "B1",
      primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 380, axis: "x", finish: "anodized_black" },
    });
    const asm: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-comm-1",
      name: "委托一：单轴可控进给模组",
      nodes: [{ id: "axis_base", label: "2080 铝型材主梁", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 }],
      output: { node: "axis_base", mount: "top" },
      commands: {},
    };
    return { workspace: { ...installPackage(emptyWorkspace(), basePkg), mechanisms: [asm] }, assembly: asm };
  }

  if (commissionId === "comm-2-xy") {
    const basePkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "工作台底座板",
      revision: "B1",
      primitive: { shape: "plate", widthMm: 320, depthMm: 360, thicknessMm: 16, finish: "anodized_black" },
    });
    const starterAsm: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-comm-2",
      name: "委托二：正交十字工作台",
      nodes: [{ id: "xy_base", label: "工作台底座板", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 }],
      output: { node: "xy_base", mount: "top" },
      commands: {},
    };
    const hostWs = installPackage(emptyWorkspace(), basePkg);
    const withY = snapModuleOntoAssembly(hostWs, starterAsm, makeLinearAxisModule("y"), "xy_base", "top");
    return { workspace: withY.workspace, assembly: withY.assembly };
  }

  if (commissionId === "comm-3-mill") {
    const xy = makeXyStageModule();
    const renamed = parseMechanicalAssembly({
      ...xy.assembly,
      id: "sandbox-comm-3",
      name: "委托三：自造三轴数控铣床",
    });
    return { workspace: { ...xy.workspace, mechanisms: [renamed] }, assembly: renamed };
  }

  // comm-4-omni
  const pedestal = buildPrimitivePartPackage({
    manufacturer: "构元积木",
    model: "重型回转基座",
    revision: "B1",
    primitive: { shape: "cylinder", radiusMm: 48, lengthMm: 40, axis: "z", finish: "anodized_black" },
  });
  const asm: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "sandbox-comm-4",
    name: "委托四：万物同源多轴机构",
    nodes: [{ id: "pedestal", label: "重型回转基座", packageKey: packageKey(pedestal), parent: null, explodeStep: 0 }],
    output: { node: "pedestal", mount: "top" },
    commands: {},
  };
  return { workspace: { ...installPackage(emptyWorkspace(), pedestal), mechanisms: [asm] }, assembly: asm };
}

export function createCommissionReferenceSolution(commissionId: CommissionId): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  if (commissionId === "comm-1-axis") {
    const start = createCommissionStarter("comm-1-axis");
    const step1 = snapBlockOntoAssembly(start.workspace, start.assembly, "slide_x", "axis_base", "top");
    const step2 = snapBlockOntoAssembly(step1.workspace, step1.assembly, "table_plate", step1.addedNodeId, "carriage_top");
    const step3 = snapBlockOntoAssembly(step2.workspace, step2.assembly, "ball_screw", "axis_base", "pos_y");
    const step4 = snapBlockOntoAssembly(step3.workspace, step3.assembly, "servo_motor", "axis_base", "neg_x");
    return snapBlockOntoAssembly(step4.workspace, step4.assembly, "limit_switch", "axis_base", "neg_y");
  }
  if (commissionId === "comm-2-xy") {
    const sol = createChallengeSolution("level-2-xy-stage");
    const renamed = parseMechanicalAssembly({ ...sol.assembly, id: "sandbox-comm-2-sol", name: "委托二标准解：双伺服十字滑台" });
    return { workspace: { ...sol.workspace, mechanisms: [renamed] }, assembly: renamed };
  }
  if (commissionId === "comm-3-mill") {
    return buildGantryMillTemplate();
  }
  return createChallengeSolution("level-4-robot-arm");
}
