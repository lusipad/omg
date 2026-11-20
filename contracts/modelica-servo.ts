import { z } from "zod";
import library from "../public/modelica/library.json";
import { resolveServoDriveRatings, resolveServoMotorRatings } from "./device-model-binding";
import { servoAxisConfigSchema, servoAxisDevices, type ServoAxisResult } from "./servo-axis";
import { readTwinData, type DevicePackage, type ModelReference, type ServoDrive, type ServoMotor } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export const MODELICA_SERVO_LIBRARY = library;
export const MODELICA_SERVO_REF: ModelReference = Object.freeze({ id: library.assembly.id, version: library.version });
const positive = z.number().finite().positive();
const ratingsSchema = z.strictObject({
  rotorInertiaKgM2: positive, ratedTorqueNm: positive, ratedPowerW: positive,
  ratedSpeedRpm: positive, driveRatedCurrentA: positive, motorRatedCurrentA: positive,
});
const parametersSchema = ratingsSchema.extend({
  targetDeg: servoAxisConfigSchema.shape.targetDeg,
  loadInertiaRatio: z.number().finite().min(0).max(100),
});
export type ModelicaServoRatings = z.infer<typeof ratingsSchema>;
export type ModelicaServoParameters = z.infer<typeof parametersSchema>;
type ParameterFields = Record<string, { field: string; unit: string; whenMissingUse?: string }>;

function requireModel(ref: ModelReference, id: string, label: string) {
  if (ref.id !== id || ref.version !== library.version) {
    throw new Error(`${label}引用的模型 ${ref.id} @ ${ref.version} 在当前运行器中不可用。此装配需要 ${id} @ ${library.version}。`);
  }
}

function bind(values: Record<string, unknown>, source: Record<string, unknown>, fields: ParameterFields) {
  for (const [name, binding] of Object.entries(fields)) {
    values[name] = source[binding.field] ?? (binding.whenMissingUse ? values[binding.whenMissingUse] : undefined);
  }
}

/** 旋转轴与进给轴共用同一驱动和电机组件的额定值、版本检查及缺项换算。 */
export function bindModelicaServoRatings(drive: ServoDrive, motor: ServoMotor): ModelicaServoRatings {
  if (drive.modelRef) requireModel(drive.modelRef, library.components.drive.id, "驱动器");
  if (motor.modelRef) requireModel(motor.modelRef, library.components.motor.id, "电机");
  const values: Record<string, unknown> = {};
  bind(values, drive, library.components.drive.parameters);
  bind(values, motor, library.components.motor.parameters);
  return readTwinData(ratingsSchema, values, "Modelica 驱动器与电机额定参数");
}

export function bindModelicaServoPackages(drive: DevicePackage, motor: DevicePackage): ModelicaServoRatings {
  return bindModelicaServoRatings(resolveServoDriveRatings(drive), resolveServoMotorRatings(motor));
}

export function bindModelicaServo(workspace: TwinWorkspace): ModelicaServoParameters {
  const axis = workspace.servoAxis;
  if (!axis?.modelRef) throw new Error("请先选择有版本的 Modelica 伺服轴模型。");
  requireModel(axis.modelRef, library.assembly.id, "伺服轴");
  const { drive, motor } = servoAxisDevices(workspace, axis);
  const values = bindModelicaServoRatings(drive, motor);
  bind(values, axis, library.assembly.parameters);
  return readTwinData(parametersSchema, values, "Modelica 伺服轴参数");
}

export function modelicaServoInfo(parameters: ModelicaServoParameters): Pick<ServoAxisResult, "limits" | "inertiaKgM2" | "assumptions"> {
  const p = readTwinData(parametersSchema, parameters, "Modelica 伺服轴参数");
  const inertiaKgM2 = p.rotorInertiaKgM2 * (1 + p.loadInertiaRatio);
  const torqueNm = p.ratedTorqueNm * Math.min(1, p.driveRatedCurrentA / p.motorRatedCurrentA);
  if (!Number.isFinite(inertiaKgM2) || !(torqueNm > 0)) throw new Error("设备额定参数与负载超出模型数值范围。");
  return {
    limits: { torqueNm, powerW: p.ratedPowerW, speedRpm: p.ratedSpeedRpm },
    inertiaKgM2,
    assumptions: [
      "电机采用平均转矩模型，转子与折算负载刚性连接，从静止零位响应位置阶跃。",
      "位置与速度反馈增益使用模型设定。厂家驱动器的实际整定、绕组电流动态和机械摩擦需要额外资料。",
      "连续转矩按驱动器与电机的额定电流匹配。电机包缺少额定电流时，取配套驱动器的额定电流作为估计。",
      "额定功率限制机械转矩，额定转速限制速度指令。",
    ],
  };
}
