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
    title: "猎鹰级可回收矢量推力火箭",
    subtitle: "四着陆支腿 + 钛栅格翼 + 二级贮箱 + 整流罩内藏金色卫星 + 摆动矢量喷管，真物理点火拔地升空",
    physicsHighlights: "局部矢量喷管 <motor site> · ±15° TVC 程序转弯 · 爆炸视图揭露卫星载荷",
    showroomMode: "rocket-launch",
  },
  {
    id: "rescue-helicopter",
    category: "flagship",
    badge: "共轴旋翼",
    title: "共轴双旋翼救援直升机",
    subtitle: "球形全景座舱 + 双雪橇起落架 + 尾梁垂尾 + 上下反向等速对转四叶旋翼 + 倾转周期变距飞控",
    physicsHighlights: "ratio=-1 物理抵消反扭力矩 · 垂直离地拉升 · 前倾 4° 空中巡航",
    showroomMode: "helicopter-flight",
  },
  {
    id: "oriental-pearl-tower",
    category: "flagship",
    badge: "地标巨构",
    title: "东方明珠三级旋转观光塔",
    subtitle: "清水混凝土三斜撑与串珠立柱 + 黛紫红大小明珠 + 90m 观光廊 / 267m 旋转餐厅 / 350m 银色太空舱三级独立旋转",
    physicsHighlights: "多级独立角速度旋转层 · 立体几何与高精度球锥组合 · 468m 发射天线桅杆",
    showroomMode: "tower-spin",
  },
  {
    id: "four-wheel-rover",
    category: "mechanism",
    badge: "移动载具",
    title: "四轮差速越障探索车",
    subtitle: "6-DOF 自由刚体底盘 + 四驱高摩擦橡胶胎，在 -9.81 m/s² 重力下自动落地并冲上 10° 坡道",
    physicsHighlights: "freejoint 自由落地 · 轮胎库仑静摩擦推进 · 质心稳定爬坡",
    showroomMode: "kinematic-demo",
  },
  {
    id: "gripper-pick-arm",
    category: "mechanism",
    badge: "接触操作",
    title: "二指摩擦夹爪取物机械臂",
    subtitle: "Z 向伺服升降臂 + 对夹同步防滑橡胶手指，纯粹依靠接触摩擦力夹起 80g 自由方块",
    physicsHighlights: "多阶段轨迹序列 · 对夹多项式耦合 · 非固定物体摩擦抓取",
    showroomMode: "kinematic-demo",
  },
  {
    id: "four-bar-linkage",
    category: "mechanism",
    badge: "闭链机构",
    title: "闭链四连杆曲柄摇杆机构",
    subtitle: "严格 Grashof 曲柄摇杆 + <connect> 球铰闭环约束，连续 360° 整周转动驱动摇杆摆动",
    physicsHighlights: "树状拓扑跨枝闭环 · 主动速度曲柄 + 双无源随动铰链",
    showroomMode: "kinematic-demo",
  },
  {
    id: "spring-suspension-rig",
    category: "mechanism",
    badge: "弹性悬架",
    title: "弹簧减震摆臂测试台",
    subtitle: "无源铰链摆臂 + 配重轮 + 斜置空间弹簧阻尼器 <tendon>，重现真实欠阻尼弹性振荡衰减",
    physicsHighlights: "空间肌腱弹簧阻尼 · 重力下垂受迫响应 · 可调刚度与阻尼系数",
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
 * 旗舰①：猎鹰级矢量推力可回收火箭（四腿着陆支架 + 栅格翼 + 金色卫星 + TVC 喷管）
 */
export function buildReusableRocketTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const sin25 = Math.sin((25 * Math.PI) / 180);
  const cos25 = Math.cos((25 * Math.PI) / 180);

  const pkgCore = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "一级可回收液体芯级贮箱",
    revision: "F9",
    primitive: { shape: "cylinder", radiusMm: 32, lengthMm: 220, axis: "z", finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.92 },
    extraOutputs: [
      { id: "interstage_mount", positionMm: [0, 0, 110], quatWxyz: Q_ID },
      { id: "nozzle_mount", positionMm: [0, 0, -110], quatWxyz: Q_ID },
      { id: "leg_px", positionMm: [30, 0, -92], quatWxyz: quatFromZToVec(-sin25, 0, cos25) },
      { id: "leg_nx", positionMm: [-30, 0, -92], quatWxyz: quatFromZToVec(sin25, 0, cos25) },
      { id: "leg_py", positionMm: [0, 30, -92], quatWxyz: quatFromZToVec(0, -sin25, cos25) },
      { id: "leg_ny", positionMm: [0, -30, -92], quatWxyz: quatFromZToVec(0, sin25, cos25) },
      { id: "fin_px", positionMm: [43, 0, 88], quatWxyz: Q_ID },
      { id: "fin_nx", positionMm: [-43, 0, 88], quatWxyz: Q_ID },
      { id: "fin_py", positionMm: [0, 43, 88], quatWxyz: quatAroundZ(Math.PI / 2) },
      { id: "fin_ny", positionMm: [0, -43, 88], quatWxyz: quatAroundZ(Math.PI / 2) },
    ],
  });

  const pkgLeg = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "碳纤维着陆支撑腿",
    revision: "F9",
    primitive: { shape: "box", widthMm: 8, depthMm: 10, heightMm: 94, finish: "anodized_black" },
    input: { positionMm: [0, 0, 47], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.045 },
  });

  const pkgGridFin = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "钛合金气动栅格翼",
    revision: "F9",
    primitive: { shape: "box", widthMm: 22, depthMm: 22, heightMm: 4, finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.028 },
  });

  const pkgNozzle = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "梅林矢量发动机喷管 (TVC)",
    revision: "F9",
    primitive: { shape: "cone", radiusBottomMm: 26, radiusTopMm: 12, lengthMm: 44, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, 22], quatWxyz: Q_ID },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-15, 15] },
    behavior: { kind: "moving_table", massKg: 0.14 },
  });

  const pkgInterstage = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "碳纤维复合材料级间段",
    revision: "F9",
    primitive: { shape: "cylinder", radiusMm: 33, lengthMm: 34, axis: "z", finish: "anodized_black" },
    input: { positionMm: [0, 0, -17], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.12 },
  });

  const pkgUpper = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "二级真空推进舱贮箱",
    revision: "F9",
    primitive: { shape: "cylinder", radiusMm: 32, lengthMm: 90, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -45], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.24 },
  });

  const pkgSat = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "金色通信卫星载荷球舱",
    revision: "F9",
    primitive: { shape: "sphere", radiusMm: 17, finish: "brass" },
    input: { positionMm: [0, 0, -18], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.06 },
  });

  const pkgFairing = buildPrimitivePartPackage({
    manufacturer: "构元空天",
    model: "可分离气动整流罩",
    revision: "F9",
    primitive: { shape: "cone", radiusBottomMm: 33, radiusTopMm: 2, lengthMm: 94, axis: "z", finish: "aerospace_white" },
    input: { positionMm: [0, 0, -47], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.14 },
  });

  const ws = [pkgCore, pkgLeg, pkgGridFin, pkgNozzle, pkgInterstage, pkgUpper, pkgSat, pkgFairing].reduce(
    installPackage,
    emptyWorkspace(),
  );

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-reusable-rocket",
    name: "猎鹰级可回收矢量推力火箭",
    baseMobility: "free",
    nodes: [
      { id: "core_stage", label: "一级可回收芯级", packageKey: packageKey(pkgCore), parent: null, explodeStep: 0 },
      { id: "leg_1", label: "着陆支腿 #1", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_px" }, explodeStep: 1, explodeVectorMm: [45, 0, -25] },
      { id: "leg_2", label: "着陆支腿 #2", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_nx" }, explodeStep: 1, explodeVectorMm: [-45, 0, -25] },
      { id: "leg_3", label: "着陆支腿 #3", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_py" }, explodeStep: 1, explodeVectorMm: [0, 45, -25] },
      { id: "leg_4", label: "着陆支腿 #4", packageKey: packageKey(pkgLeg), parent: { node: "core_stage", mount: "leg_ny" }, explodeStep: 1, explodeVectorMm: [0, -45, -25] },
      { id: "fin_1", label: "钛栅格翼 #1", packageKey: packageKey(pkgGridFin), parent: { node: "core_stage", mount: "fin_px" }, explodeStep: 1, explodeVectorMm: [35, 0, 0] },
      { id: "fin_2", label: "钛栅格翼 #2", packageKey: packageKey(pkgGridFin), parent: { node: "core_stage", mount: "fin_nx" }, explodeStep: 1, explodeVectorMm: [-35, 0, 0] },
      { id: "fin_3", label: "钛栅格翼 #3", packageKey: packageKey(pkgGridFin), parent: { node: "core_stage", mount: "fin_py" }, explodeStep: 1, explodeVectorMm: [0, 35, 0] },
      { id: "fin_4", label: "钛栅格翼 #4", packageKey: packageKey(pkgGridFin), parent: { node: "core_stage", mount: "fin_ny" }, explodeStep: 1, explodeVectorMm: [0, -35, 0] },
      {
        id: "tvc_nozzle",
        label: "梅林矢量火箭喷管",
        packageKey: packageKey(pkgNozzle),
        parent: { node: "core_stage", mount: "nozzle_mount" },
        jointMode: "actuated",
        thruster: { maxForceN: 95, direction: [0, 0, 1], label: "梅林矢量引擎主推力" },
        explodeStep: 2,
        explodeVectorMm: [0, 0, -75],
      },
      { id: "interstage", label: "复合材料级间段", packageKey: packageKey(pkgInterstage), parent: { node: "core_stage", mount: "interstage_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 55] },
      { id: "upper_stage", label: "二级真空推进段", packageKey: packageKey(pkgUpper), parent: { node: "interstage", mount: "top" }, explodeStep: 2, explodeVectorMm: [0, 0, 95] },
      { id: "payload_sat", label: "金色通信卫星载荷", packageKey: packageKey(pkgSat), parent: { node: "upper_stage", mount: "top" }, explodeStep: 3, explodeVectorMm: [0, 0, 120] },
      { id: "fairing_cone", label: "气动卫星整流罩", packageKey: packageKey(pkgFairing), parent: { node: "upper_stage", mount: "top" }, explodeStep: 4, explodeVectorMm: [0, 0, 185] },
    ],
    output: { node: "fairing_cone", mount: "top" },
    commands: { tvc_nozzle: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * 旗舰②：共轴双旋翼救援直升机（精确 COM 配平 + 上下反向耦合四叶旋翼 + 周期倾转巡航）
 */
export function buildRescueHelicopterTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgCabin = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "双发轻型救援机身",
    revision: "H2",
    primitive: { shape: "box", widthMm: 148, depthMm: 56, heightMm: 46, finish: "spindle_red" },
    behavior: { kind: "moving_table", massKg: 0.42 },
    extraOutputs: [
      { id: "cockpit_mount", positionMm: [68, 0, 2], quatWxyz: Q_ID },
      { id: "tail_mount", positionMm: [-68, 0, 8], quatWxyz: Q_ID },
      { id: "mast_mount", positionMm: [0, 0, 32], quatWxyz: Q_ID },
      { id: "skid_l_mount", positionMm: [0, 44, -44], quatWxyz: Q_ID },
      { id: "skid_r_mount", positionMm: [0, -44, -44], quatWxyz: Q_ID },
      { id: "strut_l_mount", positionMm: [0, 34, -30], quatWxyz: quatFromZToVec(0, 0.45, 0.89) },
      { id: "strut_r_mount", positionMm: [0, -34, -30], quatWxyz: quatFromZToVec(0, -0.45, 0.89) },
    ],
  });

  const pkgCanopy = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "全景气泡风挡座舱",
    revision: "H2",
    primitive: { shape: "sphere", radiusMm: 27, finish: "workpiece_alloy" },
    behavior: { kind: "moving_table", massKg: 0.22 },
  });

  const pkgTailBoom = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "航空白尾梁管桁",
    revision: "H2",
    primitive: { shape: "extrusion_profile", series: "2020", lengthMm: 136, axis: "x", finish: "aerospace_white" },
    input: { positionMm: [68, 0, 0], quatWxyz: Q_ID },
    behavior: { kind: "moving_table", massKg: 0.08 },
    extraOutputs: [{ id: "fin_mount", positionMm: [-62, 0, 22], quatWxyz: Q_ID }],
  });

  const pkgTailFin = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "高置垂直尾翼安定面",
    revision: "H2",
    primitive: { shape: "box", widthMm: 28, depthMm: 6, heightMm: 44, finish: "sensor_amber" },
    behavior: { kind: "moving_table", massKg: 0.022 },
  });

  const pkgSkid = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "管式雪橇着陆滑撬",
    revision: "H2",
    primitive: { shape: "box", widthMm: 162, depthMm: 8, heightMm: 8, finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.055 },
  });

  const pkgStrut = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "斜撑减震起落支柱",
    revision: "H2",
    primitive: { shape: "box", widthMm: 10, depthMm: 8, heightMm: 36, finish: "steel" },
    behavior: { kind: "moving_table", massKg: 0.025 },
  });

  const pkgSwashplate = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "共轴斜盘倾转飞控毂",
    revision: "H2",
    primitive: { shape: "cylinder", radiusMm: 14, lengthMm: 24, axis: "z", finish: "steel" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-12, 12] },
    behavior: { kind: "moving_table", massKg: 0.08 },
    extraOutputs: [{ id: "upper_mast", positionMm: [0, 0, 34], quatWxyz: Q_ID }],
  });

  const pkgLowerBlade = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "下层高刚性旋翼主桨叶",
    revision: "H2",
    primitive: { shape: "box", widthMm: 256, depthMm: 22, heightMm: 5, finish: "anodized_black" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.04 },
    extraOutputs: [{ id: "cross_mount", positionMm: [0, 0, 0], quatWxyz: quatAroundZ(Math.PI / 2) }],
  });

  const pkgUpperBlade = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "上层共轴反向旋翼桨叶",
    revision: "H2",
    primitive: { shape: "box", widthMm: 236, depthMm: 20, heightMm: 5, finish: "aerospace_white" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "moving_table", massKg: 0.04 },
    extraOutputs: [{ id: "cross_mount", positionMm: [0, 0, 0], quatWxyz: quatAroundZ(Math.PI / 2) }],
  });

  const pkgCrossBladeDark = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "下旋翼正交副桨叶",
    revision: "H2",
    primitive: { shape: "box", widthMm: 256, depthMm: 22, heightMm: 5, finish: "anodized_black" },
    behavior: { kind: "moving_table", massKg: 0.04 },
  });

  const pkgCrossBladeWhite = buildPrimitivePartPackage({
    manufacturer: "构元航空",
    model: "上旋翼正交副桨叶",
    revision: "H2",
    primitive: { shape: "box", widthMm: 236, depthMm: 20, heightMm: 5, finish: "aerospace_white" },
    behavior: { kind: "moving_table", massKg: 0.04 },
  });

  const ws = [
    pkgCabin,
    pkgCanopy,
    pkgTailBoom,
    pkgTailFin,
    pkgSkid,
    pkgStrut,
    pkgSwashplate,
    pkgLowerBlade,
    pkgUpperBlade,
    pkgCrossBladeDark,
    pkgCrossBladeWhite,
  ].reduce(installPackage, emptyWorkspace());

  const assembly = parseMechanicalAssembly({
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "archetype-rescue-helicopter",
    name: "共轴双旋翼救援直升机",
    baseMobility: "free",
    nodes: [
      { id: "cabin_body", label: "救援直升机主体舱", packageKey: packageKey(pkgCabin), parent: null, explodeStep: 0 },
      { id: "cockpit_glass", label: "全景风挡球舱", packageKey: packageKey(pkgCanopy), parent: { node: "cabin_body", mount: "cockpit_mount" }, explodeStep: 1, explodeVectorMm: [50, 0, 10] },
      { id: "tail_boom", label: "尾梁桁架", packageKey: packageKey(pkgTailBoom), parent: { node: "cabin_body", mount: "tail_mount" }, explodeStep: 1, explodeVectorMm: [-65, 0, 0] },
      { id: "tail_fin", label: "垂尾安定面", packageKey: packageKey(pkgTailFin), parent: { node: "tail_boom", mount: "fin_mount" }, explodeStep: 2, explodeVectorMm: [-35, 0, 40] },
      { id: "skid_l", label: "左雪橇滑撬", packageKey: packageKey(pkgSkid), parent: { node: "cabin_body", mount: "skid_l_mount" }, explodeStep: 1, explodeVectorMm: [0, 35, -30] },
      { id: "skid_r", label: "右雪橇滑撬", packageKey: packageKey(pkgSkid), parent: { node: "cabin_body", mount: "skid_r_mount" }, explodeStep: 1, explodeVectorMm: [0, -35, -30] },
      { id: "strut_l", label: "左支撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_l_mount" }, explodeStep: 1, explodeVectorMm: [0, 25, -15] },
      { id: "strut_r", label: "右支撑支柱", packageKey: packageKey(pkgStrut), parent: { node: "cabin_body", mount: "strut_r_mount" }, explodeStep: 1, explodeVectorMm: [0, -25, -15] },
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
        explodeVectorMm: [0, 0, 60],
      },
      {
        id: "lower_rotor_cross",
        label: "下旋翼正交副叶",
        packageKey: packageKey(pkgCrossBladeDark),
        parent: { node: "lower_rotor", mount: "cross_mount" },
        explodeStep: 3,
        explodeVectorMm: [0, 0, 60],
      },
      {
        id: "upper_rotor",
        label: "上旋翼四叶组 (反扭逆转)",
        packageKey: packageKey(pkgUpperBlade),
        parent: { node: "swashplate_tilt", mount: "upper_mast" },
        jointMode: "velocity",
        coupledTo: { path: "lower_rotor", ratio: -1 },
        explodeStep: 4,
        explodeVectorMm: [0, 0, 95],
      },
      {
        id: "upper_rotor_cross",
        label: "上旋翼正交副叶",
        packageKey: packageKey(pkgCrossBladeWhite),
        parent: { node: "upper_rotor", mount: "cross_mount" },
        explodeStep: 4,
        explodeVectorMm: [0, 0, 95],
      },
    ],
    output: { node: "cabin_body", mount: "center" },
    commands: { swashplate_tilt: 0, lower_rotor: 0 },
  });

  return { workspace: { ...ws, mechanisms: [assembly] }, assembly };
}

/**
 * 旗舰③：东方明珠三级旋转观光塔（清水混凝土三斜撑 + 黛紫红串珠球体 + 冰蓝玻璃幕墙观光旋转层）
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
    model: "90m 黛紫红璀璨下球体",
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
      { id: "lower_pearl", label: "90m 黛紫红璀璨下球体", packageKey: packageKey(pkgLowerPearl), parent: { node: "core_tube", mount: "lower_pearl_mount" }, explodeStep: 2, explodeVectorMm: [-70, 0, 0] },
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
 * 经典①：四轮差速越障探索车（freejoint 自由底盘 + 4× 橡胶驱动轮）
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
 * 经典②：二指摩擦夹爪取物机械臂（Z 向升降臂 + 对夹同步防滑胶指）
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
 * 经典③：闭链四连杆曲柄摇杆机构（满足 Grashof 整周曲柄条件 + connect 球铰闭环）
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
 * 经典④：弹簧减震摆臂测试台（无源摇臂 + 斜拉空间弹簧阻尼器）
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
