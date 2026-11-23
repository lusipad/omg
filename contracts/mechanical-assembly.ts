import { z } from "zod";
import { isMeasuredMaterialUnit } from "./material-import";
import {
  MECHANICAL_LIMITS, mechanicalAssemblySchema, mechanicalTopology, type MechanicalAssembly, type MechanicalPart,
} from "./mechanical-types";
import { packageKey, parseDevicePackage, readTwinData, type DevicePackage } from "./twin-device";
import { emptyWorkspace, installPackage, maxPackages, type TwinWorkspace } from "./twin-simulation";
import { deviceCompositionClosure } from "./device-composition";

export { MECHANICAL_LIMITS, type MechanicalAssembly, type MechanicalClosure, type MechanicalFrame, type MechanicalPart } from "./mechanical-types";
export interface MechanicalBundle { kind: "mechanical-package"; schemaVersion: 1; rootKey: string; packages: DevicePackage[] }
type Endpoint = { path: string; mount: string };
export interface ResolvedMechanicalAssembly {
  nodes: { path: string; parent: Endpoint | null; part: MechanicalPart; value: number }[];
  output: Endpoint;
}
const bundleSchema = z.strictObject({
  kind: z.literal("mechanical-package"), schemaVersion: z.literal(1), rootKey: z.string().min(1).max(4096),
  packages: z.array(z.unknown()).min(1).max(maxPackages),
});
export function parseMechanicalAssembly(raw: unknown): MechanicalAssembly {
  return readTwinData(mechanicalAssemblySchema, raw, "机械装配");
}

export function upsertMechanicalAssembly(ws: TwinWorkspace, raw: MechanicalAssembly): TwinWorkspace {
  const a = parseMechanicalAssembly(raw), current = ws.mechanisms ?? [];
  if (current.some((item) => item.id === a.id)) return { ...ws, mechanisms: current.map((item) => item.id === a.id ? a : item) };
  if (current.length >= MECHANICAL_LIMITS.assemblies) throw new Error(`单工程最多保存 ${MECHANICAL_LIMITS.assemblies} 个机械装配。`);
  return { ...ws, mechanisms: [...current, a] };
}

/** 顶层实例名独立于父子连接关系。提取子树时，关节路径和观察点无需改名。 */
export function mechanicalSubassembly(raw: MechanicalAssembly, rootId: string): MechanicalAssembly {
  const a = parseMechanicalAssembly(raw);
  if (!a.nodes.some((n) => n.id === rootId)) throw new Error("请选择当前装配中要提取的根实例。");
  const keep = new Set([rootId]);
  for (const parent of keep) {
    for (const child of a.nodes.filter((n) => n.parent?.node === parent)) {
      if (keep.has(child.id)) throw new Error(`提取子树时发现节点 ${child.id} 的连接环。`);
      keep.add(child.id);
    }
  }
  if (!keep.has(a.output.node) || !a.output.mount) throw new Error("请先选择子树内的有效观察点，再封装该部分。");
  const nextClosures = a.closures?.filter((c) => keep.has(c.nodeA) && keep.has(c.nodeB));
  return {
    ...a,
    nodes: a.nodes
      .filter((n) => keep.has(n.id))
      .map((n) => {
        const dropCoupling = n.coupledTo && !keep.has(n.coupledTo.path.split("/")[0]);
        const nextNode = dropCoupling ? { id: n.id, packageKey: n.packageKey, parent: n.parent, ...(n.materialId ? { materialId: n.materialId } : {}), ...(n.label ? { label: n.label } : {}), ...(n.explodeStep !== undefined ? { explodeStep: n.explodeStep } : {}), ...(n.explodeVectorMm ? { explodeVectorMm: n.explodeVectorMm } : {}), ...(n.jointMode ? { jointMode: n.jointMode } : {}) } : n;
        return nextNode.id === rootId ? { ...nextNode, parent: null } : nextNode;
      }),
    commands: Object.fromEntries(Object.entries(a.commands).filter(([path]) => keep.has(path.split("/")[0]))),
    ...(nextClosures?.length ? { closures: nextClosures } : {}),
  };
}

function inspect(ws: TwinWorkspace, a: MechanicalAssembly, rootKey?: string) {
  const catalog = new Map(ws.packages.map((p) => [packageKey(p), p]));
  const materials = new Map((ws.catalog?.materials ?? []).map((r) => [r.id, r]));
  const used = new Map<string, { count: number; first: string }>(), dependencies = new Map<string, DevicePackage>();
  const active = new Set(rootKey ? [rootKey] : []);
  const nodes: ResolvedMechanicalAssembly["nodes"] = [], leaves = new Map<string, typeof nodes[number]>(), depths = new Map<string, number>();
  const issues = new Set<string>();
  let expanded = rootKey ? 1 : 0, halted = false;
  function report(message: string) {
    if (issues.size < MECHANICAL_LIMITS.expandedNodes) issues.add(message);
    else { issues.add("装配问题过多，请修复以上问题后重新检查。"); halted = true; }
  }
  function expand(def: MechanicalAssembly, prefix: string, graft: Endpoint | null, level: number): Endpoint | undefined {
    const topology = mechanicalTopology(def);
    for (const message of topology.issues) report(`装配 ${prefix || def.id}：${message}`);
    const ports = new Map<string, Map<string, Endpoint>>(), start = nodes.length;
    const pathOf = (id: string) => prefix ? `${prefix}/${id}` : id;
    function endpoint(ref: MechanicalAssembly["output"], owner: string) {
      const found = ports.get(ref.node)?.get(ref.mount);
      if (!found) report(`${owner} 指向的安装点 ${pathOf(ref.node || "未选节点")}/${ref.mount || "未选挂点"} 无法解析。`);
      return found;
    }
    for (const n of topology.ordered) {
      if (halted) return;
      const path = pathOf(n.id);
      if (++expanded > MECHANICAL_LIMITS.expandedNodes) {
        report(`节点 ${path} 超出 ${MECHANICAL_LIMITS.expandedNodes} 个展开实例的容量。`); halted = true; return;
      }
      if (n.materialId) {
        const row = materials.get(n.materialId);
        if (!row) report(`节点 ${path} 的 BOM 行 ${n.materialId} 不存在。`);
        else if (row.binding?.kind !== "device" || row.binding.key !== n.packageKey || (row.id.startsWith("doc-") && row.unit === "份" && row.notes)) {
          report(`节点 ${path} 的 BOM 行“${row.name}”须绑定到该实例使用的同一设备修订。`);
        } else {
          const usage = used.get(row.id) ?? { count: 0, first: path };
          usage.count++; used.set(row.id, usage);
        }
      }
      const parent = n.parent ? endpoint(n.parent, `节点 ${path}`) ?? null : graft;
      if (active.has(n.packageKey)) { report(`节点 ${path} 的设备修订 ${n.packageKey} 形成递归封装。`); continue; }
      const pkg = catalog.get(n.packageKey);
      if (!pkg) { if (n.packageKey) report(`节点 ${path} 缺少已安装的设备修订 ${n.packageKey}。`); continue; }
      dependencies.set(n.packageKey, pkg);
      const mechanics = pkg.mechanics;
      if (!mechanics) { report(`节点 ${path} 的设备 ${pkg.model} 没有机械安装点。`); continue; }
      if (mechanics.kind === "part") {
        const depth = parent ? (depths.get(parent.path) ?? 0) + 1 : 1;
        if (depth > MECHANICAL_LIMITS.chainDepth) {
          report(`节点 ${path} 展开后的父子链超过 ${MECHANICAL_LIMITS.chainDepth} 层。`); halted = true; return;
        }
        const leaf = { path, parent, part: mechanics, value: 0 };
        leaves.set(path, leaf); nodes.push(leaf); depths.set(path, depth);
        ports.set(n.id, new Map(mechanics.outputs.map((mount) => [mount.id, { path, mount: mount.id }])));
      } else {
        if (level >= MECHANICAL_LIMITS.depth) { report(`节点 ${path} 的封装嵌套超过 ${MECHANICAL_LIMITS.depth} 层。`); halted = true; return; }
        active.add(n.packageKey);
        const out = expand(mechanics.assembly, path, parent, level + 1);
        active.delete(n.packageKey);
        if (out) ports.set(n.id, new Map([["out", out]]));
      }
    }
    if (halted) return;
    // 从内向外覆盖，Object.entries 保留显式零，兄弟实例使用不同完整路径。
    for (const [relative, value] of Object.entries(def.commands)) {
      const path = pathOf(relative), leaf = leaves.get(path);
      if (!leaf) { report(`关节指令 ${path} 找不到对应的运动实例。`); continue; }
      const joint = leaf.part.joint;
      if (joint.type === "fixed") { report(`固定节点 ${path} 不能接收关节指令。`); continue; }
      if (value < joint.range[0] || value > joint.range[1]) {
        report(`节点 ${path} 的指令 ${value} ${joint.unit} 超出限位 [${joint.range.join(", ")}]。`); continue;
      }
      leaf.value = value;
    }
    for (let i = start; i < nodes.length; i++) {
      const { part, value, path } = nodes[i], j = part.joint;
      if (j.type !== "fixed" && (value < j.range[0] || value > j.range[1])) report(`节点 ${path} 的默认值超出限位，请填写 [${j.range.join(", ")}] ${j.unit} 内的指令。`);
    }
    if (def.closures) {
      for (const c of def.closures) {
        endpoint({ node: c.nodeA, mount: c.mountA }, `闭链约束 ${c.id} 端点 A`);
        endpoint({ node: c.nodeB, mount: c.mountB }, `闭链约束 ${c.id} 端点 B`);
      }
    }
    return endpoint(def.output, `装配 ${prefix || def.id} 的观察点`);
  }
  const output = expand(a, "", null, rootKey ? 1 : 0);
  for (const [id, demand] of used) {
    const row = materials.get(id)!;
    if (isMeasuredMaterialUnit(row.unit)) report(`BOM 物料“${row.name}”（节点 ${demand.first}）的单位为 ${row.unit}，请填写实际部件的件数。`);
    else if (row.quantity < demand.count) report(`BOM 物料“${row.name}”（节点 ${demand.first} 等）需 ${demand.count} 件，清单数量为 ${row.quantity}。`);
  }
  return { nodes, output, dependencies, issues: [...issues] };
}

export function inspectMechanicalAssembly(ws: TwinWorkspace, assembly: MechanicalAssembly): string[] {
  try { return inspect(ws, parseMechanicalAssembly(assembly)).issues; }
  catch (error) { return [error instanceof Error ? error.message : "机械装配参数无效。"]; }
}
export function resolveMechanicalAssembly(ws: TwinWorkspace, assembly: MechanicalAssembly): ResolvedMechanicalAssembly {
  const result = inspect(ws, parseMechanicalAssembly(assembly));
  if (result.issues.length || !result.output) throw new Error(result.issues.join("\n") || "机械装配缺少有效观察点。");
  return { nodes: result.nodes, output: result.output };
}

export function parseMechanicalBundle(raw: unknown): MechanicalBundle {
  const data = readTwinData(bundleSchema, raw, "机械设备包");
  const packages = data.packages.map((item, index) => {
    const model = item && typeof item === "object" && "model" in item && typeof item.model === "string" ? item.model.trim().slice(0, 160) : "";
    try {
      return parseDevicePackage(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error), label = model ? `“${model}”` : "";
      throw new Error(`机械设备包第 ${index + 1} 项${message.includes(label) ? "" : label}无效。 ${message}`);
    }
  });
  const catalog = new Map(packages.map((p) => [packageKey(p), p]));
  if (catalog.size !== packages.length) throw new Error("机械设备包中同一设备修订重复。");
  if (packages.filter(p => p.mechanics).length > MECHANICAL_LIMITS.packages) {
    throw new Error(`同一机械包最多包含 ${MECHANICAL_LIMITS.packages} 个带运动学定义的设备修订。`);
  }
  const root = catalog.get(data.rootKey);
  if (!root) throw new Error("机械设备包缺少 rootKey 指定的根设备修订。");
  if (!root.mechanics) throw new Error(`机械设备包的根设备“${root.model}”缺少机械声明。`);
  const closure = deviceCompositionClosure(packages, [data.rootKey]);
  if (closure.missing.length) throw new Error(`机械设备包缺少依赖修订：${closure.missing.join("、")}。`);
  if (closure.packages.length !== packages.length) throw new Error("机械设备包含有不在根设备依赖闭包内的多余修订。");
  const workspace = { ...emptyWorkspace(), packages };
  for (const pkg of closure.packages) {
    if (pkg.mechanics?.kind !== "assembly") continue;
    const result = inspect(workspace, pkg.mechanics.assembly, packageKey(pkg));
    if (result.issues.length) throw new Error(`机械设备包“${pkg.model}”未通过装配校验。\n${result.issues.join("\n")}`);
  }
  return { ...data, packages };
}

export function installMechanicalBundle(ws: TwinWorkspace, raw: unknown): TwinWorkspace {
  const bundle = parseMechanicalBundle(raw);
  return bundle.packages.reduce(installPackage, ws);
}

function bundleWithDependencies(ws: TwinWorkspace, root: DevicePackage, dependencies: Map<string, DevicePackage>): MechanicalBundle {
  const key = packageKey(root);
  if (dependencies.has(key)) throw new Error("导出身份与依赖设备修订相同，会形成递归。请使用新的设备型号或修订。");
  const existing = ws.packages.find((p) => packageKey(p) === key);
  if (existing && JSON.stringify(parseDevicePackage(existing)) !== JSON.stringify(root)) throw new Error("工程中同一设备修订已有不同内容，请核对要导出的修订。");
  // 保留原机械包的节点顺序，再附上机械件内部声明的采购子件。
  const closure = deviceCompositionClosure([root, ...ws.packages.filter(p => packageKey(p) !== key)], [key]);
  if (closure.missing.length) throw new Error(`设备“${root.model}”缺少依赖修订：${closure.missing.join("、")}。`);
  const packages = new Map([[key, root], ...dependencies]);
  for (const pkg of closure.packages) packages.set(packageKey(pkg), pkg);
  return parseMechanicalBundle({ schemaVersion: 1, kind: "mechanical-package", rootKey: key, packages: [...packages.values()] });
}

/** 从库存或导入预览导出，保留根设备原始身份和来源。 */
export function bundleMechanicalDevice(ws: TwinWorkspace, pkg: DevicePackage): MechanicalBundle {
  const root = parseDevicePackage(pkg);
  if (!root.mechanics) throw new Error(`设备“${root.model}”缺少机械声明。`);
  if (root.mechanics.kind === "part") return bundleWithDependencies(ws, root, new Map());
  const result = inspect(ws, root.mechanics.assembly, packageKey(root));
  if (result.issues.length) throw new Error(result.issues.join("\n"));
  return bundleWithDependencies(ws, root, result.dependencies);
}

export function exportMechanicalBundle(ws: TwinWorkspace, definition: MechanicalAssembly,
  identity: Pick<DevicePackage, "manufacturer" | "model" | "revision">): MechanicalBundle {
  const a = parseMechanicalAssembly(definition), result = inspect(ws, a);
  if (result.issues.length) throw new Error(result.issues.join("\n"));
  const nodes = a.nodes.map((n) => ({ id: n.id, packageKey: n.packageKey, parent: n.parent }));
  const root = parseDevicePackage({
    schemaVersion: 1, ...identity, ports: [], rules: [], mechanics: { kind: "assembly", assembly: { ...a, nodes } },
    source: { kind: "local", url: "", title: `${a.name} · 机械装配`, locator: `工程装配 ${a.id}`,
      excerpt: `装配包含 ${nodes.length} 个直接实例，观察点为 ${a.output.node}/${a.output.mount}。部件参数和出处保留在各自的固定设备修订中。` },
  });
  return bundleWithDependencies(ws, root, result.dependencies);
}
