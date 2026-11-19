import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deviceCompositionClosure, getDeviceParts } from "../contracts/device-composition";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";

const file = (name: string) => parseImportText(readFileSync(new URL("../public/assemblies/" + name, import.meta.url), "utf8"), name);
const models = [
  ["stator-standard", "S40-STD"], ["stator-high-l", "S40-HL"],
  ["rotor-standard", "R40-STD"], ["rotor-high-j", "R40-HI"],
  ["bearing-standard", "B08-STD"], ["bearing-high-drag", "B08-HI"],
] as const;

describe("可从空工程使用的教学电机零件库", () => {
  it("单包、独立套件和工厂资料提供相同的六份校准件，独立套件自带全部下层结构", () => {
    const kit = file("motor-kit/components.library.json"), factory = file("cnc-factory/project.twin.json");
    if (kit.kind !== "devices" || factory.kind !== "project") throw new Error("缺少已识别的示例工程或设备库");
    const standalone = models.map(([filename, model]) => {
      const entry = file("motor-kit/devices/" + filename + ".device.json");
      if (entry.kind !== "device") throw new Error("没有识别独立电机零件包 " + filename);
      expect(entry.device).toMatchObject({ model, manufacturer: "构元教学件", revision: "1", source: { kind: "local" },
        motorPhysics: { fit: "EDU-FRAME-40" }, composition: { kind: "assembly" } });
      expect(factory.workspace.packages.find(p => packageKey(p) === packageKey(entry.device))).toEqual(entry.device);
      return entry.device;
    });
    const installed = kit.devices.reduce(installPackage, emptyWorkspace());
    const deps = deviceCompositionClosure(installed.packages, standalone.map(packageKey));
    expect(deps.missing).toEqual([]);
    expect(new Set(deps.packages.map(packageKey))).toEqual(new Set(kit.devices.map(packageKey)));
    expect(kit.devices).toHaveLength(15);
    for (const [index, rating, nominal, variant] of [[0, "qInductanceH", .004, .012], [2, "rotorInertiaKgM2", .00002, .00006],
      [4, "bearingViscousNmS", .00012, .00036]] as const) {
      const first = standalone[index].composition!.ratings!, other = standalone[index + 1].composition!.ratings!;
      expect(first[rating].value).toBe(nominal);
      expect(other).toEqual({ ...first, [rating]: { ...first[rating], value: variant } });
    }
  });

  it("两种 CNC 的声明指向各自真实的 X 轴槽位，初始电机保留原结构修订", () => {
    const factory = file("cnc-factory/project.twin.json");
    if (factory.kind !== "project") throw new Error("缺少工厂工程");
    const ws = factory.workspace, byKey = new Map(ws.packages.map(p => [packageKey(p), p]));
    for (const id of ["cnc-a", "cnc-b"]) {
      const cnc = byKey.get(ws.factories![0].resources.find(r => r.id === id)!.packageKey)!;
      const port = cnc.axisPorts!.find(a => a.id === "x")!;
      let owner = cnc;
      for (const slot of [...port.path, port.motorSlot]) {
        owner = byKey.get(getDeviceParts(owner).find(p => p.id === slot)!.packageKey)!;
      }
      expect(owner).toMatchObject({ model: "EDU-SERVO", revision: "1" });
      expect(owner.motorPhysics).toBeUndefined();
      expect(port).toMatchObject({ leadMmPerRev: 5, tableMassKg: 5, driveVoltageLimitV: 24, driveCurrentLimitA: 4 });
    }
  });
});
