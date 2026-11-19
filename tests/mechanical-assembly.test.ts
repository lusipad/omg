import { describe, expect, it } from "vitest";
import {
  bundleMechanicalDevice, exportMechanicalBundle, inspectMechanicalAssembly, installMechanicalBundle, MECHANICAL_LIMITS, mechanicalSubassembly, parseMechanicalAssembly,
  parseMechanicalBundle, resolveMechanicalAssembly, upsertMechanicalAssembly, type MechanicalAssembly, type MechanicalPart,
} from "../contracts/mechanical-assembly";
import { addInstance, emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";

const frame = { positionMm: [0, 0, 0] as [number, number, number], quatWxyz: [1, 0, 0, 0] as [number, number, number, number] };
const ident = (model: string) => ({ manufacturer: "测试装配厂", model, revision: "T1" });
const primitive = (model: string, joint: MechanicalPart["joint"], mount = "out"): DevicePackage => parseDevicePackage({
  ...ident(model), schemaVersion: 1, source: { kind: "local", url: "", title: "回归夹具", excerpt: "尺寸和限位用于离线验证。", locator: "夹具参数表" },
  ports: [], rules: [], mechanics: { kind: "part", input: frame, joint, outputs: [{ id: mount, ...frame }] },
});
const hinge = () => primitive("回转", { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-120, 120] }, "face");
const slide = () => primitive("滑台", { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-25, 80] }, "plate");
const fixture = () => primitive("固定座", { type: "fixed" }, "tip");
const pkgWorkspace = (...pkgs: DevicePackage[]) => pkgs.reduce(installPackage, emptyWorkspace());
function arm(a = hinge(), b = slide()): MechanicalAssembly {
  return {
    schemaVersion: 1, kind: "mechanical-assembly", id: "station", name: "测试工位",
    nodes: [{ id: "linear", packageKey: packageKey(b), parent: { node: "rotary", mount: "face" } },
      { id: "rotary", packageKey: packageKey(a), parent: null }],
    output: { node: "linear", mount: "plate" }, commands: { rotary: 40, linear: 7 },
  };
}

describe("机械端口、草稿与可执行结构", () => {
  it("纯机械部件不需要电气端口；有真信号端口时仍支持原接线流程", () => {
    const p = hinge(), ws = pkgWorkspace(p);
    expect(() => addInstance(ws, packageKey(p), "不能接线")).toThrow(/机械|信号端口/);
    const mixed = parseDevicePackage({ ...p, revision: "T2", ports: [{ id: "a", direction: "input", label: "使能", type: "boolean" }], rules: [] });
    expect(addInstance(pkgWorkspace(mixed), packageKey(mixed), "可接线").instances).toHaveLength(1);
    expect(() => parseDevicePackage({ ...p, mechanics: undefined })).toThrow(/信号设备/);
  });
  it("安装点和轴须为有限有效坐标，关节单位和限位严格匹配", () => {
    const pkg = slide(), part = pkg.mechanics as MechanicalPart;
    for (const invalid of [
      { input: { ...frame, quatWxyz: [0, 0, 0, 0] } }, { input: { ...frame, positionMm: [0, Infinity, 0] } },
      { outputs: [part.outputs[0], part.outputs[0]] }, { outputs: [{ ...frame, id: "constructor" }] },
      { joint: { type: "hinge", axis: [0, 0, 1], range: [-1, 2], unit: "mm" } },
      { joint: { type: "slide", axis: [0, 0, 0], range: [0, 2], unit: "mm" } },
      { joint: { type: "slide", axis: [1, 0, 0], range: [8, 2], unit: "mm" } },
    ]) expect(() => parseDevicePackage({ ...pkg, mechanics: { ...part, ...invalid } })).toThrow();
  });
  it.each([
    ["input", null, /输入安装点/], ["positionMm", "input", /毫米|mm/], ["quatWxyz", "input", /四元数|WXYZ/],
    ["axis", "joint", /方向分量/], ["unit", "joint", /mm.*毫米|毫米.*mm/], ["range", "joint", /最小值.*最大值/],
    ["outputs", null, /输出安装点/],
  ] as const)("机械包缺少 %s 时提示型号、字段和应补参数", (field, section, expected) => {
    const p = JSON.parse(JSON.stringify(slide()));
    delete (section ? p.mechanics[section] : p.mechanics)[field];
    let message = "";
    try { parseDevicePackage(p); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("滑台"); expect(message).toContain(section ? `mechanics.${section}.${field}` : `mechanics.${field}`);
    expect(message).toMatch(expected); expect(message).not.toMatch(/tuple|undefined/);
  });
  it("草稿可保存未装包、悬空挂点及多根，但运行和封装都指出问题", () => {
    const definition = arm();
    definition.nodes[0].packageKey = "";
    definition.nodes[0].parent = null;
    definition.output.mount = "unknown";
    const ws = upsertMechanicalAssembly(pkgWorkspace(hinge()), definition);
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws))).mechanisms).toEqual([definition]);
    expect(parseWorkspace(emptyWorkspace())).not.toHaveProperty("mechanisms");
    const diag = inspectMechanicalAssembly(ws, definition).join(" ");
    expect(diag).toMatch(/根/); expect(diag).toContain("linear"); expect(diag).toContain("unknown");
    expect(() => resolveMechanicalAssembly(ws, definition)).toThrow();
    expect(() => exportMechanicalBundle(ws, definition, ident("坏工位"))).toThrow();
    expect(() => parseWorkspace({ ...ws, mechanisms: [definition, definition] })).toThrow(/重复/);
  });
  it("结构层拒绝重复实例、注入路径及非有限指令，运动层拒绝环和范围外命令", () => {
    const a = arm(), ws = pkgWorkspace(hinge(), slide());
    expect(() => parseMechanicalAssembly({ ...a, nodes: [a.nodes[0], a.nodes[0]] })).toThrow(/重复/);
    for (const commands of [{ "line//x": 4 }, { "xx/constructor": 0 }, JSON.parse('{"__proto__":0}'), { rotary: NaN }]) {
      expect(() => parseMechanicalAssembly({ ...a, commands })).toThrow();
    }
    expect(inspectMechanicalAssembly(ws, { ...a, commands: { rotary: 121, "lost/inner": 0 } }).join(" ")).toMatch(/rotary/);
    const cycle = arm(); cycle.nodes[1].parent = { node: "linear", mount: "plate" };
    expect(inspectMechanicalAssembly(ws, cycle).join(" ")).toMatch(/环/);
    const dead = arm(); dead.nodes[0].parent = { node: "elsewhere", mount: "none" };
    expect(inspectMechanicalAssembly(ws, dead).join(" ")).toMatch(/elsewhere/);
    const badMount = arm(); badMount.nodes[0].parent!.mount = "absent";
    expect(inspectMechanicalAssembly(ws, badMount).join(" ")).toMatch(/absent/);
  });
  it("可在同一输出挂接两个分支，父节点总是先于子节点", () => {
    const a = arm(), tool = fixture();
    a.nodes.unshift({ id: "branch", packageKey: packageKey(tool), parent: { node: "rotary", mount: "face" } });
    const parsed = resolveMechanicalAssembly(pkgWorkspace(hinge(), slide(), tool), a);
    expect(parsed.nodes[0]).toMatchObject({ path: "rotary", value: 40, parent: null });
    expect(parsed.nodes.filter((n) => n.parent?.path === "rotary").map((n) => n.path).sort()).toEqual(["branch", "linear"]);
    expect(parsed.output).toEqual({ path: "linear", mount: "plate" });
    expect(inspectMechanicalAssembly(pkgWorkspace(hinge(), slide(), tool), { ...a, commands: { branch: 1 } }).join(" ")).toMatch(/固定/);
  });
});

describe("封装、清单与嵌套展开", () => {
  it("封装冻结设备修订并去掉源工程 BOM 行，新工程安装幂等且可继续挂下级部件", () => {
    const a = arm(), d = hinge(), s = slide();
    const ws = { ...pkgWorkspace(d, s), catalog: { models: [], materials: [{ id: "rotor-stock", name: "回转台", quantity: 1,
      binding: { kind: "device" as const, key: packageKey(d) } }] } };
    a.nodes[1].materialId = "rotor-stock";
    const bundle = parseMechanicalBundle(JSON.parse(JSON.stringify(exportMechanicalBundle(ws, a, ident("双轴面板")))));
    expect(bundle.packages).toHaveLength(3);
    expect(bundle.rootKey).toBe(packageKey(ident("双轴面板")));
    expect(JSON.stringify(bundle)).not.toContain("rotor-stock");
    const installed = installMechanicalBundle(emptyWorkspace(), bundle);
    expect(installMechanicalBundle(installed, bundle)).toBe(installed);
    expect(ws.packages).toHaveLength(2);
    const host: MechanicalAssembly = { ...a, id: "next", nodes: [{ id: "panel", packageKey: bundle.rootKey, parent: null },
      { id: "tool", packageKey: packageKey(fixture()), parent: { node: "panel", mount: "out" } }],
      output: { node: "tool", mount: "tip" }, commands: { "panel/rotary": 0 } };
    const out = resolveMechanicalAssembly(installPackage(installed, fixture()), host);
    expect(out.nodes.map((n) => [n.path, n.value])).toEqual([["panel/rotary", 0], ["panel/linear", 7], ["tool", 0]]);
    expect(out.nodes[2].parent).toEqual({ path: "panel/linear", mount: "plate" });
  });
  it("同一封装重复使用互相独立，外层完整路径覆盖每份内部保存值", () => {
    const first = exportMechanicalBundle(pkgWorkspace(hinge(), slide()), arm(), ident("面板"));
    const installed = installMechanicalBundle(emptyWorkspace(), first);
    const pair: MechanicalAssembly = { ...arm(), nodes: [{ id: "A", packageKey: first.rootKey, parent: null },
      { id: "B", packageKey: first.rootKey, parent: { node: "A", mount: "out" } }],
      output: { node: "B", mount: "out" }, commands: { "A/rotary": 0, "B/linear": -3 } };
    const r = resolveMechanicalAssembly(installed, pair);
    expect(r.nodes.map((n) => [n.path, n.value])).toEqual([["A/rotary", 0], ["A/linear", 7], ["B/rotary", 40], ["B/linear", -3]]);
    expect(r.nodes[2].parent).toEqual({ path: "A/linear", mount: "plate" });
    expect(r.output).toEqual({ path: "B/linear", mount: "plate" });
    const nested = exportMechanicalBundle(installed, pair, ident("二级平台"));
    expect(nested.packages).toHaveLength(4);
    expect(installMechanicalBundle(emptyWorkspace(), nested).packages).toHaveLength(4);
    expect(inspectMechanicalAssembly(installed, { ...pair, commands: { "A/unknown": 0 } }).join(" ")).toMatch(/A\/unknown/);
  });
  it("BOM 必须绑定实际修订；库内同一行被多个实例引用时按件数合计", () => {
    const d = hinge(), a = arm(d, d);
    a.nodes[0].parent!.mount = "face"; a.nodes.forEach((n) => n.materialId = "m1"); a.output.mount = "face";
    const base = pkgWorkspace(d);
    const withBOM = (quantity: number, key: string) => ({ ...base, catalog: { models: [], materials: [
      { id: "m1", name: "采购行", quantity, binding: { kind: "device" as const, key } }] } });
    expect(inspectMechanicalAssembly(base, a).join(" ")).toContain("m1");
    expect(inspectMechanicalAssembly(withBOM(2, packageKey(slide())), a).join(" ")).toMatch(/绑定/);
    expect(inspectMechanicalAssembly(withBOM(1, packageKey(d)), a).join(" ")).toMatch(/采购行.*2.*1/);
    expect(inspectMechanicalAssembly(withBOM(2, packageKey(d)), a)).toEqual([]);
    const measured = withBOM(100, packageKey(d));
    expect(inspectMechanicalAssembly({ ...measured, catalog: { ...measured.catalog, materials: measured.catalog.materials.map((r) => ({ ...r, unit: "kg" })) } }, a).join(" ")).toMatch(/kg.*件数/);
  });
  it("从非首位节点提取子树：切断上游，排除旁支，保留嵌套路径与原观察点", () => {
    const first = exportMechanicalBundle(pkgWorkspace(hinge(), slide()), arm(), ident("面板"));
    const installed = installPackage(installMechanicalBundle(emptyWorkspace(), first), fixture());
    const full: MechanicalAssembly = { ...arm(), nodes: [
      { id: "sibling", packageKey: packageKey(slide()), parent: { node: "base", mount: "face" } },
      { id: "tool", packageKey: packageKey(fixture()), parent: { node: "panel", mount: "out" } },
      { id: "base", packageKey: packageKey(hinge()), parent: null },
      { id: "panel", packageKey: first.rootKey, parent: { node: "base", mount: "face" } }],
      output: { node: "tool", mount: "tip" }, commands: { base: 5, sibling: 4, "panel/rotary": 0, "panel/linear": 8 } };
    const sub = mechanicalSubassembly(full, "panel");
    expect(sub.nodes.map((n) => n.id)).toEqual(["tool", "panel"]); expect(sub.nodes[1].parent).toBeNull();
    expect(sub.commands).toEqual({ "panel/rotary": 0, "panel/linear": 8 }); expect(sub.output).toEqual(full.output);
    expect(resolveMechanicalAssembly(installed, sub).nodes.map((n) => n.path)).toEqual(["panel/rotary", "panel/linear", "tool"]);
    expect(full.nodes[3].parent?.node).toBe("base");
    expect(() => mechanicalSubassembly(full, "sibling")).toThrow(/选择.*子树内.*观察点/);
  });
  it("库存中已有的第三方封装可连同全部依赖导出，厂商、原始资料与内部保存值逐项保留", () => {
    const d = hinge(), root = parseDevicePackage({ ...d, ...ident("第三方工件台"), manufacturer: "外部供应商",
      source: { title: "产品手册 A", locator: "安装图 3", url: "https://example.org/handbook", excerpt: "来自厂商的接口约定。" },
      mechanics: { kind: "assembly", assembly: { ...arm(), nodes: [{ id: "first", parent: null, packageKey: packageKey(d) },
        { id: "again", parent: { node: "first", mount: "face" }, packageKey: packageKey(d) }], output: { node: "again", mount: "face" }, commands: { again: 12 } } } });
    const exported = bundleMechanicalDevice(pkgWorkspace(d, root), root);
    expect(exported.packages).toEqual([root, d]); expect(exported.rootKey).toBe(packageKey(root));
    expect(installMechanicalBundle(emptyWorkspace(), exported).packages[0]).toEqual(root);
    expect(() => bundleMechanicalDevice(pkgWorkspace(root), root)).toThrow(/first.*缺少|缺少.*回转/);
    expect(bundleMechanicalDevice(emptyWorkspace(), d).packages).toEqual([d]);
  });
  it("指令对象键顺序不改变修订内容，调换数值仍然是冲突", () => {
    const source = pkgWorkspace(hinge(), slide()), a = arm();
    const b = exportMechanicalBundle(source, { ...a, commands: { rotary: 40, linear: 7 } }, ident("次序测试"));
    const installed = installMechanicalBundle(emptyWorkspace(), b);
    const reorder = (linear: number) => ({ ...b, packages: b.packages.map((p) => p.mechanics?.kind !== "assembly" ? p : {
      ...p, mechanics: { kind: "assembly", assembly: { ...p.mechanics.assembly, commands: { linear, rotary: 40 } } },
    }) });
    expect(installMechanicalBundle(installed, reorder(7))).toBe(installed);
    const older = { ...installed, packages: installed.packages.map((p) => p.mechanics?.kind !== "assembly" ? p : {
      ...p, mechanics: { ...p.mechanics, assembly: { ...p.mechanics.assembly, commands: { rotary: 40, linear: 7 } } },
    }) };
    expect(installMechanicalBundle(older, b)).toBe(older);
    const again = exportMechanicalBundle(installed, { ...a, commands: { linear: 7, rotary: 40 } }, ident("次序测试"));
    expect(again).toEqual(b);
    expect(() => installMechanicalBundle(installed, reorder(8))).toThrow(/修订/);
  });
  it("拒绝依赖缺失、无关成员、重复修订及不配套的已装修订，失败不污染原工程", () => {
    const d = hinge(), s = slide(), bundle = exportMechanicalBundle(pkgWorkspace(d, s), arm(), ident("平台"));
    expect(() => parseMechanicalBundle({ ...bundle, packages: bundle.packages.filter((p) => p.model !== s.model) })).toThrow(/缺少|未安装/);
    expect(() => parseMechanicalBundle({ ...bundle, packages: [...bundle.packages, fixture()] })).toThrow(/无关|多余|依赖/);
    expect(() => parseMechanicalBundle({ ...bundle, packages: [...bundle.packages, d] })).toThrow(/重复/);
    const incomplete = { ...s, mechanics: { ...s.mechanics as MechanicalPart, joint: { type: "slide", unit: "mm" } } };
    expect(() => parseMechanicalBundle({ ...bundle, packages: [incomplete, d] })).toThrow(/滑台.*axis/);
    const changed = { ...d, source: { ...d.source, title: "同修订不同内容" } };
    const before = pkgWorkspace(changed);
    expect(() => installMechanicalBundle(before, bundle)).toThrow(/修订/);
    expect(before.packages).toEqual([changed]);
  });
  it("工程草稿可保留未完成的修订文本，已封装的部件引用必须锁定完整身份", () => {
    const a = arm(); a.nodes[0].packageKey = "只写了型号";
    expect(parseMechanicalAssembly(a).nodes[0].packageKey).toBe("只写了型号");
    expect(() => parseDevicePackage({ ...hinge(), mechanics: { kind: "assembly", assembly: a } })).toThrow(/linear.*修订|packageKey.*修订/);
  });
  it("阻断递归封装和超出展开上限的重复实例图", () => {
    const base = fixture(), id = ident("自引用"), k = packageKey(id);
    const compound = (model: string, child: string, copies: number): DevicePackage => parseDevicePackage({
      ...base, ...ident(model), mechanics: { kind: "assembly", assembly: { ...arm(), nodes: Array.from({ length: copies }, (_, i) =>
        ({ id: "n" + i, packageKey: child, parent: i ? { node: "n" + (i - 1), mount: "out" } : null })),
        output: { node: "n" + (copies - 1), mount: "out" }, commands: {} } },
    });
    const self = compound(id.model, k, 1);
    expect(() => parseMechanicalBundle({ schemaVersion: 1, kind: "mechanical-package", rootKey: k, packages: [self] })).toThrow(/递归|循环/);
    const leaf = primitive("末端", { type: "fixed" });
    const mid = compound("中层", packageKey(leaf), 32);
    const root = compound("大组", packageKey(mid), 32);
    expect(() => parseMechanicalBundle({ schemaVersion: 1, kind: "mechanical-package", rootKey: packageKey(root), packages: [leaf, mid, root] })).toThrow(/展开|容量/);
    const members = [leaf];
    for (let i = 0; i <= MECHANICAL_LIMITS.depth; i++) members.push(compound("套层" + i, packageKey(members.at(-1)!), 1));
    expect(() => parseMechanicalBundle({ schemaVersion: 1, kind: "mechanical-package", rootKey: packageKey(members.at(-1)!), packages: members })).toThrow(/嵌套/);
  });
});
