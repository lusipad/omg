import { describe, expect, it } from "vitest";
import { createCalibratedPackage, type MaterialCalibrationInput } from "../contracts/material-calibration";
import { parseDevicePackage, packageKey } from "../contracts/twin-device";
import { addInstance, advanceSimulation, emptyWorkspace, initialSimulation, installPackage, setInput } from "../contracts/twin-simulation";

const points: MaterialCalibrationInput = {
  manufacturer: "自制", model: "P-2", revision: "台架记录 1",
  title: "实验记录", locator: "记录 2", excerpt: "0 kPa：4 mA；100 kPa：20 mA。",
  inputLabel: "压力", inputUnit: "kPa", outputLabel: "电流", outputUnit: "mA",
  inputPoints: [0, 100], outputPoints: [4, 20], confirmedLinear: true,
};

describe("两点标定生成可运行设备", () => {
  it("保留本地实测依据和标定点，安装后中点运行得到 12 mA", () => {
    const device = createCalibratedPackage(points);
    expect(device.source).toMatchObject({ kind: "local", url: "", excerpt: points.excerpt });
    expect(parseDevicePackage(JSON.parse(JSON.stringify(device)))).toEqual(device);
    expect(device.calibration).toEqual({ inputPoints: [0, 100], outputPoints: [4, 20] });
    let ws = addInstance(installPackage(emptyWorkspace(), device), packageKey(device), "压力计");
    const id = ws.instances[0].id;
    ws = setInput(ws, id, "input", 50);
    expect(advanceSimulation(ws, initialSimulation(ws), 1).outputs[id].output).toBe(12);
    ws = setInput(ws, id, "input", 125);
    expect(advanceSimulation(ws, initialSimulation(ws), 1).outputs[id].output).toBe(24);
  });

  it("反向标定得到负增益，可保留有网址的厂商资料", () => {
    const pkg = createCalibratedPackage({ ...points, url: "https://example.org/cal", inputPoints: [100, 0], outputPoints: [4, 20] });
    expect(pkg.rules).toEqual([{ op: "linear", input: "input", output: "output", gain: -0.16, offset: 20 }]);
    expect(pkg.source.url).toBe("https://example.org/cal");
    expect(pkg.source.kind).not.toBe("local");
  });

  it.each<Partial<MaterialCalibrationInput>>([
    { confirmedLinear: false }, { inputPoints: [3, 3] }, { outputPoints: [1, Infinity] },
    { inputPoints: [NaN, 1] }, { inputUnit: " " }, { excerpt: "" }, { url: "ftp://example.org" },
  ])("拒绝不完整或不适用的标定 %o", changes => {
    expect(() => createCalibratedPackage({ ...points, ...changes })).toThrow();
  });
});
