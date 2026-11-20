import servoLibrary from "../public/modelica/library.json";
import linearLibrary from "../public/modelica/linear-library.json";
import motorLibrary from "../public/modelica/motor-library.json";
import contourLibrary from "../public/modelica/contour-library.json";
import factoryLibrary from "../public/modelica/factory-library.json";
import feedTrackingLibrary from "../public/modelica/feed-tracking-library.json";
import servoManifest from "../public/modelica/runtime/manifest.json";
import feedManifest from "../public/modelica/runtime/feed-axis.json";
import motorManifest from "../public/modelica/runtime/motor-axis.json";
import contourManifest from "../public/modelica/runtime/contour-axis.json";
import factoryManifest from "../public/modelica/runtime/factory-models.json";
import feedTrackingManifest from "../public/modelica/runtime/feed-tracking-axis.json";
import { parseUnitSpec, type Dimension } from "./units";
import type { ModelReference } from "./twin-device";

export const FEED_TRACKING_KERNEL_REF: ModelReference = {
  id: feedTrackingLibrary.assembly.id,
  version: feedTrackingLibrary.version,
};

export type ProblemTier = "geometry" | "kinematics" | "dynamics" | "signal" | "throughput";
export type ModelKind = "component" | "kernel";
export type ModelCategory =
  | "servo_drive"
  | "servo_motor"
  | "motor_part"
  | "ball_screw"
  | "linear_load"
  | "limit_sensor"
  | "digital_input"
  | "signal_source"
  | "factory_station"
  | "axis_kernel";

export interface ModelVariableSpec {
  readonly name: string;
  readonly type: "Real" | "Boolean";
  readonly unit?: string;
  readonly prefix?: "potential" | "flow";
}

export interface ModelPortSpec {
  readonly id: string;
  readonly label: string;
  readonly causality: "input" | "output" | "acausal";
  readonly domain: "signal" | "rotational" | "translational" | "electrical_drive" | "factory";
  readonly variables: readonly ModelVariableSpec[];
}

export interface ModelParameterSpec {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly dimension: Dimension;
  readonly valueType?: "number" | "boolean";
  readonly aliases?: readonly string[];
  readonly positive?: boolean;
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly optional?: boolean;
  readonly defaultValue?: number | boolean;
  readonly fallbackFromPeer?: { readonly role: string; readonly parameter: string };
}

export interface ModelSolverSpec {
  readonly runtime: "modelica_wasm" | "discrete_signal" | "modelica_composition";
  readonly artifact?: string;
  readonly method?: string;
  readonly stepUs?: number;
  readonly compiler?: string;
  readonly msl?: string;
  readonly wasmSha256?: string;
}

export interface RegisteredModel {
  readonly id: string;
  readonly version: string;
  readonly kind: ModelKind;
  readonly category: ModelCategory;
  readonly label: string;
  readonly simPurpose: {
    readonly tier: ProblemTier;
    readonly summary: string;
    readonly includedScope: readonly string[];
    readonly excludedScope: readonly string[];
  };
  readonly parameters: readonly ModelParameterSpec[];
  readonly ports: readonly ModelPortSpec[];
  readonly solver: ModelSolverSpec;
  readonly topologyPattern?: {
    readonly roles: Readonly<Record<string, ModelReference>>;
  };
}

function dim(unit: string): Dimension {
  const spec = parseUnitSpec(unit);
  if (!spec) throw new Error(`模型注册表声明了未识别的物理单位“${unit}”。`);
  return spec.dimension;
}

function param(
  key: string,
  label: string,
  unit: string,
  extra: Omit<ModelParameterSpec, "key" | "label" | "unit" | "dimension"> = {},
): ModelParameterSpec {
  return { key, label, unit, dimension: dim(unit), ...extra };
}

function assertAligned(condition: boolean, message: string) {
  if (!condition) throw new Error(`模型注册表与公开清单不一致：${message}`);
}

const MODELS: readonly RegisteredModel[] = [
  // -------------------------------------------------------------------------
  // 1. 组件模型（供厂家设备包通过 modelBindings 绑定）
  // -------------------------------------------------------------------------
  {
    id: servoLibrary.components.drive.id,
    version: servoLibrary.version,
    kind: "component",
    category: "servo_drive",
    label: "额定限流位置伺服驱动器",
    simPurpose: {
      tier: "dynamics",
      summary: "固定增益位置/速度环与连续电流限幅，将位置误差与速度反馈转换为电机电流指令。",
      includedScope: ["位置比例与速度反馈", "连续输出电流对称限幅", "参考惯量前馈基准"],
      excludedScope: ["厂商实机控制环自动整定", "电流环延迟与开关纹波", "过载保护时间曲线"],
    },
    parameters: [
      param("driveRatedCurrentA", "连续输出额定电流", "A", { positive: true, aliases: ["ratedCurrentA"] }),
      param("drivePeakCurrentA", "最大瞬时输出电流", "A", { positive: true, optional: true, aliases: ["peakCurrentA"] }),
    ],
    ports: [
      { id: "targetAngleRad", label: "目标角位置", causality: "input", domain: "signal", variables: [{ name: "targetAngleRad", type: "Real", unit: "rad" }] },
      { id: "angleRad", label: "转子角位置反馈", causality: "input", domain: "signal", variables: [{ name: "angleRad", type: "Real", unit: "rad" }] },
      { id: "speedRadS", label: "转子角速度反馈", causality: "input", domain: "signal", variables: [{ name: "speedRadS", type: "Real", unit: "rad/s" }] },
      { id: "currentCommandA", label: "电流指令输出", causality: "output", domain: "electrical_drive", variables: [{ name: "currentCommandA", type: "Real", unit: "A" }] },
    ],
    solver: { runtime: "modelica_wasm", artifact: "servo-axis.wasm", method: servoManifest.integrator.method, stepUs: servoManifest.integrator.stepUs, compiler: servoManifest.compiler, msl: servoManifest.msl },
  },
  {
    id: servoLibrary.components.motor.id,
    version: servoLibrary.version,
    kind: "component",
    category: "servo_motor",
    label: "额定点校准永磁伺服电机",
    simPurpose: {
      tier: "dynamics",
      summary: "按额定转矩/电流比例折算电机转矩，受连续机械功率、额定转速与转子惯量约束。",
      includedScope: ["转子惯量动力学", "额定电流/转矩线性比例", "连续功率与额定转速限幅"],
      excludedScope: ["绕组电阻电感电磁暂态", "齿槽转矩与油封/轴承摩擦", "温升与退磁降额"],
    },
    parameters: [
      param("rotorInertiaKgM2", "转子转动惯量", "kg.m2", { positive: true }),
      param("ratedTorqueNm", "额定输出转矩", "N.m", { positive: true }),
      param("ratedPowerW", "额定输出功率", "W", { positive: true }),
      param("ratedSpeedRpm", "额定转速", "rpm", { positive: true }),
      param("motorRatedCurrentA", "额定相电流", "A", {
        positive: true,
        optional: true,
        aliases: ["ratedCurrentA"],
        fallbackFromPeer: { role: "drive", parameter: "driveRatedCurrentA" },
      }),
      param("peakTorqueNm", "瞬时峰值转矩", "N.m", { positive: true, optional: true }),
      param("maxSpeedRpm", "最高允许转速", "rpm", { positive: true, optional: true }),
    ],
    ports: [
      { id: "currentA", label: "驱动电流指令输入", causality: "input", domain: "electrical_drive", variables: [{ name: "currentA", type: "Real", unit: "A" }] },
      { id: "torqueNm", label: "电磁输出转矩读数", causality: "output", domain: "signal", variables: [{ name: "torqueNm", type: "Real", unit: "N.m" }] },
      {
        id: "shaft",
        label: "电机机械输出轴（法兰）",
        causality: "acausal",
        domain: "rotational",
        variables: [
          { name: "phi", type: "Real", unit: "rad", prefix: "potential" },
          { name: "tau", type: "Real", unit: "N.m", prefix: "flow" },
        ],
      },
    ],
    solver: { runtime: "modelica_wasm", artifact: "servo-axis.wasm", method: servoManifest.integrator.method, stepUs: servoManifest.integrator.stepUs, compiler: servoManifest.compiler, msl: servoManifest.msl },
  },
  {
    id: linearLibrary.components.screw.id,
    version: linearLibrary.components.screw.version,
    kind: "component",
    category: "ball_screw",
    label: "理想刚性滚珠丝杠副",
    simPurpose: {
      tier: "kinematics",
      summary: "复用 Modelica 标准库 IdealGearR2T，将旋转运动与直线平动按导程严格双向耦合。",
      includedScope: ["导程运动学传递比 (2π/L)", "功率与力/转矩无损守恒约束"],
      excludedScope: ["丝杠自身转动惯量", "传动效率损耗与预压摩擦", "轴向拉压刚度与反向间隙"],
    },
    parameters: [
      param("leadMmPerRev", "丝杠导程", "mm/rev", { positive: true }),
    ],
    ports: [
      {
        id: "shaft",
        label: "丝杠旋转输入端",
        causality: "acausal",
        domain: "rotational",
        variables: [
          { name: "phi", type: "Real", unit: "rad", prefix: "potential" },
          { name: "tau", type: "Real", unit: "N.m", prefix: "flow" },
        ],
      },
      {
        id: "carriage",
        label: "螺母直线输出端",
        causality: "acausal",
        domain: "translational",
        variables: [
          { name: "s", type: "Real", unit: "m", prefix: "potential" },
          { name: "f", type: "Real", unit: "N", prefix: "flow" },
        ],
      },
    ],
    solver: { runtime: "modelica_wasm", artifact: "feed-axis.wasm", method: feedManifest.integrator.method, stepUs: feedManifest.integrator.stepUs, compiler: feedManifest.compiler, msl: feedManifest.msl },
  },
  {
    id: linearLibrary.components.table.id,
    version: linearLibrary.components.table.version,
    kind: "component",
    category: "linear_load",
    label: "水平直线平动质量块（滑台与负载）",
    simPurpose: {
      tier: "dynamics",
      summary: "Modelica 标准库一维平动刚体质量，承受丝杠轴向推力并产生加速阻力。",
      includedScope: ["总移动质量惯性阻力 (F = m·a)"],
      excludedScope: ["导轨粘滞与库仑摩擦", "重力倾角分量", "外部切削载荷"],
    },
    parameters: [
      param("massKg", "移动总质量", "kg", { positive: true, aliases: ["tableMassKg"] }),
    ],
    ports: [
      {
        id: "flange_a",
        label: "平动机械连接端",
        causality: "acausal",
        domain: "translational",
        variables: [
          { name: "s", type: "Real", unit: "m", prefix: "potential" },
          { name: "f", type: "Real", unit: "N", prefix: "flow" },
        ],
      },
    ],
    solver: { runtime: "modelica_wasm", artifact: "feed-axis.wasm", method: feedManifest.integrator.method, stepUs: feedManifest.integrator.stepUs, compiler: feedManifest.compiler, msl: feedManifest.msl },
  },
  // 电机子部件与零件级自组电机
  {
    id: motorLibrary.components.stator.id,
    version: motorLibrary.version,
    kind: "component",
    category: "motor_part",
    label: "伺服电机定子绕组组件",
    simPurpose: {
      tier: "dynamics",
      summary: "描述永磁同步电机 q 轴电阻、电感、匝数、绕组系数及电流指令上限。",
      includedScope: ["q 轴电感与相电阻动态", "电磁反电动势与转矩常数计算", "内径几何配合校验"],
      excludedScope: ["铜损温升与磁饱和非线性"],
    },
    parameters: [
      param("phaseResistanceOhm", "每相绕组电阻", "Ohm", { positive: true }),
      param("qInductanceH", "q 轴同步电感", "H", { positive: true }),
      param("windingTurns", "每相串联匝数", "1", { positive: true, integer: true }),
      param("windingFactor", "基波绕组系数", "1", { positive: true, max: 1 }),
      param("windingCurrentLimitA", "绕组峰值电流指令上限", "A", { positive: true }),
      param("polePairs", "绕组极对数", "1", { positive: true, integer: true }),
      param("statorBoreMm", "定子内径", "mm", { positive: true }),
    ],
    ports: [],
    solver: { runtime: "modelica_wasm", artifact: "motor-axis.wasm", method: motorManifest.integrator.method, stepUs: motorManifest.integrator.stepUs, compiler: motorManifest.compiler, msl: motorManifest.msl },
  },
  {
    id: motorLibrary.components.rotor.id,
    version: motorLibrary.version,
    kind: "component",
    category: "motor_part",
    label: "永磁同步电机转子组件",
    simPurpose: {
      tier: "dynamics",
      summary: "描述转子永磁磁链、转动惯量、极对数及配合尺寸。",
      includedScope: ["转子惯量", "永磁体磁链", "定转子气隙及轴颈几何核对"],
      excludedScope: ["转子偏心与风摩损耗"],
    },
    parameters: [
      param("rotorFluxWb", "永磁转子等效磁链", "Wb", { positive: true }),
      param("rotorInertiaKgM2", "转子转动惯量", "kg.m2", { positive: true }),
      param("polePairs", "转子极对数", "1", { positive: true, integer: true }),
      param("rotorDiameterMm", "转子外径", "mm", { positive: true }),
      param("bearingSeatMm", "转子名义轴颈", "mm", { positive: true }),
    ],
    ports: [],
    solver: { runtime: "modelica_wasm", artifact: "motor-axis.wasm", method: motorManifest.integrator.method, stepUs: motorManifest.integrator.stepUs, compiler: motorManifest.compiler, msl: motorManifest.msl },
  },
  {
    id: motorLibrary.components.bearing.id,
    version: motorLibrary.version,
    kind: "component",
    category: "motor_part",
    label: "电机支承滚动轴承",
    simPurpose: {
      tier: "dynamics",
      summary: "提供单个支承轴承的粘滞阻尼与轴颈配合内径。",
      includedScope: ["按装配槽位数量叠加的粘滞阻尼", "轴承内径尺寸校核"],
      excludedScope: ["轴承疲劳寿命 L10h 与轴向预紧变形"],
    },
    parameters: [
      param("bearingViscousNmS", "单只轴承粘滞阻尼系数", "N.m.s/rad", { positive: false, min: 0 }),
      param("boreMm", "轴承内径", "mm", { positive: true }),
    ],
    ports: [],
    solver: { runtime: "modelica_wasm", artifact: "motor-axis.wasm", method: motorManifest.integrator.method, stepUs: motorManifest.integrator.stepUs, compiler: motorManifest.compiler, msl: motorManifest.msl },
  },
  {
    id: motorLibrary.components.motor.id,
    version: motorLibrary.version,
    kind: "component",
    category: "servo_motor",
    label: "零件级组装永磁伺服电机",
    simPurpose: {
      tier: "dynamics",
      summary: "由定子、转子与多只支承轴承按槽位数量组装而成的电磁-机械伺服电机。",
      includedScope: ["q 轴电枢动态", "电磁反电动势与转矩", "多只轴承阻尼叠加"],
      excludedScope: ["热-磁耦合退磁与齿槽脉动"],
    },
    parameters: [
      param("phaseResistanceOhm", "每相绕组电阻", "Ohm", { positive: true }),
      param("qInductanceH", "q 轴同步电感", "H", { positive: true }),
      param("windingTurns", "每相串联匝数", "1", { positive: true, integer: true }),
      param("windingFactor", "基波绕组系数", "1", { positive: true, max: 1 }),
      param("windingCurrentLimitA", "绕组峰值电流指令上限", "A", { positive: true }),
      param("polePairs", "极对数", "1", { positive: true, integer: true }),
      param("rotorFluxWb", "永磁转子等效磁链", "Wb", { positive: true }),
      param("rotorInertiaKgM2", "转子转动惯量", "kg.m2", { positive: true }),
      param("bearingViscousNmS", "单只轴承粘滞阻尼系数", "N.m.s/rad", { positive: false, min: 0 }),
      param("bearingCount", "支承轴承安装数量", "1", { positive: true, integer: true }),
    ],
    ports: [
      {
        id: "shaft",
        label: "电机输出轴",
        causality: "acausal",
        domain: "rotational",
        variables: [
          { name: "phi", type: "Real", unit: "rad", prefix: "potential" },
          { name: "tau", type: "Real", unit: "N.m", prefix: "flow" },
        ],
      },
    ],
    solver: { runtime: "modelica_wasm", artifact: "motor-axis.wasm", method: motorManifest.integrator.method, stepUs: motorManifest.integrator.stepUs, compiler: motorManifest.compiler, msl: motorManifest.msl },
  },
  // 离散信号与限位开关组件模型
  {
    id: "GouyuanSignal.DigitalInputChannel",
    version: "1.0.0",
    kind: "component",
    category: "digital_input",
    label: "带滞回阈值与滤波时间的数字量输入通道",
    simPurpose: {
      tier: "signal",
      summary: "模拟工业 DI 模块电压滞回判别与持续滤波计时（与汇川 GL10 及 LinuxCNC debounce 10 ms 逻辑一致）。",
      includedScope: ["导通/关断电压双阈值滞回", "毫秒级防抖滤波延时"],
      excludedScope: ["端口浪涌保护与内部光耦温漂"],
    },
    parameters: [
      param("onAbove", "导通高电平阈值", "V"),
      param("offBelow", "关断低电平阈值", "V"),
      param("filterMs", "输入防抖滤波时间", "ms", { positive: false, min: 0 }),
    ],
    ports: [
      { id: "voltageIn", label: "输入电压", causality: "input", domain: "signal", variables: [{ name: "voltageIn", type: "Real", unit: "V" }] },
      { id: "stateOut", label: "滤波后布尔状态", causality: "output", domain: "signal", variables: [{ name: "stateOut", type: "Boolean" }] },
    ],
    solver: { runtime: "discrete_signal" },
  },
  {
    id: "GouyuanSignal.PositionLimitSwitch",
    version: "1.0.0",
    kind: "component",
    category: "limit_sensor",
    label: "位置限位/接近开关传感器",
    simPurpose: {
      tier: "signal",
      summary: "根据滑台/轴当前位置与设定安装触发坐标比较，输出常开/常闭电平电压与开关状态。",
      includedScope: ["感应触发坐标区间判定", "常开（NO）/常闭（NC）极性", "输出供电电压电平"],
      excludedScope: ["金属材质衰减系数与高速响应微秒级延迟"],
    },
    parameters: [
      param("triggerPositionMm", "轴向触发安装坐标", "mm", { optional: true }),
      param("senseDistanceMm", "标称感应距离", "mm", { positive: true, optional: true }),
      param("supplyVoltageV", "供电输出电压", "V", { positive: true, optional: true, defaultValue: 24 }),
      param("normallyClosed", "是否常闭触点（NC）", "1", { valueType: "boolean", optional: true, defaultValue: true }),
    ],
    ports: [
      { id: "positionMm", label: "检测轴实时位置", causality: "input", domain: "signal", variables: [{ name: "positionMm", type: "Real", unit: "mm" }] },
      { id: "voltageOut", label: "输出开关电压", causality: "output", domain: "signal", variables: [{ name: "voltageOut", type: "Real", unit: "V" }] },
      { id: "triggeredOut", label: "触发布尔信号", causality: "output", domain: "signal", variables: [{ name: "triggeredOut", type: "Boolean" }] },
    ],
    solver: { runtime: "discrete_signal" },
  },
  // 工厂节拍模型（与 public/modelica/factory-library.json 对齐）
  ...factoryLibrary.models.map((item): RegisteredModel => ({
    id: item.id,
    version: factoryLibrary.version,
    kind: "component",
    category: "factory_station",
    label: item.label,
    simPurpose: {
      tier: "throughput",
      summary: `工厂调度工位/载具模型（${item.interface}），用于产线节拍与事件派工复算。`,
      includedScope: ["单件服务时间、搬运空载/满载节拍与取放耗时"],
      excludedScope: ["单轴伺服加减速与设备随机故障停机"],
    },
    parameters: item.parameters.map(p =>
      param(p.key, p.label, p.unit, { positive: p.positive, min: p.positive ? undefined : 0, defaultValue: p.default }),
    ),
    ports: [],
    solver: {
      runtime: "modelica_wasm",
      artifact: "factory-models.wasm",
      compiler: factoryManifest.compiler,
      msl: factoryManifest.msl,
      wasmSha256: factoryManifest.wasmSha256,
    },
  })),

  // -------------------------------------------------------------------------
  // 2. 预编译轴级求解内核（供子图匹配调度 WASM 执行）
  // -------------------------------------------------------------------------
  {
    id: servoLibrary.assembly.id,
    version: servoLibrary.version,
    kind: "kernel",
    category: "axis_kernel",
    label: "Modelica 伺服单轴位置阶跃内核",
    simPurpose: {
      tier: "dynamics",
      summary: "由驱动器与电机组成的一维刚性旋转轴位置阶跃闭环内核。",
      includedScope: ["位置阶跃、额定转矩/功率/转速限幅、电流匹配降额"],
      excludedScope: ["传动间隙、机械摩擦与实机整定增益"],
    },
    parameters: [
      param("targetDeg", "目标角位移", "deg", { min: -3600, max: 3600 }),
      param("loadInertiaRatio", "负载惯量比", "1", { min: 0, max: 100 }),
      param("rotorInertiaKgM2", "转子转动惯量", "kg.m2", { positive: true }),
      param("ratedTorqueNm", "额定转矩", "N.m", { positive: true }),
      param("ratedPowerW", "额定功率", "W", { positive: true }),
      param("ratedSpeedRpm", "额定转速", "rpm", { positive: true }),
      param("driveRatedCurrentA", "驱动器额定电流", "A", { positive: true }),
      param("motorRatedCurrentA", "电机额定电流", "A", { positive: true }),
    ],
    ports: [
      { id: "angleDeg", label: "角位置", causality: "output", domain: "signal", variables: [{ name: "angleDeg", type: "Real", unit: "deg" }] },
      { id: "speedRpm", label: "角速度", causality: "output", domain: "signal", variables: [{ name: "speedRpm", type: "Real", unit: "rpm" }] },
      { id: "torqueNm", label: "电磁转矩", causality: "output", domain: "signal", variables: [{ name: "torqueNm", type: "Real", unit: "N.m" }] },
    ],
    solver: {
      runtime: "modelica_wasm",
      artifact: "servo-axis.wasm",
      method: servoManifest.integrator.method,
      stepUs: servoManifest.integrator.stepUs,
      compiler: servoManifest.compiler,
      msl: servoManifest.msl,
      wasmSha256: servoManifest.wasmSha256,
    },
    topologyPattern: {
      roles: {
        drive: { id: servoLibrary.components.drive.id, version: servoLibrary.version },
        motor: { id: servoLibrary.components.motor.id, version: servoLibrary.version },
      },
    },
  },
  {
    id: linearLibrary.assembly.id,
    version: linearLibrary.version,
    kind: "kernel",
    category: "axis_kernel",
    label: "Modelica 直驱丝杠直线进给轴内核",
    simPurpose: {
      tier: "dynamics",
      summary: "连接伺服驱动、电机、理想丝杠与工作台质量的直线位置阶跃动力学内核。",
      includedScope: ["工作台折算惯量、轴向推力与转子力矩平衡", "丝杠导程换算"],
      excludedScope: ["导轨摩擦、丝杠惯量、重力倾角与切削反力"],
    },
    parameters: [
      param("targetMm", "目标直线位移", "mm"),
      param("leadMmPerRev", "丝杠导程", "mm/rev", { positive: true }),
      param("tableMassKg", "工作台移动总质量", "kg", { positive: true }),
      param("rotorInertiaKgM2", "转子转动惯量", "kg.m2", { positive: true }),
      param("ratedTorqueNm", "额定转矩", "N.m", { positive: true }),
      param("ratedPowerW", "额定功率", "W", { positive: true }),
      param("ratedSpeedRpm", "额定转速", "rpm", { positive: true }),
      param("driveRatedCurrentA", "驱动器额定电流", "A", { positive: true }),
      param("motorRatedCurrentA", "电机额定电流", "A", { positive: true }),
    ],
    ports: [
      { id: "positionMm", label: "工作台位置", causality: "output", domain: "signal", variables: [{ name: "positionMm", type: "Real", unit: "mm" }] },
      { id: "velocityMmS", label: "进给速度", causality: "output", domain: "signal", variables: [{ name: "velocityMmS", type: "Real", unit: "mm/s" }] },
      { id: "motorTorqueNm", label: "电机转矩", causality: "output", domain: "signal", variables: [{ name: "motorTorqueNm", type: "Real", unit: "N.m" }] },
      { id: "axialForceN", label: "轴向推力", causality: "output", domain: "signal", variables: [{ name: "axialForceN", type: "Real", unit: "N" }] },
      { id: "angleDeg", label: "电机角位置", causality: "output", domain: "signal", variables: [{ name: "angleDeg", type: "Real", unit: "deg" }] },
      { id: "speedRpm", label: "电机转速", causality: "output", domain: "signal", variables: [{ name: "speedRpm", type: "Real", unit: "rpm" }] },
    ],
    solver: {
      runtime: "modelica_wasm",
      artifact: "feed-axis.wasm",
      method: feedManifest.integrator.method,
      stepUs: feedManifest.integrator.stepUs,
      compiler: feedManifest.compiler,
      msl: feedManifest.msl,
      wasmSha256: feedManifest.wasmSha256,
    },
    topologyPattern: {
      roles: {
        drive: { id: linearLibrary.components.drive.id, version: linearLibrary.components.drive.version },
        motor: { id: linearLibrary.components.motor.id, version: linearLibrary.components.motor.version },
        screw: { id: linearLibrary.components.screw.id, version: linearLibrary.components.screw.version },
        table: { id: linearLibrary.components.table.id, version: linearLibrary.components.table.version },
      },
    },
  },
  {
    id: motorLibrary.assembly.id,
    version: motorLibrary.version,
    kind: "kernel",
    category: "axis_kernel",
    label: "零件装配永磁伺服进给轴内核",
    simPurpose: {
      tier: "dynamics",
      summary: "由定子、转子与轴承参数实时驱动 q 轴电流和机械进给的精细伺服进给轴内核。",
      includedScope: ["q 轴电感/电阻电枢动态", "定子/转子/轴承实装参数耦合"],
      excludedScope: ["切削反力、机械弹性变形与温度漂移"],
    },
    parameters: Object.entries(motorLibrary.assembly.parameters).map(([key, spec]) =>
      param(key, key, spec.unit, { positive: key !== "targetMm" && key !== "bearingViscousNmS", min: key === "bearingViscousNmS" ? 0 : undefined }),
    ),
    ports: Object.entries(motorLibrary.assembly.outputs).map(([id, unit]) => ({
      id,
      label: id,
      causality: "output" as const,
      domain: "signal" as const,
      variables: [{ name: id, type: "Real" as const, unit }],
    })),
    solver: {
      runtime: "modelica_wasm",
      artifact: "motor-axis.wasm",
      method: motorManifest.integrator.method,
      stepUs: motorManifest.integrator.stepUs,
      compiler: motorManifest.compiler,
      msl: motorManifest.msl,
      wasmSha256: motorManifest.wasmSha256,
    },
  },
  {
    id: contourLibrary.assembly.id,
    version: contourLibrary.version,
    kind: "kernel",
    category: "axis_kernel",
    label: "三轴轮廓插补跟随误差轴内核",
    simPurpose: {
      tier: "dynamics",
      summary: "接受时变位置参考 `referenceMm` 跟踪 G 代码轮廓轨迹，计算单轴动态跟随误差。",
      includedScope: ["一阶线性保持参考轨迹", "三状态电磁-机械轴动态"],
      excludedScope: ["刀具切削载荷与几何误差补偿"],
    },
    parameters: Object.entries(contourLibrary.assembly.parameters).map(([key, spec]) =>
      param(key, key, spec.unit, { positive: key !== "bearingViscousNmS", min: key === "bearingViscousNmS" ? 0 : undefined }),
    ),
    ports: [
      ...Object.entries(contourLibrary.assembly.inputs).map(([id, unit]) => ({
        id,
        label: "轨迹位置指令",
        causality: "input" as const,
        domain: "signal" as const,
        variables: [{ name: id, type: "Real" as const, unit }],
      })),
      ...Object.entries(contourLibrary.assembly.outputs).map(([id, unit]) => ({
        id,
        label: id,
        causality: "output" as const,
        domain: "signal" as const,
        variables: [{ name: id, type: "Real" as const, unit }],
      })),
    ],
    solver: {
      runtime: "modelica_wasm",
      artifact: "contour-axis.wasm",
      method: contourManifest.integrator.method,
      stepUs: contourManifest.integrator.stepUs,
      compiler: contourManifest.compiler,
      msl: contourManifest.msl,
      wasmSha256: contourManifest.wasmSha256,
    },
  },
  {
    id: feedTrackingLibrary.assembly.id,
    version: feedTrackingLibrary.version,
    kind: "kernel",
    category: "axis_kernel",
    label: "连续参考驱动进给轴闭环内核",
    simPurpose: {
      tier: "dynamics",
      summary: "接收时变直线位置参考 `referenceMm` 驱动伺服与理想丝杠-工作台动力学，支持限位急停、回零与通信步耦合。",
      includedScope: ["一阶线性保持参考轨迹", "工作台惯量与电机转矩/功率/电流对称限幅", "丝杠导程双向耦合"],
      excludedScope: ["导轨粘滞库仑摩擦、反向间隙与实机驱动器自动整定"],
    },
    parameters: Object.entries(feedTrackingLibrary.assembly.parameters).map(([key, spec]) =>
      param(key, key, spec.unit, { positive: true }),
    ),
    ports: [
      ...Object.entries(feedTrackingLibrary.assembly.inputs).map(([id, unit]) => ({
        id,
        label: "连续直线位置指令",
        causality: "input" as const,
        domain: "signal" as const,
        variables: [{ name: id, type: "Real" as const, unit }],
      })),
      ...Object.entries(feedTrackingLibrary.assembly.outputs).map(([id, unit]) => ({
        id,
        label: id,
        causality: "output" as const,
        domain: "signal" as const,
        variables: [{ name: id, type: "Real" as const, unit }],
      })),
    ],
    solver: {
      runtime: "modelica_wasm",
      artifact: "feed-tracking-axis.wasm",
      method: feedTrackingManifest.integrator.method,
      stepUs: feedTrackingManifest.integrator.stepUs,
      compiler: feedTrackingManifest.compiler,
      msl: feedTrackingManifest.msl,
      wasmSha256: feedTrackingManifest.wasmSha256,
    },
  },
];

export function modelKey(ref: ModelReference): string {
  return `${ref.id}@${ref.version}`;
}

const REGISTRY = new Map<string, RegisteredModel>(MODELS.map((model) => [modelKey(model), model]));

// 启动自检：确保注册表与只读 Modelica 清单和 WASM manifest 完全对齐
(function verifyRegistryAlignment() {
  assertAligned(REGISTRY.size === MODELS.length, "存在重复的模型 ID 与版本。");
  const checks: Array<[ModelReference, readonly string[], readonly string[]]> = [
    [
      { id: servoLibrary.assembly.id, version: servoLibrary.version },
      servoManifest.parameters,
      Object.keys(servoLibrary.assembly.outputs),
    ],
    [
      { id: linearLibrary.assembly.id, version: linearLibrary.version },
      feedManifest.parameters,
      feedManifest.outputs,
    ],
    [
      { id: motorLibrary.assembly.id, version: motorLibrary.version },
      motorManifest.parameters,
      motorManifest.outputs,
    ],
    [
      { id: contourLibrary.assembly.id, version: contourLibrary.version },
      contourManifest.parameters,
      contourManifest.outputs,
    ],
    [
      { id: feedTrackingLibrary.assembly.id, version: feedTrackingLibrary.version },
      feedTrackingManifest.parameters,
      feedTrackingManifest.outputs,
    ],
  ];
  for (const [ref, expectedParams, expectedOutputs] of checks) {
    const model = REGISTRY.get(modelKey(ref));
    assertAligned(Boolean(model), `缺少内核 ${modelKey(ref)}`);
    const actualParams = model!.parameters.map((p) => p.key);
    assertAligned(
      actualParams.length === expectedParams.length && actualParams.every((k, i) => k === expectedParams[i]),
      `${modelKey(ref)} 参数列表与 manifest 不一致`,
    );
    const actualOutputs = model!.ports.filter((p) => p.causality === "output").map((p) => p.id);
    assertAligned(
      actualOutputs.length === expectedOutputs.length && actualOutputs.every((k, i) => k === expectedOutputs[i]),
      `${modelKey(ref)} 输出列表与 manifest 不一致`,
    );
  }
})();

export const MODEL_REGISTRY: ReadonlyMap<string, RegisteredModel> = REGISTRY;

export function getRegisteredModel(ref: ModelReference): RegisteredModel | undefined {
  return REGISTRY.get(modelKey(ref));
}

export function requireRegisteredModel(ref: ModelReference, label = "模型"): RegisteredModel {
  const model = getRegisteredModel(ref);
  if (!model) {
    throw new Error(`${label}引用的模型 ${ref.id} @ ${ref.version} 在当前模型注册表中不可用。`);
  }
  return model;
}

export function listRegisteredModels(): readonly RegisteredModel[] {
  return MODELS;
}

export function listModelsByCategory(category: ModelCategory): readonly RegisteredModel[] {
  return MODELS.filter((model) => model.category === category);
}

export function matchCompiledKernel(roles: Record<string, ModelReference>): RegisteredModel | undefined {
  const roleKeys = Object.keys(roles);
  return MODELS.find((model) => {
    if (model.kind !== "kernel" || !model.topologyPattern) return false;
    const expected = model.topologyPattern.roles;
    const expectedKeys = Object.keys(expected);
    if (expectedKeys.length !== roleKeys.length) return false;
    return expectedKeys.every((role) => {
      const actual = roles[role];
      return actual && actual.id === expected[role].id && actual.version === expected[role].version;
    });
  });
}
