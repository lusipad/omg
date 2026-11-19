import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import registry from "../public/modelica/contour-library.json";
import manifest from "../public/modelica/runtime/contour-axis.json";
import native from "../scripts/modelica/motor-native-results.json";

const outputs = ["positionMm", "velocityMmS", "angleDeg", "speedRpm", "currentA", "motorTorqueNm"] as const;
type Observations = Record<typeof outputs[number], () => number>;
type Axis = Observations & { reset(...args: number[]): void; stepReference(h: number, a: number, b: number): void };
const asset = (path: string) => readFileSync(new URL("../public/modelica/" + path, import.meta.url));
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const reference = native.cases.normal.parameters;
const args = manifest.parameters.map(name => reference[name as keyof typeof reference]);
const binary = asset("runtime/contour-axis.wasm");
const compiled = new WebAssembly.Module(binary);

function newAxis() {
  const axis = new WebAssembly.Instance(compiled).exports as unknown as Axis;
  axis.reset(...args);
  return axis;
}

it("轮廓工件保留输入端口和编译器选定的三个电机状态", () => {
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  expect(WebAssembly.Module.exports(compiled).map(x => x.name)).toEqual(expect.arrayContaining(["reset", "stepReference", ...outputs]));
  expect(manifest.inputs).toEqual({ referenceMm: "mm" });
  expect(manifest.integrator.inputHold).toBe("linear");
  expect(manifest.states).toEqual(registry.assembly.states);
  expect(manifest.parameters).toEqual(Object.keys(registry.assembly.parameters));
  expect(manifest.wasmSha256).toBe(sha(binary));
  expect(manifest.sourceSha256).toBe(sha(asset(registry.source)));
  expect(manifest.librarySha256).toBe(sha(asset("contour-library.json")));
  for (const [path, hash] of Object.entries(manifest.dependencySha256)) expect(sha(asset(path))).toBe(hash);
});

it("连续恒定指令复现原装机轴，复位会清除上次试验的状态和输入", () => {
  const moving = newAxis();
  const fixed = new WebAssembly.Instance(new WebAssembly.Module(asset("runtime/motor-axis.wasm"))).exports as unknown as
    Observations & { reset(...args: number[]): void; step(h: number): void };
  fixed.reset(10, ...args);
  for (let i = 1; i <= 4000; i++) {
    fixed.step(0.000025);
    moving.stepReference(0.000025, 10, 10);
    if (i % 400 === 0) for (const name of outputs) expect(moving[name]()).toBeCloseTo(fixed[name](), 9);
  }
  expect(moving.positionMm()).toBeGreaterThan(6);
  moving.reset(...args);
  moving.stepReference(0.000025, 0, 0);
  expect(outputs.map(name => moving[name]())).toEqual([0, 0, 0, 0, 0, 0]);
});

it("按 RK4 各阶段输入斜坡，反向后保留先前电流与惯量的运动历史", () => {
  const axis = newAxis(), fine = newAxis(), h = 0.000025;
  axis.stepReference(h, 0, 0.1);
  for (let i = 0; i < 20; i++) fine.stepReference(h / 20, 0.1 * i / 20, 0.1 * (i + 1) / 20);
  expect(axis.currentA()).toBeGreaterThan(0.0001);
  expect(axis.currentA()).toBeCloseTo(fine.currentA(), 8);
  for (let i = 0; i < 4000; i++) axis.stepReference(h, 0.1 + i / 4000, 0.1 + (i + 1) / 4000);
  const before = axis.positionMm(), velocity = axis.velocityMmS();
  axis.stepReference(h, 1.1, 1.09975);
  expect(axis.positionMm()).toBeGreaterThan(before);
  expect(Math.abs(axis.velocityMmS() - velocity)).toBeLessThan(0.02);
  for (let i = 1; i < 8000; i++) axis.stepReference(h, 1.1 - i / 4000, 1.1 - (i + 1) / 4000);
  expect(axis.velocityMmS()).toBeLessThan(-7);
});
