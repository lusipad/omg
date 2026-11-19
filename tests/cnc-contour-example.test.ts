import { expect, it } from "vitest";
import { resolveContourAxes, resolveContourMount } from "../contracts/cnc-contour";
import { upsertFactoryLayout } from "../contracts/factory";
import { factoryStructureSnapshot } from "../contracts/factory-structure";
import { buildServoMotor, installMotorOnFactoryAxis } from "../contracts/motor-assembly";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installDeviceDependencies, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import project from "../public/assemblies/cnc-factory/project.twin.json";
import { contourTemplate, prepareContourTrial } from "../src/lib/cnc-contour-example";

const sample = parseWorkspace(project), layout = sample.factories![0], id = "cnc-a", program = "G21 G17 G90\nG1 X1 F150";
const key = (model: string) => packageKey(sample.packages.find(p => p.model === model && p.revision === "1")!);
const parts = { manufacturer: "机加工车间", model: "自组电机", statorKey: key("S40-STD"), bearingKey: key("B08-STD") };
const first = buildServoMotor(sample, { ...parts, revision: "1", rotorKey: key("R40-STD") });
const chosen = buildServoMotor(sample, { ...parts, revision: "2", rotorKey: key("R40-HI") });
const stock = [first, chosen].reduce(installPackage, sample);

it("全新工程从原始机床组装标准教学电机", () => {
  const trial = prepareContourTrial(emptyWorkspace(), sample, id, program);
  const machine = resolveContourAxes(trial.workspace, trial.workspace.factories![0], id);
  expect(machine.axes.map(a => [a.stator.model, a.rotor.model, a.bearing.model])).toEqual(Array(3).fill(["S40-STD", "R40-STD", "B08-STD"]));
  expect(machine.resource.contourRun?.program).toBe(program);
  expect(trial.note).toMatch(/教学标准/);
});

it("已有精简机床，或本地电机接口不匹配、零件未齐时，保留三根轴的原装电机", () => {
  const reduced = factoryStructureSnapshot(sample, layout).workspace;
  expect(reduced.packages.some(p => p.motorPhysics)).toBe(false);
  const incompatible = parseDevicePackage({ ...chosen, revision: "其它接口", motorPhysics: { ...chosen.motorPhysics, fit: "其它法兰" } });
  const incompatibleLibrary = installDeviceDependencies(emptyWorkspace(), installPackage(stock, incompatible).packages, [packageKey(incompatible)]);
  const incompleteLibrary = parseWorkspace({ ...emptyWorkspace(), packages: [chosen] });
  const original = resolveContourMount(sample, layout, id, contourTemplate).mounts.map(m => m.motorKey);
  for (const start of [reduced, sample, incompatibleLibrary, incompleteLibrary]) {
    const trial = prepareContourTrial(start, sample, id, program);
    const machine = resolveContourMount(trial.workspace, trial.workspace.factories![0], id, contourTemplate);
    expect(machine.root.revision).toBe("3");
    expect(machine.mounts.map(m => m.motorKey)).toEqual(original);
    expect(machine.compatibleMotors).toHaveLength(0);
    expect(trial.workspace.packages.some(p => p.model === "标准选件伺服电机")).toBe(false);
    expect(trial.note).toMatch(/组装或导入/);
  }
});

it("试跑优先沿用已保存在 X 轴的确切电机修订，保留原有工厂和另一台 CNC", () => {
  const old = installMotorOnFactoryAxis(stock, layout, id, "x", packageKey(chosen), "上次装机");
  const prior = upsertFactoryLayout(old.workspace, old.layout), before = JSON.stringify(prior);
  const trial = prepareContourTrial(prior, sample, id, program), trialLayout = trial.workspace.factories![0];
  const machine = resolveContourAxes(trial.workspace, trialLayout, id);
  expect(trial.note).toMatch(/当前工程 X 轴/);
  expect(machine.axes.map(a => [a.motorKey, a.parameters.rotorInertiaKgM2])).toEqual(Array(3).fill([packageKey(chosen), .00006]));
  expect(trialLayout.resources.find(r => r.id === "cnc-b")).toEqual(old.layout.resources.find(r => r.id === "cnc-b"));
  expect(JSON.stringify(prior)).toBe(before);
});

it("仅有设备库时采用唯一兼容电机，多种同名修订则保留所有选项等用户选择", () => {
  const one = installDeviceDependencies(emptyWorkspace(), stock.packages, [packageKey(chosen)]);
  if (first.composition?.kind !== "assembly") throw new Error("试件须由零件组装");
  const missingKey = packageKey({ manufacturer: "机加工车间", model: "未到货转子", revision: "1" });
  const missingRotor = parseDevicePackage({ ...first, revision: "缺件", composition: { ...first.composition,
    parts: first.composition.parts.map(p => p.id === "rotor" ? { ...p, packageKey: missingKey } : p) } });
  const selected = prepareContourTrial(installPackage(one, missingRotor), sample, id, program), chosenLayout = selected.workspace.factories![0];
  expect(selected.note).toMatch(/唯一匹配/);
  expect(resolveContourAxes(selected.workspace, chosenLayout, id).motorKey).toBe(packageKey(chosen));
  const both = installDeviceDependencies(one, stock.packages, [packageKey(first)]);
  for (const start of [both, stock]) {
    const trial = prepareContourTrial(start, sample, id, program), trialLayout = trial.workspace.factories![0];
    const pending = resolveContourMount(trial.workspace, trialLayout, id, contourTemplate);
    expect(trial.note).toMatch(/选择/);
    expect(pending.recommendedMotorKey).toBeUndefined();
    expect(pending.compatibleMotors.map(packageKey).sort()).toEqual([packageKey(first), packageKey(chosen)].sort());
    expect(pending.root.revision).toBe("3");
    expect(() => resolveContourAxes(trial.workspace, trialLayout, id)).toThrow(/三轴/);
  }
});
