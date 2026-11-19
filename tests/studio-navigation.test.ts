import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PICK_PLACE_EXAMPLE, ROBOT_EXAMPLES } from "../contracts/robot-examples";
import { createServoDemo, createTwinDemo } from "../contracts/twin-demo";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { getStudioExample, getWorkbenchTargets, readStudioRoute, STUDIO_EXAMPLES, studioHref, type StudioRoute } from "../contracts/studio-navigation";

const hash = "a".repeat(64);
describe("工作台路由", () => {
  it("空地址展示资源总览，纯运行台地址由当前工程决定对象", () => {
    expect(readStudioRoute("")).toEqual({ view: "resources" });
    expect(readStudioRoute("?view=resources")).toEqual({ view: "resources" });
    expect(readStudioRoute("?view=workbench")).toEqual({ view: "workbench" });
    expect(readStudioRoute("?view=examples")).toEqual({ view: "examples" });
  });
  it("可新建装配或按工程中的装配 ID 打开，不依赖机型目录", () => {
    const definition = { schemaVersion: 1, kind: "linear-axis-assembly", id: "unlisted-feed", name: "用户送料机构",
      modules: [{ id: "transmission", drive: "驱动", motor: "电机", screw: "丝杠", leadMmPerRev: 5, loadInertiaRatio: 1 }],
      axes: [{ id: "feed", module: "transmission", direction: [0, 1, 0], targetMm: 10 }] };
    const project = parseWorkspace({ ...emptyWorkspace(), assemblies: [definition] });
    const target = { id: "assembly:unlisted-feed", name: "用户送料机构" };
    expect(getWorkbenchTargets(project)).toEqual([target]);
    expect(getStudioExample(definition.id)).toBeUndefined();
    for (const id of ["assembly-new", target.id]) {
      expect(readStudioRoute(new URLSearchParams({ view: "workbench", target: id }))).toEqual({ view: "workbench", target: id });
    }
    expect(readStudioRoute("?view=workbench&target=assembly:")).toEqual({ view: "workbench", unavailableTarget: "assembly:" });
    expect(readStudioRoute("?view=workbench&target=assembly:constructor")).toEqual({ view: "workbench", unavailableTarget: "assembly:constructor" });
  });
  it.each(["device", "material", "physics", "system", "author"] as const)("资源筛选 %s 可往返规范地址", (section) => {
    const route = { view: "resources", section } as const;
    expect(studioHref(route)).toBe(`?view=resources&section=${section}`);
    expect(readStudioRoute(studioHref(route))).toEqual(route);
  });
  it("临时示例、已装物理模型和待预览输入是三个独立目标", () => {
    const routes: StudioRoute[] = [
      { view: "workbench", exampleId: "ur5e" }, { view: "workbench", target: `model:${hash}` }, { view: "workbench", target: "incoming" },
      { view: "workbench", target: "wiring" }, { view: "workbench", exampleId: "wiring-demo" },
    ];
    for (const route of routes) expect(readStudioRoute(studioHref(route))).toEqual(route);
    expect(readStudioRoute(new URLSearchParams({ view: "workbench", target: "model:" + hash }))).toEqual(routes[1]);
    expect(studioHref(routes[0])).toBe("?view=workbench&example=ur5e");
  });
  it("普通旧导航保留当前工程目标与资源功能", () => {
    expect(readStudioRoute("?view=import")).toEqual({ view: "resources" });
    for (const section of ["device", "material", "physics"]) expect(readStudioRoute(`?view=import&section=${section}`)).toEqual({ view: "resources", section });
    expect(readStudioRoute("?view=library")).toEqual({ view: "resources", section: "author" });
    for (const [old, target] of [["simulation", "wiring"], ["servo", "servo"], ["so101", "so101"], ["milo", "milo"]]) {
      expect(readStudioRoute("?view=" + old)).toEqual({ view: "workbench", target });
    }
  });
  it("旧圆槽演示专链进入独立示例，明确选择当前工程的链接仍打开用户程序", () => {
    const demo = { view: "workbench", exampleId: "milo-v1-5" } as const;
    expect(readStudioRoute("?view=milo#milo-pocket")).toEqual(demo);
    expect(readStudioRoute(new URLSearchParams({ view: "milo" }), "#milo-pocket")).toEqual(demo);
    expect(readStudioRoute("#milo-pocket")).toEqual(demo);
    expect(readStudioRoute("", "#milo-pocket")).toEqual(demo);
    expect(studioHref(demo)).toBe("?view=workbench&example=milo-v1-5");
    const current = { view: "workbench", target: "milo" } as const;
    expect(readStudioRoute("?view=milo")).toEqual(current);
    expect(readStudioRoute(studioHref(current, "#milo-pocket"))).toEqual(current);
  });
  it("未知 ID 保留未命中状态，不加载默认示例、不将目标降级成其他模型", () => {
    expect(readStudioRoute("?view=unknown&robot=ur5e")).toEqual({ view: "resources" });
    expect(readStudioRoute("?view=resources&section=oops")).toEqual({ view: "resources" });
    for (const id of ["ur5e", "ur5e-pick-place", "nonexistent"]) {
      expect(readStudioRoute(new URLSearchParams({ view: "import", robot: id }))).toEqual({ view: "workbench", exampleId: id });
    }
    expect(getStudioExample("nonexistent")).toBeUndefined();
    const unavailable = readStudioRoute("?view=workbench&target=model%3Anot-a-hash");
    expect(unavailable).toEqual({ view: "workbench", unavailableTarget: "model:not-a-hash" });
    const escaped = studioHref({ view: "workbench", exampleId: "bad&target=servo" });
    expect(readStudioRoute(escaped)).toEqual({ view: "workbench", exampleId: "bad&target=servo" });
  });
});

describe("示例和当前工程对象", () => {
  it("统一目录覆盖五种已有试用功能、六个机器人和组合工位", () => {
    const ids = ["wiring-demo", "inovance-servo", "so101-follower", "milo-v1-5", "spring-carriage",
      ...ROBOT_EXAMPLES.map((r) => r.id), PICK_PLACE_EXAMPLE.id];
    expect(new Set(STUDIO_EXAMPLES.map((e) => e.id)).size).toBe(STUDIO_EXAMPLES.length);
    expect(STUDIO_EXAMPLES.map((e) => e.id)).toEqual(expect.arrayContaining(ids));
    for (const example of STUDIO_EXAMPLES) {
      expect(example.name && example.category && example.description && example.preview).toBeTruthy();
      expect(getStudioExample(example.id)).toBe(example);
      expect(example.preview).not.toMatch(/^(?:\/|https?:|\.\.)/);
      for (const asset of [example.preview, example.download, example.sourceNotes]) {
        if (asset) expect(statSync(new URL("../public/" + asset.split(/[?#]/, 1)[0], import.meta.url)).isFile()).toBe(true);
      }
    }
    expect(getStudioExample("spring-carriage")).toMatchObject({ kind: "physics", name: "弹簧滑台", download: "examples/spring-carriage.xml" });
    for (const robot of ROBOT_EXAMPLES) {
      expect(getStudioExample(robot.id)).toMatchObject({ kind: "physics", category: robot.category, name: robot.name, description: robot.description,
        source: robot.sourceUrl, bytes: robot.bytes, license: robot.license, author: robot.author, preview: `robots/${robot.id}/preview.webp` });
    }
  });
  it("空工程没有虚构对象，已装资源只生成对应目标且导航不会写工程数据", () => {
    const empty = emptyWorkspace(), model = { id: hash, entry: "custom.xml", name: "用户滑台" };
    expect(getWorkbenchTargets(empty)).toEqual([]);
    expect(getWorkbenchTargets({ ...empty, catalog: { models: [model], materials: [] } })).toEqual([{ id: "model:" + hash, name: "用户滑台" }]);
    const signals = createTwinDemo();
    expect(getWorkbenchTargets(signals).map((t) => t.id)).toEqual(["wiring"]);
    const servo = createServoDemo();
    expect(getWorkbenchTargets(servo).map((t) => t.id)).toEqual(["servo"]);
    expect(getWorkbenchTargets({ ...empty, packages: [servo.packages[0]] }).map((t) => t.id)).toEqual(["servo"]);
    expect(getWorkbenchTargets({ ...empty, milo: { program: "G1 X1 F100", assembled: [] } }).map((t) => t.id)).toEqual(["milo"]);
    const follower = parseWorkspace(JSON.parse(readFileSync(new URL("../examples/so101-follower.twin.json", import.meta.url), "utf8")));
    const saved = JSON.stringify(follower);
    expect(getWorkbenchTargets(follower).map((t) => t.id)).toContain("so101");
    readStudioRoute("?view=workbench&example=barkour-v0");
    expect(JSON.stringify(follower)).toBe(saved);
  });
  it("已装配对象和已安装模型排在散件之前", () => {
    const base = emptyWorkspace(), signals = createTwinDemo().packages, servoParts = createServoDemo().packages;
    const model = { id: hash, entry: "custom.xml", name: "用户模型" }, packages = [...signals, ...servoParts];
    const targets = getWorkbenchTargets({ ...base, packages, catalog: { models: [model], materials: [] } });
    expect(targets.map((t) => t.id)).toEqual(["model:" + hash, "wiring", "servo"]);
    expect(getWorkbenchTargets({ ...base, packages, milo: { program: "G1 X1 F100", assembled: [] } }).map((t) => t.id)).toEqual(["milo", "wiring", "servo"]);
    expect(getWorkbenchTargets({ ...base, milo: { program: "", assembled: [] } })).toEqual([]);
  });
});
