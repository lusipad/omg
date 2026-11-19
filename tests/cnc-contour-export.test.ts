import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { afterEach, expect, it, vi } from "vitest";
import { resolveContourAxes } from "../contracts/cnc-contour";
import { planContourProgram } from "../contracts/contour-plan";
import { buildServoMotor, installMotorOnFactoryAxis } from "../contracts/motor-assembly";
import { packageKey } from "../contracts/twin-device";
import { installPackage, parseWorkspace } from "../contracts/twin-simulation";
import fixture from "../public/assemblies/cnc-factory/contour.twin.json";
import manifest from "../public/modelica/runtime/contour-axis.json";
import baseline from "../scripts/modelica/contour-export-results.json";
import { exportCncContour } from "../src/lib/cnc-contour-export";
import { inspectWorkbenchFiles } from "../src/lib/workbench-import";

const workspace = parseWorkspace(fixture), layout = workspace.factories![0], cnc = "cnc-a";
const program = "G21 G90 G17\nG1 X2 Y2 Z3 F360\nG3 X0 Y2 I-1 J0\nG2 X2 Y2 I1 J0\n";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function serve(broken = "") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const name = new URL(url, "https://local.test").pathname.split("/").at(-1)!;
    const data = Uint8Array.from(readFileSync(new URL("../public/modelica/" + name, import.meta.url)));
    if (name === broken) data[0] ^= 1;
    return new Response(data);
  }));
}
afterEach(() => vi.unstubAllGlobals());

it("发布的原生复算报告对应当前圆槽程序、WASM、Modelica 源码及独立核验程序", () => {
  const fileHash = (path: string) => sha(readFileSync(new URL(path, import.meta.url)));
  expect(baseline).toMatchObject({ passed: true, compiler: manifest.compiler, sourceSha256: manifest.sourceSha256,
    wasmSha256: manifest.wasmSha256, verifierSha256: fileHash("../scripts/modelica/verify-contour-exports.py") });
  expect(baseline.cases.pocket.programSha256).toBe(fileHash("../public/assemblies/cnc-factory/circular-pocket.nc"));
  expect(baseline.cases.pocket.referenceSha256).toBe(baseline.cases["heavy-rotor"].referenceSha256);
  for (const item of Object.values(baseline.cases)) {
    expect(item.passed).toBe(true);
    expect(item.browser).toMatch(/Chrome\//);
    expect(item.nativeRows).toBeGreaterThanOrEqual(item.matchedTimes);
  }
  expect(baseline.negativeControl).toMatch(/actualX:.*exceeds/);
});

it("导出的三轴复用一种电机修订、各自的安装工况及同一张工件系指令表，回导后保留程序", async () => {
  serve();
  const mounted = resolveContourAxes(workspace, layout, cnc), plan = planContourProgram(program, mounted.contour);
  const blob = await exportCncContour(workspace, layout, cnc, program);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer())), text = (name: string) => new TextDecoder().decode(files[name]);
  const map = JSON.parse(text("contour-map.json")), model = text("ContourRun.mo");
  expect(map).toMatchObject({ kind: "cnc-contour-map", layoutId: layout.id, resourceId: cnc, motorKey: mounted.motorKey,
    profile: mounted.contour, wasmSha256: manifest.wasmSha256 });
  for (const [name, hash] of Object.entries({ "GouyuanContour.mo": manifest.sourceSha256, ...manifest.dependencySha256 })) {
    expect(sha(files[name])).toBe(hash);
    expect(map.sourceSha256[name]).toBe(hash);
  }
  expect(text("program.nc")).toBe(program);
  expect(map.program.sha256).toBe(sha(files["program.nc"]));
  expect(sha(files["reference.txt"])).toBe(map.reference.sha256);
  expect(text("run.mos")).toMatch(/method="dassl".*outputFormat="csv"/);
  expect(text("AssembledMotor.mo")).toContain("extends GouyuanMotor.PMServoMotor");
  expect(model).toContain('constant Real origin[3](each unit="mm") = {0,0,5}');
  expect(model).not.toContain("targetMm=");
  for (const [i, axis] of ["X", "Y", "Z"].entries()) {
    const resolved = mounted.axes[i], recorded = map.axes[i];
    expect(model).toContain(`GouyuanContour.TrackingAxis axis${axis}(redeclare model MotorModel=AssembledMotor`);
    expect(model).toContain(`axis${axis}.referenceMm = ref.y[${i+1}] - origin[${i+1}]`);
    expect(recorded).toMatchObject({ axisId: resolved.port.id, axisPath: resolved.port.path, motorSlot: resolved.port.motorSlot,
      motorKey: mounted.motorKey, coordinate: axis, fixtureSource: resolved.port.source });
    for (const key of Object.keys(resolved.sources) as (keyof typeof resolved.sources)[]) {
      if (key === "targetMm") continue;
      expect(recorded.parameterSources[key]).toEqual(resolved.sources[key]);
      expect(recorded.parameters[key]).toBe(resolved.parameters[key]);
    }
  }
  const [format, header, ...data] = text("reference.txt").trimEnd().split("\n");
  expect([format, header]).toEqual(["#1", `double command(${plan.timesS.length},7)`]);
  const times = data.map(line => Number(line.split(" ", 1)[0]));
  expect(times).toEqual(Array.from(plan.timesS));
  expect(data[0].split(" ").map(Number)).toEqual([0, 0, 0, 5, 0, 0, 0]);
  expect(data.at(-1)!.split(" ").map(Number)).toEqual([plan.endS, 2, 2, 3, 0, 0, 0]);
  const imported = await inspectWorkbenchFiles([new File([blob], "圆槽试验.zip")]);
  if (imported.kind !== "project") throw new Error("三轴 ZIP 应恢复为选定工厂");
  expect(imported).toMatchObject({ contourFocus: cnc });
  const restored = resolveContourAxes(imported.workspace, imported.workspace.factories![0], cnc);
  expect(restored.resource.contourRun?.program).toBe(program);
  expect(restored.axes.map(axis => axis.sources)).toEqual(mounted.axes.map(axis => axis.sources));
  expect(layout.resources.find(r => r.id === cnc)?.contourRun?.program).not.toBe(program);
});

it("装机不全或混用修订、程序越界、取消和错误源码均阻止导出", async () => {
  serve("GouyuanMotor.mo");
  const { motor, axes } = resolveContourAxes(workspace, layout, cnc);
  const incomplete = { ...workspace, packages: workspace.packages.filter(p => p !== motor) };
  await expect(exportCncContour(incomplete, layout, cnc, program)).rejects.toThrow(/电机/);
  const other = buildServoMotor(workspace, { manufacturer: motor.manufacturer, model: motor.model, revision: "2",
    statorKey: packageKey(axes[0].stator), rotorKey: packageKey(axes[0].rotor), bearingKey: packageKey(axes[0].bearing) });
  const mixed = installMotorOnFactoryAxis(installPackage(workspace, other), layout, cnc, axes[0].port.id, packageKey(other), "x-only");
  await expect(exportCncContour(mixed.workspace, mixed.layout, cnc, program)).rejects.toThrow(/三根轴的电机修订不一致/);
  await expect(exportCncContour(workspace, layout, cnc, "G0 X99999")).rejects.toThrow(/行程/);
  await expect(exportCncContour(workspace, layout, cnc, program, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(exportCncContour(workspace, layout, cnc, program)).rejects.toThrow(/SHA-256/);
});
