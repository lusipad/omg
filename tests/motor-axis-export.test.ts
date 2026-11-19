import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { afterEach, expect, it, vi } from "vitest";
import { buildServoMotor, installMotorOnFactoryAxis, resolveMotorAxis, resolveServoMotor } from "../contracts/motor-assembly";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { parseImportText } from "../contracts/workbench-import";
import manifest from "../public/modelica/runtime/motor-axis.json";
import { exportMotorAxis } from "../src/lib/motor-axis-export";
import { inspectWorkbenchFiles } from "../src/lib/workbench-import";

const read = (path: string) => readFileSync(new URL("../public/" + path, import.meta.url));
function mockSources(broken = "") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const file = new URL(url, "https://studio.local").pathname.slice(1), data = Uint8Array.from(read(file));
    if (file === broken) data[0] ^= 1;
    return new Response(data);
  }));
}
function testedAxis() {
  const start = parseWorkspace(JSON.parse(read("assemblies/cnc-factory/project.twin.json").toString("utf8")));
  const keyOf = (model: string) => packageKey(start.packages.find(p => p.model === model && p.revision === "1")!);
  const motor = buildServoMotor(start, { manufacturer: "自建", model: "试验电机", revision: "1",
    statorKey: keyOf("S40-HL"), rotorKey: keyOf("R40-HI"), bearingKey: keyOf("B08-HI") });
  const layout = start.factories![0];
  const mounted = installMotorOnFactoryAxis(installPackage(start, motor), layout, "cnc-a", "x", packageKey(motor), "test-installed");
  return { start, motor, mounted };
}
afterEach(() => vi.unstubAllGlobals());

it("从实际 CNC 装机槽导出独立可用的电机、原生实验与可恢复的试验工况", async () => {
  mockSources();
  const { motor, mounted } = testedAxis();
  const zip = await exportMotorAxis(mounted.workspace, mounted.layout, "cnc-a", "x", -7.25);
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer())), text = (name: string) => new TextDecoder().decode(files[name]);
  for (const [file, digest] of Object.entries({ "GouyuanMotor.mo": manifest.sourceSha256, ...manifest.dependencySha256 })) {
    expect(createHash("sha256").update(files[file]).digest("hex")).toBe(digest);
  }
  expect(text("MotorAxisRun.mo")).toContain("redeclare model MotorModel = AssembledMotor");
  expect(text("AssembledMotor.mo")).toContain('qInductanceH(unit="H")=0.012');
  expect(text("MotorAxisRun.mo")).toContain("qInductanceH=AssembledMotor.StatorData.qInductanceH");
  const lib = parseImportText(text("motor.library.json"), "motor.library.json");
  if (lib.kind !== "devices") throw new Error("导出的电机库未被识别");
  const independent = lib.devices.reduce(installPackage, emptyWorkspace());
  const built = resolveServoMotor(independent, packageKey(motor));
  expect([built.stator.model, built.rotor.model, built.bearing.model]).toEqual(["S40-HL", "R40-HI", "B08-HI"]);
  const result = await inspectWorkbenchFiles([new File([zip], "X轴-Modelica.zip")]);
  if (result.kind !== "project") throw new Error("导出的电机试验 ZIP 未能作为工程恢复");
  expect(result.motorFocus).toEqual({ resourceId: "cnc-a", axisId: "x" });
  const axis = resolveMotorAxis(result.workspace, result.workspace.factories![0], "cnc-a", "x");
  const map = JSON.parse(text("motor-map.json"));
  expect(map.parameterSources).toEqual(axis.sources);
  expect(map.motor.packageKey).toBe(packageKey(motor));
  expect(axis.parameters).toMatchObject({ targetMm: -7.25, rotorInertiaKgM2: 0.00006, bearingViscousNmS: 0.00036, bearingCount: 2 });
  expect(mounted.layout.resources.find(r => r.id === "cnc-a")?.axisTargetsMm?.x).not.toBe(-7.25);
});

it("未建模电机、主动取消和不匹配的源码都会停止导出", async () => {
  mockSources("modelica/GouyuanMotor.mo");
  const { start, mounted } = testedAxis();
  await expect(exportMotorAxis(start, start.factories![0], "cnc-a", "x", 10)).rejects.toThrow();
  await expect(exportMotorAxis(mounted.workspace, mounted.layout, "cnc-a", "x", 10, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(exportMotorAxis(mounted.workspace, mounted.layout, "cnc-a", "x", 10)).rejects.toThrow(/SHA-256/);
});
