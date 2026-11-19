import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bindModelicaServo } from "../contracts/modelica-servo";
import { assembleServoAxis } from "../contracts/servo-axis";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ref = { id: "Gouyuan.ServoAxis", version: "1.0.0" } as const;
const projectName = "servo-axis.twin.json";
const openProject = (text: string) => {
  const candidate = parseImportText(text, projectName);
  if (candidate.kind !== "project" || !candidate.workspace.servoAxis) throw new Error("公开文件缺少可导入的伺服轴");
  return candidate.workspace;
};

describe("可下载的 Modelica 伺服轴工程", () => {
  it("从两个绑定模型的独立修订复原公开工程，并与原始汇川修订共存", () => {
    const models = ["SV660NS2R8I-FS-INT", "MS1H1-40B30CB-A331R-INT"];
    const roles = ["Gouyuan.PositionDrive", "Gouyuan.RatedTorqueMotor"];
    const originals = models.map(model => parseDevicePackage(JSON.parse(read(`../public/devices/inovance/${model}.device.json`))));
    const devices = models.map((model, i) => {
      const name = model + ".device.json";
      const candidate = parseImportText(read(`../public/modelica/devices/${name}`), name);
      if (candidate.kind !== "device") throw new Error(`未识别设备包 ${model}`);
      expect(candidate.device).toEqual({
        ...originals[i], revision: "v0.6-modelica.1",
        servo: { ...originals[i].servo, modelRef: { id: roles[i], version: "1.0.0" } },
      });
      return candidate.device;
    });
    const [drive, motor] = devices;
    const ws = devices.reduce((workspace, device) => installPackage(workspace, device), emptyWorkspace());
    const assembled = assembleServoAxis(ws, { driveKey: packageKey(drive), motorKey: packageKey(motor), targetDeg: 90, loadInertiaRatio: 1, modelRef: ref });
    const downloaded = openProject(read(`../public/modelica/${projectName}`));
    expect(downloaded).toEqual(assembled);
    expect(downloaded.packages).toEqual(devices);
    expect(downloaded.servoAxis?.modelRef).toEqual(ref);
    expect(bindModelicaServo(downloaded)).toEqual({
      targetDeg: 90, loadInertiaRatio: 1, rotorInertiaKgM2: 0.0000145, ratedTorqueNm: 1.27,
      ratedPowerW: 400, ratedSpeedRpm: 3000, driveRatedCurrentA: 2.8, motorRatedCurrentA: 2.8,
    });
    const mixed = originals.reduce((workspace, pkg) => installPackage(workspace, pkg), downloaded);
    expect(new Set(mixed.packages.map(packageKey)).size).toBe(4);
    expect(mixed.servoAxis?.driveKey).toBe(packageKey(drive));
    expect(mixed.servoAxis?.motorKey).toBe(packageKey(motor));
    expect(bindModelicaServo(mixed)).toEqual(bindModelicaServo(downloaded));
  });

  it("改为负角度后再次导出导入，模型版本、驱动和电机修订仍保持一致", () => {
    const ws = openProject(read(`../public/modelica/${projectName}`));
    const changed = assembleServoAxis(ws, { ...ws.servoAxis!, targetDeg: -45 });
    const restored = openProject(JSON.stringify(changed));
    expect(restored.servoAxis).toEqual({ ...ws.servoAxis, targetDeg: -45, modelRef: ref });
    expect(restored.packages).toEqual(ws.packages);
  });
});
