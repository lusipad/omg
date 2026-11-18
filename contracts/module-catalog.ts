export type ModuleField = {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  description: string;
};

export type ModuleBlueprint = {
  key: "linear_axis" | "rotary_joint" | "drive_wheel";
  name: string;
  shortName: string;
  family: string;
  description: string;
  ruleVersion: string;
  fields: ModuleField[];
};

export const ENGINE_RULE_VERSION = "0.1.0-pilot";

export const MODULE_COMPONENT_ROLES: Record<ModuleBlueprint["key"], string[]> = {
  linear_axis: ["ball_screw", "linear_guide", "servo_motor", "servo_drive"],
  rotary_joint: ["gearbox", "servo_motor", "encoder"],
  drive_wheel: ["servo_motor", "gearbox", "wheel", "encoder"],
};

export const MODULE_BLUEPRINTS: ModuleBlueprint[] = [
  {
    key: "linear_axis",
    name: "丝杠直线进给轴",
    shortName: "直线轴",
    family: "直线运动",
    description: "由负载、运动需求和安装倾角初算推力、丝杠转速、转矩与功率。丝杠寿命、临界转速及刚度仍需专项校核。",
    ruleVersion: ENGINE_RULE_VERSION,
    fields: [
      { key: "travelMm", label: "有效行程", unit: "mm", min: 1, max: 10000, step: 10, defaultValue: 500, description: "不含两端安全余量的有效工作行程" },
      { key: "movingMassKg", label: "运动总质量", unit: "kg", min: 0.01, max: 50000, step: 1, defaultValue: 80, description: "工件、滑台及随动附件的质量总和" },
      { key: "maxSpeedMmS", label: "最大速度", unit: "mm/s", min: 0.1, max: 5000, step: 10, defaultValue: 250, description: "稳态最大直线速度" },
      { key: "accelerationMmS2", label: "最大加速度", unit: "mm/s²", min: 0.1, max: 50000, step: 10, defaultValue: 1000, description: "用于峰值推力初算" },
      { key: "leadMm", label: "丝杠导程", unit: "mm/rev", min: 0.5, max: 100, step: 1, defaultValue: 10, description: "每转对应的直线位移" },
      { key: "efficiency", label: "传动效率", unit: "—", min: 0.05, max: 1, step: 0.01, defaultValue: 0.9, description: "丝杠与联轴环节的合并工程假设" },
      { key: "safetyFactor", label: "载荷安全系数", unit: "—", min: 1, max: 10, step: 0.1, defaultValue: 1.5, description: "初算系数，不替代具体工况谱" },
      { key: "inclineDeg", label: "相对水平倾角", unit: "°", min: 0, max: 90, step: 1, defaultValue: 0, description: "0° 为水平，90° 为竖直提升" },
      { key: "frictionCoefficient", label: "等效摩擦系数", unit: "—", min: 0, max: 0.5, step: 0.001, defaultValue: 0.01, description: "导向与密封阻力的等效假设" },
      { key: "dutyCycle", label: "工作循环占比", unit: "—", min: 0.01, max: 1, step: 0.05, defaultValue: 0.6, description: "仅用于提示热校核，不直接计算温升" },
    ],
  },
  {
    key: "rotary_joint",
    name: "伺服减速旋转关节",
    shortName: "旋转关节",
    family: "旋转运动",
    description: "按最不利重力矩与加速惯性矩初算关节和电机侧需求，不包含减速器寿命、轴承刚度与冲击谱验证。",
    ruleVersion: ENGINE_RULE_VERSION,
    fields: [
      { key: "loadKg", label: "下游等效负载", unit: "kg", min: 0.01, max: 10000, step: 1, defaultValue: 12, description: "该关节下游全部运动质量的等效值" },
      { key: "centerOfMassM", label: "等效质心半径", unit: "m", min: 0.001, max: 20, step: 0.01, defaultValue: 0.45, description: "关节轴线至下游等效质心的距离" },
      { key: "movingInertiaKgm2", label: "附加转动惯量", unit: "kg·m²", min: 0, max: 100000, step: 0.01, defaultValue: 0.2, description: "不含负载质点近似项的下游惯量" },
      { key: "maxSpeedDegS", label: "关节最大角速度", unit: "°/s", min: 0.01, max: 3600, step: 1, defaultValue: 90, description: "输出关节侧角速度" },
      { key: "accelerationDegS2", label: "关节角加速度", unit: "°/s²", min: 0.01, max: 20000, step: 1, defaultValue: 180, description: "用于加速转矩初算" },
      { key: "gearRatio", label: "减速比", unit: "—", min: 1, max: 1000, step: 1, defaultValue: 80, description: "电机转速与关节输出转速之比" },
      { key: "efficiency", label: "传动效率", unit: "—", min: 0.05, max: 1, step: 0.01, defaultValue: 0.75, description: "减速器及传动环节的合并工程假设" },
      { key: "safetyFactor", label: "载荷安全系数", unit: "—", min: 1, max: 10, step: 0.1, defaultValue: 1.5, description: "初算系数，不替代冲击载荷谱" },
      { key: "gravityFactor", label: "重力姿态系数", unit: "—", min: 0, max: 1, step: 0.05, defaultValue: 1, description: "1 为最不利水平伸展姿态，0 为不计重力矩" },
      { key: "dutyCycle", label: "工作循环占比", unit: "—", min: 0.01, max: 1, step: 0.05, defaultValue: 0.5, description: "仅用于提示热与寿命校核" },
    ],
  },
  {
    key: "drive_wheel",
    name: "电机减速驱动轮",
    shortName: "驱动轮",
    family: "移动驱动",
    description: "根据整车质量、速度、坡度与滚阻初算驱动力、轮端转矩、电机转速和功率；附着、制动与热容量另行验证。",
    ruleVersion: ENGINE_RULE_VERSION,
    fields: [
      { key: "vehicleMassKg", label: "整车满载质量", unit: "kg", min: 0.01, max: 100000, step: 1, defaultValue: 120, description: "包含载荷、电池、车架与附件" },
      { key: "maxSpeedMS", label: "最高车速", unit: "m/s", min: 0.01, max: 30, step: 0.1, defaultValue: 1.2, description: "水平路面最高设计速度" },
      { key: "accelerationMS2", label: "最大加速度", unit: "m/s²", min: 0.01, max: 30, step: 0.1, defaultValue: 0.6, description: "用于峰值牵引力初算" },
      { key: "gradePercent", label: "最大坡度", unit: "%", min: 0, max: 100, step: 1, defaultValue: 10, description: "坡度百分比，10% 对应 tanθ=0.1" },
      { key: "wheelRadiusM", label: "驱动轮半径", unit: "m", min: 0.01, max: 2, step: 0.005, defaultValue: 0.1, description: "受载后的有效滚动半径" },
      { key: "wheelCount", label: "驱动轮数量", unit: "个", min: 1, max: 16, step: 1, defaultValue: 2, description: "默认各驱动轮均匀分配牵引力" },
      { key: "gearRatio", label: "减速比", unit: "—", min: 1, max: 1000, step: 1, defaultValue: 30, description: "电机转速与轮端转速之比" },
      { key: "efficiency", label: "传动效率", unit: "—", min: 0.05, max: 1, step: 0.01, defaultValue: 0.8, description: "减速器与轮端传动的合并工程假设" },
      { key: "safetyFactor", label: "载荷安全系数", unit: "—", min: 1, max: 10, step: 0.1, defaultValue: 1.4, description: "初算系数，不替代冲击与附着校核" },
      { key: "rollingResistanceCoefficient", label: "滚动阻力系数", unit: "—", min: 0, max: 0.5, step: 0.005, defaultValue: 0.02, description: "轮胎、地面与轴承损耗的等效假设" },
      { key: "dutyCycle", label: "工作循环占比", unit: "—", min: 0.01, max: 1, step: 0.05, defaultValue: 0.7, description: "仅用于提示热容量校核" },
    ],
  },
];

export function getModuleBlueprint(key: string) {
  return MODULE_BLUEPRINTS.find((module) => module.key === key);
}

export function defaultConfiguration(key: string) {
  const blueprint = getModuleBlueprint(key);
  if (!blueprint) throw new Error(`Unknown module: ${key}`);
  return Object.fromEntries(blueprint.fields.map((field) => [field.key, field.defaultValue]));
}
