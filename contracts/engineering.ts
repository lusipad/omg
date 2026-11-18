import { z } from "zod";

/**
 * 三类通用机电模块的纯 TypeScript 工程初算，无数据库等外部依赖。
 *
 * 适用范围声明（适用于所有计算结果）：
 *  - 仅为一阶准静态估算。
 *  - 不构成强度、疲劳寿命、热、刚度、临界转速、压杆稳定、
 *    附着/牵引、认证或供应商选型的验证。
 */

export const MODULE_KEYS = ["linear_axis", "rotary_joint", "drive_wheel"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const GRAVITY_MPS2 = 9.80665;

/** 超过该电机转速给出警告（常见伺服电机的经验上限）。 */
const HIGH_MOTOR_SPEED_RPM = 3000;
/** 超过该电机转速则中止计算，需专项校核后方可继续。 */
const BLOCK_MOTOR_SPEED_RPM = 6000;
/** 效率低于该值时，认为初算结果对其高度敏感并给出警告。 */
const LOW_EFFICIENCY = 0.5;
/** 占空比超过该值时，提示接近连续运行（需热校核）。 */
const HIGH_DUTY_CYCLE = 0.8;

const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// 通用结果类型
// ---------------------------------------------------------------------------

export interface Step {
  key: string;
  order: number;
  title: string;
  /** 符号公式，例如 "T = F * L / (2*pi*eta)"。 */
  formula: string;
  /** 代入数值后的算式，供审计核对。 */
  substitution: string;
  value: number;
  unit: string;
  /** 该步骤的工程依据 / 说明。 */
  basis: string;
}

export type WarningSeverity = "warning" | "critical";

export interface Warning {
  code: string;
  severity: WarningSeverity;
  message: string;
  requiredAction: string;
}

export type CalculationStatus = "ok" | "warning" | "blocked";

/** 可 JSON 序列化的结果类型，可直接复用为 db JSON 列类型。 */
export interface CalculationResult {
  moduleKey: ModuleKey;
  status: CalculationStatus;
  metrics: Record<string, number>;
  steps: Step[];
  warnings: Warning[];
  assumptions: string[];
}

// ---------------------------------------------------------------------------
// 输入 schema（zod v4）。字段名前后端统一，并标明单位
// （Mm = 毫米，S = 秒，Deg = 度）。
// ---------------------------------------------------------------------------

export const linearAxisInputSchema = z.object({
  /** 轴所需行程 [mm]。 */
  travelMm: z.number().gt(0).max(50_000),
  /** 轴拖动的质量（负载 + 滑台）[kg]。 */
  movingMassKg: z.number().gt(0).max(50_000),
  /** 峰值线速度 [mm/s]。 */
  maxSpeedMmS: z.number().gt(0).max(10_000),
  /** 峰值线加速度 [mm/s^2]。 */
  accelerationMmS2: z.number().gt(0).max(100_000),
  /** 滚珠/梯形丝杠导程 [mm/rev]。 */
  leadMm: z.number().gt(0).max(200),
  /** 丝杠传动总效率 (0, 1]。 */
  efficiency: z.number().gt(0).lte(1),
  /** 作用于驱动力的设计安全系数 (>= 1)。 */
  safetyFactor: z.number().min(1).max(10),
  /** 轴相对水平面的倾角；0 = 水平，90 = 垂直 [deg]。 */
  inclineDeg: z.number().min(0).max(90),
  /** 导轨摩擦系数 [-]，0 表示理想无摩擦。 */
  frictionCoefficient: z.number().min(0).max(1),
  /** 一个工作循环内处于峰值负载的时间占比 (0, 1]。 */
  dutyCycle: z.number().gt(0).lte(1),
});
export type LinearAxisInput = z.infer<typeof linearAxisInputSchema>;

export const rotaryJointInputSchema = z.object({
  /** 关节携带的负载质量 [kg]。 */
  loadKg: z.number().gt(0).max(100_000),
  /** 关节轴线到负载质心的距离 [m]。 */
  centerOfMassM: z.number().min(0).max(20),
  /**
   * 附加转动惯量（不含负载质点近似项 m*r^2）[kg*m^2]，允许为 0；
   * 计算时内部会加上 m*r^2 得到 J_total。
   */
  movingInertiaKgm2: z.number().min(0).max(1_000_000),
  /** 输出端峰值角速度 [deg/s]。 */
  maxSpeedDegS: z.number().gt(0).max(36_000),
  /** 输出端峰值角加速度 [deg/s^2]。 */
  accelerationDegS2: z.number().gt(0).max(360_000),
  /** 减速比 i >= 1（电机转速 / 输出转速）。 */
  gearRatio: z.number().min(1).max(100_000),
  /** 减速器效率 (0, 1]。 */
  efficiency: z.number().gt(0).lte(1),
  /** 作用于输出转矩的设计安全系数 (>= 1)。 */
  safetyFactor: z.number().min(1).max(10),
  /**
   * 重力作用系数，取值 [0, 1]：1 = 最恶劣情况（质心臂水平，
   * 重力矩最大），0 = 关节轴线垂直（无重力矩）。
   */
  gravityFactor: z.number().min(0).lte(1),
  /** 一个工作循环内处于峰值负载的时间占比 (0, 1]。 */
  dutyCycle: z.number().gt(0).lte(1),
});
export type RotaryJointInput = z.infer<typeof rotaryJointInputSchema>;

export const driveWheelInputSchema = z.object({
  /** 整车质量 [kg]。 */
  vehicleMassKg: z.number().gt(0).max(200_000),
  /** 峰值车速 [m/s]。 */
  maxSpeedMS: z.number().gt(0).max(80),
  /** 峰值加速度 [m/s^2]。 */
  accelerationMS2: z.number().gt(0).max(30),
  /** 路面坡度 [%]；0 = 平地。 */
  gradePercent: z.number().min(0).max(100),
  /** 车轮负载半径 [m]。 */
  wheelRadiusM: z.number().gt(0).max(2),
  /** 分担牵引力的驱动轮数量（每轮各配一台电机）。 */
  wheelCount: z.number().int().min(1).max(16),
  /** 减速比 i >= 1（电机转速 / 车轮转速）。 */
  gearRatio: z.number().min(1).max(10_000),
  /** 传动链总效率 (0, 1]。 */
  efficiency: z.number().gt(0).lte(1),
  /** 作用于牵引力的设计安全系数 (>= 1)。 */
  safetyFactor: z.number().min(1).max(10),
  /** 滚动阻力系数 Crr [-]，0 表示理想无滚阻。 */
  rollingResistanceCoefficient: z.number().min(0).max(1),
  /** 一个工作循环内处于峰值负载的时间占比 (0, 1]。 */
  dutyCycle: z.number().gt(0).lte(1),
});
export type DriveWheelInput = z.infer<typeof driveWheelInputSchema>;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

const fmt = (x: number, digits = 4): string => {
  const s = x.toFixed(digits);
  return s.replace(/\.?0+$/, "");
};

class StepBuilder {
  readonly steps: Step[] = [];
  add(
    key: string,
    title: string,
    formula: string,
    substitution: string,
    value: number,
    unit: string,
    basis: string,
  ): number {
    this.steps.push({
      key,
      order: this.steps.length + 1,
      title,
      formula,
      substitution,
      value,
      unit,
      basis,
    });
    return value;
  }
}

function statusFromWarnings(warnings: Warning[]): CalculationStatus {
  if (warnings.some((w) => w.severity === "critical")) return "blocked";
  if (warnings.some((w) => w.severity === "warning")) return "warning";
  return "ok";
}

function motorSpeedWarnings(warnings: Warning[], motorSpeedRpm: number): void {
  if (motorSpeedRpm > BLOCK_MOTOR_SPEED_RPM) {
    warnings.push({
      code: "MOTOR_SPEED_EXCEEDED",
      severity: "critical",
      message: `所需电机转速 ${fmt(motorSpeedRpm, 1)} rpm 超出常见伺服电机 ${BLOCK_MOTOR_SPEED_RPM} rpm 的初算上界。`,
      requiredAction: "请增大减速比、选用更高转速的电机，或降低输出速度要求后再继续。",
    });
  } else if (motorSpeedRpm > HIGH_MOTOR_SPEED_RPM) {
    warnings.push({
      code: "HIGH_MOTOR_SPEED",
      severity: "warning",
      message: `所需电机转速 ${fmt(motorSpeedRpm, 1)} rpm 高于 ${HIGH_MOTOR_SPEED_RPM} rpm 的初算参考值。`,
      requiredAction: "请与供应商核实电机连续运行转速范围；本估算不构成电机选型验证。",
    });
  }
}

function lowEfficiencyWarning(warnings: Warning[], eta: number): void {
  if (eta < LOW_EFFICIENCY) {
    warnings.push({
      code: "LOW_EFFICIENCY",
      severity: "warning",
      message: `假定效率 ${fmt(eta, 2)} 低于 ${LOW_EFFICIENCY}，计算结果对该取值高度敏感。`,
      requiredAction: "请用实测或供应商数据确认效率；本估算无法评估自锁型传动。",
    });
  }
}

function dutyCycleWarning(warnings: Warning[], dutyCycle: number): void {
  if (dutyCycle > HIGH_DUTY_CYCLE) {
    warnings.push({
      code: "HIGH_DUTY_CYCLE",
      severity: "warning",
      message: `占空比 ${fmt(dutyCycle * 100, 1)}% 已接近连续运行。`,
      requiredAction: "请与供应商进行电机热 / RMS 转矩校核；本估算不包含热评估。",
    });
  }
}

const SCOPE_ASSUMPTION =
  "仅为初步准静态估算：未校核强度、疲劳寿命、热、刚度、临界转速、压杆稳定、认证与供应商选型。";

// ---------------------------------------------------------------------------
// linear_axis：丝杠直线进给轴
// ---------------------------------------------------------------------------

export function calculateLinearAxis(rawInput: unknown): CalculationResult {
  const input = linearAxisInputSchema.parse(rawInput);
  const steps = new StepBuilder();
  const warnings: Warning[] = [];

  const theta = input.inclineDeg * DEG2RAD;
  const leadM = input.leadMm / 1000;
  const speedMps = input.maxSpeedMmS / 1000;
  const accelMps2 = input.accelerationMmS2 / 1000;

  const gravityForceN = steps.add(
    "gravity_force",
    "沿轴方向的重力分量",
    "F_g = m * g * sin(theta)",
    `F_g = ${fmt(input.movingMassKg)} * ${fmt(GRAVITY_MPS2)} * sin(${fmt(input.inclineDeg)} deg)`,
    input.movingMassKg * GRAVITY_MPS2 * Math.sin(theta),
    "N",
    "斜面重力分解，假设 g 恒定。",
  );

  const frictionForceN = steps.add(
    "friction_force",
    "导轨摩擦力",
    "F_f = mu * m * g * cos(theta)",
    `F_f = ${fmt(input.frictionCoefficient)} * ${fmt(input.movingMassKg)} * ${fmt(GRAVITY_MPS2)} * cos(${fmt(input.inclineDeg)} deg)`,
    input.frictionCoefficient * input.movingMassKg * GRAVITY_MPS2 * Math.cos(theta),
    "N",
    "库仑摩擦模型，摩擦系数恒定；法向载荷仅由重力产生。",
  );

  const accelerationForceN = steps.add(
    "acceleration_force",
    "加速惯性力",
    "F_a = m * a",
    `F_a = ${fmt(input.movingMassKg)} kg * ${fmt(accelMps2)} m/s^2`,
    input.movingMassKg * accelMps2,
    "N",
    "牛顿第二定律；按最恶劣情况假设加速方向沿上坡。",
  );

  const designForceN = steps.add(
    "design_force",
    "含安全系数的设计驱动力",
    "F = (F_g + F_f + F_a) * SF",
    `F = (${fmt(gravityForceN)} + ${fmt(frictionForceN)} + ${fmt(accelerationForceN)}) * ${fmt(input.safetyFactor)}`,
    (gravityForceN + frictionForceN + accelerationForceN) * input.safetyFactor,
    "N",
    "重力、摩擦与惯性力的最恶劣叠加；未包含外部工艺力。",
  );

  const screwTorqueNm = steps.add(
    "screw_torque",
    "丝杠所需输入转矩",
    "T = F * L / (2 * pi * eta)",
    `T = ${fmt(designForceN)} * ${fmt(leadM, 6)} / (2 * pi * ${fmt(input.efficiency)})`,
    (designForceN * leadM) / (2 * Math.PI * input.efficiency),
    "N*m",
    "理想丝杠转矩 F*L/(2*pi) 除以传动效率。",
  );

  const screwSpeedRpm = steps.add(
    "screw_speed",
    "峰值线速度对应的丝杠转速",
    "n = v / L * 60",
    `n = ${fmt(speedMps)} m/s / ${fmt(leadM, 6)} m * 60`,
    (speedMps / leadM) * 60,
    "rpm",
    "导程运动学关系；未校核丝杠临界转速与 DN 值。",
  );

  const peakPowerW = steps.add(
    "peak_power",
    "峰值机械功率",
    "P_peak = F * v / eta",
    `P_peak = ${fmt(designForceN)} * ${fmt(speedMps)} / ${fmt(input.efficiency)}`,
    (designForceN * speedMps) / input.efficiency,
    "W",
    "峰值速度与设计力按同时出现取值（保守）。",
  );

  const averagePowerW = steps.add(
    "average_power",
    "占空比平均功率",
    "P_avg = P_peak * dutyCycle",
    `P_avg = ${fmt(peakPowerW)} * ${fmt(input.dutyCycle)}`,
    peakPowerW * input.dutyCycle,
    "W",
    "粗略的连续等效功率；非真正的 RMS 热分析。",
  );

  motorSpeedWarnings(warnings, screwSpeedRpm);
  lowEfficiencyWarning(warnings, input.efficiency);
  dutyCycleWarning(warnings, input.dutyCycle);

  return {
    moduleKey: "linear_axis",
    status: statusFromWarnings(warnings),
    metrics: {
      designForceN,
      screwTorqueNm,
      screwSpeedRpm,
      peakPowerW,
      averagePowerW,
    },
    steps: steps.steps,
    warnings,
    assumptions: [
      `重力加速度 g 取 ${GRAVITY_MPS2} m/s^2 且恒定。`,
      `行程 ${fmt(input.travelMm)} mm 仅作上下文记录，不进入准静态初算（未做运动规划 / RMS 分析）。`,
      "峰值加速度与峰值速度按同时出现处理（保守）；实际运动曲线可能降低峰值功率。",
      "按最恶劣情况假设加速方向沿上坡；未包含外部工艺/切削力。",
      "摩擦系数恒定，不随速度与载荷方向变化。",
      "效率在整个运行范围内恒定；未评估逆驱动 / 自锁特性。",
      SCOPE_ASSUMPTION,
    ],
  };
}

// ---------------------------------------------------------------------------
// rotary_joint：伺服 + 减速器旋转关节
// ---------------------------------------------------------------------------

export function calculateRotaryJoint(rawInput: unknown): CalculationResult {
  const input = rotaryJointInputSchema.parse(rawInput);
  const steps = new StepBuilder();
  const warnings: Warning[] = [];

  const omegaOut = input.maxSpeedDegS * DEG2RAD;
  const alphaOut = input.accelerationDegS2 * DEG2RAD;

  const gravityTorqueNm = steps.add(
    "gravity_torque",
    "输出端重力矩",
    "T_g = m * g * r * gravityFactor",
    `T_g = ${fmt(input.loadKg)} * ${fmt(GRAVITY_MPS2)} * ${fmt(input.centerOfMassM)} * ${fmt(input.gravityFactor)}`,
    input.loadKg * GRAVITY_MPS2 * input.centerOfMassM * input.gravityFactor,
    "N*m",
    "gravityFactor=1 表示质心臂水平（重力矩最大）；0 表示关节轴线垂直。",
  );

  const totalInertiaKgM2 = steps.add(
    "total_inertia",
    "负载总转动惯量",
    "J_total = m * r^2 + J_add",
    `J_total = ${fmt(input.loadKg)} * ${fmt(input.centerOfMassM)}^2 + ${fmt(input.movingInertiaKgm2)}`,
    input.loadKg * input.centerOfMassM * input.centerOfMassM + input.movingInertiaKgm2,
    "kg*m^2",
    "负载质点近似项 m*r^2 与附加转动惯量 movingInertiaKgm2 之和；两者均不可遗漏。",
  );

  const inertiaTorqueNm = steps.add(
    "inertia_torque",
    "输出端加速转矩",
    "T_a = J_total * alpha",
    `T_a = ${fmt(totalInertiaKgM2)} * ${fmt(alphaOut)} rad/s^2`,
    totalInertiaKgM2 * alphaOut,
    "N*m",
    "刚体转动动力学；未建模弹性与背隙。",
  );

  const outputTorqueNm = steps.add(
    "output_torque",
    "含安全系数的设计输出转矩",
    "T_out = (T_g + T_a) * SF",
    `T_out = (${fmt(gravityTorqueNm)} + ${fmt(inertiaTorqueNm)}) * ${fmt(input.safetyFactor)}`,
    (gravityTorqueNm + inertiaTorqueNm) * input.safetyFactor,
    "N*m",
    "重力矩与加速转矩的最恶劣叠加。",
  );

  const motorTorqueNm = steps.add(
    "motor_torque",
    "所需电机转矩",
    "T_m = T_out / (i * eta)",
    `T_m = ${fmt(outputTorqueNm)} / (${fmt(input.gearRatio)} * ${fmt(input.efficiency)})`,
    outputTorqueNm / (input.gearRatio * input.efficiency),
    "N*m",
    "输出转矩经减速比折算并除以减速器效率。",
  );

  const motorSpeedRpm = steps.add(
    "motor_speed",
    "峰值输出速度对应的电机转速",
    "n_m = omega_out * i * 60 / (2 * pi)",
    `n_m = ${fmt(omegaOut)} rad/s * ${fmt(input.gearRatio)} * 60 / (2 * pi)`,
    (omegaOut * input.gearRatio * 60) / (2 * Math.PI),
    "rpm",
    "运动学速比关系；未校核减速器输入转速上限。",
  );

  const peakPowerW = steps.add(
    "peak_power",
    "峰值机械功率",
    "P_peak = T_out * omega_out / eta",
    `P_peak = ${fmt(outputTorqueNm)} * ${fmt(omegaOut)} / ${fmt(input.efficiency)}`,
    (outputTorqueNm * omegaOut) / input.efficiency,
    "W",
    "峰值速度与设计转矩按同时出现取值（保守）。",
  );

  const averagePowerW = steps.add(
    "average_power",
    "占空比平均功率",
    "P_avg = P_peak * dutyCycle",
    `P_avg = ${fmt(peakPowerW)} * ${fmt(input.dutyCycle)}`,
    peakPowerW * input.dutyCycle,
    "W",
    "粗略的连续等效功率；非真正的 RMS 热分析。",
  );

  motorSpeedWarnings(warnings, motorSpeedRpm);
  lowEfficiencyWarning(warnings, input.efficiency);
  dutyCycleWarning(warnings, input.dutyCycle);

  return {
    moduleKey: "rotary_joint",
    status: statusFromWarnings(warnings),
    metrics: {
      gravityTorqueNm,
      totalInertiaKgM2,
      inertiaTorqueNm,
      outputTorqueNm,
      motorTorqueNm,
      motorSpeedRpm,
      peakPowerW,
      averagePowerW,
    },
    steps: steps.steps,
    warnings,
    assumptions: [
      `重力加速度 g 取 ${GRAVITY_MPS2} m/s^2 且恒定。`,
      "重力矩按 gravityFactor 缩放：1 = 最恶劣情况（质心臂水平），0 = 关节轴线垂直（无重力矩）。",
      "负载总转动惯量 = 质点近似项 m*r^2 + 附加转动惯量 movingInertiaKgm2。",
      "负载惯性与减速比按理想刚体处理；忽略刚度、背隙与空程。",
      "减速器效率在整个转速与载荷范围内恒定；未单独评估静止保持/制动转矩。",
      SCOPE_ASSUMPTION,
    ],
  };
}

// ---------------------------------------------------------------------------
// drive_wheel：电机 + 减速器驱动轮
// ---------------------------------------------------------------------------

export function calculateDriveWheel(rawInput: unknown): CalculationResult {
  const input = driveWheelInputSchema.parse(rawInput);
  const steps = new StepBuilder();
  const warnings: Warning[] = [];

  const theta = Math.atan(input.gradePercent / 100);

  const gradeForceN = steps.add(
    "grade_force",
    "坡度阻力",
    "F_g = m * g * sin(atan(grade/100))",
    `F_g = ${fmt(input.vehicleMassKg)} * ${fmt(GRAVITY_MPS2)} * sin(atan(${fmt(input.gradePercent)}/100))`,
    input.vehicleMassKg * GRAVITY_MPS2 * Math.sin(theta),
    "N",
    "恒定坡度上的车辆纵向动力学。",
  );

  const rollingForceN = steps.add(
    "rolling_resistance_force",
    "滚动阻力",
    "F_r = Crr * m * g * cos(theta)",
    `F_r = ${fmt(input.rollingResistanceCoefficient)} * ${fmt(input.vehicleMassKg)} * ${fmt(GRAVITY_MPS2)} * cos(${fmt(theta / DEG2RAD)} deg)`,
    input.rollingResistanceCoefficient * input.vehicleMassKg * GRAVITY_MPS2 * Math.cos(theta),
    "N",
    "滚动阻力系数恒定；未包含空气阻力。",
  );

  const accelerationForceN = steps.add(
    "acceleration_force",
    "加速惯性力",
    "F_a = m * a",
    `F_a = ${fmt(input.vehicleMassKg)} * ${fmt(input.accelerationMS2)}`,
    input.vehicleMassKg * input.accelerationMS2,
    "N",
    "牛顿第二定律；按最恶劣情况假设上坡加速。",
  );

  const designTractiveForceN = steps.add(
    "design_tractive_force",
    "含安全系数的设计牵引力",
    "F = (F_g + F_r + F_a) * SF",
    `F = (${fmt(gradeForceN)} + ${fmt(rollingForceN)} + ${fmt(accelerationForceN)}) * ${fmt(input.safetyFactor)}`,
    (gradeForceN + rollingForceN + accelerationForceN) * input.safetyFactor,
    "N",
    "坡度、滚阻与惯性力的最恶劣叠加。",
  );

  const wheelTorqueNm = steps.add(
    "wheel_torque",
    "单个驱动轮转矩",
    "T_w = F * R / N_wheels",
    `T_w = ${fmt(designTractiveForceN)} * ${fmt(input.wheelRadiusM)} / ${fmt(input.wheelCount)}`,
    (designTractiveForceN * input.wheelRadiusM) / input.wheelCount,
    "N*m",
    "牵引力按全部驱动轮均摊。",
  );

  const motorTorqueNm = steps.add(
    "motor_torque",
    "单个驱动轮所需电机转矩",
    "T_m = T_w / (i * eta)",
    `T_m = ${fmt(wheelTorqueNm)} / (${fmt(input.gearRatio)} * ${fmt(input.efficiency)})`,
    wheelTorqueNm / (input.gearRatio * input.efficiency),
    "N*m",
    "假设每个驱动轮各配一台电机；转矩经减速比折算并除以效率。",
  );

  const wheelSpeedRpm = (input.maxSpeedMS / (2 * Math.PI * input.wheelRadiusM)) * 60;
  const motorSpeedRpm = steps.add(
    "motor_speed",
    "峰值车速对应的电机转速",
    "n_m = v / (2 * pi * R) * 60 * i",
    `n_m = ${fmt(input.maxSpeedMS)} / (2 * pi * ${fmt(input.wheelRadiusM)}) * 60 * ${fmt(input.gearRatio)}`,
    wheelSpeedRpm * input.gearRatio,
    "rpm",
    "按纯滚动假设（无滑移）；未校核车轮打滑与附着极限。",
  );

  const peakPowerW = steps.add(
    "peak_power",
    "总峰值机械功率（全部车轮）",
    "P_peak = F * v / eta",
    `P_peak = ${fmt(designTractiveForceN)} * ${fmt(input.maxSpeedMS)} / ${fmt(input.efficiency)}`,
    (designTractiveForceN * input.maxSpeedMS) / input.efficiency,
    "W",
    "峰值速度与设计牵引力按同时出现取值（保守）。",
  );

  const averagePowerW = steps.add(
    "average_power",
    "占空比平均功率（全部车轮）",
    "P_avg = P_peak * dutyCycle",
    `P_avg = ${fmt(peakPowerW)} * ${fmt(input.dutyCycle)}`,
    peakPowerW * input.dutyCycle,
    "W",
    "粗略的连续等效功率；非真正的 RMS 热分析。",
  );

  motorSpeedWarnings(warnings, motorSpeedRpm);
  lowEfficiencyWarning(warnings, input.efficiency);
  dutyCycleWarning(warnings, input.dutyCycle);

  if (input.gradePercent > 15) {
    warnings.push({
      code: "STEEP_GRADE_TRACTION",
      severity: "warning",
      message: `坡度 ${fmt(input.gradePercent)}% 较陡，所需牵引力可能超出轮胎与地面的附着极限。`,
      requiredAction: "请另行校核车轮附着（含驱动轮载荷转移）；本估算不检查打滑。",
    });
  }

  return {
    moduleKey: "drive_wheel",
    status: statusFromWarnings(warnings),
    metrics: {
      designTractiveForceN,
      wheelTorqueNm,
      motorTorqueNm,
      motorSpeedRpm,
      peakPowerW,
      averagePowerW,
    },
    steps: steps.steps,
    warnings,
    assumptions: [
      `重力加速度 g 取 ${GRAVITY_MPS2} m/s^2 且恒定。`,
      "牵引力按全部驱动轮均摊，并假设每个驱动轮各配一台电机。",
      "滚动半径取输入的车轮半径；忽略滑移、轮胎变形动态与空气阻力。",
      "峰值加速度与峰值速度按同时出现处理（保守）。",
      "未校核车轮-地面附着（牵引极限）；抱死/打滑工况超出本估算范围。",
      SCOPE_ASSUMPTION,
    ],
  };
}

// ---------------------------------------------------------------------------
// 分派器
// ---------------------------------------------------------------------------

export function calculateModule(key: ModuleKey, input: unknown): CalculationResult {
  switch (key) {
    case "linear_axis":
      return calculateLinearAxis(input);
    case "rotary_joint":
      return calculateRotaryJoint(input);
    case "drive_wheel":
      return calculateDriveWheel(input);
    default: {
      const exhaustive: never = key;
      throw new Error(`Unknown module key: ${String(exhaustive)}`);
    }
  }
}
