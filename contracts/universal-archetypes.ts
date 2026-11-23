import { Quaternion, Vector3 } from "three";
import { parseMechanicalAssembly, type MechanicalAssembly } from "./mechanical-assembly";
import { buildPrimitivePartPackage, packageKey } from "./twin-device";
import { emptyWorkspace, installPackage, type TwinWorkspace } from "./twin-simulation";

export type UniversalArchetypeId =
  | "reusable-tvc-rocket"
  | "rescue-helicopter"
  | "oriental-pearl-tower"
  | "four-wheel-rover"
  | "gripper-pick-arm"
  | "four-bar-linkage"
  | "spring-suspension-rig";

export interface UniversalArchetypeDef {
  readonly id: UniversalArchetypeId;
  readonly category: "flagship" | "mechanism";
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly physicsHighlights: string;
  readonly showroomMode: "rocket-launch" | "helicopter-flight" | "tower-spin" | "kinematic-demo";
}

export const UNIVERSAL_ARCHETYPES: readonly UniversalArchetypeDef[] = [
  {
    id: "reusable-tvc-rocket",
    category: "flagship",
    badge: "矢量火箭",
    title: "两级可回收矢量推力火箭",
    subtitle: "八机裙框 + 液压折叠支腿 + 钛合金栅格翼 + 二级卫星载荷舱 + TVC 摆动主喷管",
    physicsHighlights: "局部矢量喷管 <motor site> · ±15° TVC 程序转弯 · 整流罩剖面展开",
    showroomMode: "rocket-launch",
  },
  {
    id: "rescue-helicopter",
    category: "flagship",
    badge: "共轴旋翼",
    title: "共轴双旋翼救援直升机",
    subtitle: "全景玻璃风挡 + 双涡轴短舱 + 锥形尾梁双垂尾 + 四撑杆滑橇 + 共轴反转四叶旋翼",
    physicsHighlights: "ratio=-1 抵消反扭力矩 · 垂直拉升 · 周期变距前飞",
    showroomMode: "helicopter-flight",
  },
  {
    id: "oriental-pearl-tower",
    category: "flagship",
    badge: "建筑结构",
    title: "东方明珠三级旋转观光塔",
    subtitle: "清水混凝土三斜撑与串珠立柱 + 黛紫红大小球体 + 90m 观光廊 / 267m 旋转餐厅 / 350m 太空舱分级旋转",
    physicsHighlights: "多级独立角速度旋转层 · 混凝土/玻璃幕墙材质 · 468m 发射天线桅杆",
    showroomMode: "tower-spin",
  },
  {
    id: "four-wheel-rover",
    category: "mechanism",
    badge: "移动底盘",
    title: "四轮差速越障探索车",
    subtitle: "铝制护甲底盘 + 防撞防滚杠 + 轮毂四驱胶胎 + 双目视觉与激光雷达桅杆，-9.81 m/s² 爬坡",
    physicsHighlights: "freejoint 自由落地 · 轮胎库仑静摩擦推进 · 10° 坡道爬升",
    showroomMode: "kinematic-demo",
  },
  {
    id: "gripper-pick-arm",
    category: "mechanism",
    badge: "工业机械臂",
    title: "二指摩擦夹爪取物机械臂",
    subtitle: "带孔底板 + 加强角件 + Z 向直线导轨伺服模组 + 腕部法兰 + 金属加强平行橡胶夹指",
    physicsHighlights: "多阶段轨迹序列 · 对夹多项式耦合 · 接触静摩擦抓取",
    showroomMode: "kinematic-demo",
  },
  {
    id: "four-bar-linkage",
    category: "mechanism",
    badge: "闭链机构",
    title: "闭链四连杆曲柄摇杆机构",
    subtitle: "带座轴承支承 + 后置伺服驱动 + 平衡飞轮盘 + 满足 Grashof 条件的 <connect> 球铰闭环",
    physicsHighlights: "树状拓扑跨枝闭环 · 主动速度曲柄 + 双无源随动铰链",
    showroomMode: "kinematic-demo",
  },
  {
    id: "spring-suspension-rig",
    category: "mechanism",
    badge: "弹性悬架",
    title: "弹簧减震摆臂测试台",
    subtitle: "带角撑门架 + 轴承枢轴 + 双肋下摆臂 + 油气减震筒与制动盘钳轮组，斜置 <tendon> 阻尼测试",
    physicsHighlights: "空间肌腱弹簧阻尼 · 重力下垂受迫响应 · 欠阻尼振荡收敛",
    showroomMode: "kinematic-demo",
  },
];

const Q_ID: [number, number, number, number] = [1, 0, 0, 0];

function quatFromZToVec(vx: number, vy: number, vz: number): [number, number, number, number] {
  const q = new Quaternion().setFromUnitVectors(
    new Vector3(0, 0, 1),
    new Vector3(vx, vy, vz).normalize(),
  );
  return [q.w, q.x, q.y, q.z];
}

function quatAroundZ(rad: number): [number, number, number, number] {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rad);
  return [q.w, q.x, q.y, q.z];
}

/**
 * ① 两级可回收矢量推力火箭（八机裙框 + 液压折叠支腿 + 镂空钛栅格翼 + 卫星载荷 + 双锥整流罩 + TVC 喷管）
 */
export function buildReusableRocketTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const legTiltDeg = 26;
  const sinLeg = Math.sin((legTiltDeg * Math.PI) / 180);
  const cosLeg = Math.cos((legTiltDeg * Math.PI) / 180);
  const sideAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2] as const;

  const pkgCore = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "一级可回收液体芯级贮箱",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 32, lengthMm: 220, axis: "z", finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.85 },
    extraOutputs: [
      { id: "interstage_mount", positionMm: [0, 0, 110], quatWxyz: Q_ID },
      { id: "octaweb_mount", positionMm: [0, 0, -110], quatWxyz: Q_ID },
      { id: "raceway_px", positionMm: [32.5, 0, 0], quatWxyz: Q_ID },
      { id: "raceway_nx", positionMm: [-32.5, 0, 0], quatWxyz: Q_ID },
      { id: "leg_px", positionMm: [30, 0, -92], quatWxyz: quatFromZToVec(-sinLeg, 0, cosLeg) },
      { id: "leg_nx", positionMm: [-30, 0, -92], quatWxyz: quatFromZToVec(sinLeg, 0, cosLeg) },
      { id: "leg_py", positionMm: [0, 30, -92], quatWxyz: quatFromZToVec(0, -sinLeg, cosLeg) },
      { id: "leg_ny", positionMm: [0, -30, -92], quatWxyz: quatFromZToVec(0, sinLeg, cosLeg) },
      { id: "strut_px", positionMm: [31, 0, -82], quatWxyz: quatFromZToVec(20, 0, -53) },
      { id: "strut_nx", positionMm: [-31, 0, -82], quatWxyz: quatFromZToVec(-20, 0, -53) },
      { id: "strut_py", positionMm: [0, 31, -82], quatWxyz: quatFromZToVec(0, 20, -53) },
      { id: "strut_ny", positionMm: [0, -31, -82], quatWxyz: quatFromZToVec(0, -20, -53) },
    ],
  });

  const pkgRaceway = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "氧化剂输送与航电管槽",
    revision: "F9-B5",
    primitive: { shape: "box", widthMm: 4, depthMm: 7, heightMm: 192, finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.015 },
  });

  const pkgLeg = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "碳纤维锥形着陆腿",
    revision: "F9-B5",
    primitive: { shape: "cone", radiusBottomMm: 6.5, radiusTopMm: 3.5, lengthMm: 96, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, 48], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.038 },
  });

  const pkgLegStrut = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "液压收放斜支撑杆",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 2.2, lengthMm: 56, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, -28], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.015 },
  });

  const pkgOctaweb = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "八机防热承力裙框",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 33, lengthMm: 26, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, 13], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.08 },
    extraOutputs: [
      { id: "nozzle_mount", positionMm: [0, 0, -13], quatWxyz: Q_ID },
      { id: "bell_1", positionMm: [18, 0, -13], quatWxyz: Q_ID },
      { id: "bell_2", positionMm: [-18, 0, -13], quatWxyz: Q_ID },
      { id: "bell_3", positionMm: [0, 18, -13], quatWxyz: Q_ID },
      { id: "bell_4", positionMm: [0, -18, -13], quatWxyz: Q_ID },
    ],
  });

  const pkgOuterBell = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "周向固定辅助发动机喷管",
    revision: "F9-B5",
    primitive: { shape: "cone", radiusBottomMm: 8.5, radiusTopMm: 4, lengthMm: 18, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, 9], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.02 },
  });

  const pkgNozzle = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "梅林矢量核心发动机喷管 (TVC)",
    revision: "F9-B5",
    primitive: { shape: "cone", radiusBottomMm: 21, radiusTopMm: 9.5, lengthMm: 38, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, 19], quatWxyz: Q_ID },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-15, 15] },
    behavior: { kind: "moving_table", massKg: 0.12 },
  });

  const pkgInterstage = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "碳纤维复合材料级间段",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 32.5, lengthMm: 38, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -19], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.11 },
    extraOutputs: sideAngles.map((phi, i) => ({
      id: `pod_${i + 1}`,
      positionMm: [34 * Math.cos(phi), 34 * Math.sin(phi), 2] as [number, number, number],
      quatWxyz: quatAroundZ(phi),
    })),
  });

  const pkgFinPod = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "栅格翼作动铰链整流包",
    revision: "F9-B5",
    primitive: { shape: "box", widthMm: 10, depthMm: 10, heightMm: 16, finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.015 },
    extraOutputs: [{ id: "fin_out", positionMm: [16, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgGridFin = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "锻造钛合金多孔栅格翼",
    revision: "F9-B5",
    primitive: {
      shape: "plate",
      widthMm: 22,
      depthMm: 22,
      thicknessMm: 3.5,
      cornerRadiusMm: 2,
      holeDiameterMm: 5.5,
      holeInsetMm: 5.5,
      finish: "steel",
    },
    behavior: { kind: "moving_table", massKg: 0.022 },
  });

  const pkgUpper = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "二级真空推进舱贮箱",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 32, lengthMm: 86, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -43], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.22 },
  });

  const pkgSatBus = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "通信卫星星体平台",
    revision: "F9-B5",
    primitive: { shape: "box", widthMm: 20, depthMm: 20, heightMm: 26, finish: "brass" },
    input: { positionMm: [0, 0, -13], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.05 },
    extraOutputs: [
      { id: "wing_l", positionMm: [0, 12.5, 0], quatWxyz: Q_ID },
      { id: "wing_r", positionMm: [0, -12.5, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgSolarWing = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "折叠砷化镓太阳电池帆板",
    revision: "F9-B5",
    primitive: { shape: "box", widthMm: 16, depthMm: 3.5, heightMm: 24, finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.015 },
  });

  const pkgSatDish = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "Ka 波段高增益抛物面天线",
    revision: "F9-B5",
    primitive: { shape: "cone", radiusBottomMm: 3, radiusTopMm: 10, lengthMm: 7, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -3.5], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.01 },
  });

  const pkgFairingBarrel = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "复合材料整流罩柱段",
    revision: "F9-B5",
    primitive: { shape: "cylinder", radiusMm: 34.5, lengthMm: 40, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -20], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.07 },
  });

  const pkgFairingCone = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "双锥低阻气动整流罩锥段",
    revision: "F9-B5",
    primitive: { shape: "cone", radiusBottomMm: 34.5, radiusTopMm: 3, lengthMm: 68, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -34], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.07 },
  });

  const ws = [
    pkgCore,
    pkgRaceway,
    pkgLeg,
    pkgLegStrut,
    pkgOctaweb,
    pkgOuterBell,
    pkgNozzle,
    pkgInterstage,
    pkgFinPod,
    pkgGridFin,
    pkgUpper,
    pkgSatBus,
    pkgSolarWing,
    pkgSatDish,
    pkgFairingBarrel,
    pkgFairingCone,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-reusable-rocket",
    name: "两级可回收矢量推力火箭",
    baseMobility: "free",
    nodes: [
      { id: "core_stage", label: "一级液体芯级贮箱", packageKey: packageKey(pkgCore), parent: null, explodeStep: 0 },
      { id: "raceway_px", label: "前向电缆管槽 +X", packageKey: packageKey(pkgRaceway), parent: { node: "core_stage", mount: "raceway_px" }, explodeStep: 1, explodeVectorMm: [25, 0, 0] },
      { id: "raceway_nx", label: "后向电缆管槽 -X", packageKey: packageKey(pkgRaceway), parent: { node: "core_stage", mount: "raceway_nx" }, explodeStep: 1, explodeVectorMm: [-25, 0, 0] },
      { id: "leg_1", label: "着陆支腿 #1", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_px" }, explodeStep: 1, explodeVectorMm: [45, 0, -25] },
      { id: "leg_2", label: "着陆支腿 #2", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_nx" }, explodeStep: 1, explodeVectorMm: [-45, 0, -25] },
      { id: "leg_3", label: "着陆支腿 #3", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_py" }, explodeStep: 1, explodeVectorMm: [0, 45, -25] },
      { id: "leg_4", label: "着陆支腿 #4", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_ny" }, explodeStep: 1, explodeVectorMm: [0, -45, -25] },
      { id: "leg_strut_1", label: "液压斜撑杆 #1", packageKey: packageKey(pkgLegStrut), parent: { node: "core_stage", mount: "strut_px" }, explodeStep: 1, explodeVectorMm: [30, 0, -15] },
      { id: "leg_strut_2", label: "液压斜撑杆 #2", packageKey: packageKey(pkgLegStrut), parent: { node: "core_stage", mount: "strut_nx" }, explodeStep: 1, explodeVectorMm: [-30, 0, -15] },
      { id: "leg_strut_3", label: "液压斜撑杆 #3", packageKey: packageKey(pkgLegStrut), parent: { node: "core_stage", mount: "strut_py" }, explodeStep: 1, explodeVectorMm: [0, 30, -15] },
      { id: "leg_strut_4", label: "液压斜撑杆 #4", packageKey: packageKey(pkgLegStrut), parent: { node: "core_stage", mount: "strut_ny" }, explodeStep: 1, explodeVectorMm: [0, -30, -15] },
      { id: "octaweb_skirt", label: "八机防热尾裙框", packageKey: packageKey(pkgOctaweb), parent: { node: "core_stage", mount: "octaweb_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, -35] },
      {
        id: "tvc_nozzle",
        label: "梅林矢量引擎主喷管",
        packageKey: packageKey(pkgNozzle),
        parent: { node: "octaweb_skirt", mount: "nozzle_mount" },
        jointMode: "actuated",
        thruster: { maxForceN: 95, direction: [0, 0, 1], label: "梅林矢量引擎主推力" },
        explodeStep: 2,
        explodeVectorMm: [0, 0, -75],
      },
      { id: "outer_bell_1", label: "外围辅助喷管 #1", packageKey: packageKey(pkgOuterBell), parent: { node: "octaweb_skirt", mount: "bell_1" }, explodeStep: 2, explodeVectorMm: [25, 0, -55] },
      { id: "outer_bell_2", label: "外围辅助喷管 #2", packageKey: packageKey(pkgOuterBell), parent: { node: "octaweb_skirt", mount: "bell_2" }, explodeStep: 2, explodeVectorMm: [-25, 0, -55] },
      { id: "outer_bell_3", label: "外围辅助喷管 #3", packageKey: packageKey(pkgOuterBell), parent: { node: "octaweb_skirt", mount: "bell_3" }, explodeStep: 2, explodeVectorMm: [0, 25, -55] },
      { id: "outer_bell_4", label: "外围辅助喷管 #4", packageKey: packageKey(pkgOuterBell), parent: { node: "octaweb_skirt", mount: "bell_4" }, explodeStep: 2, explodeVectorMm: [0, -25, -55] },
      { id: "interstage", label: "复合材料级间段", packageKey: packageKey(pkgInterstage), parent: { node: "core_stage", mount: "interstage_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 55] },
      { id: "fin_pod_1", label: "栅格翼铰链包 #1", packageKey: packageKey(pkgFinPod), parent: { node: "interstage", mount: "pod_1" }, explodeStep: 2, explodeVectorMm: [25, 0, 35] },
      { id: "fin_1", label: "钛合金多孔栅格翼 #1", packageKey: packageKey(pkgGridFin), parent: { node: "fin_pod_1", mount: "fin_out" }, explodeStep: 2, explodeVectorMm: [45, 0, 35] },
      { id: "fin_pod_2", label: "栅格翼铰链包 #2", packageKey: packageKey(pkgFinPod), parent: { node: "interstage", mount: "pod_2" }, explodeStep: 2, explodeVectorMm: [0, 25, 35] },
      { id: "fin_2", label: "钛合金多孔栅格翼 #2", packageKey: packageKey(pkgGridFin), parent: { node: "fin_pod_2", mount: "fin_out" }, explodeStep: 2, explodeVectorMm: [0, 45, 35] },
      { id: "fin_pod_3", label: "栅格翼铰链包 #3", packageKey: packageKey(pkgFinPod), parent: { node: "interstage", mount: "pod_3" }, explodeStep: 2, explodeVectorMm: [-25, 0, 35] },
      { id: "fin_3", label: "钛合金多孔栅格翼 #3", packageKey: packageKey(pkgGridFin), parent: { node: "fin_pod_3", mount: "fin_out" }, explodeStep: 2, explodeVectorMm: [-45, 0, 35] },
      { id: "fin_pod_4", label: "栅格翼铰链包 #4", packageKey: packageKey(pkgFinPod), parent: { node: "interstage", mount: "pod_4" }, explodeStep: 2, explodeVectorMm: [0, -25, 35] },
      { id: "fin_4", label: "钛合金多孔栅格翼 #4", packageKey: packageKey(pkgGridFin), parent: { node: "fin_pod_4", mount: "fin_out" }, explodeStep: 2, explodeVectorMm: [0, -45, 35] },
      { id: "upper_stage", label: "二级真空推进段", packageKey: packageKey(pkgUpper), parent: { node: "interstage", mount: "top" }, explodeStep: 2, explodeVectorMm: [0, 0, 95] },
      { id: "payload_sat", label: "通信卫星星体平台", packageKey: packageKey(pkgSatBus), parent: { node: "upper_stage", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 125] },
      { id: "solar_wing_l", label: "左太阳电池帆板", packageKey: packageKey(pkgSolarWing), parent: { node: "payload_sat", mount: "wing_l" }, explodeStep: 3, explodeVectorMm: [0, 32, 125] },
      { id: "solar_wing_r", label: "右太阳电池帆板", packageKey: packageKey(pkgSolarWing), parent: { node: "payload_sat", mount: "wing_r" }, explodeStep: 3, explodeVectorMm: [0, -32, 125] },
      { id: "sat_dish", label: "Ka 波段高增益天线", packageKey: packageKey(pkgSatDish), parent: { node: "payload_sat", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 145] },
      { id: "fairing_barrel", label: "整流罩复合柱段", packageKey: packageKey(pkgFairingBarrel), parent: { node: "upper_stage", mount: "top" }, explodeStep: 4, explodeVectorMm: [0, 0, 195] },
      { id: "fairing_cone", label: "双锥低阻整流罩头锥", packageKey: packageKey(pkgFairingCone), parent: { node: "fairing_barrel", mount: "top" }, explodeStep: 4, explodeVectorMm: [0, 0, 225] },
    ],
    output: { node: "fairing_cone", mount: "top" },
    commands: { tvc_nozzle: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * ② 共轴双旋翼救援直升机（COM 配平机身 + 双涡轴短舱 + 锥形尾梁双垂尾 + 四撑杆滑橇 + 共轴反转旋翼）
 */
export function buildRescueHelicopterTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgCabin = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "双发轻型救援机身",
    revision: "H3",
    primitive: { shape: "box", widthMm: 144, depthMm: 56, heightMm: 40, finish: "spindle_red" },
    behavior: { kind: "moving_table", massKg: 0.36 },
    extraOutputs: [
      { id: "belly_mount", positionMm: [0, 0, -23], quatWxyz: Q_ID },
      { id: "window_mount", positionMm: [12, 0, 5], quatWxyz: Q_ID },
      { id: "engine_mount", positionMm: [-4, 0, 25], quatWxyz: Q_ID },
      { id: "cockpit_mount", positionMm: [66, 0, -1], quatWxyz: Q_ID },
      { id: "flir_mount", positionMm: [78, 0, -22], quatWxyz: Q_ID },
      { id: "tail_mount", positionMm: [-70, 0, 6], quatWxyz: Q_ID },
      { id: "mast_mount", positionMm: [0, 0, 42], quatWxyz: Q_ID },
      { id: "skid_l_mount", positionMm: [4, 44, -48], quatWxyz: Q_ID },
      { id: "skid_r_mount", positionMm: [4, -44, -48], quatWxyz: Q_ID },
      { id: "strut_fl_mount", positionMm: [42, 34, -33], quatWxyz: quatFromZToVec(0, 0.44, 0.9) },
      { id: "strut_fr_mount", positionMm: [42, -34, -33], quatWxyz: quatFromZToVec(0, -0.44, 0.9) },
      { id: "strut_rl_mount", positionMm: [-34, 34, -33], quatWxyz: quatFromZToVec(0, 0.44, 0.9) },
      { id: "strut_rr_mount", positionMm: [-34, -34, -33], quatWxyz: quatFromZToVec(0, -0.44, 0.9) },
    ],
  });

  const pkgBelly = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "复合材料圆角底壳",
    revision: "H3",
    primitive: { shape: "plate", widthMm: 152, depthMm: 58, thicknessMm: 10, cornerRadiusMm: 16, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.045 },
  });

  const pkgSideWindow = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "舷窗全景玻璃观察带",
    revision: "H3",
    primitive: { shape: "box", widthMm: 68, depthMm: 58.5, heightMm: 14, finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.015 },
  });

  const pkgCanopy = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "全景气泡风挡座舱",
    revision: "H3",
    primitive: { shape: "sphere", radiusMm: 26, finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.3 },
    extraOutputs: [{ id: "nose_mount", positionMm: [24, 0, -4], quatWxyz: Q_ID }],
  });

  const pkgNoseRadome = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "流线型机头雷达整流罩",
    revision: "H3",
    primitive: { shape: "cone", radiusBottomMm: 14, radiusTopMm: 5, lengthMm: 22, axis: "x", finish: "aerospace_white" },
    input: { positionMm: [-11, 0, 0], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.03 },
  });

  const pkgFlir = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "机颌光电搜救吊舱 (FLIR)",
    revision: "H3",
    primitive: { shape: "sphere", radiusMm: 7.5, finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.02 },
  });

  const pkgEngineDeck = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "顶部双发减速器整流罩",
    revision: "H3",
    primitive: { shape: "box", widthMm: 82, depthMm: 44, heightMm: 14, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.045 },
    extraOutputs: [
      { id: "nacelle_l", positionMm: [0, 17, 2], quatWxyz: Q_ID },
      { id: "nacelle_r", positionMm: [0, -17, 2], quatWxyz: Q_ID },
    ],
  });

  const pkgNacelle = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "涡轴发动机进气短舱",
    revision: "H3",
    primitive: { shape: "cylinder", radiusMm: 9.5, lengthMm: 70, axis: "x", finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.022 },
    extraOutputs: [{ id: "exhaust_out", positionMm: [-39, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgExhaust = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "耐高温涡喷尾气喷管",
    revision: "H3",
    primitive: { shape: "cylinder", radiusMm: 6, lengthMm: 16, axis: "x", finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.01 },
  });

  const pkgTailBoom = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "航空白锥形承力尾梁",
    revision: "H3",
    primitive: { shape: "cone", radiusBottomMm: 6.5, radiusTopMm: 14, lengthMm: 136, axis: "x", finish: "aerospace_white" },
    input: { positionMm: [68, 0, 0], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.092 },
    extraOutputs: [{ id: "stab_mount", positionMm: [-58, 0, 5], quatWxyz: Q_ID }],
  });

  const pkgHStab = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "双端板水平尾翼安定面",
    revision: "H3",
    primitive: { shape: "box", widthMm: 22, depthMm: 74, heightMm: 4.5, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.018 },
    extraOutputs: [
      { id: "fin_l", positionMm: [0, 37, 14], quatWxyz: Q_ID },
      { id: "fin_r", positionMm: [0, -37, 14], quatWxyz: Q_ID },
    ],
  });

  const pkgTailFin = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "救援红端板垂直尾翼",
    revision: "H3",
    primitive: { shape: "box", widthMm: 28, depthMm: 4, heightMm: 42, finish: "spindle_red" },
    behavior: { kind: "moving_table", massKg: 0.011 },
  });

  const pkgSkid = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "管式着陆防撞滑撬",
    revision: "H3",
    primitive: { shape: "cylinder", radiusMm: 4.5, lengthMm: 168, axis: "x", finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.05 },
  });

  const pkgStrut = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "不锈钢减震斜撑起落支柱",
    revision: "H3",
    primitive: { shape: "box", widthMm: 8, depthMm: 6, heightMm: 38, finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.015 },
  });

  const pkgSwashplate = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "共轴斜盘倾转飞控毂",
    revision: "H3",
    primitive: { shape: "cylinder", radiusMm: 13, lengthMm: 24, axis: "z", finish: "steel" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-12, 12] },
    behavior: { kind: "moving_table", massKg: 0.075 },
    extraOutputs: [{ id: "upper_mast", positionMm: [0, 0, 34], quatWxyz: Q_ID }],
  });

  const pkgLowerBlade = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "下层碳纤维主旋翼桨叶",
    revision: "H3",
    primitive: { shape: "box", widthMm: 256, depthMm: 22, heightMm: 5, finish: "anodized_black" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.04 },
    extraOutputs: [{ id: "cross_mount", positionMm: [0, 0, 0], quatWxyz: quatAroundZ(Math.PI / 2) }],
  });

  const pkgUpperBlade = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "上层共轴反向旋翼桨叶",
    revision: "H3",
    primitive: { shape: "box", widthMm: 236, depthMm: 20, heightMm: 5, finish: "aerospace_white" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.038 },
    extraOutputs: [
      { id: "cross_mount", positionMm: [0, 0, 0], quatWxyz: quatAroundZ(Math.PI / 2) },
      { id: "cap_mount", positionMm: [0, 0, 3], quatWxyz: Q_ID },
    ],
  });

  const pkgCrossBladeDark = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "下旋翼正交副桨叶",
    revision: "H3",
    primitive: { shape: "box", widthMm: 256, depthMm: 22, heightMm: 5, finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.04 },
  });

  const pkgCrossBladeWhite = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "上旋翼正交副桨叶",
    revision: "H3",
    primitive: { shape: "box", widthMm: 236, depthMm: 20, heightMm: 5, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.038 },
  });

  const pkgRotorCap = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "流线型旋翼桨毂整流帽",
    revision: "H3",
    primitive: { shape: "cone", radiusBottomMm: 11, radiusTopMm: 3, lengthMm: 12, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, -6], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.012 },
  });

  const ws = [
    pkgCabin,
    pkgBelly,
    pkgSideWindow,
    pkgCanopy,
    pkgNoseRadome,
    pkgFlir,
    pkgEngineDeck,
    pkgNacelle,
    pkgExhaust,
    pkgTailBoom,
    pkgHStab,
    pkgTailFin,
    pkgSkid,
    pkgStrut,
    pkgSwashplate,
    pkgLowerBlade,
    pkgUpperBlade,
    pkgCrossBladeDark,
    pkgCrossBladeWhite,
    pkgRotorCap,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-rescue-helicopter",
    name: "共轴双旋翼救援直升机",
    baseMobility: "free",
    nodes: [
      { id: "cabin_body", label: "救援直升机主体舱", packageKey: packageKey(pkgCabin), parent: null, explodeStep: 0 },
      { id: "belly_keel", label: "复合圆角底壳", packageKey: packageKey(pkgBelly), parent: { node: "cabin_body", mount: "belly_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, -25] },
      { id: "cabin_window", label: "侧舷玻璃观察带", packageKey: packageKey(pkgSideWindow), parent: { node: "cabin_body", mount: "window_mount" }, explodeStep: 1, explodeVectorMm: [0, 28, 12] },
      { id: "cockpit_glass", label: "全景风挡球舱", packageKey: packageKey(pkgCanopy), parent: { node: "cabin_body", mount: "cockpit_mount" }, explodeStep: 1, explodeVectorMm: [50, 0, 10] },
      { id: "nose_radome", label: "气象雷达头锥", packageKey: packageKey(pkgNoseRadome), parent: { node: "cockpit_glass", mount: "nose_mount" }, explodeStep: 2, explodeVectorMm: [75, 0, 8] },
      { id: "flir_turret", label: "光电搜救转塔", packageKey: packageKey(pkgFlir), parent: { node: "cabin_body", mount: "flir_mount" }, explodeStep: 1, explodeVectorMm: [45, 0, -25] },
      { id: "engine_deck", label: "双涡轴动力罩", packageKey: packageKey(pkgEngineDeck), parent: { node: "cabin_body", mount: "engine_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 35] },
      { id: "nacelle_l", label: "左涡轴短舱", packageKey: packageKey(pkgNacelle), parent: { node: "engine_deck", mount: "nacelle_l" }, explodeStep: 2, explodeVectorMm: [0, 32, 35] },
      { id: "exhaust_l", label: "左涡喷尾管", packageKey: packageKey(pkgExhaust), parent: { node: "nacelle_l", mount: "exhaust_out" }, explodeStep: 2, explodeVectorMm: [-25, 32, 35] },
      { id: "nacelle_r", label: "右涡轴短舱", packageKey: packageKey(pkgNacelle), parent: { node: "engine_deck", mount: "nacelle_r" }, explodeStep: 2, explodeVectorMm: [0, -32, 35] },
      { id: "exhaust_r", label: "右涡喷尾管", packageKey: packageKey(pkgExhaust), parent: { node: "nacelle_r", mount: "exhaust_out" }, explodeStep: 2, explodeVectorMm: [-25, -32, 35] },
      { id: "tail_boom", label: "航空白锥形尾梁", packageKey: packageKey(pkgTailBoom), parent: { node: "cabin_body", mount: "tail_mount" }, explodeStep: 1, explodeVectorMm: [-65, 0, 0] },
      { id: "h_stab", label: "水平安定面", packageKey: packageKey(pkgHStab), parent: { node: "tail_boom", mount: "stab_mount" }, explodeStep: 2, explodeVectorMm: [-55, 0, 20] },
      { id: "tail_fin_l", label: "左端板垂直尾翼", packageKey: packageKey(pkgTailFin), parent: { node: "h_stab", mount: "fin_l" }, explodeStep: 2, explodeVectorMm: [-55, 30, 42] },
      { id: "tail_fin_r", label: "右端板垂直尾翼", packageKey: packageKey(pkgTailFin), parent: { node: "h_stab", mount: "fin_r" }, explodeStep: 2, explodeVectorMm: [-55, -30, 42] },
      { id: "skid_l", label: "左管式着陆滑撬", packageKey: packageKey(pkgSkid), parent: { node: "cabin_body", mount: "skid_l_mount" }, explodeStep: 1, explodeVectorMm: [0, 38, -32] },
      { id: "skid_r", label: "右管式着陆滑撬", packageKey: packageKey(pkgSkid), parent: { node: "cabin_body", mount: "skid_r_mount" }, explodeStep: 1, explodeVectorMm: [0, -38, -32] },
      { id: "strut_fl", label: "左前斜撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_fl_mount" }, explodeStep: 1, explodeVectorMm: [20, 26, -18] },
      { id: "strut_fr", label: "右前斜撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_fr_mount" }, explodeStep: 1, explodeVectorMm: [20, -26, -18] },
      { id: "strut_rl", label: "左后斜撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_rl_mount" }, explodeStep: 1, explodeVectorMm: [-20, 26, -18] },
      { id: "strut_rr", label: "右后斜撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_rr_mount" }, explodeStep: 1, explodeVectorMm: [-20, -26, -18] },
      {
        id: "swashplate_tilt",
        label: "倾斜盘总距飞控毂",
        packageKey: packageKey(pkgSwashplate),
        parent: { node: "cabin_body", mount: "mast_mount" },
        jointMode: "actuated",
        thruster: { maxForceN: 60, direction: [0, 0, 1], label: "共轴双旋翼总距升力" },
        explodeStep: 2,
        explodeVectorMm: [0, 0, 45],
      },
      {
        id: "lower_rotor",
        label: "下旋翼四叶组 (顺时针)",
        packageKey: packageKey(pkgLowerBlade),
        parent: { node: "swashplate_tilt", mount: "top" },
        jointMode: "velocity",
        explodeStep: 3,
        explodeVectorMm: [0, 0, 65],
      },
      {
        id: "lower_rotor_cross",
        label: "下旋翼正交副叶",
        packageKey: packageKey(pkgCrossBladeDark),
        parent: { node: "lower_rotor", mount: "cross_mount" },
        explodeStep: 3,
        explodeVectorMm: [0, 0, 65],
      },
      {
        id: "upper_rotor",
        label: "上旋翼四叶组 (反扭逆转)",
        packageKey: packageKey(pkgUpperBlade),
        parent: { node: "swashplate_tilt", mount: "upper_mast" },
        jointMode: "velocity",
        coupledTo: { path: "lower_rotor", ratio: -1 },
        explodeStep: 4,
        explodeVectorMm: [0, 0, 98],
      },
      {
        id: "upper_rotor_cross",
        label: "上旋翼正交副叶",
        packageKey: packageKey(pkgCrossBladeWhite),
        parent: { node: "upper_rotor", mount: "cross_mount" },
        explodeStep: 4,
        explodeVectorMm: [0, 0, 98],
      },
      { id: "rotor_cap", label: "桨毂流线整流帽", packageKey: packageKey(pkgRotorCap), parent: { node: "upper_rotor", mount: "cap_mount" }, explodeStep: 5, explodeVectorMm: [0, 0, 120] },
    ],
    output: { node: "cabin_body", mount: "center" },
    commands: { swashplate_tilt: 0, lower_rotor: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * ③ 东方明珠三级旋转观光塔（清水混凝土三斜撑 + 黛紫红串珠球体 + 冰蓝玻璃幕墙观光旋转层）
 */
export function buildOrientalPearlTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const angles = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3] as const;

  const pkgPodium = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "外滩圆形清水混凝土基座",
    revision: "SH",
    primitive: { shape: "cylinder", radiusMm: 98, lengthMm: 16, axis: "z", finish: "concrete_gray" },
    behavior: { kind: "moving_table", massKg: 4.5 },
    extraOutputs: [
      { id: "core_mount", positionMm: [0, 0, 8], quatWxyz: Q_ID },
      ...angles.map((phi, i) => ({
        id: `col_mount_${i + 1}`,
        positionMm: [66 * Math.cos(phi), 66 * Math.sin(phi), 8] as [number, number, number],
        quatWxyz: quatFromZToVec(-46 * Math.cos(phi), -46 * Math.sin(phi), 120),
      })),
    ],
  });

  const pkgTripodCol = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "C60 混凝土斜撑巨柱",
    revision: "SH",
    primitive: { shape: "cylinder", radiusMm: 9.5, lengthMm: 132, axis: "z", finish: "concrete_gray" },
    input: { positionMm: [0, 0, -66], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.45 },
  });

  const pkgCoreTube = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "中心垂直电梯核心筒",
    revision: "SH",
    primitive: { shape: "tube", outerRadiusMm: 10.5, innerRadiusMm: 6, lengthMm: 374, axis: "z", finish: "concrete_gray" },
    input: { positionMm: [0, 0, -187], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.9 },
    extraOutputs: [
      { id: "orbit_deck_mount", positionMm: [0, 0, -69], quatWxyz: Q_ID },
      { id: "lower_pearl_mount", positionMm: [0, 0, -69], quatWxyz: Q_ID },
      { id: "mid_pearl_1_mount", positionMm: [0, 0, -7], quatWxyz: Q_ID },
      { id: "mid_pearl_2_mount", positionMm: [0, 0, 18], quatWxyz: Q_ID },
      { id: "mid_pearl_3_mount", positionMm: [0, 0, 43], quatWxyz: Q_ID },
      { id: "restaurant_mount", positionMm: [0, 0, 99], quatWxyz: Q_ID },
      { id: "upper_pearl_mount", positionMm: [0, 0, 97], quatWxyz: Q_ID },
      { id: "space_capsule_mount", positionMm: [0, 0, 169], quatWxyz: Q_ID },
    ],
  });

  const pkgLowerPearl = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "90m 黛紫红主下球体",
    revision: "SH",
    primitive: { shape: "sphere", radiusMm: 46, finish: "pearl_crimson" },
    behavior: { kind: "moving_table", massKg: 0.65 },
  });

  const pkgMidPearl = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "太空酒店中段串珠小球",
    revision: "SH",
    primitive: { shape: "sphere", radiusMm: 15, finish: "pearl_crimson" },
    behavior: { kind: "moving_table", massKg: 0.08 },
  });

  const pkgUpperPearl = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "263m 主观光球体",
    revision: "SH",
    primitive: { shape: "sphere", radiusMm: 34, finish: "pearl_crimson" },
    behavior: { kind: "moving_table", massKg: 0.42 },
  });

  const pkgOrbitRing = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "98m 冰蓝玻璃观光旋转环",
    revision: "SH",
    primitive: { shape: "cylinder", radiusMm: 48.5, lengthMm: 9, axis: "z", finish: "curtain_glass" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.16 },
    extraOutputs: [
      { id: "pod_1", positionMm: [49.2, 0, 0], quatWxyz: Q_ID },
      { id: "pod_2", positionMm: [-49.2, 0, 0], quatWxyz: Q_ID },
      { id: "pod_3", positionMm: [0, 49.2, 0], quatWxyz: quatAroundZ(Math.PI / 2) },
      { id: "pod_4", positionMm: [0, -49.2, 0], quatWxyz: quatAroundZ(Math.PI / 2) },
    ],
  });

  const pkgObsMullion = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "银白玻璃幕墙竖梃窗框",
    revision: "SH",
    primitive: { shape: "box", widthMm: 4.5, depthMm: 14, heightMm: 8, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.02 },
  });

  const pkgRestaurantDeck = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "267m 冰蓝玻璃空中旋转餐厅",
    revision: "SH",
    primitive: { shape: "cylinder", radiusMm: 36.5, lengthMm: 9, axis: "z", finish: "curtain_glass" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.14 },
    extraOutputs: [
      { id: "bay_px", positionMm: [37.2, 0, 0], quatWxyz: Q_ID },
      { id: "bay_nx", positionMm: [-37.2, 0, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgGlassBay = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "旋转餐厅银白挑窗框",
    revision: "SH",
    primitive: { shape: "box", widthMm: 4.5, depthMm: 16, heightMm: 8, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.025 },
  });

  const pkgSpaceCapsule = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "350m 太空舱银白旋转顶球",
    revision: "SH",
    primitive: { shape: "sphere", radiusMm: 19, finish: "aerospace_white" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.1 },
    extraOutputs: [
      { id: "beacon_px", positionMm: [18.5, 0, 0], quatWxyz: Q_ID },
      { id: "beacon_nx", positionMm: [-18.5, 0, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgCapsuleWindow = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "太空舱冰蓝全景观景窗",
    revision: "SH",
    primitive: { shape: "box", widthMm: 4, depthMm: 12, heightMm: 6, finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.02 },
  });

  const pkgSpirePedestal = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "混凝土收分天线基筒",
    revision: "SH",
    primitive: { shape: "cone", radiusBottomMm: 10.5, radiusTopMm: 5.5, lengthMm: 58, axis: "z", finish: "concrete_gray" },
    input: { positionMm: [0, 0, -29], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.15 },
  });

  const pkgSpire = buildPrimitivePartPackage({
    manufacturer: "构元地标",
    model: "468m 银白电视广播发射天线桅杆",
    revision: "SH",
    primitive: { shape: "cone", radiusBottomMm: 4.5, radiusTopMm: 1.0, lengthMm: 92, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -46], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.12 },
  });

  const ws = [
    pkgPodium,
    pkgTripodCol,
    pkgCoreTube,
    pkgLowerPearl,
    pkgMidPearl,
    pkgUpperPearl,
    pkgOrbitRing,
    pkgObsMullion,
    pkgRestaurantDeck,
    pkgGlassBay,
    pkgSpaceCapsule,
    pkgCapsuleWindow,
    pkgSpirePedestal,
    pkgSpire,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-oriental-pearl",
    name: "东方明珠三级旋转观光塔",
    baseMobility: "fixed",
    nodes: [
      { id: "bund_podium", label: "外滩圆形清水混凝土基座", packageKey: packageKey(pkgPodium), parent: null, explodeStep: 0 },
      { id: "mega_col_1", label: "东侧混凝土斜撑巨柱", packageKey: packageKey(pkgTripodCol), parent: { node: "bund_podium", mount: "col_mount_1" }, explodeStep: 1, explodeVectorMm: [55, 0, 20] },
      { id: "mega_col_2", label: "西北混凝土斜撑巨柱", packageKey: packageKey(pkgTripodCol), parent: { node: "bund_podium", mount: "col_mount_2" }, explodeStep: 1, explodeVectorMm: [-32, 48, 20] },
      { id: "mega_col_3", label: "西南混凝土斜撑巨柱", packageKey: packageKey(pkgTripodCol), parent: { node: "bund_podium", mount: "col_mount_3" }, explodeStep: 1, explodeVectorMm: [-32, -48, 20] },
      { id: "core_tube", label: "全高度电梯核心井筒", packageKey: packageKey(pkgCoreTube), parent: { node: "bund_podium", mount: "core_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
      {
        id: "lower_orbit_ring",
        label: "① 98m 冰蓝玻璃观光旋转环",
        packageKey: packageKey(pkgOrbitRing),
        parent: { node: "core_tube", mount: "orbit_deck_mount" },
        jointMode: "velocity",
        explodeStep: 2,
        explodeVectorMm: [0, 0, -35],
      },
      { id: "orbit_pod_1", label: "观光环银白竖梃 #1", packageKey: packageKey(pkgObsMullion), parent: { node: "lower_orbit_ring", mount: "pod_1" }, explodeStep: 3, explodeVectorMm: [30, 0, 0] },
      { id: "orbit_pod_2", label: "观光环银白竖梃 #2", packageKey: packageKey(pkgObsMullion), parent: { node: "lower_orbit_ring", mount: "pod_2" }, explodeStep: 3, explodeVectorMm: [-30, 0, 0] },
      { id: "orbit_pod_3", label: "观光环银白竖梃 #3", packageKey: packageKey(pkgObsMullion), parent: { node: "lower_orbit_ring", mount: "pod_3" }, explodeStep: 3, explodeVectorMm: [0, 30, 0] },
      { id: "orbit_pod_4", label: "观光环银白竖梃 #4", packageKey: packageKey(pkgObsMullion), parent: { node: "lower_orbit_ring", mount: "pod_4" }, explodeStep: 3, explodeVectorMm: [0, -30, 0] },
      { id: "lower_pearl", label: "90m 黛紫红主下球体", packageKey: packageKey(pkgLowerPearl), parent: { node: "core_tube", mount: "lower_pearl_mount" }, explodeStep: 2, explodeVectorMm: [-70, 0, 0] },
      { id: "mid_pearl_1", label: "中段酒店串珠 #1", packageKey: packageKey(pkgMidPearl), parent: { node: "core_tube", mount: "mid_pearl_1_mount" }, explodeStep: 2, explodeVectorMm: [45, 0, 0] },
      { id: "mid_pearl_2", label: "中段酒店串珠 #2", packageKey: packageKey(pkgMidPearl), parent: { node: "core_tube", mount: "mid_pearl_2_mount" }, explodeStep: 2, explodeVectorMm: [-45, 0, 0] },
      { id: "mid_pearl_3", label: "中段酒店串珠 #3", packageKey: packageKey(pkgMidPearl), parent: { node: "core_tube", mount: "mid_pearl_3_mount" }, explodeStep: 2, explodeVectorMm: [0, 45, 0] },
      {
        id: "sky_restaurant_deck",
        label: "② 267m 空中旋转餐厅玻璃环",
        packageKey: packageKey(pkgRestaurantDeck),
        parent: { node: "core_tube", mount: "restaurant_mount" },
        jointMode: "velocity",
        explodeStep: 3,
        explodeVectorMm: [65, 0, 20],
      },
      { id: "rest_bay_a", label: "旋转餐厅银白挑窗框 A", packageKey: packageKey(pkgGlassBay), parent: { node: "sky_restaurant_deck", mount: "bay_px" }, explodeStep: 4, explodeVectorMm: [25, 0, 0] },
      { id: "rest_bay_b", label: "旋转餐厅银白挑窗框 B", packageKey: packageKey(pkgGlassBay), parent: { node: "sky_restaurant_deck", mount: "bay_nx" }, explodeStep: 4, explodeVectorMm: [-25, 0, 0] },
      { id: "upper_pearl", label: "263m 黛紫红主观光球体", packageKey: packageKey(pkgUpperPearl), parent: { node: "core_tube", mount: "upper_pearl_mount" }, explodeStep: 3, explodeVectorMm: [0, 65, 35] },
      {
        id: "space_capsule_rotor",
        label: "③ 350m 银色太空舱旋转层",
        packageKey: packageKey(pkgSpaceCapsule),
        parent: { node: "core_tube", mount: "space_capsule_mount" },
        jointMode: "velocity",
        explodeStep: 4,
        explodeVectorMm: [0, 0, 60],
      },
      { id: "space_beacon_a", label: "太空舱冰蓝观景窗 A", packageKey: packageKey(pkgCapsuleWindow), parent: { node: "space_capsule_rotor", mount: "beacon_px" }, explodeStep: 5, explodeVectorMm: [25, 0, 0] },
      { id: "space_beacon_b", label: "太空舱冰蓝观景窗 B", packageKey: packageKey(pkgCapsuleWindow), parent: { node: "space_capsule_rotor", mount: "beacon_nx" }, explodeStep: 5, explodeVectorMm: [-25, 0, 0] },
      { id: "spire_pedestal", label: "410m 混凝土收分天线基筒", packageKey: packageKey(pkgSpirePedestal), parent: { node: "core_tube", mount: "top" }, explodeStep: 4, explodeVectorMm: [0, 0, 80] },
      { id: "antenna_spire", label: "468m 银白发射天线桅杆", packageKey: packageKey(pkgSpire), parent: { node: "spire_pedestal", mount: "top" }, explodeStep: 5, explodeVectorMm: [0, 0, 115] },
    ],
    output: { node: "antenna_spire", mount: "top" },
    commands: { lower_orbit_ring: 0, sky_restaurant_deck: 0, space_capsule_rotor: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * ④ 四轮差速越障探索车（护甲底盘 + 防撞杠 + 轮毂胶胎 + 双目/激光雷达感知桅杆）
 */
export function buildFourWheelRoverTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgChassis = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "铝合金增强型底盘箱体",
    revision: "R2",
    primitive: { shape: "box", widthMm: 190, depthMm: 120, heightMm: 18, finish: "anodized_black" },
    extraOutputs: [
      { id: "deck_mount", positionMm: [0, 0, 12], quatWxyz: Q_ID },
      { id: "bumper_f", positionMm: [98, 0, 4], quatWxyz: Q_ID },
      { id: "bumper_r", positionMm: [-98, 0, 4], quatWxyz: Q_ID },
      { id: "pod_l", positionMm: [0, 56, 14], quatWxyz: Q_ID },
      { id: "pod_r", positionMm: [0, -56, 14], quatWxyz: Q_ID },
      { id: "fl_axle", positionMm: [68, 74, -12], quatWxyz: Q_ID },
      { id: "fr_axle", positionMm: [68, -74, -12], quatWxyz: Q_ID },
      { id: "rl_axle", positionMm: [-68, 74, -12], quatWxyz: Q_ID },
      { id: "rr_axle", positionMm: [-68, -74, -12], quatWxyz: Q_ID },
      { id: "mast_mount", positionMm: [55, 0, 15], quatWxyz: Q_ID },
    ],
  });

  const pkgTopDeck = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "CNC 铣削圆角上盖板",
    revision: "R2",
    primitive: { shape: "plate", widthMm: 184, depthMm: 112, thicknessMm: 6, cornerRadiusMm: 10, holeDiameterMm: 5, holeInsetMm: 10, finish: "aluminum" },
    behavior: { kind: "moving_table", massKg: 0.14 },
  });

  const pkgBumper = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "管式不锈钢防撞防滚杠",
    revision: "R2",
    primitive: { shape: "cylinder", radiusMm: 4.5, lengthMm: 116, axis: "y", finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.04 },
  });

  const pkgSidePod = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "侧置动力电池与电调护盒",
    revision: "R2",
    primitive: { shape: "box", widthMm: 46, depthMm: 12, heightMm: 14, finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.06 },
  });

  const pkgWheel = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "Ø84 高摩擦橡胶越野胎",
    revision: "R2",
    primitive: { shape: "cylinder", radiusMm: 42, lengthMm: 24, axis: "y", finish: "rubber_grip" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-36000, 36000] },
  });

  const pkgRim = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "双面机加工铝合金轮毂",
    revision: "R2",
    primitive: { shape: "cylinder", radiusMm: 23, lengthMm: 26, axis: "y", finish: "aluminum" },
    behavior: { kind: "moving_table", massKg: 0.04 },
  });

  const pkgMastPost = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "2020 铝型材感知立柱",
    revision: "R2",
    primitive: { shape: "extrusion_profile", series: "2020", lengthMm: 44, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -22], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.035 },
  });

  const pkgStereoCam = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "双目深度视觉相机云台",
    revision: "R2",
    primitive: { shape: "box", widthMm: 18, depthMm: 52, heightMm: 14, finish: "aerospace_white" },
    input: { positionMm: [0, 0, -7], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.035 },
    extraOutputs: [{ id: "visor_mount", positionMm: [10, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgCamVisor = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "光学镀膜双目视窗",
    revision: "R2",
    primitive: { shape: "box", widthMm: 4, depthMm: 42, heightMm: 8, finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.01 },
  });

  const pkgMast = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "16 线三维激光雷达塔头",
    revision: "R2",
    primitive: { shape: "cylinder", radiusMm: 16, lengthMm: 18, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, -9], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.035 },
  });

  const pkgLidarGlass = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "红外光学激光扫描窗口",
    revision: "R2",
    primitive: { shape: "cylinder", radiusMm: 16.4, lengthMm: 8, axis: "z", finish: "curtain_glass" },
    behavior: { kind: "moving_table", massKg: 0.01 },
  });

  const ws = [
    pkgChassis,
    pkgTopDeck,
    pkgBumper,
    pkgSidePod,
    pkgWheel,
    pkgRim,
    pkgMastPost,
    pkgStereoCam,
    pkgCamVisor,
    pkgMast,
    pkgLidarGlass,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-four-wheel-rover",
    name: "四轮差速越障探索车",
    baseMobility: "free",
    nodes: [
      { id: "chassis", label: "下层装甲底盘框", packageKey: packageKey(pkgChassis), parent: null, explodeStep: 0 },
      { id: "top_deck", label: "CNC 铝制仪器盖板", packageKey: packageKey(pkgTopDeck), parent: { node: "chassis", mount: "deck_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 25] },
      { id: "bumper_f", label: "前向钢制防撞杠", packageKey: packageKey(pkgBumper), parent: { node: "chassis", mount: "bumper_f" }, explodeStep: 1, explodeVectorMm: [35, 0, 0] },
      { id: "bumper_r", label: "后向钢制防撞杠", packageKey: packageKey(pkgBumper), parent: { node: "chassis", mount: "bumper_r" }, explodeStep: 1, explodeVectorMm: [-35, 0, 0] },
      { id: "side_pod_l", label: "左电调电池护盒", packageKey: packageKey(pkgSidePod), parent: { node: "chassis", mount: "pod_l" }, explodeStep: 1, explodeVectorMm: [0, 28, 12] },
      { id: "side_pod_r", label: "右电调电池护盒", packageKey: packageKey(pkgSidePod), parent: { node: "chassis", mount: "pod_r" }, explodeStep: 1, explodeVectorMm: [0, -28, 12] },
      { id: "wheel_fl", label: "左前橡胶驱动胎", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "fl_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, 48, 0] },
      { id: "rim_fl", label: "左前铝合金轮毂", packageKey: packageKey(pkgRim), parent: { node: "wheel_fl", mount: "center" }, explodeStep: 2, explodeVectorMm: [0, 72, 0] },
      { id: "wheel_fr", label: "右前橡胶驱动胎", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "fr_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, -48, 0] },
      { id: "rim_fr", label: "右前铝合金轮毂", packageKey: packageKey(pkgRim), parent: { node: "wheel_fr", mount: "center" }, explodeStep: 2, explodeVectorMm: [0, -72, 0] },
      { id: "wheel_rl", label: "左后橡胶驱动胎", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "rl_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, 48, 0] },
      { id: "rim_rl", label: "左后铝合金轮毂", packageKey: packageKey(pkgRim), parent: { node: "wheel_rl", mount: "center" }, explodeStep: 2, explodeVectorMm: [0, 72, 0] },
      { id: "wheel_rr", label: "右后橡胶驱动胎", packageKey: packageKey(pkgWheel), parent: { node: "chassis", mount: "rr_axle" }, jointMode: "velocity", explodeStep: 1, explodeVectorMm: [0, -48, 0] },
      { id: "rim_rr", label: "右后铝合金轮毂", packageKey: packageKey(pkgRim), parent: { node: "wheel_rr", mount: "center" }, explodeStep: 2, explodeVectorMm: [0, -72, 0] },
      { id: "mast_post", label: "2020 感知桅杆柱", packageKey: packageKey(pkgMastPost), parent: { node: "chassis", mount: "mast_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 35] },
      { id: "stereo_cam", label: "双目立体相机仓", packageKey: packageKey(pkgStereoCam), parent: { node: "mast_post", mount: "top" }, explodeStep: 2, explodeVectorMm: [0, 0, 55] },
      { id: "cam_visor", label: "双目光学视窗", packageKey: packageKey(pkgCamVisor), parent: { node: "stereo_cam", mount: "visor_mount" }, explodeStep: 2, explodeVectorMm: [18, 0, 55] },
      { id: "nav_sensor", label: "车顶三维激光雷达", packageKey: packageKey(pkgMast), parent: { node: "stereo_cam", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 78] },
      { id: "lidar_window", label: "激光雷达红外光窗", packageKey: packageKey(pkgLidarGlass), parent: { node: "nav_sensor", mount: "center" }, explodeStep: 3, explodeVectorMm: [0, 0, 78] },
    ],
    output: { node: "nav_sensor", mount: "top" },
    commands: { wheel_fl: 0, wheel_fr: 0, wheel_rl: 0, wheel_rr: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * ⑤ 二指摩擦夹爪取物机械臂（带孔底座 + 立柱加强肋 + Z向导轨伺服 + 金属强化平行夹指）
 */
export function buildGripperPickArmTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "带安装孔机加工底座板",
    revision: "G3",
    primitive: { shape: "plate", widthMm: 140, depthMm: 156, thicknessMm: 18, cornerRadiusMm: 10, holeDiameterMm: 7, holeInsetMm: 14, finish: "anodized_black" },
    extraOutputs: [
      { id: "col_mount", positionMm: [0, 0, 9], quatWxyz: Q_ID },
      { id: "rib_back", positionMm: [-32, 0, 27], quatWxyz: Q_ID },
      { id: "rib_l", positionMm: [0, 32, 27], quatWxyz: Q_ID },
      { id: "rib_r", positionMm: [0, -32, 27], quatWxyz: Q_ID },
    ],
  });

  const pkgRibBack = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "后向立柱直角加强肋板",
    revision: "G3",
    primitive: { shape: "box", widthMm: 28, depthMm: 10, heightMm: 36, finish: "steel" },
  });

  const pkgRibSide = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "侧向立柱直角加强肋板",
    revision: "G3",
    primitive: { shape: "box", widthMm: 10, depthMm: 28, heightMm: 36, finish: "steel" },
  });

  const pkgCol = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "4040 重型门架立柱",
    revision: "G3",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 240, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -120], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "z_carriage_mount", positionMm: [40, 0, 52], quatWxyz: Q_ID },
      { id: "rail_mount", positionMm: [27, 0, 10], quatWxyz: quatAroundZ(Math.PI / 2) },
      { id: "motor_mount", positionMm: [0, 0, 141], quatWxyz: quatFromZToVec(0, 0, -1) },
    ],
  });

  const pkgZRail = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "MGN15 直线导轨副",
    revision: "G3",
    primitive: {
      shape: "linear_rail_block",
      railLengthMm: 190,
      railWidthMm: 18,
      blockLengthMm: 38,
      blockWidthMm: 26,
      heightMm: 14,
      axis: "z",
      finish: "steel",
    },
  });

  const pkgZMotor = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "NEMA23 Z 向步进驱动电机",
    revision: "G3",
    primitive: { shape: "servo_motor_body", flangeMm: 42, bodyLengthMm: 42, shaftLengthMm: 14, shaftDiameterMm: 8, axis: "z", finish: "anodized_black" },
  });

  const pkgZCarriage = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "Z 向精密升降滑座",
    revision: "G3",
    primitive: { shape: "box", widthMm: 36, depthMm: 46, heightMm: 38, finish: "steel" },
    input: { positionMm: [-18, 0, 0], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 0, 1], unit: "mm", range: [-95, 55] },
    extraOutputs: [{ id: "boom_mount", positionMm: [18, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgBoom = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "前伸刚性悬臂梁",
    revision: "G3",
    primitive: { shape: "box", widthMm: 82, depthMm: 44, heightMm: 16, finish: "aluminum" },
    input: { positionMm: [-41, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "palm_mount", positionMm: [41, 0, -8], quatWxyz: Q_ID },
      { id: "flange_mount", positionMm: [41, 0, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgWristFlange = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "ISO 工具端过渡法兰盘",
    revision: "G3",
    primitive: { shape: "cylinder", radiusMm: 22, lengthMm: 12, axis: "z", finish: "steel" },
  });

  const pkgPalm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "平行二指夹爪导轨座",
    revision: "G3",
    primitive: { shape: "plate", widthMm: 32, depthMm: 94, thicknessMm: 12, cornerRadiusMm: 4, holeDiameterMm: 4, holeInsetMm: 7, finish: "anodized_black" },
    input: { positionMm: [0, 0, 6], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "pack_mount", positionMm: [0, 0, 14], quatWxyz: Q_ID },
      { id: "jaw_l_mount", positionMm: [0, 30, -6], quatWxyz: Q_ID },
      { id: "jaw_r_mount", positionMm: [0, -30, -6], quatWxyz: Q_ID },
    ],
  });

  const pkgJawActuator = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "电动平行夹爪驱动仓",
    revision: "G3",
    primitive: { shape: "box", widthMm: 34, depthMm: 54, heightMm: 16, finish: "aerospace_white" },
  });

  const pkgJawLeft = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "左防滑橡胶夹持垫",
    revision: "G3",
    primitive: { shape: "box", widthMm: 26, depthMm: 12, heightMm: 54, finish: "rubber_grip" },
    input: { positionMm: [0, 0, 27], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, -1, 0], unit: "mm", range: [-8, 22] },
    extraOutputs: [{ id: "outer_brace", positionMm: [0, 8, 2], quatWxyz: Q_ID }],
  });

  const pkgJawRight = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "右防滑橡胶夹持垫",
    revision: "G3",
    primitive: { shape: "box", widthMm: 26, depthMm: 12, heightMm: 54, finish: "rubber_grip" },
    input: { positionMm: [0, 0, 27], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-8, 22] },
    extraOutputs: [{ id: "outer_brace", positionMm: [0, -8, 2], quatWxyz: Q_ID }],
  });

  const pkgFingerAlu = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "铝合金高刚性夹指背板",
    revision: "G3",
    primitive: { shape: "box", widthMm: 24, depthMm: 5, heightMm: 46, finish: "aluminum" },
  });

  const ws = [
    pkgBase,
    pkgRibBack,
    pkgRibSide,
    pkgCol,
    pkgZRail,
    pkgZMotor,
    pkgZCarriage,
    pkgBoom,
    pkgWristFlange,
    pkgPalm,
    pkgJawActuator,
    pkgJawLeft,
    pkgJawRight,
    pkgFingerAlu,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-gripper-pick-arm",
    name: "二指摩擦夹爪取物机械臂",
    baseMobility: "fixed",
    nodes: [
      { id: "arm_base", label: "带孔装配底座板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "col_rib_back", label: "立柱后向加强肋", packageKey: packageKey(pkgRibBack), parent: { node: "arm_base", mount: "rib_back" }, explodeStep: 1, explodeVectorMm: [-25, 0, 0] },
      { id: "col_rib_l", label: "立柱左向加强肋", packageKey: packageKey(pkgRibSide), parent: { node: "arm_base", mount: "rib_l" }, explodeStep: 1, explodeVectorMm: [0, 25, 0] },
      { id: "col_rib_r", label: "立柱右向加强肋", packageKey: packageKey(pkgRibSide), parent: { node: "arm_base", mount: "rib_r" }, explodeStep: 1, explodeVectorMm: [0, -25, 0] },
      { id: "arm_col", label: "4040 垂直门架立柱", packageKey: packageKey(pkgCol), parent: { node: "arm_base", mount: "col_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 60] },
      { id: "z_rail", label: "Z 轴直线导轨副", packageKey: packageKey(pkgZRail), parent: { node: "arm_col", mount: "rail_mount" }, explodeStep: 2, explodeVectorMm: [25, 0, 60] },
      { id: "z_motor", label: "顶部步进伺服电机", packageKey: packageKey(pkgZMotor), parent: { node: "arm_col", mount: "motor_mount" }, explodeStep: 2, explodeVectorMm: [0, 0, 95] },
      { id: "z_lift", label: "Z 轴升降滑座", packageKey: packageKey(pkgZCarriage), parent: { node: "arm_col", mount: "z_carriage_mount" }, jointMode: "actuated", explodeStep: 2, explodeVectorMm: [50, 0, 0] },
      { id: "arm_boom", label: "前伸刚性悬臂梁", packageKey: packageKey(pkgBoom), parent: { node: "z_lift", mount: "boom_mount" }, explodeStep: 3, explodeVectorMm: [55, 0, 0] },
      { id: "wrist_flange", label: "端拾器过渡法兰盘", packageKey: packageKey(pkgWristFlange), parent: { node: "arm_boom", mount: "flange_mount" }, explodeStep: 3, explodeVectorMm: [55, 0, -18] },
      { id: "gripper_palm", label: "平行夹爪导轨座", packageKey: packageKey(pkgPalm), parent: { node: "arm_boom", mount: "palm_mount" }, explodeStep: 4, explodeVectorMm: [0, 0, -40] },
      { id: "jaw_actuator_box", label: "电动平行夹爪驱动仓", packageKey: packageKey(pkgJawActuator), parent: { node: "gripper_palm", mount: "pack_mount" }, explodeStep: 4, explodeVectorMm: [0, 0, -20] },
      { id: "jaw_left", label: "左防滑橡胶夹持垫", packageKey: packageKey(pkgJawLeft), parent: { node: "gripper_palm", mount: "jaw_l_mount" }, jointMode: "actuated", explodeStep: 5, explodeVectorMm: [0, 35, -35] },
      { id: "finger_alu_l", label: "左夹指铝制加强背板", packageKey: packageKey(pkgFingerAlu), parent: { node: "jaw_left", mount: "outer_brace" }, explodeStep: 5, explodeVectorMm: [0, 52, -35] },
      {
        id: "jaw_right",
        label: "右防滑橡胶夹持垫 (耦合)",
        packageKey: packageKey(pkgJawRight),
        parent: { node: "gripper_palm", mount: "jaw_r_mount" },
        jointMode: "actuated",
        coupledTo: { path: "jaw_left", ratio: 1 },
        explodeStep: 5,
        explodeVectorMm: [0, -35, -35],
      },
      { id: "finger_alu_r", label: "右夹指铝制加强背板", packageKey: packageKey(pkgFingerAlu), parent: { node: "jaw_right", mount: "outer_brace" }, explodeStep: 5, explodeVectorMm: [0, -52, -35] },
    ],
    output: { node: "gripper_palm", mount: "bottom" },
    commands: { z_lift: 0, jaw_left: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * ⑥ 闭链四连杆曲柄摇杆机构（满足 Grashof 条件 + 带座轴承/伺服驱动/平衡盘 + connect 球铰闭环）
 */
export function buildFourBarLinkageTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "圆角带孔机构实验底板",
    revision: "L2",
    primitive: { shape: "plate", widthMm: 280, depthMm: 126, thicknessMm: 20, cornerRadiusMm: 12, holeDiameterMm: 7, holeInsetMm: 12, finish: "anodized_black" },
    extraOutputs: [
      { id: "mount_a", positionMm: [-90, 0, 10], quatWxyz: Q_ID },
      { id: "mount_d", positionMm: [70, 0, 10], quatWxyz: Q_ID },
      { id: "gusset_a_f", positionMm: [-66, 0, 22], quatWxyz: Q_ID },
      { id: "gusset_d_b", positionMm: [94, 0, 22], quatWxyz: Q_ID },
    ],
  });

  const pkgGusset = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "钢制直角支座加强板",
    revision: "L2",
    primitive: { shape: "box", widthMm: 16, depthMm: 36, heightMm: 24, finish: "steel" },
  });

  const pkgPostA = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "曲柄侧高支座立柱",
    revision: "L2",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 120, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -60], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "bearing_mount", positionMm: [0, 0, 56], quatWxyz: Q_ID },
      { id: "motor_mount", positionMm: [0, -48, 56], quatWxyz: Q_ID },
    ],
  });

  const pkgPostD = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "摇杆侧矮支座立柱",
    revision: "L2",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 70, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -35], quatWxyz: Q_ID },
    extraOutputs: [{ id: "bearing_mount", positionMm: [0, 0, 31], quatWxyz: Q_ID }],
  });

  const pkgBearing = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "UCP204 立式带座轴承",
    revision: "L2",
    primitive: { shape: "bearing_pillow", widthMm: 44, depthMm: 28, heightMm: 28, boreDiameterMm: 16, axis: "y", finish: "steel" },
  });

  const pkgDriveMotor = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "减速直流伺服驱动电机",
    revision: "L2",
    primitive: { shape: "servo_motor_body", flangeMm: 38, bodyLengthMm: 46, shaftLengthMm: 14, shaftDiameterMm: 10, axis: "y", finish: "anodized_black" },
  });

  const pkgCrankPin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "主动曲柄驱动轴 A",
    revision: "L2",
    primitive: { shape: "cylinder", radiusMm: 15, lengthMm: 26, axis: "y", finish: "spindle_red" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-36000, 36000] },
  });

  const pkgCrankDisc = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "高速平衡飞轮盘",
    revision: "L2",
    primitive: { shape: "cylinder", radiusMm: 24, lengthMm: 7, axis: "y", finish: "steel" },
  });

  const pkgCrankBar = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "主动曲柄杆 (50mm)",
    revision: "L2",
    primitive: { shape: "box", widthMm: 16, depthMm: 14, heightMm: 50, finish: "spindle_red" },
    input: { positionMm: [0, 0, -25], quatWxyz: Q_ID },
  });

  const pkgPassivePin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "无源随动铰链销",
    revision: "L2",
    primitive: { shape: "cylinder", radiusMm: 12, lengthMm: 24, axis: "y", finish: "brass" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-180, 180] },
  });

  const pkgPinCap = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "黄铜耐磨轴端挡圈",
    revision: "L2",
    primitive: { shape: "cylinder", radiusMm: 8, lengthMm: 28, axis: "y", finish: "brass" },
  });

  const pkgCouplerRod = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "连杆臂 B-C (160mm)",
    revision: "L2",
    primitive: { shape: "box", widthMm: 160, depthMm: 16, heightMm: 16, finish: "aluminum" },
    input: { positionMm: [-80, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "pin_c", positionMm: [80, 0, 0], quatWxyz: Q_ID }],
  });

  const pkgCouplerPlate = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "连杆白色轻量化翼板",
    revision: "L2",
    primitive: { shape: "plate", widthMm: 146, depthMm: 22, thicknessMm: 6, cornerRadiusMm: 8, holeDiameterMm: 6, holeInsetMm: 16, finish: "aerospace_white" },
  });

  const pkgRockerArm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "从动摇杆 D-C (100mm)",
    revision: "L2",
    primitive: { shape: "box", widthMm: 18, depthMm: 16, heightMm: 100, finish: "steel" },
    input: { positionMm: [0, 0, -50], quatWxyz: Q_ID },
  });

  const ws = [
    pkgBase,
    pkgGusset,
    pkgPostA,
    pkgPostD,
    pkgBearing,
    pkgDriveMotor,
    pkgCrankPin,
    pkgCrankDisc,
    pkgCrankBar,
    pkgPassivePin,
    pkgPinCap,
    pkgCouplerRod,
    pkgCouplerPlate,
    pkgRockerArm,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-four-bar-linkage",
    name: "闭链四连杆曲柄摇杆机构",
    baseMobility: "fixed",
    nodes: [
      { id: "base_plate", label: "圆角带孔机构底板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "gusset_a", label: "A 支座角撑板", packageKey: packageKey(pkgGusset), parent: { node: "base_plate", mount: "gusset_a_f" }, explodeStep: 1, explodeVectorMm: [0, 0, 20] },
      { id: "gusset_d", label: "D 支座角撑板", packageKey: packageKey(pkgGusset), parent: { node: "base_plate", mount: "gusset_d_b" }, explodeStep: 1, explodeVectorMm: [0, 0, 20] },
      { id: "post_a", label: "A 点主支座立柱", packageKey: packageKey(pkgPostA), parent: { node: "base_plate", mount: "mount_a" }, explodeStep: 1, explodeVectorMm: [0, 0, 45] },
      { id: "bearing_a", label: "A 轴带座轴承块", packageKey: packageKey(pkgBearing), parent: { node: "post_a", mount: "bearing_mount" }, explodeStep: 1, explodeVectorMm: [0, 28, 45] },
      { id: "drive_motor", label: "A 轴减速伺服电机", packageKey: packageKey(pkgDriveMotor), parent: { node: "post_a", mount: "motor_mount" }, explodeStep: 2, explodeVectorMm: [0, -35, 45] },
      { id: "crank_hinge", label: "A 曲柄驱动轴", packageKey: packageKey(pkgCrankPin), parent: { node: "post_a", mount: "top" }, jointMode: "velocity", explodeStep: 2, explodeVectorMm: [0, 0, 45] },
      { id: "crank_disc", label: "曲柄平衡飞轮盘", packageKey: packageKey(pkgCrankDisc), parent: { node: "crank_hinge", mount: "center" }, explodeStep: 2, explodeVectorMm: [0, -18, 45] },
      { id: "crank_bar", label: "曲柄臂 a=50mm", packageKey: packageKey(pkgCrankBar), parent: { node: "crank_hinge", mount: "center" }, explodeStep: 3, explodeVectorMm: [0, 0, 50] },
      { id: "coupler_hinge", label: "B 随动铰链", packageKey: packageKey(pkgPassivePin), parent: { node: "crank_bar", mount: "top" }, jointMode: "passive", explodeStep: 4, explodeVectorMm: [0, 0, 45] },
      { id: "coupler_rod", label: "连杆臂 b=160mm", packageKey: packageKey(pkgCouplerRod), parent: { node: "coupler_hinge", mount: "center" }, explodeStep: 5, explodeVectorMm: [45, 0, 45] },
      { id: "coupler_cap", label: "连杆轻量化翼板", packageKey: packageKey(pkgCouplerPlate), parent: { node: "coupler_rod", mount: "center" }, explodeStep: 5, explodeVectorMm: [45, 0, 62] },
      { id: "pin_c_cap", label: "C 铰链铜套端盖", packageKey: packageKey(pkgPinCap), parent: { node: "coupler_rod", mount: "pin_c" }, explodeStep: 5, explodeVectorMm: [55, 0, 45] },
      { id: "post_d", label: "D 点副支座立柱", packageKey: packageKey(pkgPostD), parent: { node: "base_plate", mount: "mount_d" }, explodeStep: 1, explodeVectorMm: [0, 0, 45] },
      { id: "bearing_d", label: "D 轴带座轴承块", packageKey: packageKey(pkgBearing), parent: { node: "post_d", mount: "bearing_mount" }, explodeStep: 1, explodeVectorMm: [0, 28, 45] },
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
 * ⑦ 弹簧减震摆臂测试台（门式角撑塔架 + 轴承枢轴 + 双肋下摆臂 + 油气减震筒与制动盘钳轮组）
 */
export function buildSpringSuspensionTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgBase = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "带孔悬架实验台底板",
    revision: "S2",
    primitive: { shape: "plate", widthMm: 280, depthMm: 146, thicknessMm: 20, cornerRadiusMm: 12, holeDiameterMm: 7, holeInsetMm: 12, finish: "anodized_black" },
    extraOutputs: [
      { id: "pivot_mount", positionMm: [-85, 0, 10], quatWxyz: Q_ID },
      { id: "tower_mount", positionMm: [-15, 0, 10], quatWxyz: Q_ID },
      { id: "gusset_p", positionMm: [-108, 0, 22], quatWxyz: Q_ID },
      { id: "gusset_t", positionMm: [6, 0, 22], quatWxyz: Q_ID },
    ],
  });

  const pkgGusset = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "钢制塔架底部角撑",
    revision: "S2",
    primitive: { shape: "box", widthMm: 16, depthMm: 36, heightMm: 24, finish: "steel" },
  });

  const pkgPivotPost = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "4040 摆臂枢轴立柱",
    revision: "S2",
    primitive: { shape: "extrusion_profile", series: "4040", lengthMm: 160, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -80], quatWxyz: Q_ID },
    extraOutputs: [{ id: "bearing_mount", positionMm: [0, 0, 74], quatWxyz: Q_ID }],
  });

  const pkgBearing = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "摆臂枢轴带座轴承",
    revision: "S2",
    primitive: { shape: "bearing_pillow", widthMm: 42, depthMm: 30, heightMm: 28, boreDiameterMm: 16, axis: "y", finish: "steel" },
  });

  const pkgSpringTower = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "2040 减震器上拉塔架",
    revision: "S2",
    primitive: { shape: "extrusion_profile", series: "2040", lengthMm: 230, axis: "z", finish: "steel" },
    input: { positionMm: [0, 0, -115], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "shock_mount", positionMm: [0, 0, 122], quatWxyz: Q_ID },
      { id: "brace_mount", positionMm: [-36, 0, 44], quatWxyz: quatFromZToVec(70, 0, 68) },
    ],
  });

  const pkgCrossBrace = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "斜向门架加强铝梁",
    revision: "S2",
    primitive: { shape: "extrusion_profile", series: "2020", lengthMm: 94, axis: "z", finish: "aluminum" },
    behavior: { kind: "moving_table", massKg: 0.08 },
  });

  const pkgShockCap = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "氮气外置减震副油壶",
    revision: "S2",
    primitive: { shape: "cylinder", radiusMm: 10, lengthMm: 26, axis: "z", finish: "spindle_red" },
  });

  const pkgSwingPin = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "悬架低阻尼黄铜枢轴",
    revision: "S2",
    primitive: { shape: "cylinder", radiusMm: 14, lengthMm: 24, axis: "y", finish: "brass" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-75, 75] },
  });

  const pkgSwingArm = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "铝合金箱型下摆臂",
    revision: "S2",
    primitive: { shape: "box", widthMm: 165, depthMm: 22, heightMm: 18, finish: "aluminum" },
    input: { positionMm: [-82.5, 0, 0], quatWxyz: Q_ID },
    extraOutputs: [
      { id: "spring_eye", positionMm: [30, 0, 9], quatWxyz: Q_ID },
      { id: "wheel_end", positionMm: [82.5, 0, 0], quatWxyz: Q_ID },
    ],
  });

  const pkgWishbone = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "高刚性钢制双肋加强板",
    revision: "S2",
    primitive: { shape: "plate", widthMm: 148, depthMm: 28, thicknessMm: 6, cornerRadiusMm: 8, holeDiameterMm: 6, holeInsetMm: 16, finish: "steel" },
  });

  const pkgHubWheel = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "悬架橡胶测试轮胎",
    revision: "S2",
    primitive: { shape: "cylinder", radiusMm: 38, lengthMm: 26, axis: "y", finish: "rubber_grip" },
    behavior: { kind: "moving_table", massKg: 0.54 },
    extraOutputs: [
      { id: "disc_mount", positionMm: [0, -15, 0], quatWxyz: Q_ID },
      { id: "caliper_mount", positionMm: [-12, -16, 8], quatWxyz: Q_ID },
    ],
  });

  const pkgWheelRim = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "机加工铝合金轮辋",
    revision: "S2",
    primitive: { shape: "cylinder", radiusMm: 22, lengthMm: 28, axis: "y", finish: "aluminum" },
    behavior: { kind: "moving_table", massKg: 0.06 },
  });

  const pkgBrakeDisc = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "金属通风制动盘",
    revision: "S2",
    primitive: { shape: "cylinder", radiusMm: 17, lengthMm: 4, axis: "y", finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.03 },
  });

  const pkgCaliper = buildPrimitivePartPackage({
    manufacturer: "构元造物",
    model: "液压固定制动卡钳",
    revision: "S2",
    primitive: { shape: "box", widthMm: 16, depthMm: 9, heightMm: 18, finish: "spindle_red" },
    behavior: { kind: "moving_table", massKg: 0.02 },
  });

  const ws = [
    pkgBase,
    pkgGusset,
    pkgPivotPost,
    pkgBearing,
    pkgSpringTower,
    pkgCrossBrace,
    pkgShockCap,
    pkgSwingPin,
    pkgSwingArm,
    pkgWishbone,
    pkgHubWheel,
    pkgWheelRim,
    pkgBrakeDisc,
    pkgCaliper,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-spring-suspension",
    name: "弹簧减震摆臂测试台",
    baseMobility: "fixed",
    nodes: [
      { id: "rig_base", label: "圆角悬架试验底板", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "gusset_p", label: "枢轴立柱角撑", packageKey: packageKey(pkgGusset), parent: { node: "rig_base", mount: "gusset_p" }, explodeStep: 1, explodeVectorMm: [0, 0, 20] },
      { id: "gusset_t", label: "弹簧塔架角撑", packageKey: packageKey(pkgGusset), parent: { node: "rig_base", mount: "gusset_t" }, explodeStep: 1, explodeVectorMm: [0, 0, 20] },
      { id: "pivot_post", label: "4040 主铰链立柱", packageKey: packageKey(pkgPivotPost), parent: { node: "rig_base", mount: "pivot_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 40] },
      { id: "pivot_bearing", label: "带座轴承支承块", packageKey: packageKey(pkgBearing), parent: { node: "pivot_post", mount: "bearing_mount" }, explodeStep: 1, explodeVectorMm: [0, 26, 40] },
      { id: "spring_tower", label: "2040 减震弹簧塔架", packageKey: packageKey(pkgSpringTower), parent: { node: "rig_base", mount: "tower_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 50] },
      { id: "top_brace", label: "塔架斜向加强连梁", packageKey: packageKey(pkgCrossBrace), parent: { node: "spring_tower", mount: "brace_mount" }, explodeStep: 2, explodeVectorMm: [0, 0, 65] },
      { id: "shock_reservoir", label: "外置减震油气蓄能筒", packageKey: packageKey(pkgShockCap), parent: { node: "spring_tower", mount: "shock_mount" }, explodeStep: 2, explodeVectorMm: [0, 0, 72] },
      { id: "swing_hinge", label: "无源摆臂旋转轴", packageKey: packageKey(pkgSwingPin), parent: { node: "pivot_post", mount: "top" }, jointMode: "passive", explodeStep: 2, explodeVectorMm: [0, 0, 40] },
      { id: "swing_arm", label: "铝合金箱型下摆臂", packageKey: packageKey(pkgSwingArm), parent: { node: "swing_hinge", mount: "center" }, explodeStep: 3, explodeVectorMm: [50, 0, 0] },
      { id: "wishbone_plate", label: "摆臂双肋加强板", packageKey: packageKey(pkgWishbone), parent: { node: "swing_arm", mount: "center" }, explodeStep: 3, explodeVectorMm: [50, 0, 20] },
      { id: "hub_wheel", label: "悬架橡胶测试轮胎", packageKey: packageKey(pkgHubWheel), parent: { node: "swing_arm", mount: "wheel_end" }, explodeStep: 4, explodeVectorMm: [45, 0, 0] },
      { id: "wheel_rim", label: "铝合金轮辋盘", packageKey: packageKey(pkgWheelRim), parent: { node: "hub_wheel", mount: "center" }, explodeStep: 4, explodeVectorMm: [45, 25, 0] },
      { id: "brake_disc", label: "金属通风制动盘", packageKey: packageKey(pkgBrakeDisc), parent: { node: "hub_wheel", mount: "disc_mount" }, explodeStep: 5, explodeVectorMm: [45, -35, 0] },
      { id: "brake_caliper", label: "液压制动卡钳", packageKey: packageKey(pkgCaliper), parent: { node: "hub_wheel", mount: "caliper_mount" }, explodeStep: 5, explodeVectorMm: [30, -45, 10] },
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
    case "reusable-tvc-rocket":
      return buildReusableRocketTemplate();
    case "rescue-helicopter":
      return buildRescueHelicopterTemplate();
    case "oriental-pearl-tower":
      return buildOrientalPearlTemplate();
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
