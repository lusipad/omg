import { z } from "zod";
import { packageKey, readTwinData, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export const SERVO_AXIS_MODEL = {
  integrationStepMs: 1, samplePeriodMs: 10, maxTimeMs: 8000,
  naturalFrequencyRadPerS: 24, referenceLoadInertiaRatio: 1,
  positionToleranceDeg: 0.1, speedToleranceRpm: 0.5, settleHoldMs: 50,
} as const;

export const servoAxisConfigSchema = z.strictObject({
  driveKey: z.string().min(1).max(4096), motorKey: z.string().min(1).max(4096),
  targetDeg: z.number().finite().min(-3600).max(3600),
  loadInertiaRatio: z.number().finite().min(0).max(100).default(SERVO_AXIS_MODEL.referenceLoadInertiaRatio),
});
export type ServoAxisConfig = z.infer<typeof servoAxisConfigSchema>;
export interface ServoAxisSample { timeMs: number; positionDeg: number; speedRpm: number }
export interface ServoAxisResult {
  samples: ServoAxisSample[];
  settled: boolean;
  limits: { torqueNm: number; powerW: number; speedRpm: number };
  inertiaKgM2: number;
  assumptions: string[];
}

export function isCompatibleServoPair(drive: DevicePackage, motor: DevicePackage): boolean {
  return drive.servo?.kind === "drive" && motor.servo?.kind === "motor" &&
    drive.manufacturer === motor.manufacturer && motor.servo.compatibleDriveModels.includes(drive.model);
}

function axisDevices(ws: TwinWorkspace, config: ServoAxisConfig) {
  const drive = ws.packages.find((pkg) => packageKey(pkg) === config.driveKey);
  const motor = ws.packages.find((pkg) => packageKey(pkg) === config.motorKey);
  if (drive?.servo?.kind !== "drive") throw new Error("请选择已安装的伺服驱动器修订");
  if (motor?.servo?.kind !== "motor") throw new Error("请选择已安装的伺服电机修订");
  if (!isCompatibleServoPair(drive, motor)) throw new Error("装配需要同一制造商，且电机配套表中须列有该驱动器的完整型号");
  return { drive: drive.servo, motor: motor.servo };
}

export function assembleServoAxis(ws: TwinWorkspace, config: z.input<typeof servoAxisConfigSchema>): TwinWorkspace {
  const servoAxis = readTwinData(servoAxisConfigSchema, config, "伺服轴参数");
  axisDevices(ws, servoAxis);
  return { ...ws, servoAxis };
}

const radPerDeg = Math.PI / 180;
const radPerSecondPerRpm = Math.PI / 30;
function limit(value: number, magnitude: number) {
  return Math.max(-magnitude, Math.min(magnitude, value));
}

export function simulateServoAxis(ws: TwinWorkspace): ServoAxisResult {
  if (!ws.servoAxis) throw new Error("请先装配伺服轴");
  const config = readTwinData(servoAxisConfigSchema, ws.servoAxis, "伺服轴参数");
  const { drive, motor } = axisDevices(ws, config);
  const effectiveCurrentRatio = motor.ratedCurrentA === undefined ? 1 : Math.min(1, drive.ratedCurrentA / motor.ratedCurrentA);
  const limits = { torqueNm: motor.ratedTorqueNm * effectiveCurrentRatio, powerW: motor.ratedPowerW, speedRpm: motor.ratedSpeedRpm };
  const inertiaKgM2 = motor.rotorInertiaKgM2 * (1 + config.loadInertiaRatio);
  const speedLimit = limits.speedRpm * radPerSecondPerRpm;
  if (!Number.isFinite(inertiaKgM2) || inertiaKgM2 <= 0 || limits.torqueNm <= 0 || speedLimit <= 0) {
    throw new Error("额定参数与负载组合超出数值积分范围");
  }
  const model = SERVO_AXIS_MODEL;
  const dt = model.integrationStepMs / 1000;
  const target = config.targetDeg * radPerDeg;
  // Kp = Jref·ωn²，Kd = 2·Jref·ωn。固定增益，换负载时只改变 Jref/J。
  const inertiaRatio = (1 + model.referenceLoadInertiaRatio) / (1 + config.loadInertiaRatio);
  const wn = model.naturalFrequencyRadPerS;
  const samples: ServoAxisSample[] = [{ timeMs: 0, positionDeg: 0, speedRpm: 0 }];
  let position = 0, speed = 0, settled = false;
  let stableSinceMs: number | undefined = Math.abs(config.targetDeg) <= model.positionToleranceDeg ? 0 : undefined;
  for (let timeMs = model.integrationStepMs; timeMs <= model.maxTimeMs; timeMs += model.integrationStepMs) {
    const demand = inertiaRatio * (wn * wn * (target - position) - 2 * wn * speed);
    const acceleration = limit(demand, limits.torqueNm / inertiaKgM2);
    const speedFromTorque = limit(speed + acceleration * dt, speedLimit);
    // 以本步两端较高的转速限制机械功率，使加速和制动均满足 |T·ω| ≤ P。
    const peakSpeed = Math.max(Math.abs(speed), Math.abs(speedFromTorque));
    const powerDelta = peakSpeed > 0 ? limits.powerW / peakSpeed / inertiaKgM2 * dt : 0;
    const nextSpeed = speed + limit(speedFromTorque - speed, powerDelta);
    position += (speed + nextSpeed) * 0.5 * dt;
    speed = nextSpeed;
    const positionDeg = position / radPerDeg, speedRpm = speed / radPerSecondPerRpm;
    if (Math.abs(positionDeg - config.targetDeg) <= model.positionToleranceDeg && Math.abs(speedRpm) <= model.speedToleranceRpm) {
      stableSinceMs ??= timeMs;
      settled = timeMs - stableSinceMs >= model.settleHoldMs;
    } else {
      stableSinceMs = undefined;
    }
    if (timeMs % model.samplePeriodMs === 0 || settled) samples.push({ timeMs, positionDeg, speedRpm });
    if (settled) break;
  }
  const assumptions = [
    "电机与折算负载刚性相连，从静止零位接受位置阶跃。模型忽略摩擦、传动弹性、编码器量化和电流环延迟。",
    `位置和速度反馈增益按惯量比 ${model.referenceLoadInertiaRatio}、自然角频率 ${wn} rad/s 的临界阻尼设定，更换负载后保持原增益。`,
    motor.ratedCurrentA === undefined
      ? "资料未列电机额定电流，模型假定配套表列出的驱动器可支持电机额定转矩。"
      : "假定转矩与电流成正比，连续转矩按驱动器与电机额定电流之比降额，上限取电机额定转矩。",
    "额定轴功率和额定转速限制连续运动，加速与制动使用对称的转矩和功率能力。",
  ];
  return { samples, settled, limits, inertiaKgM2, assumptions };
}
