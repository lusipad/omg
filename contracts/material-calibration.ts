import { linearCoefficients, parseDevicePackage, type DevicePackage } from "./twin-device";

export interface MaterialCalibrationInput {
  manufacturer: string;
  model: string;
  revision: string;
  title: string;
  url?: string;
  locator: string;
  excerpt: string;
  inputLabel: string;
  inputUnit: string;
  outputLabel: string;
  outputUnit: string;
  inputPoints: [number, number];
  outputPoints: [number, number];
  confirmedLinear: boolean;
}

export function createCalibratedPackage(input: MaterialCalibrationInput): DevicePackage {
  if (!input.confirmedLinear) throw new Error("请先确认用两点之间的线性关系表示该设备。");
  const required = {
    manufacturer: "制造商或制作者", model: "设备型号", revision: "设备包修订", title: "资料标题",
    locator: "证据位置", excerpt: "手册摘录或实测记录", inputLabel: "输入名称", outputLabel: "输出名称",
  } as const;
  for (const field of Object.keys(required) as (keyof typeof required)[]) {
    if (!input[field].trim()) throw new Error(`请填写${required[field]}。`);
  }
  if (!input.inputUnit.trim() || !input.outputUnit.trim()) throw new Error("请填写输入和输出单位，无量纲请填 1。");
  const calibration = { inputPoints: input.inputPoints, outputPoints: input.outputPoints };
  const { gain, offset } = linearCoefficients(calibration);
  const url = input.url?.trim() ?? "";
  return parseDevicePackage({
    schemaVersion: 1, manufacturer: input.manufacturer, model: input.model, revision: input.revision,
    source: { ...(url ? {} : { kind: "local" }), title: input.title, url, locator: input.locator, excerpt: input.excerpt },
    ports: [
      { id: "input", direction: "input", type: "number", label: input.inputLabel, unit: input.inputUnit },
      { id: "output", direction: "output", type: "number", label: input.outputLabel, unit: input.outputUnit },
    ],
    rules: [{ op: "linear", input: "input", output: "output", gain, offset }], calibration,
  });
}
