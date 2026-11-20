import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStudioExample, prepareStudioExampleJoin } from "../src/lib/studio-example-workspace";
import { createServoDemo, createTwinDemo } from "../contracts/twin-demo";
import { emptyWorkspace, parseWorkspace, setInput } from "../contracts/twin-simulation";
import { DEFAULT_SO101_MOTION, parseSo101Motion } from "../contracts/so101";
import { applySo101BomImport } from "../contracts/import-apply";
import { createDocumentMaterial } from "../contracts/material-import";
import { getStudioExample } from "../contracts/studio-navigation";
import { inspectLinearAssembly } from "../contracts/linear-assembly";
import { requireReadySystem } from "../contracts/system-twin";
import { integrateSystemTwin } from "../src/lib/system-twin-runtime";

const file = (name: string) => readFileSync(new URL("../public/" + name, import.meta.url), "utf8");
function fakeSources() {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const name = new URL(url, "http://localhost").pathname.replace(/^\//, "");
    return new Response(file(name));
  }));
}
afterEach(() => vi.unstubAllGlobals());

it("工厂试用与加入共用同一份工程，替换已有布局时需确认，既有轴和备用设备随工程保留", async () => {
  fakeSources();
  const example = getStudioExample("cnc-factory")!;
  const trial = (await loadStudioExample("factory", new AbortController().signal, example.download)).workspace;
  const previous = createServoDemo();
  const change = prepareStudioExampleJoin("factory", previous, trial);
  expect(previous.factories).toBeUndefined();
  expect(change.replacement).toBeUndefined();
  expect(change.next.factories).toEqual(trial.factories);
  expect(change.next.servoAxis).toEqual(previous.servoAxis);
  expect(change.next.packages).toHaveLength(previous.packages.length + trial.packages.length);
  expect(prepareStudioExampleJoin("factory", change.next, trial).replacement).toBeUndefined();
  const revised = structuredClone(trial);
  revised.factories![0].lines[0].batch.quantity = 3;
  const replacing = prepareStudioExampleJoin("factory", change.next, revised);
  expect(replacing.replacement).toContain(trial.factories![0].name);
  expect(replacing.next.factories![0].lines[0].batch.quantity).toBe(3);
});

it("试用的进给轴可以连同可换丝杠和工作台加入工程，既有物料和装配保留", async () => {
  fakeSources();
  const example = getStudioExample("modelica-feed-axis");
  expect(example?.kind).toBe("linear-assembly");
  const sample = (await loadStudioExample("linear-assembly", new AbortController().signal, example!.download)).workspace;
  const initial = createServoDemo();
  const unrelated = createDocumentMaterial("设备笔记", "原工程记录");
  const project = { ...initial, catalog: { materials: [unrelated], models: [] } };
  const join = prepareStudioExampleJoin("linear-assembly", project, sample);
  expect(join.next.catalog?.materials).toHaveLength(7);
  expect(join.next.catalog?.materials).toContainEqual(unrelated);
  expect(join.next.servoAxis).toEqual(initial.servoAxis);
  expect(join.next.assemblies?.[0].modelRef?.id).toBe("GouyuanLinear.FeedAxis");
  expect(join.next.packages).toHaveLength(initial.packages.length + 6);
  expect(join.replacement).toBeUndefined();
  expect(prepareStudioExampleJoin("linear-assembly", sample, sample).replacement).toBeUndefined();
  expect(prepareStudioExampleJoin("linear-assembly", join.next, sample).replacement).toBeUndefined();
  const changed = structuredClone(sample);
  changed.assemblies![0].axes[0].targetMm = -3;
  const next = prepareStudioExampleJoin("linear-assembly", join.next, changed);
  expect(next.replacement).toContain(sample.assemblies![0].name);
  expect(next.next.assemblies?.[0].axes[0].targetMm).toBe(-3);
  expect(project.catalog.materials).toEqual([unrelated]);
});

it("加入进给轴时按原来的 BOM 行选料，同名物料与已绑定的替代件仍可辨别", async () => {
  fakeSources();
  const sample = (await loadStudioExample("linear-assembly", new AbortController().signal, getStudioExample("modelica-feed-axis")!.download)).workspace;
  const rows = sample.catalog!.materials, screw = rows.find(row => row.leadMmPerRev === 5)!;
  const duplicate = { ...screw, id: "user-screw", binding: undefined, leadMmPerRev: 8 };
  const base = { ...emptyWorkspace(), catalog: { materials: [duplicate], models: [] } };
  const joined = prepareStudioExampleJoin("linear-assembly", base, sample).next;
  expect(joined.assemblies![0].modules[0].screw).toBe(screw.id);
  expect(inspectLinearAssembly(joined, joined.assemblies![0])).toEqual([]);
  const original = { ...sample, catalog: { ...sample.catalog!, materials: rows.map(row => row.id === screw.id ? duplicate : row) },
    assemblies: [{ ...sample.assemblies![0], id: "old-axis", name: "已有 8 mm 丝杠" }] };
  const both = prepareStudioExampleJoin("linear-assembly", original, sample).next;
  expect(both.assemblies!.map(a => a.modules[0].screw)).toEqual([duplicate.id, screw.id]);
  expect(both.assemblies!.flatMap(a => inspectLinearAssembly(both, a))).toEqual([]);
  const otherScrew = rows.find(row => row.leadMmPerRev === 10)!;
  const conflicting = { ...sample, catalog: { ...sample.catalog!, materials: rows.map(row =>
    row.id === screw.id ? { ...screw, binding: otherScrew.binding } : row) } };
  expect(() => prepareStudioExampleJoin("linear-assembly", conflicting, sample)).toThrow(/已绑定其他修订/);
});

it("示例库从可下载工程试跑有版本的轴，加入旧工程前展示型号修订和求解模型", async () => {
  fakeSources();
  const sample = (await loadStudioExample("servo", new AbortController().signal)).workspace;
  const download = getStudioExample("inovance-servo")?.download;
  expect(download).toBe("modelica/servo-axis.twin.json");
  expect(sample).toEqual(parseWorkspace(JSON.parse(file(download!))));
  expect(sample.servoAxis?.modelRef).toEqual({ id: "Gouyuan.ServoAxis", version: "1.0.0" });
  const previous = createServoDemo();
  const change = prepareStudioExampleJoin("servo", previous, sample);
  expect(change.replacement).toMatch(/工作台刚性轴模型.*v0.6-modelica.1.*Gouyuan.ServoAxis @ 1.0.0/);
  expect(change.next.servoAxis).toEqual(sample.servoAxis);
  expect(previous.servoAxis).not.toHaveProperty("modelRef");
});

describe("四个工作台示例", () => {
  it("独立加载本站从臂 BOM 及 Milo 实际采购表、三轴与圆槽 NC", async () => {
    fakeSources();
    const signal = new AbortController().signal;
    const follower = await loadStudioExample("so101", signal);
    expect(follower.workspace.so101?.bom).toHaveLength(6);
    expect(follower.workspace.so101?.waypoints).toEqual(DEFAULT_SO101_MOTION);
    const project = applySo101BomImport(emptyWorkspace(), follower.workspace.so101!.bom);
    expect(project.so101.waypoints).toHaveLength(1);
    const fromExample = prepareStudioExampleJoin("so101", project, follower.workspace);
    expect(fromExample.replacement).toMatch(/1 个示教路点.*3 个路点/);
    expect(project.so101.waypoints).toHaveLength(1);
    expect(fromExample.next.so101?.waypoints).toEqual(DEFAULT_SO101_MOTION);
    const milo = await loadStudioExample("milo", signal);
    expect(milo.workspace.milo).toMatchObject({ assembled: ["X", "Y", "Z"], program: expect.stringContaining("G3") });
    expect(milo.workspace.milo?.bom).toHaveLength(81);
    expect(milo.plan?.segments.some(segment => segment.arc)).toBe(true);
    expect(milo.workspace.milo?.program).toContain("Ø30");
  });

  it("切换示例中止迟到的读取，即使来源忽略 abort", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { release = () => resolve(new Response(file("models/so101/follower-bom.md"))); }));
    const controller = new AbortController();
    const load = loadStudioExample("so101", controller.signal);
    controller.abort(); release();
    await expect(load).rejects.toThrow();
  });

  it("缺料工程试用完整 Milo 示例，必须确认替换才会带入设备和程序", async () => {
    fakeSources();
    const signal = new AbortController().signal;
    const sample = await loadStudioExample("milo", signal);
    const milo = sample.workspace.milo!;
    const partial = { ...sample.workspace, milo: { ...milo, bom: milo.bom!.filter(row => row.name !== "Motor Drivers"), assembled: [], program: "G1 X7 F80" } };
    const fresh = await loadStudioExample("milo", signal);
    const pending = prepareStudioExampleJoin("milo", partial, fresh.workspace);
    expect(pending.replacement).toMatch(/0 根轴.*程序/);
    expect(pending.next.milo?.assembled).toEqual(["X", "Y", "Z"]);
    expect(partial.milo.program).toBe("G1 X7 F80");
    expect(partial.milo.assembled).toEqual([]);
  });

  it("接线试用不写工程，加入后保留伺服、其他设备包与资料，重复加入幂等", () => {
    const project = { ...createServoDemo(), catalog: { models: [], materials: [createDocumentMaterial("机台 A", "安装记录")] } };
    const before = JSON.stringify(project);
    let trial = createTwinDemo();
    trial = setInput(trial, trial.instances[1].id, "setting", 18);
    const join = prepareStudioExampleJoin("wiring", project, trial);
    expect(join.replacement).toBeUndefined();
    expect(JSON.stringify(project)).toBe(before);
    expect(join.next.instances[1].inputs.setting).toBe(18);
    expect(join.next.packages).toHaveLength(4);
    expect(join.next.servoAxis).toEqual(project.servoAxis);
    expect(join.next.catalog).toEqual(project.catalog);
    const again = prepareStudioExampleJoin("wiring", join.next, trial);
    expect(again.replacement).toBeUndefined();
    expect(again.next).toEqual(join.next);
  });

  it("已有不同接线时给出替换数量，取消拟议变更保留原值", () => {
    const project = createTwinDemo(), before = JSON.stringify(project);
    const alternative = setInput(createTwinDemo(), project.instances[1].id, "setting", 0);
    const pending = prepareStudioExampleJoin("wiring", project, alternative);
    expect(pending.replacement).toMatch(/2.*实例.*1.*接线/);
    expect(JSON.stringify(project)).toBe(before);
    expect(pending.next.instances).toHaveLength(2);
    expect(pending.next.instances[1].inputs.setting).toBe(0);
  });

  it("JSON 字段顺序不同的同一接线配置无需确认", () => {
    let sample = createTwinDemo();
    const id = sample.instances[0].id;
    sample = setInput(setInput(sample, id, "v1", 0), id, "v2", 12);
    const project = { ...sample, instances: sample.instances.map(node =>
      node.id === id ? { ...node, inputs: { v2: 12, v1: 0 } } : node) };
    expect(prepareStudioExampleJoin("wiring", project, sample).replacement).toBeUndefined();
  });

  it("伺服只合入所选驱动和电机，已有目标变化需明确替换", () => {
    const project = createTwinDemo(), trial = createServoDemo();
    const spare = { ...project.packages[0], revision: "试用独有修订" };
    const applied = prepareStudioExampleJoin("servo", project, { ...trial, packages: [...trial.packages, spare] });
    expect(applied.replacement).toBeUndefined();
    expect(applied.next.packages.some(device => device.revision === spare.revision)).toBe(false);
    expect(applied.next.connections).toEqual(project.connections);
    const adjusted = { ...trial, servoAxis: { ...trial.servoAxis!, targetDeg: -45 } };
    const replacing = prepareStudioExampleJoin("servo", applied.next, adjusted);
    expect(replacing.replacement).toMatch(/伺服轴/);
    expect(applied.next.servoAxis?.targetDeg).toBe(90);
    expect(replacing.next.servoAxis?.targetDeg).toBe(-45);
  });

  it("Milo 与从臂彼此保留，编辑后的程序、路点只在加入时替换同类资产", async () => {
    fakeSources();
    const signal = new AbortController().signal;
    const { workspace: follower } = await loadStudioExample("so101", signal);
    const { workspace: mill } = await loadStudioExample("milo", signal);
    const step1 = prepareStudioExampleJoin("so101", emptyWorkspace(), follower).next;
    const step2 = prepareStudioExampleJoin("milo", step1, mill);
    expect(step2.replacement).toBeUndefined();
    expect(step2.next.so101).toEqual(follower.so101);
    const edited = { ...follower, so101: { ...follower.so101!, waypoints: parseSo101Motion([{ timeS: 1, anglesDeg: [1, 2, 3, 4, 5, 6] }]) } };
    const step3 = prepareStudioExampleJoin("so101", step2.next, edited);
    expect(step3.replacement).toMatch(/路点/);
    expect(step3.next.milo).toBe(step2.next.milo);
    expect(step2.next.so101).toEqual(follower.so101);
    const revised = { ...mill, milo: { ...mill.milo!, program: "G1 F120 X3" } };
    const step4 = prepareStudioExampleJoin("milo", step3.next, revised);
    expect(step4.replacement).toMatch(/程序/);
    expect(step4.next.so101?.waypoints).toEqual(edited.so101.waypoints);
    expect(parseWorkspace(JSON.parse(JSON.stringify(step4.next)))).toEqual(step4.next);
    expect(prepareStudioExampleJoin("milo", step4.next, revised).replacement).toBeUndefined();
  });

  it("同修订定义已冲突时不合入任何一部分", () => {
    const sample = createTwinDemo();
    const old = { ...sample.packages[1], source: { ...sample.packages[1].source, excerpt: "另一修订的证据" } };
    const project = { ...emptyWorkspace(), packages: [old] };
    expect(() => prepareStudioExampleJoin("wiring", project, sample)).toThrow();
    expect(project.packages).toEqual([old]);
    expect(project.instances).toEqual([]);
  });

  it("跨品牌机电控闭环示例可直接加载、执行 WASM 仿真并并入现有工程", async () => {
    fakeSources();
    const example = getStudioExample("closed-loop-feed-system");
    expect(example?.kind).toBe("system");
    const sample = (await loadStudioExample("system", new AbortController().signal, example!.download)).workspace;
    expect(sample.systems).toHaveLength(1);
    const wasm = new WebAssembly.Module(Uint8Array.from(readFileSync(new URL("../public/modelica/runtime/feed-tracking-axis.wasm", import.meta.url))));
    const trace = integrateSystemTwin(requireReadySystem(sample, sample.systems![0]), wasm);
    expect(trace.axisSummaries[0].stopTriggeredAtMs).toBeGreaterThan(200);
    const joined = prepareStudioExampleJoin("system", createServoDemo(), sample);
    expect(joined.replacement).toBeUndefined();
    expect(joined.next.systems).toHaveLength(1);
    expect(joined.next.packages.length).toBeGreaterThan(sample.packages.length);
  });
});
