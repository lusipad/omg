import { Matrix4, Quaternion, Vector3 } from "three";
import {
  buildComposableFeedModuleTemplate,
  buildComposableMiloMillTemplate,
  type ArticulatedSolveResult,
} from "./articulated-kinematics";
import { hasFeedRole, hasServoRole } from "./device-model-binding";
import { parseMechanicalAssembly, type MechanicalAssembly, type MechanicalFrame, type MechanicalPart } from "./mechanical-assembly";
import { PRIMITIVE_SHAPE_LABELS, primitiveBoundingBoxMm, type AxisDir, type PrimitivePartSpec } from "./primitive-parts";
import { upsertTwinSystem, type TwinSystemAssembly } from "./system-twin";
import { buildPrimitivePartPackage, packageKey, parseDevicePackage, type DeviceModelBinding, type DevicePackage, type DeviceParameterEntry } from "./twin-device";
import { emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "./twin-simulation";

export type SandboxBlockCategory = "frame" | "motion" | "actuator" | "sensor";

export interface SandboxBlockDefinition {
  readonly id: string;
  readonly category: SandboxBlockCategory;
  readonly name: string;
  readonly subtitle: string;
  readonly spec: PrimitivePartSpec;
  readonly defaultJoint: MechanicalPart["joint"];
  readonly attachMode?: "bottom" | "side_x" | "side_y" | "center";
  readonly roleHint?: "drive" | "motor" | "screw" | "table" | "sensor" | "spindle" | "workpiece" | "frame";
  readonly behavior?: Parameters<typeof buildPrimitivePartPackage>[0]["behavior"];
}

export const SANDBOX_CATEGORY_LABELS: Record<SandboxBlockCategory, string> = {
  frame: "① 骨架与结构",
  motion: "② 运动关节副",
  actuator: "③ 动力与末端",
  sensor: "④ 传感与工件",
};

export const SANDBOX_BLOCKS: readonly SandboxBlockDefinition[] = [
  // ① 骨架结构
  {
    id: "beam_2080",
    category: "frame",
    name: "2080 铝型材主梁",
    subtitle: "420 mm 长机床/模组床身基梁",
    spec: { shape: "extrusion_profile", series: "2080", lengthMm: 420, axis: "x", finish: "anodized_black" },
    defaultJoint: { type: "fixed" },
    roleHint: "frame",
  },
  {
    id: "column_4080",
    category: "frame",
    name: "4080 立柱型材",
    subtitle: "360 mm 高垂直立柱（支持挂载 Z 轴）",
    spec: { shape: "extrusion_profile", series: "4080", lengthMm: 360, axis: "z", finish: "anodized_black" },
    defaultJoint: { type: "fixed" },
    roleHint: "frame",
  },
  {
    id: "table_plate",
    category: "frame",
    name: "带孔铝合金工作台板",
    subtitle: "200×140×14 mm 滑台承载板",
    spec: { shape: "plate", widthMm: 200, depthMm: 140, thicknessMm: 14, holeDiameterMm: 6, holeInsetMm: 14, finish: "aluminum" },
    defaultJoint: { type: "fixed" },
    roleHint: "table",
    behavior: { kind: "moving_table", massKg: 6.5 },
  },
  {
    id: "gusset_l",
    category: "frame",
    name: "L 型铸铝角件",
    subtitle: "直角加固连接筋板",
    spec: { shape: "angle_bracket", widthMm: 28, legAMm: 70, legBMm: 85, thicknessMm: 10, finish: "steel" },
    defaultJoint: { type: "fixed" },
    roleHint: "frame",
  },

  // ② 运动关节副
  {
    id: "slide_x",
    category: "motion",
    name: "X 轴直线导轨滑台",
    subtitle: "沿 X 左右直线移动 (±120 mm)",
    spec: { shape: "linear_rail_block", railLengthMm: 300, railWidthMm: 16, blockLengthMm: 60, blockWidthMm: 44, heightMm: 22, axis: "x", finish: "steel" },
    defaultJoint: { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-120, 120] },
    roleHint: "table",
    behavior: { kind: "moving_table", massKg: 5.5 },
  },
  {
    id: "slide_y",
    category: "motion",
    name: "Y 轴直线导轨滑台",
    subtitle: "沿 Y 前后直线移动 (±100 mm)",
    spec: { shape: "linear_rail_block", railLengthMm: 320, railWidthMm: 16, blockLengthMm: 60, blockWidthMm: 44, heightMm: 22, axis: "y", finish: "steel" },
    defaultJoint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-100, 100] },
    roleHint: "table",
    behavior: { kind: "moving_table", massKg: 7.0 },
  },
  {
    id: "slide_z",
    category: "motion",
    name: "Z 轴垂直升降滑台",
    subtitle: "沿 Z 上下直线移动 (-95 ~ +55 mm)",
    spec: { shape: "linear_rail_block", railLengthMm: 280, railWidthMm: 16, blockLengthMm: 60, blockWidthMm: 44, heightMm: 22, axis: "z", finish: "steel" },
    defaultJoint: { type: "slide", axis: [0, 0, 1], unit: "mm", range: [-95, 55] },
    roleHint: "table",
    behavior: { kind: "moving_table", massKg: 4.8 },
  },
  {
    id: "rotary_z",
    category: "motion",
    name: "水平回转关节 (Z 轴)",
    subtitle: "绕 Z 轴 ±180° 旋转底座/分度盘",
    spec: { shape: "cylinder", radiusMm: 34, lengthMm: 26, axis: "z", finish: "steel" },
    defaultJoint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-180, 180] },
    roleHint: "frame",
  },
  {
    id: "rotary_y",
    category: "motion",
    name: "俯仰摆臂关节 (Y 轴)",
    subtitle: "绕 Y 轴 ±135° 摆动肩/肘关节",
    spec: { shape: "box", widthMm: 36, depthMm: 36, heightMm: 30, finish: "brass" },
    defaultJoint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-135, 135] },
    roleHint: "frame",
  },
  {
    id: "ball_screw",
    category: "motion",
    name: "滚珠丝杠 (带自动耦合)",
    subtitle: "Ø12 导程 8 mm，挂载后自动随同轴滑台自转",
    spec: { shape: "lead_screw", diameterMm: 12, lengthMm: 300, leadMm: 8, axis: "x", finish: "steel" },
    defaultJoint: { type: "hinge", axis: [1, 0, 0], unit: "deg", range: [-18000, 18000] },
    roleHint: "screw",
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  },

  // ③ 动力与末端执行
  {
    id: "servo_motor",
    category: "actuator",
    name: "400W 伺服电机壳体",
    subtitle: "NEMA57 法兰，可直接换配松下/汇川/台达真实铭牌",
    spec: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x", finish: "anodized_black" },
    defaultJoint: { type: "fixed" },
    roleHint: "motor",
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026, motorRatedCurrentA: 2.6 },
  },
  {
    id: "spindle_head",
    category: "actuator",
    name: "电主轴与立铣刀",
    subtitle: "ER16 主轴 + Ø10 铣刀，自带刀尖观察点",
    spec: { shape: "spindle_cutter", bodyDiameterMm: 56, bodyLengthMm: 120, toolDiameterMm: 10, toolStickoutMm: 36, finish: "spindle_red" },
    defaultJoint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    roleHint: "spindle",
  },
  {
    id: "arm_link",
    category: "actuator",
    name: "机械臂刚性臂杆",
    subtitle: "130 mm 中空管臂杆，适合拼接大臂/小臂",
    spec: { shape: "tube", outerRadiusMm: 16, innerRadiusMm: 11, lengthMm: 130, axis: "z", finish: "aluminum" },
    defaultJoint: { type: "fixed" },
    roleHint: "frame",
  },
  {
    id: "gripper_tip",
    category: "actuator",
    name: "机器人末端抓手 / 探针",
    subtitle: "32 mm 紧凑执行器末端",
    spec: { shape: "box", widthMm: 30, depthMm: 30, heightMm: 32, finish: "spindle_red" },
    defaultJoint: { type: "fixed" },
    roleHint: "frame",
  },

  // ④ 传感与工件
  {
    id: "limit_switch",
    category: "sensor",
    name: "限位接近开关",
    subtitle: "24V 常闭限位传感器，触发信号接入闭环急停",
    spec: { shape: "box", widthMm: 24, depthMm: 18, heightMm: 22, finish: "sensor_amber" },
    defaultJoint: { type: "fixed" },
    roleHint: "sensor",
  },
  {
    id: "workpiece_block",
    category: "sensor",
    name: "6061 铝合金测试毛坯",
    subtitle: "100×80×24 mm 待铣削/加工工件",
    spec: { shape: "box", widthMm: 100, depthMm: 80, heightMm: 24, finish: "workpiece_alloy" },
    defaultJoint: { type: "fixed" },
    roleHint: "workpiece",
  },
];

export interface RealVendorBomPreset {
  readonly id: string;
  readonly category: "motor" | "screw" | "sensor" | "table";
  readonly manufacturer: string;
  readonly model: string;
  readonly label: string;
  readonly summary: string;
  readonly parameters: Record<string, DeviceParameterEntry>;
  readonly modelBinding: DeviceModelBinding;
}

export const REAL_VENDOR_BOM_PRESETS: readonly RealVendorBomPreset[] = [
  {
    id: "motor-inovance-400w",
    category: "motor",
    manufacturer: "汇川技术",
    model: "MS1H1-40B30CB-A331Z",
    label: "汇川 400W 伺服电机 MS1H1-40B30CB",
    summary: "400 W · 1.27 N·m · 3000 rpm · 转子惯量 0.26×10⁻⁴ kg·m² · 2.8 A",
    parameters: {
      ratedPowerW: { status: "catalog", value: 400, unit: "W", label: "额定功率" },
      ratedTorqueNm: { status: "catalog", value: 1.27, unit: "N.m", label: "额定转矩" },
      ratedSpeedRpm: { status: "catalog", value: 3000, unit: "rpm", label: "额定转速" },
      rotorInertiaKgM2: { status: "catalog", value: 0.000026, unit: "kg.m2", label: "转子惯量" },
      motorRatedCurrentA: { status: "catalog", value: 2.8, unit: "A", label: "额定电流" },
    },
    modelBinding: {
      id: "vendor-motor-inovance",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings: [
        { kind: "parameter", source: "ratedPowerW", target: "ratedPowerW" },
        { kind: "parameter", source: "ratedTorqueNm", target: "ratedTorqueNm" },
        { kind: "parameter", source: "ratedSpeedRpm", target: "ratedSpeedRpm" },
        { kind: "parameter", source: "rotorInertiaKgM2", target: "rotorInertiaKgM2" },
        { kind: "parameter", source: "motorRatedCurrentA", target: "motorRatedCurrentA" },
      ],
    },
  },
  {
    id: "motor-panasonic-400w",
    category: "motor",
    manufacturer: "Panasonic",
    model: "MSMF042L1V2M",
    label: "松下 MINAS A6 400W 伺服电机 MSMF042L1V2M",
    summary: "400 W · 1.27 N·m · 3000 rpm · 转子惯量 0.14×10⁻⁴ kg·m² · 2.6 A",
    parameters: {
      ratedPowerW: { status: "catalog", value: 400, unit: "W", label: "额定功率" },
      ratedTorqueNm: { status: "catalog", value: 1.27, unit: "N.m", label: "额定转矩" },
      ratedSpeedRpm: { status: "catalog", value: 3000, unit: "rpm", label: "额定转速" },
      rotorInertiaKgM2: { status: "catalog", value: 0.000014, unit: "kg.m2", label: "转子惯量" },
      motorRatedCurrentA: { status: "catalog", value: 2.6, unit: "A", label: "额定电流" },
    },
    modelBinding: {
      id: "vendor-motor-panasonic",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings: [
        { kind: "parameter", source: "ratedPowerW", target: "ratedPowerW" },
        { kind: "parameter", source: "ratedTorqueNm", target: "ratedTorqueNm" },
        { kind: "parameter", source: "ratedSpeedRpm", target: "ratedSpeedRpm" },
        { kind: "parameter", source: "rotorInertiaKgM2", target: "rotorInertiaKgM2" },
        { kind: "parameter", source: "motorRatedCurrentA", target: "motorRatedCurrentA" },
      ],
    },
  },
  {
    id: "motor-delta-400w",
    category: "motor",
    manufacturer: "Delta 台达",
    model: "ECMA-C10604RS",
    label: "台达 ASDA-B3 400W 伺服电机 ECMA-C10604RS",
    summary: "400 W · 1.27 N·m · 3000 rpm · 转子惯量 0.254×10⁻⁴ kg·m² · 2.6 A",
    parameters: {
      ratedPowerW: { status: "catalog", value: 400, unit: "W", label: "额定功率" },
      ratedTorqueNm: { status: "catalog", value: 1.27, unit: "N.m", label: "额定转矩" },
      ratedSpeedRpm: { status: "catalog", value: 3000, unit: "rpm", label: "额定转速" },
      rotorInertiaKgM2: { status: "catalog", value: 0.0000254, unit: "kg.m2", label: "转子惯量" },
      motorRatedCurrentA: { status: "catalog", value: 2.6, unit: "A", label: "额定电流" },
    },
    modelBinding: {
      id: "vendor-motor-delta",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings: [
        { kind: "parameter", source: "ratedPowerW", target: "ratedPowerW" },
        { kind: "parameter", source: "ratedTorqueNm", target: "ratedTorqueNm" },
        { kind: "parameter", source: "ratedSpeedRpm", target: "ratedSpeedRpm" },
        { kind: "parameter", source: "rotorInertiaKgM2", target: "rotorInertiaKgM2" },
        { kind: "parameter", source: "motorRatedCurrentA", target: "motorRatedCurrentA" },
      ],
    },
  },
  {
    id: "screw-pmi-1610",
    category: "screw",
    manufacturer: "PMI 银泰",
    model: "SFU1610-C5",
    label: "PMI 滚珠丝杠 SFU1610 (导程 10 mm)",
    summary: "公称外径 Ø16 mm · 导程 10 mm/rev · C5 精度",
    parameters: {
      leadMmPerRev: { status: "catalog", value: 10, unit: "mm/rev", label: "丝杠导程" },
    },
    modelBinding: {
      id: "vendor-screw-pmi",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      mappings: [{ kind: "parameter", source: "leadMmPerRev", target: "leadMmPerRev" }],
    },
  },
  {
    id: "screw-thk-1208",
    category: "screw",
    manufacturer: "THK",
    model: "BNK1208-2.5G0",
    label: "THK 精密滚珠丝杠 BNK1208 (导程 8 mm)",
    summary: "公称外径 Ø12 mm · 导程 8 mm/rev · G0 零背隙",
    parameters: {
      leadMmPerRev: { status: "catalog", value: 8, unit: "mm/rev", label: "丝杠导程" },
    },
    modelBinding: {
      id: "vendor-screw-thk",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      mappings: [{ kind: "parameter", source: "leadMmPerRev", target: "leadMmPerRev" }],
    },
  },
  {
    id: "sensor-omron-sx670",
    category: "sensor",
    manufacturer: "OMRON 欧姆龙",
    model: "EE-SX670-NC",
    label: "欧姆龙槽型光电限位开关 EE-SX670 (24V 常闭)",
    summary: "24 V 工业电源 · 常闭触点 (NC) · 2 mm 触发感距",
    parameters: {
      supplyVoltageV: { status: "catalog", value: 24, unit: "V", label: "供电电压" },
      normallyClosed: { status: "catalog", value: true, unit: "1", label: "常闭触点" },
      senseDistanceMm: { status: "catalog", value: 2, unit: "mm", label: "感应窗口" },
    },
    modelBinding: {
      id: "vendor-sensor-omron",
      modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" },
      mappings: [
        { kind: "parameter", source: "supplyVoltageV", target: "supplyVoltageV" },
        { kind: "parameter", source: "normallyClosed", target: "normallyClosed" },
        { kind: "parameter", source: "senseDistanceMm", target: "senseDistanceMm" },
      ],
    },
  },
];

const Q_ID: [number, number, number, number] = [1, 0, 0, 0];

function pickUniqueRevision(existing: readonly DevicePackage[], candidate: DevicePackage): DevicePackage {
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

function matingInputAndExplode(
  mountId: string,
  bounds: readonly [number, number, number],
): { inputPosMm: [number, number, number]; explodeVecMm: [number, number, number] } {
  const [dx, dy, dz] = bounds;
  switch (mountId) {
    case "bottom":
    case "neg_z":
    case "spindle_clamp":
    case "tool_tip":
      return { inputPosMm: [0, 0, dz / 2], explodeVecMm: [0, 0, -75] };
    case "pos_x":
    case "bearing_mount":
      return { inputPosMm: [-dx / 2, 0, 0], explodeVecMm: [85, 0, 0] };
    case "neg_x":
    case "motor_mount":
      return { inputPosMm: [dx / 2, 0, 0], explodeVecMm: [-85, 0, 0] };
    case "pos_y":
    case "rear_plate_mount":
      return { inputPosMm: [0, -dy / 2, 0], explodeVecMm: [0, 85, 0] };
    case "neg_y":
    case "carriage_front":
    case "z_rail_mount":
      return { inputPosMm: [0, dy / 2, 0], explodeVecMm: [0, -85, 0] };
    case "center":
      return { inputPosMm: [0, 0, 0], explodeVecMm: [0, 0, 65] };
    default:
      // top, pos_z, carriage_top, sensor_mount, etc.
      return { inputPosMm: [0, 0, -dz / 2], explodeVecMm: [0, 0, 75] };
  }
}

export function snapBlockOntoAssembly(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  blockId: string,
  parentNodeId: string,
  parentMountId: string,
): { workspace: TwinWorkspace; assembly: MechanicalAssembly; addedNodeId: string } {
  const block = SANDBOX_BLOCKS.find((b) => b.id === blockId);
  if (!block) throw new Error(`找不到积木定义：${blockId}`);
  const parentNode = assembly.nodes.find((n) => n.id === parentNodeId);
  if (!parentNode) throw new Error(`父积木节点不存在：${parentNodeId}`);

  const bounds = primitiveBoundingBoxMm(block.spec);
  const { inputPosMm, explodeVecMm } = matingInputAndExplode(parentMountId, bounds);

  // Align Z-rail carriage facing forward (-Y) when attaching onto column front
  const effectiveSpec: PrimitivePartSpec = { ...block.spec };

  const newPkgCandidate = buildPrimitivePartPackage({
    manufacturer: "构元积木",
    model: block.name,
    revision: "B1",
    title: `${block.name}（积木吸附创建）`,
    primitive: effectiveSpec,
    joint: block.defaultJoint,
    input: { positionMm: inputPosMm, quatWxyz: Q_ID },
    behavior: block.behavior,
  });

  const installedPkg = pickUniqueRevision(ws.packages, newPkgCandidate);
  let nextWs = ws.packages.some((p) => packageKey(p) === packageKey(installedPkg))
    ? parseWorkspace(ws)
    : installPackage(ws, installedPkg);

  let idx = 1;
  while (assembly.nodes.some((n) => n.id === `${blockId}_${idx}`)) idx++;
  const addedNodeId = `${blockId}_${idx}`;

  // Detect matching slide sibling or parent so ball screws automatically couple rotations
  let coupledTo: MechanicalAssembly["nodes"][number]["coupledTo"];
  if (effectiveSpec.shape === "lead_screw") {
    const screwAxis = effectiveSpec.axis;
    const axisIdx = screwAxis === "x" ? 0 : screwAxis === "y" ? 1 : 2;
    const siblingSlide = assembly.nodes.find((n) => {
      const p = nextWs.packages.find((item) => packageKey(item) === n.packageKey);
      const j = p?.mechanics?.kind === "part" ? p.mechanics.joint : undefined;
      return j?.type === "slide" && Math.abs(j.axis[axisIdx]) > 0.5;
    });
    if (siblingSlide) {
      coupledTo = { path: siblingSlide.id, ratio: 360 / effectiveSpec.leadMm };
    }
  }

  const parentStep = parentNode.explodeStep ?? 0;
  const newNode: MechanicalAssembly["nodes"][number] = {
    id: addedNodeId,
    label: block.name,
    packageKey: packageKey(installedPkg),
    parent: { node: parentNodeId, mount: parentMountId },
    explodeStep: parentStep + 1,
    explodeVectorMm: explodeVecMm,
    ...(coupledTo ? { coupledTo } : {}),
  };

  // Promote output tip to functional endpoints (tool_tip / gripper / movable stage)
  let nextOutput = assembly.output;
  if (effectiveSpec.shape === "spindle_cutter") {
    nextOutput = { node: addedNodeId, mount: "tool_tip" };
  } else if (blockId === "gripper_tip" || block.defaultJoint.type === "slide") {
    nextOutput = { node: addedNodeId, mount: effectiveSpec.shape === "linear_rail_block" ? "carriage_top" : "top" };
  } else if (assembly.output.node === assembly.nodes[0]?.id) {
    nextOutput = { node: addedNodeId, mount: "top" };
  }

  const nextAssembly = parseMechanicalAssembly({
    ...assembly,
    nodes: [...assembly.nodes, newNode],
    output: nextOutput,
    commands:
      block.defaultJoint.type !== "fixed" && !coupledTo
        ? { ...assembly.commands, [addedNodeId]: 0 }
        : assembly.commands,
  });

  if (nextWs.mechanisms?.some((m) => m.id === nextAssembly.id)) {
    nextWs = {
      ...nextWs,
      mechanisms: nextWs.mechanisms.map((m) => (m.id === nextAssembly.id ? nextAssembly : m)),
    };
  }
  return { workspace: nextWs, assembly: nextAssembly, addedNodeId };
}

export function updateSandboxNode(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  nodeId: string,
  patch: {
    label?: string;
    primaryLengthMm?: number;
    axis?: AxisDir;
    rotateZ90?: boolean;
    jointType?: "fixed" | "slide" | "hinge";
    jointAxis?: AxisDir;
    jointRange?: readonly [number, number];
    vendorPresetId?: string;
  },
): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const node = assembly.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`找不到要调整的积木：${nodeId}`);
  const oldPkg = ws.packages.find((p) => packageKey(p) === node.packageKey);
  if (!oldPkg || oldPkg.mechanics?.kind !== "part") {
    throw new Error(`积木“${nodeId}”缺少可编辑的部件定义。`);
  }

  let nextSpec: PrimitivePartSpec | undefined = oldPkg.primitive ? { ...oldPkg.primitive } : undefined;
  let nextInput: MechanicalFrame = { ...oldPkg.mechanics.input };
  let nextJoint: MechanicalPart["joint"] = oldPkg.mechanics.joint;
  let manufacturer = oldPkg.manufacturer;
  let model = patch.label?.trim() || oldPkg.model;
  let parameters = oldPkg.parameters;
  let modelBindings = oldPkg.modelBindings;

  if (nextSpec && patch.primaryLengthMm !== undefined && patch.primaryLengthMm > 0) {
    const len = patch.primaryLengthMm;
    if (nextSpec.shape === "extrusion_profile" || nextSpec.shape === "cylinder" || nextSpec.shape === "tube" || nextSpec.shape === "lead_screw") {
      nextSpec = { ...nextSpec, lengthMm: len };
    } else if (nextSpec.shape === "linear_rail_block") {
      nextSpec = { ...nextSpec, railLengthMm: len };
    } else if (nextSpec.shape === "box" || nextSpec.shape === "plate") {
      nextSpec = { ...nextSpec, widthMm: len };
    } else if (nextSpec.shape === "spindle_cutter") {
      nextSpec = { ...nextSpec, bodyLengthMm: len };
    }
  }

  if (nextSpec && patch.axis && "axis" in nextSpec) {
    nextSpec = { ...nextSpec, axis: patch.axis } as PrimitivePartSpec;
    if (patch.jointAxis === undefined && nextJoint.type !== "fixed") {
      const vec: [number, number, number] =
        patch.axis === "x" ? [1, 0, 0] : patch.axis === "y" ? [0, 1, 0] : [0, 0, 1];
      nextJoint = { ...nextJoint, axis: vec };
    }
  }

  if (patch.rotateZ90) {
    const [w, x, y, z] = nextInput.quatWxyz;
    const cur = new Quaternion(x, y, z, w).normalize();
    const rot90 = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const combined = cur.multiply(rot90).normalize();
    nextInput = { ...nextInput, quatWxyz: [combined.w, combined.x, combined.y, combined.z] };
  }

  if (patch.jointType) {
    const ax = patch.jointAxis ?? (nextJoint.type !== "fixed" ? (Math.abs(nextJoint.axis[0]) > 0.5 ? "x" : Math.abs(nextJoint.axis[1]) > 0.5 ? "y" : "z") : "x");
    const axisVec: [number, number, number] = ax === "x" ? [1, 0, 0] : ax === "y" ? [0, 1, 0] : [0, 0, 1];
    if (patch.jointType === "fixed") nextJoint = { type: "fixed" };
    else if (patch.jointType === "slide") {
      nextJoint = { type: "slide", unit: "mm", axis: axisVec, range: patch.jointRange ? [patch.jointRange[0], patch.jointRange[1]] : [-120, 120] };
    } else {
      nextJoint = { type: "hinge", unit: "deg", axis: axisVec, range: patch.jointRange ? [patch.jointRange[0], patch.jointRange[1]] : [-180, 180] };
    }
  } else if (patch.jointAxis && nextJoint.type !== "fixed") {
    const axisVec: [number, number, number] = patch.jointAxis === "x" ? [1, 0, 0] : patch.jointAxis === "y" ? [0, 1, 0] : [0, 0, 1];
    nextJoint = { ...nextJoint, axis: axisVec };
  } else if (patch.jointRange && nextJoint.type !== "fixed") {
    nextJoint = { ...nextJoint, range: [patch.jointRange[0], patch.jointRange[1]] };
  }

  if (patch.vendorPresetId) {
    const preset = REAL_VENDOR_BOM_PRESETS.find((v) => v.id === patch.vendorPresetId);
    if (!preset) throw new Error(`找不到厂商预置：${patch.vendorPresetId}`);
    manufacturer = preset.manufacturer;
    model = preset.model;
    parameters = { ...preset.parameters };
    modelBindings = [preset.modelBinding];
  }

  let rebuilt: DevicePackage;
  if (nextSpec) {
    const built = buildPrimitivePartPackage({
      manufacturer,
      model,
      revision: oldPkg.revision,
      title: oldPkg.source.title,
      primitive: nextSpec,
      joint: nextJoint,
      input: nextInput,
      extraOutputs: oldPkg.mechanics.outputs,
    });
    rebuilt = parseDevicePackage({
      ...built,
      ...(parameters ? { parameters } : oldPkg.parameters ? { parameters: oldPkg.parameters } : {}),
      ...(modelBindings ? { modelBindings } : oldPkg.modelBindings ? { modelBindings: oldPkg.modelBindings } : {}),
    });
  } else {
    rebuilt = parseDevicePackage({
      ...oldPkg,
      manufacturer,
      model,
      mechanics: { ...oldPkg.mechanics, input: nextInput, joint: nextJoint },
      ...(parameters ? { parameters } : {}),
      ...(modelBindings ? { modelBindings } : {}),
    });
  }

  const finalPkg = pickUniqueRevision(ws.packages, rebuilt);
  let nextWs = ws.packages.some((p) => packageKey(p) === packageKey(finalPkg))
    ? parseWorkspace(ws)
    : installPackage(ws, finalPkg);

  const nextNodes = assembly.nodes.map((n) =>
    n.id === nodeId
      ? {
          ...n,
          packageKey: packageKey(finalPkg),
          ...(patch.label?.trim() ? { label: patch.label.trim() } : patch.vendorPresetId ? { label: model } : {}),
        }
      : n,
  );
  const nextAssembly = parseMechanicalAssembly({
    ...assembly,
    nodes: nextNodes,
  });

  if (nextWs.mechanisms?.some((m) => m.id === nextAssembly.id)) {
    nextWs = {
      ...nextWs,
      mechanisms: nextWs.mechanisms.map((m) => (m.id === nextAssembly.id ? nextAssembly : m)),
    };
  }
  return { workspace: nextWs, assembly: nextAssembly };
}

export function removeSandboxNode(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  nodeId: string,
): MechanicalAssembly {
  const target = assembly.nodes.find((n) => n.id === nodeId);
  if (!target) return assembly;
  if (!target.parent) throw new Error("根节点底座不可拆除（可通过上方切换关卡或重置画布）。");

  const toDrop = new Set([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of assembly.nodes) {
      if (!toDrop.has(n.id) && n.parent && toDrop.has(n.parent.node)) {
        toDrop.add(n.id);
        grew = true;
      }
    }
  }

  const remaining = assembly.nodes
    .filter((n) => !toDrop.has(n.id))
    .map((n) => {
      if (!n.coupledTo || !toDrop.has(n.coupledTo.path.split("/")[0])) return n;
      const { id, packageKey: pk, parent, materialId, label, explodeStep, explodeVectorMm } = n;
      return {
        id,
        packageKey: pk,
        parent,
        ...(materialId ? { materialId } : {}),
        ...(label ? { label } : {}),
        ...(explodeStep !== undefined ? { explodeStep } : {}),
        ...(explodeVectorMm ? { explodeVectorMm } : {}),
      };
    });

  let nextOutput = assembly.output;
  if (toDrop.has(assembly.output.node)) {
    const fallbackNode = remaining.at(-1) ?? remaining[0]!;
    const pkg = ws.packages.find((p) => packageKey(p) === fallbackNode.packageKey);
    const fallbackMount = pkg?.mechanics?.kind === "part" ? pkg.mechanics.outputs[0]?.id ?? "center" : "center";
    nextOutput = { node: fallbackNode.id, mount: fallbackMount };
  }

  const nextCommands: Record<string, number> = {};
  for (const [k, v] of Object.entries(assembly.commands)) {
    if (!toDrop.has(k.split("/")[0])) nextCommands[k] = v;
  }

  return parseMechanicalAssembly({
    ...assembly,
    nodes: remaining,
    output: nextOutput,
    commands: nextCommands,
  });
}

// ==========================================
// 渐进式引导关卡与空间挑战判定（Poly Bridge / KSP 风格）
// ==========================================

export interface ChallengeTargetSpec {
  readonly id: string;
  readonly label: string;
  readonly anchorMode: "world" | "workpiece";
  readonly posMm: readonly [number, number, number];
  readonly radiusMm: number;
}

export interface WorldTargetStatus extends ChallengeTargetSpec {
  readonly worldPosMm: readonly [number, number, number];
  readonly hit: boolean;
}

export interface ChallengeStructuralCheck {
  readonly label: string;
  readonly passed: boolean;
}

export interface SandboxChallengeDef {
  readonly id: "level-1-axis" | "level-2-xy-stage" | "level-3-cnc-mill" | "level-4-robot-arm" | "free-sandbox";
  readonly badge: string;
  readonly title: string;
  readonly story: string;
  readonly hints: readonly string[];
  readonly targets: readonly ChallengeTargetSpec[];
  readonly demoSweep?: readonly Record<string, number>[];
}

export const SANDBOX_CHALLENGES: readonly SandboxChallengeDef[] = [
  {
    id: "level-1-axis",
    badge: "第 1 关",
    title: "单轴限位滑台",
    story: "在 2080 铝型材主梁上吸出一条直线滑动工作台，并装上限位开关，让滑台精准抵达 +100 mm 发光目标点。",
    hints: [
      "1. 点击左侧积木「X 轴直线导轨滑台」，点击 3D 主梁顶面的发光圆点即可吸上",
      "2. 再吸一块「带孔铝合金工作台板」作为承载输出端，并用「限位接近开关」挂在底座旁",
      "3. 切到顶部「▶ 试动与挑战」，向右推滑块至 +100 mm 点亮目标通关",
    ],
    targets: [
      { id: "t1", label: "目标停靠点 +100 mm", anchorMode: "world", posMm: [100, 0, 48], radiusMm: 28 },
    ],
    demoSweep: [{ axis_x: 0 }, { axis_x: 50 }, { axis_x: 100 }],
  },
  {
    id: "level-2-xy-stage",
    badge: "第 2 关",
    title: "十字双轴工作台",
    story: "把 X 轴和 Y 轴导轨上下正交叠拼起来，让台面上的测试工件能走遍四个平面角点！",
    hints: [
      "1. 在底梁和 Y 轴滑块上加装「X 轴直线导轨滑台」，形成正交双轴联动",
      "2. 放上「铝合金工作台板」或「测试毛坯」后，切换到「▶ 试动与挑战」",
      "3. 分别拖动 X (±60 mm) 与 Y (±40 mm) 滑块，依次扫过 4 个黄色发光靶点",
    ],
    targets: [
      { id: "p1", label: "角点 A (+60,+40)", anchorMode: "world", posMm: [60, 40, 72], radiusMm: 34 },
      { id: "p2", label: "角点 B (-60,+40)", anchorMode: "world", posMm: [-60, 40, 72], radiusMm: 34 },
      { id: "p3", label: "角点 C (-60,-40)", anchorMode: "world", posMm: [-60, -40, 72], radiusMm: 34 },
      { id: "p4", label: "角点 D (+60,-40)", anchorMode: "world", posMm: [60, -40, 72], radiusMm: 34 },
    ],
    demoSweep: [
      { x_table: 60, y_saddle: 40 },
      { x_table: -60, y_saddle: 40 },
      { x_table: -60, y_saddle: -40 },
      { x_table: 60, y_saddle: -40 },
    ],
  },
  {
    id: "level-3-cnc-mill",
    badge: "第 3 关",
    title: "拼出一台三轴数控铣床",
    story: "无论是床身移动还是动龙门结构，只要同时具备 X/Y/Z 三轴进给 + 电主轴立铣刀，并能触及工件表面 4 个刀路点即可过关。",
    hints: [
      "1. 可直接在左侧点「查看参考拼法」载入 23 件标准三轴铣床，或自己用型材/导轨/主轴自由搭出全新构型",
      "2. 在「▶ 试动与挑战」下让 Z 轴下降贴近毛坯，并移动 X/Y 覆盖毛坯上方的 4 个切削靶球",
      "3. 随时点顶部「💥 爆炸视图」拉动展开，直接看清所有配合面和丝杠传动关系",
    ],
    targets: [
      { id: "m1", label: "切点 1 (-35,-25)", anchorMode: "workpiece", posMm: [-35, -25, 0], radiusMm: 26 },
      { id: "m2", label: "切点 2 (+35,-25)", anchorMode: "workpiece", posMm: [35, -25, 0], radiusMm: 26 },
      { id: "m3", label: "切点 3 (+35,+25)", anchorMode: "workpiece", posMm: [35, 25, 0], radiusMm: 26 },
      { id: "m4", label: "切点 4 (-35,+25)", anchorMode: "workpiece", posMm: [-35, 25, 0], radiusMm: 26 },
    ],
    demoSweep: [
      { x_table: 35, y_saddle: 15, z_carriage: -36.5, spindle_unit: 180 },
      { x_table: -35, y_saddle: 15, z_carriage: -36.5, spindle_unit: 360 },
      { x_table: -35, y_saddle: -35, z_carriage: -36.5, spindle_unit: 540 },
      { x_table: 35, y_saddle: -35, z_carriage: -36.5, spindle_unit: 720 },
    ],
  },
  {
    id: "level-4-robot-arm",
    badge: "第 4 关",
    title: "同源拼装：三自由度机械臂",
    story: "换个拼接方式，把直线导轨换成「水平回转」与「俯仰摆臂」关节，用同一套积木拼出够得到空中 3 个靶球的机械臂！",
    hints: [
      "1. 从底座向上串联：水平回转 Z → 肩部俯仰 Y → 刚性臂杆 → 肘部俯仰 Y → 臂杆 → 抓手末端",
      "2. 点「查看参考拼法」可看完整臂架；在「▶ 试动与挑战」依次转动 3 个角度关节触碰空中三球",
      "3. 完成后可将任一驱动关节替换为真实厂商型号并生成 BOM",
    ],
    targets: [
      { id: "r1", label: "空中点 1 (前方)", anchorMode: "world", posMm: [284, 0, 182], radiusMm: 35 },
      { id: "r2", label: "空中点 2 (左侧)", anchorMode: "world", posMm: [0, 284, 182], radiusMm: 35 },
      { id: "r3", label: "空中点 3 (右侧高点)", anchorMode: "world", posMm: [0, -249, 209], radiusMm: 35 },
    ],
    demoSweep: [
      { base_yaw: 0, shoulder_pitch: 45, elbow_pitch: 45 },
      { base_yaw: 90, shoulder_pitch: 45, elbow_pitch: 45 },
      { base_yaw: -90, shoulder_pitch: 30, elbow_pitch: 60 },
    ],
  },
  {
    id: "free-sandbox",
    badge: "自由创造",
    title: "无限构型沙盒工坊",
    story: "无拘束拼装任意还未存在的新机床、桁架机械手、自动换刀装置或混合机构，并随时查看爆炸图、生成 BOM 与转入闭环验证。",
    hints: [
      "左侧拿起任意积木，在 3D 发光吸附点直接点击吸合；选中任意部件可在右侧改尺寸、改旋转或换为运动关节。",
    ],
    targets: [],
  },
];

export function createChallengeStarter(challengeId: SandboxChallengeDef["id"]): {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
} {
  if (challengeId === "level-1-axis") {
    const basePkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "2080 铝型材主梁",
      revision: "B1",
      primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 380, axis: "x", finish: "anodized_black" },
    });
    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-1",
      name: "第1关：单轴限位滑台",
      nodes: [{ id: "axis_base", label: "2080 铝型材主梁", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 }],
      output: { node: "axis_base", mount: "top" },
      commands: {},
    };
    const ws = { ...installPackage(emptyWorkspace(), basePkg), mechanisms: [assembly] };
    return { workspace: ws, assembly };
  }

  if (challengeId === "level-2-xy-stage") {
    const basePkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "2080 底座主梁",
      revision: "B1",
      primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 380, axis: "y", finish: "anodized_black" },
    });
    const yRailPkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "Y 轴直线导轨滑台",
      revision: "B1",
      primitive: { shape: "linear_rail_block", railLengthMm: 320, railWidthMm: 16, blockLengthMm: 60, blockWidthMm: 44, heightMm: 22, axis: "y", finish: "steel" },
      input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
      joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-100, 100] },
      behavior: { kind: "moving_table", massKg: 7 },
    });
    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-2",
      name: "第2关：十字双轴工作台",
      nodes: [
        { id: "y_base", label: "2080 底座主梁", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 },
        { id: "y_saddle", label: "Y 轴直线导轨滑台", packageKey: packageKey(yRailPkg), parent: { node: "y_base", mount: "top" }, explodeStep: 1, explodeVectorMm: [0, 0, 55] },
      ],
      output: { node: "y_saddle", mount: "carriage_top" },
      commands: { y_saddle: 0 },
    };
    const ws = {
      ...installPackage(installPackage(emptyWorkspace(), basePkg), yRailPkg),
      mechanisms: [assembly],
    };
    return { workspace: ws, assembly };
  }

  if (challengeId === "level-3-cnc-mill") {
    const basePkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "机床铸铝底梁",
      revision: "B1",
      primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 480, axis: "y", finish: "anodized_black" },
      extraOutputs: [{ id: "column_seat", positionMm: [0, 190, 10], quatWxyz: Q_ID }],
    });
    const colPkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "4080 立柱型材",
      revision: "B1",
      primitive: { shape: "extrusion_profile", series: "4080", lengthMm: 380, axis: "z", finish: "anodized_black" },
      input: { positionMm: [0, 0, -190], quatWxyz: Q_ID },
    });
    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-3",
      name: "第3关：创造三轴机床",
      nodes: [
        { id: "mill_base", label: "机床底梁", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 },
        { id: "mill_col", label: "4080 立柱型材", packageKey: packageKey(colPkg), parent: { node: "mill_base", mount: "column_seat" }, explodeStep: 1, explodeVectorMm: [0, 60, 75] },
      ],
      output: { node: "mill_base", mount: "top" },
      commands: {},
    };
    const ws = {
      ...installPackage(installPackage(emptyWorkspace(), basePkg), colPkg),
      mechanisms: [assembly],
    };
    return { workspace: ws, assembly };
  }

  if (challengeId === "level-4-robot-arm") {
    const pedestalPkg = buildPrimitivePartPackage({
      manufacturer: "构元积木",
      model: "机械臂重型底座盘",
      revision: "B1",
      primitive: { shape: "cylinder", radiusMm: 48, lengthMm: 40, axis: "z", finish: "anodized_black" },
    });
    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-4",
      name: "第4关：三自由度机械臂",
      nodes: [{ id: "pedestal", label: "机械臂底座盘", packageKey: packageKey(pedestalPkg), parent: null, explodeStep: 0 }],
      output: { node: "pedestal", mount: "top" },
      commands: {},
    };
    const ws = { ...installPackage(emptyWorkspace(), pedestalPkg), mechanisms: [assembly] };
    return { workspace: ws, assembly };
  }

  // free-sandbox
  const platePkg = buildPrimitivePartPackage({
    manufacturer: "构元积木",
    model: "自由创造基准底板",
    revision: "B1",
    primitive: { shape: "plate", widthMm: 360, depthMm: 320, thicknessMm: 20, holeDiameterMm: 8, holeInsetMm: 18, finish: "anodized_black" },
  });
  const assembly: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "sandbox-free",
    name: "自由创造新构型",
    nodes: [{ id: "free_base", label: "创造基准底板", packageKey: packageKey(platePkg), parent: null, explodeStep: 0 }],
    output: { node: "free_base", mount: "top" },
    commands: {},
  };
  return { workspace: { ...installPackage(emptyWorkspace(), platePkg), mechanisms: [assembly] }, assembly };
}

export function createChallengeSolution(challengeId: SandboxChallengeDef["id"]): {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
} {
  if (challengeId === "level-1-axis") {
    const tpl = buildComposableFeedModuleTemplate();
    const motor = tpl.workspace.packages.find((p) => hasServoRole(p, "motor"));
    const renamed = parseMechanicalAssembly({
      ...tpl.assembly,
      id: "sandbox-level-1-sol",
      name: "第1关参考：单轴限位滑台模组",
    });
    let ws = tpl.workspace;
    if (motor) ws = parseWorkspace(ws);
    return { workspace: { ...ws, mechanisms: [renamed] }, assembly: renamed };
  }

  if (challengeId === "level-2-xy-stage") {
    const pkgBase = buildPrimitivePartPackage({
      model: "2080 底座双导轨横梁",
      revision: "S2",
      primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 380, axis: "y", finish: "anodized_black" },
      extraOutputs: [
        { id: "rail_seat", positionMm: [0, 0, 10], quatWxyz: Q_ID },
        { id: "motor_seat", positionMm: [44, -220, 22], quatWxyz: Q_ID },
        { id: "screw_seat", positionMm: [44, 0, 22], quatWxyz: Q_ID },
      ],
    });
    const pkgYRail = buildPrimitivePartPackage({
      model: "Y 轴直线导轨滑块副",
      revision: "S2",
      primitive: { shape: "linear_rail_block", railLengthMm: 340, railWidthMm: 16, blockLengthMm: 62, blockWidthMm: 46, heightMm: 22, axis: "y", finish: "steel" },
      input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
    });
    const pkgYSaddle = buildPrimitivePartPackage({
      model: "Y 轴承载鞍座板",
      revision: "S2",
      primitive: { shape: "plate", widthMm: 220, depthMm: 160, thicknessMm: 14, finish: "aluminum" },
      input: { positionMm: [0, 0, -7], quatWxyz: Q_ID },
      joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-100, 100] },
      extraOutputs: [
        { id: "x_rail_seat", positionMm: [0, 0, 7], quatWxyz: Q_ID },
        { id: "x_motor_seat", positionMm: [185, -44, 16], quatWxyz: Q_ID },
        { id: "x_screw_seat", positionMm: [0, -44, 16], quatWxyz: Q_ID },
      ],
    });
    const pkgXRail = buildPrimitivePartPackage({
      model: "X 轴直线导轨滑块副",
      revision: "S2",
      primitive: { shape: "linear_rail_block", railLengthMm: 280, railWidthMm: 16, blockLengthMm: 58, blockWidthMm: 42, heightMm: 20, axis: "x", finish: "steel" },
      input: { positionMm: [0, 0, -10], quatWxyz: Q_ID },
    });
    const pkgXTable = buildPrimitivePartPackage({
      model: "X 轴工作台面",
      revision: "S2",
      primitive: { shape: "plate", widthMm: 220, depthMm: 140, thicknessMm: 16, finish: "aluminum" },
      input: { positionMm: [0, 0, -8], quatWxyz: Q_ID },
      joint: { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-120, 120] },
      behavior: { kind: "moving_table", massKg: 6.5 },
    });
    const pkgYMotor = buildPrimitivePartPackage({
      model: "Y 轴伺服电机",
      revision: "S2",
      primitive: { shape: "servo_motor_body", flangeMm: 52, bodyLengthMm: 54, shaftDiameterMm: 8, shaftLengthMm: 18, axis: "y", finish: "anodized_black" },
      behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
    });
    const pkgXMotor = buildPrimitivePartPackage({
      model: "X 轴伺服电机",
      revision: "S2",
      primitive: { shape: "servo_motor_body", flangeMm: 52, bodyLengthMm: 54, shaftDiameterMm: 8, shaftLengthMm: 18, axis: "x", finish: "anodized_black" },
      behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
    });
    const pkgYScrew = buildPrimitivePartPackage({
      model: "Y 轴滚珠丝杠",
      revision: "S2",
      primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 340, leadMm: 8, axis: "y", finish: "steel" },
      joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-18000, 18000] },
      behavior: { kind: "lead_screw", leadMmPerRev: 8 },
    });
    const pkgXScrew = buildPrimitivePartPackage({
      model: "X 轴滚珠丝杠",
      revision: "S2",
      primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 280, leadMm: 8, axis: "x", finish: "steel" },
      joint: { type: "hinge", axis: [1, 0, 0], unit: "deg", range: [-18000, 18000] },
      behavior: { kind: "lead_screw", leadMmPerRev: 8 },
    });

    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-2-sol",
      name: "第2关参考：十字双轴工作台",
      nodes: [
        { id: "y_base", label: "2080 底座主梁", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
        { id: "y_rail", label: "Y 轴线性导轨", packageKey: packageKey(pkgYRail), parent: { node: "y_base", mount: "rail_seat" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
        { id: "y_motor", label: "Y 轴伺服电机", packageKey: packageKey(pkgYMotor), parent: { node: "y_base", mount: "motor_seat" }, explodeStep: 1, explodeVectorMm: [0, -70, 0] },
        { id: "y_screw", label: "Y 轴滚珠丝杠", packageKey: packageKey(pkgYScrew), parent: { node: "y_base", mount: "screw_seat" }, explodeStep: 1, explodeVectorMm: [55, 0, 35], coupledTo: { path: "y_saddle", ratio: 45 } },
        { id: "y_saddle", label: "Y 轴承载鞍座", packageKey: packageKey(pkgYSaddle), parent: { node: "y_rail", mount: "carriage_top" }, explodeStep: 2, explodeVectorMm: [0, 0, 60] },
        { id: "x_rail", label: "X 轴线性导轨", packageKey: packageKey(pkgXRail), parent: { node: "y_saddle", mount: "x_rail_seat" }, explodeStep: 3, explodeVectorMm: [0, 0, 55] },
        { id: "x_motor", label: "X 轴伺服电机", packageKey: packageKey(pkgXMotor), parent: { node: "y_saddle", mount: "x_motor_seat" }, explodeStep: 3, explodeVectorMm: [75, 0, 0] },
        { id: "x_screw", label: "X 轴滚珠丝杠", packageKey: packageKey(pkgXScrew), parent: { node: "y_saddle", mount: "x_screw_seat" }, explodeStep: 3, explodeVectorMm: [0, -60, 35], coupledTo: { path: "x_table", ratio: 45 } },
        { id: "x_table", label: "X 轴工作台面", packageKey: packageKey(pkgXTable), parent: { node: "x_rail", mount: "carriage_top" }, explodeStep: 4, explodeVectorMm: [0, 0, 75] },
      ],
      output: { node: "x_table", mount: "top" },
      commands: { y_saddle: 0, x_table: 0 },
    };

    const ws = [pkgBase, pkgYRail, pkgYSaddle, pkgXRail, pkgXTable, pkgYMotor, pkgXMotor, pkgYScrew, pkgXScrew].reduce(
      installPackage,
      emptyWorkspace(),
    );
    return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
  }

  if (challengeId === "level-3-cnc-mill") {
    return buildComposableMiloMillTemplate();
  }

  if (challengeId === "level-4-robot-arm") {
    const pkgPedestal = buildPrimitivePartPackage({
      model: "机械臂底座盘",
      revision: "S4",
      primitive: { shape: "cylinder", radiusMm: 48, lengthMm: 40, axis: "z", finish: "anodized_black" },
    });
    const pkgYaw = buildPrimitivePartPackage({
      model: "水平回转腰座 (Z 轴)",
      revision: "S4",
      primitive: { shape: "cylinder", radiusMm: 36, lengthMm: 26, axis: "z", finish: "steel" },
      input: { positionMm: [0, 0, -13], quatWxyz: Q_ID },
      joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-180, 180] },
    });
    const pkgShoulder = buildPrimitivePartPackage({
      model: "肩部俯仰关节 (Y 轴)",
      revision: "S4",
      primitive: { shape: "box", widthMm: 38, depthMm: 42, heightMm: 32, finish: "brass" },
      input: { positionMm: [0, 0, -16], quatWxyz: Q_ID },
      joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-135, 135] },
    });
    const pkgUpperArm = buildPrimitivePartPackage({
      model: "机械臂大臂管",
      revision: "S4",
      primitive: { shape: "tube", outerRadiusMm: 17, innerRadiusMm: 11, lengthMm: 140, axis: "z", finish: "aluminum" },
      input: { positionMm: [0, 0, -70], quatWxyz: Q_ID },
    });
    const pkgElbow = buildPrimitivePartPackage({
      model: "肘部俯仰关节 (Y 轴)",
      revision: "S4",
      primitive: { shape: "box", widthMm: 34, depthMm: 36, heightMm: 28, finish: "brass" },
      input: { positionMm: [0, 0, -14], quatWxyz: Q_ID },
      joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-135, 135] },
    });
    const pkgForearm = buildPrimitivePartPackage({
      model: "机械臂前臂杆",
      revision: "S4",
      primitive: { shape: "tube", outerRadiusMm: 14, innerRadiusMm: 9, lengthMm: 120, axis: "z", finish: "aluminum" },
      input: { positionMm: [0, 0, -60], quatWxyz: Q_ID },
    });
    const pkgGripper = buildPrimitivePartPackage({
      model: "末端探针抓手",
      revision: "S4",
      primitive: { shape: "box", widthMm: 28, depthMm: 28, heightMm: 30, finish: "spindle_red" },
      input: { positionMm: [0, 0, -15], quatWxyz: Q_ID },
    });

    const assembly: MechanicalAssembly = {
      schemaVersion: 1,
      kind: "mechanical-assembly",
      id: "sandbox-level-4-sol",
      name: "第4关参考：同源拼装 3 自由度机械臂",
      nodes: [
        { id: "pedestal", label: "重型底座盘", packageKey: packageKey(pkgPedestal), parent: null, explodeStep: 0 },
        { id: "base_yaw", label: "腰部回转 Z", packageKey: packageKey(pkgYaw), parent: { node: "pedestal", mount: "top" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
        { id: "shoulder_pitch", label: "肩部俯仰 Y", packageKey: packageKey(pkgShoulder), parent: { node: "base_yaw", mount: "top" }, explodeStep: 2, explodeVectorMm: [0, 0, 55] },
        { id: "upper_arm", label: "大臂臂杆", packageKey: packageKey(pkgUpperArm), parent: { node: "shoulder_pitch", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 75] },
        { id: "elbow_pitch", label: "肘部俯仰 Y", packageKey: packageKey(pkgElbow), parent: { node: "upper_arm", mount: "top" }, explodeStep: 4, explodeVectorMm: [0, 0, 55] },
        { id: "forearm", label: "前臂臂杆", packageKey: packageKey(pkgForearm), parent: { node: "elbow_pitch", mount: "top" }, explodeStep: 5, explodeVectorMm: [0, 0, 75] },
        { id: "gripper_tip", label: "末端抓手", packageKey: packageKey(pkgGripper), parent: { node: "forearm", mount: "top" }, explodeStep: 6, explodeVectorMm: [0, 0, 55] },
      ],
      output: { node: "gripper_tip", mount: "top" },
      commands: { base_yaw: 0, shoulder_pitch: 30, elbow_pitch: 45 },
    };

    const ws = [pkgPedestal, pkgYaw, pkgShoulder, pkgUpperArm, pkgElbow, pkgForearm, pkgGripper].reduce(
      installPackage,
      emptyWorkspace(),
    );
    return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
  }

  return createChallengeStarter("free-sandbox");
}

function findWorkpieceTopMatrix(ws: TwinWorkspace, solved: ArticulatedSolveResult, assembly: MechanicalAssembly): Matrix4 | null {
  const targetNode = solved.nodes.find((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    const idLow = n.id.toLowerCase();
    const labelLow = n.label.toLowerCase();
    return idLow.includes("workpiece") || labelLow.includes("毛坯") || labelLow.includes("工件") || pkg?.primitive?.finish === "workpiece_alloy";
  });
  if (!targetNode) return null;
  const rawNode = assembly.nodes.find((n) => n.id === targetNode.id);
  const pkg = rawNode ? ws.packages.find((p) => packageKey(p) === rawNode.packageKey) : undefined;
  const topMount = pkg?.mechanics?.kind === "part" ? pkg.mechanics.outputs.find((o) => o.id === "top") : undefined;
  if (!topMount) return targetNode.explodedMatrix.clone();
  const [tw, tx, ty, tz] = topMount.quatWxyz;
  const mountMat = new Matrix4().compose(
    new Vector3(...topMount.positionMm),
    new Quaternion(tx, ty, tz, tw).normalize(),
    new Vector3(1, 1, 1),
  );
  return targetNode.explodedMatrix.clone().multiply(mountMat);
}

export function evaluateChallengeProgress(
  challenge: SandboxChallengeDef,
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  solved: ArticulatedSolveResult,
  visitedTargetIds: ReadonlySet<string>,
): {
  readonly structuralChecks: readonly ChallengeStructuralCheck[];
  readonly worldTargets: readonly WorldTargetStatus[];
  readonly newlyHitIds: readonly string[];
  readonly hitCount: number;
  readonly completed: boolean;
} {
  const joints = solved.nodes.map((n) => n.joint);
  const slideX = joints.some((j) => j.type === "slide" && Math.abs(j.axis[0]) > 0.5);
  const slideY = joints.some((j) => j.type === "slide" && Math.abs(j.axis[1]) > 0.5);
  const slideZ = joints.some((j) => j.type === "slide" && Math.abs(j.axis[2]) > 0.5);
  const hingeCount = joints.filter((j) => j.type === "hinge" && !solved.coupledControls.some((c) => c.joint === j)).length;
  const hasMotorOrActuator = solved.nodes.some((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    return pkg?.primitive?.shape === "servo_motor_body" || pkg?.primitive?.shape === "spindle_cutter" || hasServoRole(pkg, "motor");
  });
  const hasSensor = solved.nodes.some((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    return n.id.includes("sensor") || n.id.includes("limit") || pkg?.primitive?.finish === "sensor_amber" || n.label.includes("限位");
  });
  const hasSpindle = solved.nodes.some((n) => {
    const pkg = ws.packages.find((p) => packageKey(p) === n.packageKey);
    return pkg?.primitive?.shape === "spindle_cutter";
  });

  const structuralChecks: ChallengeStructuralCheck[] = [];
  if (challenge.id === "level-1-axis") {
    structuralChecks.push(
      { label: "包含 ≥ 1 个直线滑台关节", passed: slideX || slideY || slideZ },
      { label: "包含限位接近开关或传感器", passed: hasSensor || hasMotorOrActuator },
    );
  } else if (challenge.id === "level-2-xy-stage") {
    structuralChecks.push(
      { label: "包含 Y 轴直线进给", passed: slideY },
      { label: "包含 X 轴直线进给（叠拼十字）", passed: slideX },
    );
  } else if (challenge.id === "level-3-cnc-mill") {
    structuralChecks.push(
      { label: "X/Y/Z 三向直线轴齐备", passed: slideX && slideY && slideZ },
      { label: "配备电主轴与立铣刀", passed: hasSpindle },
    );
  } else if (challenge.id === "level-4-robot-arm") {
    structuralChecks.push(
      { label: "包含 ≥ 2 个旋转关节 (hinge)", passed: hingeCount >= 2 },
    );
  }

  const wpMatrix = findWorkpieceTopMatrix(ws, solved, assembly);
  const tip = new Vector3(...solved.observationPointMm);
  const worldTargets: WorldTargetStatus[] = [];
  const newlyHitIds: string[] = [];

  for (const t of challenge.targets) {
    let worldPos: [number, number, number] = [t.posMm[0], t.posMm[1], t.posMm[2]];
    if (t.anchorMode === "workpiece") {
      if (wpMatrix) {
        const p = new Vector3(...t.posMm).applyMatrix4(wpMatrix);
        worldPos = [p.x, p.y, p.z];
      } else {
        worldPos = [t.posMm[0], t.posMm[1] - 10, t.posMm[2] + 108];
      }
    }
    const dist = tip.distanceTo(new Vector3(...worldPos));
    const isHitNow = dist <= t.radiusMm;
    const hit = isHitNow || visitedTargetIds.has(t.id);
    if (isHitNow && !visitedTargetIds.has(t.id)) {
      newlyHitIds.push(t.id);
    }
    worldTargets.push({ ...t, worldPosMm: worldPos, hit });
  }

  const allStructPass = structuralChecks.every((c) => c.passed);
  const hitCount = worldTargets.filter((t) => t.hit).length;
  const completed = challenge.targets.length > 0 && allStructPass && hitCount === challenge.targets.length;

  return { structuralChecks, worldTargets, newlyHitIds, hitCount, completed };
}

// ==========================================
// BOM 实时清单聚合 & Modelica 闭环系统转换
// ==========================================

export interface SandboxBomRow {
  readonly packageKey: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly shapeLabel: string;
  readonly dimensionsText: string;
  readonly quantity: number;
  readonly nodeIds: readonly string[];
  readonly hasRealBehavior: boolean;
  readonly suggestedPresetCategory?: RealVendorBomPreset["category"];
}

export function extractSandboxBomSummary(ws: TwinWorkspace, assembly: MechanicalAssembly): SandboxBomRow[] {
  const pkgByKey = new Map(ws.packages.map((p) => [packageKey(p), p]));
  const grouped = new Map<string, { pkg?: DevicePackage; nodeIds: string[] }>();

  for (const node of assembly.nodes) {
    const existing = grouped.get(node.packageKey);
    if (existing) existing.nodeIds.push(node.id);
    else grouped.set(node.packageKey, { pkg: pkgByKey.get(node.packageKey), nodeIds: [node.id] });
  }

  const rows: SandboxBomRow[] = [];
  for (const [pk, entry] of grouped) {
    const pkg = entry.pkg;
    const spec = pkg?.primitive;
    const shapeLabel = spec ? PRIMITIVE_SHAPE_LABELS[spec.shape].label : "定制机械件";
    const dims = spec ? primitiveBoundingBoxMm(spec).map((d) => Number(d.toFixed(1))).join("×") + " mm" : "按接口定义";
    const hasRealBehavior = Boolean(pkg?.modelBindings?.length || pkg?.servo || pkg?.feed);
    const suggestedPresetCategory: RealVendorBomPreset["category"] | undefined =
      spec?.shape === "servo_motor_body" ? "motor"
        : spec?.shape === "lead_screw" ? "screw"
          : spec?.finish === "sensor_amber" ? "sensor"
            : undefined;

    rows.push({
      packageKey: pk,
      manufacturer: pkg?.manufacturer ?? "未知",
      model: pkg?.model ?? pk,
      shapeLabel,
      dimensionsText: dims,
      quantity: entry.nodeIds.length,
      nodeIds: entry.nodeIds,
      hasRealBehavior,
      suggestedPresetCategory,
    });
  }
  return rows;
}

export function sandboxBomToCsv(rows: readonly SandboxBomRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const header = "品牌,型号,类别,包络尺寸,数量,节点实例,Modelica物理绑定";
  const body = rows.map((r) =>
    [
      esc(r.manufacturer),
      esc(r.model),
      esc(r.shapeLabel),
      esc(r.dimensionsText),
      String(r.quantity),
      esc(r.nodeIds.join(" / ")),
      r.hasRealBehavior ? "已绑定可执行模型" : "纯结构基本件",
    ].join(","),
  );
  return [header, ...body].join("\n");
}

/**
 * 将用户在积木工坊拼出的机器自动转换为完整可运行的 Modelica 机电控闭环系统（缺失项用一阶假设补齐，已有真实器件自动对接）。
 */
export function convertSandboxToSystemTwin(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
): { workspace: TwinWorkspace; system: TwinSystemAssembly } {
  let nextWs = parseWorkspace(ws);

  const ensureDefaultPkg = (candidate: DevicePackage): DevicePackage => {
    const installed = pickUniqueRevision(nextWs.packages, candidate);
    if (!nextWs.packages.some((p) => packageKey(p) === packageKey(installed))) {
      nextWs = installPackage(nextWs, installed);
    }
    return installed;
  };

  let drivePkg = nextWs.packages.find((p) => hasServoRole(p, "drive"));
  if (!drivePkg) {
    drivePkg = ensureDefaultPkg(
      parseDevicePackage({
        schemaVersion: 1,
        manufacturer: "构元闭环匹配",
        model: "通用2.8A伺服驱动器",
        revision: "S1",
        source: { kind: "local", url: "", title: "积木转闭环默认驱动器", locator: "一阶匹配", excerpt: "2.8 A" },
        ports: [],
        rules: [],
        parameters: {
          driveRatedCurrentA: { status: "assumed", value: 2.8, unit: "A", label: "额定电流", condition: "积木转闭环默认匹配" },
        },
        modelBindings: [
          {
            id: "sandbox-drive",
            modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
            mappings: [{ kind: "parameter", source: "driveRatedCurrentA", target: "driveRatedCurrentA" }],
          },
        ],
      }),
    );
  }

  let motorPkg = nextWs.packages.find((p) => hasServoRole(p, "motor"));
  if (!motorPkg) {
    motorPkg = ensureDefaultPkg(
      buildPrimitivePartPackage({
        manufacturer: "构元闭环匹配",
        model: "400W标准伺服电机",
        revision: "S1",
        primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x" },
        behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026, motorRatedCurrentA: 2.8 },
      }),
    );
  }

  let screwPkg = nextWs.packages.find((p) => hasFeedRole(p, "screw"));
  if (!screwPkg) {
    screwPkg = ensureDefaultPkg(
      buildPrimitivePartPackage({
        model: "Ø12滚珠丝杠(8mm导程)",
        revision: "S1",
        primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 300, leadMm: 8, axis: "x" },
        behavior: { kind: "lead_screw", leadMmPerRev: 8 },
      }),
    );
  }

  let tablePkg = nextWs.packages.find((p) => hasFeedRole(p, "table"));
  if (!tablePkg) {
    tablePkg = ensureDefaultPkg(
      buildPrimitivePartPackage({
        model: "滑台移动负载(6.5kg)",
        revision: "S1",
        primitive: { shape: "plate", widthMm: 200, depthMm: 140, thicknessMm: 14 },
        behavior: { kind: "moving_table", massKg: 6.5 },
      }),
    );
  }

  const diPkg = ensureDefaultPkg(
    parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "汇川技术",
      model: "GL10-DI00(Sandbox)",
      revision: "S1",
      source: { kind: "local", url: "", title: "24V工业DI通道", locator: "默认", excerpt: "15V/5V/10ms" },
      ports: [],
      rules: [],
      parameters: {
        onAbove: { status: "assumed", value: 15, unit: "V", label: "导通阈值", condition: "工业24V常规" },
        offBelow: { status: "assumed", value: 5, unit: "V", label: "关断阈值", condition: "工业24V常规" },
        filterMs: { status: "assumed", value: 10, unit: "ms", label: "滤波延时", condition: "常规10ms" },
      },
      modelBindings: [
        {
          id: "sandbox-di",
          modelRef: { id: "GouyuanSignal.DigitalInputChannel", version: "1.0.0" },
          mappings: [
            { kind: "parameter", source: "onAbove", target: "onAbove" },
            { kind: "parameter", source: "offBelow", target: "offBelow" },
            { kind: "parameter", source: "filterMs", target: "filterMs" },
          ],
        },
      ],
    }),
  );

  const sensorPkg = nextWs.packages.find((p) => p.primitive?.finish === "sensor_amber" || p.modelBindings?.some((b) => b.modelRef.id === "GouyuanSignal.PositionLimitSwitch"));

  const firstSlideNode = assembly.nodes.find((n) => {
    const pkg = nextWs.packages.find((p) => packageKey(p) === n.packageKey);
    return pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "slide";
  });
  const slidePart = firstSlideNode ? nextWs.packages.find((p) => packageKey(p) === firstSlideNode.packageKey)?.mechanics : undefined;
  const targetMm =
    slidePart?.kind === "part" && slidePart.joint.type === "slide"
      ? Math.max(40, Math.min(180, slidePart.joint.range[1]))
      : 100;
  const triggerMm = Number((targetMm * 0.92).toFixed(1));

  const system: TwinSystemAssembly = {
    schemaVersion: 1,
    kind: "system-twin-assembly",
    id: `sys-${assembly.id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64),
    name: `${assembly.name} · 闭环校验`,
    commStepMs: 1,
    durationMs: 2500,
    axes: [
      {
        id: "axis_x",
        name: firstSlideNode?.label || "主进给轴",
        direction: [1, 0, 0],
        originMm: [0, 0, 0],
        factor: 1,
        driveKey: packageKey(drivePkg),
        motorKey: packageKey(motorPkg),
        screwKey: packageKey(screwPkg),
        tableKey: packageKey(tablePkg),
        provenance: "confirmed",
        note: `从积木装配「${assembly.name}」一键生成`,
      },
    ],
    sensors: [
      {
        id: "limit_pos",
        name: sensorPkg ? `${sensorPkg.manufacturer} ${sensorPkg.model}` : "限位接近开关",
        ...(sensorPkg ? { packageKey: packageKey(sensorPkg) } : {}),
        axisId: "axis_x",
        triggerPositionMm: triggerMm,
        senseDistanceMm: 4,
        triggerMode: "positive_overtravel",
        normallyClosed: true,
        supplyVoltageV: 24,
        provenance: "confirmed",
      },
    ],
    diChannels: [
      {
        id: "di_00",
        name: "控制器数字量输入 DI00",
        packageKey: packageKey(diPkg),
        onAboveV: 15,
        offBelowV: 5,
        filterMs: 10,
        provenance: "confirmed",
      },
    ],
    wires: [
      { id: "w_sensor_di", from: { kind: "sensor", nodeId: "limit_pos", portId: "voltageOut" }, to: { kind: "di", nodeId: "di_00", portId: "voltageIn" }, provenance: "confirmed" },
      { id: "w_di_ctrl", from: { kind: "di", nodeId: "di_00", portId: "stateOut" }, to: { kind: "controller", nodeId: "ctrl_x", portId: "posLimitIn" }, invert: true, provenance: "confirmed" },
    ],
    controllers: [
      {
        id: "ctrl_x",
        axisId: "axis_x",
        mode: "move_with_limit_stop",
        targetMm,
        cruiseVelocityMmS: 100,
        initialPositionMm: 0,
        stopOnPosLimit: true,
        stopOnNegLimit: false,
        stopOnHome: false,
      },
    ],
  };

  return { workspace: upsertTwinSystem(nextWs, system), system };
}
