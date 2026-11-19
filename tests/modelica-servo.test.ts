import { describe, expect, it } from "vitest";
import { bindModelicaServo, MODELICA_SERVO_REF, modelicaServoInfo } from "../contracts/modelica-servo";
import { assembleServoAxis, simulateServoAxis } from "../contracts/servo-axis";
import { createServoDemo } from "../contracts/twin-demo";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";

describe("Modelica 模型版本与设备库绑定", () => {
  it("旧工程保留旧算法，显式选模型后锁定版本，由现有设备和工况映射八个参数", () => {
    const old = createServoDemo(), oldRaw = JSON.stringify(old);
    expect(parseWorkspace(JSON.parse(oldRaw)).servoAxis?.modelRef).toBeUndefined();
    const locked = assembleServoAxis(old, { ...old.servoAxis!, modelRef: MODELICA_SERVO_REF });
    expect(parseWorkspace(JSON.parse(JSON.stringify(locked)))).toEqual(locked);
    const p = bindModelicaServo(locked);
    expect(p).toEqual({ targetDeg: 90, loadInertiaRatio: 1, rotorInertiaKgM2: 0.0000145,
      ratedTorqueNm: 1.27, ratedPowerW: 400, ratedSpeedRpm: 3000, driveRatedCurrentA: 2.8, motorRatedCurrentA: 2.8 });
    expect(modelicaServoInfo(p).inertiaKgM2).toBeCloseTo(0.000029, 12);
    expect(() => simulateServoAxis(locked)).toThrow(/模型|Modelica/);
    expect(JSON.stringify(old)).toBe(oldRaw);
  });

  it("新厂家显式引用组件类，替换其参数即可通过同一绑定路径", () => {
    const base = createServoDemo();
    const parts = base.packages.map(p => {
      const drive = p.servo?.kind === "drive";
      return parseDevicePackage({ ...p, manufacturer: "试验厂", model: drive ? "D2" : "M2", revision: "试验1",
        servo: { ...p.servo, modelRef: { id: drive ? "Gouyuan.PositionDrive" : "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
          ...(drive ? { ratedCurrentA: 1 } : { compatibleDriveModels: ["D2"], rotorInertiaKgM2: 0.00003, ratedCurrentA: 2 }) } });
    });
    const ws = assembleServoAxis(parts.reduce(installPackage, emptyWorkspace()), {
      driveKey: packageKey(parts[0]), motorKey: packageKey(parts[1]), targetDeg: -45, loadInertiaRatio: 3, modelRef: MODELICA_SERVO_REF,
    });
    const p = bindModelicaServo(ws);
    expect(p).toMatchObject({ targetDeg: -45, loadInertiaRatio: 3, rotorInertiaKgM2: 0.00003, driveRatedCurrentA: 1, motorRatedCurrentA: 2 });
    expect(modelicaServoInfo(p).limits.torqueNm).toBeCloseTo(0.635);
  });

  it("未知模型或组件版本可恢复原工程，并且运行时不会降级或替换", () => {
    const old = createServoDemo();
    const unknown = { id: "Gouyuan.ServoAxis", version: "9.9.9" };
    const ws = parseWorkspace({ ...old, servoAxis: { ...old.servoAxis, modelRef: unknown } });
    expect(ws.servoAxis?.modelRef).toEqual(unknown);
    expect(() => bindModelicaServo(ws)).toThrow(/9\.9\.9/);
    expect(() => simulateServoAxis(ws)).toThrow(/模型|Modelica/);
    const withPart = parseWorkspace({ ...old, servoAxis: { ...old.servoAxis, modelRef: MODELICA_SERVO_REF },
      packages: old.packages.map(p => p.servo?.kind === "motor" ? { ...p, servo: { ...p.servo, modelRef: { id: "Other.Motor", version: "2.0" } } } : p) });
    expect(() => bindModelicaServo(withPart)).toThrow(/Other.Motor.*2\.0/);
  });
});
