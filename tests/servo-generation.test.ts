import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateServoPair } from "../api/servo-generation";
import { readOfficialDocument } from "../api/twin-source";
import driveExample from "../examples/SV660NS2R8I-FS-INT.device.json";
import motorExample from "../examples/MS1H1-40B30CB-A331R-INT.device.json";

vi.mock("../api/twin-source", () => ({ readOfficialDocument: vi.fn() }));
const read = vi.mocked(readOfficialDocument);
const input = { driveUrl: driveExample.source.productUrl, motorUrl: motorExample.source.productUrl };
const catalogUrl = driveExample.source.url;
const row = motorExample.source.excerpt;
const rowH4 = row.replace("0.145 MS1H1", "0.43 MS1H4");
const drive = { model: driveExample.model, ratedCurrentA: 2.8, peakCurrentA: 10.1 };
const motor = { model: motorExample.model, ratedPowerW: 400, ratedTorqueNm: 1.27, peakTorqueNm: 4.45, ratedSpeedRpm: 3000, maxSpeedRpm: 7000, rotorInertiaKgM2: 0.0000145 };
const answer = { drive, motor, pairRow: row };

function flyer(rows = [row, rowH4]) {
  return [
    "SV660N – Single-Axis EtherCAT Servo\fpage 2\fSV660N Selection Chart", "Data code: L6210209 V0.6",
    "Drive Motor Motor Motor Motor Motor peak Motor Rotor inertia MS1 motor type SV660N-FS Type Material SV660 SV660 Drive",
    "power base maximum rated rated torque frame without brake (please refer to below notes) code of rated peak",
    "supply speed speed power torque (N·m) size (10-4 kg·m2) SV660N current current",
    "voltage (rpm) (rpm) (W) (N·m) (mm) (A) (A)", ...rows,
    "“yn”can be:", "A3: 23 bit absolute single/multi-turn encoder; V3: Batteryless 23 bit absolute single/multi-turn encoder",
    "“z”can be (not in all models):", "0: W/O oil seal, W/O brake; 1: With oil seal, W/O brake; 2: W/O oil seal, with brake",
  ].join("\n");
}

function documents(driveModel = drive.model, motorModel = motor.model, catalog = flyer()) {
  read.mockImplementation(async url => {
    if (url === catalogUrl) return { format: "pdf", text: catalog };
    if (url === input.driveUrl) return { format: "html", heading: driveModel, text: driveModel };
    if (url === input.motorUrl) return { format: "html", heading: motorModel, text: motorModel };
    throw new Error("unexpected test URL");
  });
}
beforeEach(() => { read.mockReset(); documents(); });

describe("双链接伺服设备生成", () => {
  it("用两份产品资料和官方选型表调用模型，可重复得到同一组样例包", async () => {
    const model = vi.fn().mockResolvedValue(answer);
    const result = await generateServoPair(input, model);
    expect(read.mock.calls.map(call => call[0])).toEqual([input.driveUrl, input.motorUrl, catalogUrl]);
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][0]).toContain(row);
    expect(model.mock.calls[0][0]).toContain("With oil seal, W/O brake");
    expect(result).toEqual({ drive: driveExample, motor: motorExample });
    expect(result.motor.servo).not.toHaveProperty("ratedCurrentA");
  });

  it("同驱动配另一台高惯量电机，驱动包完全一致", async () => {
    const other = motor.model.replace("MS1H1", "MS1H4");
    documents(drive.model, other);
    const result = await generateServoPair(input, async () => ({
      drive, motor: { ...motor, model: other, rotorInertiaKgM2: 0.000043 }, pairRow: rowH4,
    }));
    expect(result.drive).toEqual(driveExample);
    expect(result.motor.servo).toMatchObject({ rotorInertiaKgM2: 0.000043 });
  });

  it("同一电机在不同驱动上的峰值不同，各配套修订独立", async () => {
    const otherDrive = "SV660NS012I-FS-INT";
    const otherRow = row.replace(drive.model, otherDrive).replace("1.27 4.45", "1.27 4.65");
    documents(drive.model, motor.model, flyer([row, otherRow]));
    const result = await generateServoPair(input, async () => answer);
    expect(result.motor.revision).toBe("v0.6/" + drive.model);
    expect(result.motor.servo).toMatchObject({ kind: "motor", peakTorqueNm: 4.45, compatibleDriveModels: [drive.model] });
  });

  it.each([
    [{ ...answer, drive: { ...drive, ratedCurrentA: 2.5 } }, /ratedCurrentA/],
    [{ ...answer, motor: { ...motor, rotorInertiaKgM2: 0.145 } }, /rotorInertiaKgM2/],
    [{ ...answer, motor: { ...motor, ratedCurrentA: 2.8 } }, /完整的规格/],
    [{ ...answer, pairRow: rowH4 }, /配套行/],
    [{ missing: ["峰值扭矩"] }, /峰值扭矩/],
  ])("拒绝模型错列、单位错误和缺证据的草案", async (bad, message) => {
    await expect(generateServoPair(input, async () => bad)).rejects.toThrow(message);
  });

  it("产品页型号提示必须与标题一致", async () => {
    const model = vi.fn();
    await expect(generateServoPair({ ...input, motorModel: "MS1H4-40B30CB-A331R-INT" }, model)).rejects.toThrow(/产品页标题/);
    expect(model).not.toHaveBeenCalled();
  });

  it("同一多型号手册可用两个订货号定位到指定配套行", async () => {
    read.mockResolvedValue({ format: "pdf", text: flyer() });
    const urls = { driveUrl: catalogUrl, motorUrl: catalogUrl, catalogUrl };
    await expect(generateServoPair(urls, vi.fn())).rejects.toThrow(/具体型号/);
    const result = await generateServoPair({ ...urls, driveModel: drive.model, motorModel: motor.model }, async () => answer);
    expect(result.motor.servo).toMatchObject({ ratedTorqueNm: 1.27 });
  });

  it("两型号分列在不同数据行时拒绝配对", async () => {
    documents(drive.model, motor.model, flyer([row.replace(drive.model, "SV660NS1R6I-FS-INT"), rowH4]));
    const model = vi.fn();
    await expect(generateServoPair(input, model)).rejects.toThrow(/未找到同时匹配/);
    expect(model).not.toHaveBeenCalled();
  });

  it("无抱闸的惯量不用于带抱闸订货号", async () => {
    documents(drive.model, motor.model.replace("A331R", "A332R"));
    await expect(generateServoPair(input, vi.fn())).rejects.toThrow(/含抱闸惯量/);
  });

  it("表头单位缺失或原文未说明占位编码时不生成", async () => {
    documents(drive.model, motor.model, flyer().replace("(10-4 kg·m2)", "(kg·m2)"));
    await expect(generateServoPair(input, vi.fn())).rejects.toThrow(/列名或单位/);
    documents(drive.model, motor.model, flyer().replace("code of rated peak", "code of peak rated"));
    await expect(generateServoPair(input, vi.fn())).rejects.toThrow(/列名或单位/);
    documents(drive.model, motor.model, flyer().replace("A3: 23 bit", "A4: 23 bit"));
    await expect(generateServoPair(input, vi.fn())).rejects.toThrow(/未找到同时匹配/);
  });
});
