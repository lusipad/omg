import { describe, expect, it } from "vitest";
import { assembleServoAxis, isCompatibleServoPair, SERVO_AXIS_MODEL, simulateServoAxis, type ServoAxisConfig } from "../contracts/servo-axis";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { addInstance, emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";

const source = { title: "伺服仿真测试夹具", url: "https://example.com/manual", locator: "参数表", excerpt: "此处数值仅用于回归测试。" };
const driveRatings = { kind: "drive" as const, ratedCurrentA: 1.5, peakCurrentA: 4 };
const motorRatings = {
  kind: "motor" as const, ratedPowerW: 100, ratedTorqueNm: 0.32, peakTorqueNm: 1,
  ratedSpeedRpm: 3000, maxSpeedRpm: 5000, rotorInertiaKgM2: 0.00001, ratedCurrentA: 1,
  compatibleDriveModels: ["驱动-A"],
};
const drive: DevicePackage = { schemaVersion: 1, manufacturer: "仿真测试厂", model: "驱动-A", revision: "1", source, ports: [], rules: [], servo: driveRatings };
const motor: DevicePackage = { ...drive, model: "电机-B", servo: motorRatings };

function axis(config: Partial<ServoAxisConfig> = {}, drivePkg = drive, motorPkg = motor) {
  const library = installPackage(installPackage(emptyWorkspace(), drivePkg), motorPkg);
  return assembleServoAxis(library, { driveKey: packageKey(drivePkg), motorKey: packageKey(motorPkg), targetDeg: 90, loadInertiaRatio: 1, ...config });
}

describe("可移植伺服设备与装配", () => {
  it("保留主要参数来源及可选精确产品页，拒绝空通用设备和混用信号端口", () => {
    const productUrl = "https://example.com/products/drive-a";
    expect(parseDevicePackage({ ...drive, source: { ...source, productUrl } }).source.productUrl).toBe(productUrl);
    expect(() => parseDevicePackage({ ...drive, source: { ...source, productUrl: "javascript:alert(1)" } })).toThrow();
    expect(() => parseDevicePackage({ ...drive, servo: undefined })).toThrow();
    expect(() => parseDevicePackage({ ...drive, ports: [{ id: "in", label: "输入", direction: "input", type: "number" }] })).toThrow();
  });

  it.each([
    { ...driveRatings, ratedCurrentA: 0 }, { ...driveRatings, peakCurrentA: 1 },
    { ...motorRatings, rotorInertiaKgM2: -1 }, { ...motorRatings, ratedPowerW: Infinity },
    { ...motorRatings, ratedCurrentA: 0 }, { ...motorRatings, peakTorqueNm: 0.1 },
    { ...motorRatings, maxSpeedRpm: 100 }, { ...motorRatings, compatibleDriveModels: [" "] },
  ])("拒绝不合法伺服铭牌值 %#", (servo) => expect(() => parseDevicePackage({ ...motor, servo })).toThrow());

  it("旧场景可以原样导入；同时保存设备包和轴参数可重现仿真", () => {
    expect(parseWorkspace(emptyWorkspace())).not.toHaveProperty("servoAxis");
    const ws = axis({ targetDeg: -100, loadInertiaRatio: 2 });
    const restored = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    expect(restored).toEqual(ws);
    expect(simulateServoAxis(restored)).toEqual(simulateServoAxis(ws));
    const withoutRatio = { driveKey: packageKey(drive), motorKey: packageKey(motor), targetDeg: 45 };
    expect(parseWorkspace({ ...ws, servoAxis: withoutRatio }).servoAxis?.loadInertiaRatio).toBe(1);
  });

  it("校验同厂精确配套型号与角色，导入场景和手工装配走同一校验", () => {
    const ws = axis();
    const config = ws.servoAxis!;
    expect(isCompatibleServoPair(drive, motor)).toBe(true);
    expect(() => axis({}, { ...drive, manufacturer: "其他厂" })).toThrow(/厂商|制造商/);
    expect(() => axis({}, { ...drive, model: "驱动-A-其他后缀" })).toThrow(/配套|匹配|兼容/);
    expect(isCompatibleServoPair(motor, drive)).toBe(false);
    expect(() => parseWorkspace({ ...ws, servoAxis: { ...config, driveKey: config.motorKey } })).toThrow(/驱动/);
    expect(() => parseWorkspace({ ...ws, servoAxis: { ...config, motorKey: "missing" } })).toThrow(/电机/);
    expect(() => addInstance(ws, config.driveKey, "驱动")).toThrow(/伺服轴/);
    expect(() => parseWorkspace({ ...ws, instances: [{ id: "n1", name: "错误实例", packageKey: config.motorKey, inputs: {} }] })).toThrow(/伺服轴/);
    expect(() => simulateServoAxis(emptyWorkspace())).toThrow(/装配/);
  });

  it.each([{ targetDeg: 3600.01 }, { targetDeg: -3600.01 }, { targetDeg: NaN }, { loadInertiaRatio: -1 }, { loadInertiaRatio: 101 }])(
    "拒绝超出试验范围的工况 %#", (config) => expect(() => axis(config)).toThrow());
});

describe("伺服轴闭环响应", () => {
  it("从静止起步，对正负目标给出对称轨迹，并按误差和速度收敛", () => {
    const plus = simulateServoAxis(axis({ targetDeg: 90 }));
    const minus = simulateServoAxis(axis({ targetDeg: -90 }));
    expect(plus.samples[0]).toEqual({ timeMs: 0, positionDeg: 0, speedRpm: 0 });
    expect(plus.settled && minus.settled).toBe(true);
    const end = plus.samples.at(-1)!;
    expect(Math.abs(end.positionDeg - 90)).toBeLessThanOrEqual(SERVO_AXIS_MODEL.positionToleranceDeg);
    expect(end.positionDeg).not.toBe(90);
    expect(Math.abs(end.speedRpm)).toBeLessThanOrEqual(SERVO_AXIS_MODEL.speedToleranceRpm);
    expect(minus.samples).toHaveLength(plus.samples.length);
    plus.samples.forEach((sample, index) => {
      expect(minus.samples[index].timeMs).toBe(sample.timeMs);
      expect(minus.samples[index].positionDeg).toBeCloseTo(-sample.positionDeg, 11);
      expect(minus.samples[index].speedRpm).toBeCloseTo(-sample.speedRpm, 11);
    });
    expect(plus.samples.some((sample) => sample.speedRpm > 0)).toBe(true);
  });

  it("零位指令从零位保持静止，仍观察完整的到位保持时间", () => {
    const result = simulateServoAxis(axis({ targetDeg: 0 }));
    expect(result.settled).toBe(true);
    expect(result.samples.every((sample) => sample.positionDeg === 0 && sample.speedRpm === 0)).toBe(true);
    expect(result.samples.at(-1)?.timeMs).toBe(SERVO_AXIS_MODEL.settleHoldMs);
  });

  it("负载惯量增加使相同输入的初期加速变慢；驱动连续电流不足时限矩降额", () => {
    const normal = simulateServoAxis(axis());
    const loaded = simulateServoAxis(axis({ loadInertiaRatio: 20 }));
    const smallDrive = { ...drive, servo: { ...driveRatings, ratedCurrentA: 0.01 } };
    const limited = simulateServoAxis(axis({}, smallDrive));
    expect(loaded.inertiaKgM2).toBeCloseTo(21 * motorRatings.rotorInertiaKgM2, 12);
    expect(loaded.samples[1].speedRpm).toBeLessThan(normal.samples[1].speedRpm);
    expect(limited.limits.torqueNm).toBeCloseTo(0.01 * motorRatings.ratedTorqueNm, 12);
    expect(limited.samples[1].speedRpm).toBeLessThan(normal.samples[1].speedRpm);
    const unknownCurrent = { ...motor, servo: { ...motorRatings, ratedCurrentA: undefined } };
    const fallback = simulateServoAxis(axis({}, drive, unknownCurrent));
    expect(fallback.limits.torqueNm).toBe(motorRatings.ratedTorqueNm);
    expect(fallback.assumptions.join(" ")).toMatch(/额定电流/);
  });

  it("有限时窗内不能到达的工况标记超时，最后一个实测积分点保持实际位置", () => {
    const slow = { ...motor, servo: { ...motorRatings, ratedSpeedRpm: 1, maxSpeedRpm: 1 } };
    const result = simulateServoAxis(axis({ targetDeg: 3600 }, drive, slow));
    expect(result.settled).toBe(false);
    expect(result.samples.at(-1)?.timeMs).toBe(SERVO_AXIS_MODEL.maxTimeMs);
    expect(result.samples.at(-1)!.positionDeg).toBeLessThanOrEqual(SERVO_AXIS_MODEL.maxTimeMs / 1000 * 6);
    expect(Math.max(...result.samples.map((s) => Math.abs(s.speedRpm)))).toBeLessThanOrEqual(1 + 1e-12);
  });

  it("从状态差分反算的加速转矩与机械功率处于连续额定工况内", () => {
    const powerLimited = { ...motor, servo: { ...motorRatings, ratedPowerW: 0.01 } };
    const result = simulateServoAxis(axis({ targetDeg: 3600 }, drive, powerLimited));
    let peakTorque = 0, peakPower = 0;
    for (let i = 1; i < result.samples.length; i++) {
      const a = result.samples[i - 1], b = result.samples[i];
      const va = a.speedRpm * Math.PI / 30, vb = b.speedRpm * Math.PI / 30;
      const torque = result.inertiaKgM2 * (vb - va) / ((b.timeMs - a.timeMs) / 1000);
      peakTorque = Math.max(peakTorque, Math.abs(torque));
      peakPower = Math.max(peakPower, Math.abs(torque * (va + vb) / 2));
    }
    expect(peakTorque).toBeGreaterThan(0);
    expect(peakTorque).toBeLessThanOrEqual(result.limits.torqueNm + 1e-10);
    expect(peakPower).toBeLessThanOrEqual(result.limits.powerW + 1e-10);
  });
});
