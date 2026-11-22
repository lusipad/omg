import { z } from "zod";
import { isPackageKey } from "./package-identity";

export const signalIdSchema = z.string().max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "标识只支持字母、数字、连字符与下划线")
  .refine((id) => id !== "prototype" && !Object.hasOwn(Object.prototype, id), "标识使用了保留属性名");
export const MECHANICAL_LIMITS = { assemblies: 64, nodes: 128, outputs: 32, expandedNodes: 512, depth: 16, chainDepth: 128, packages: 128 } as const;
const finite = z.number("请填写有限数值").finite("请填写有限数值");
const vec3 = (message: string) => z.tuple([finite, finite, finite], message);
const nonzero = (v: number[]) => v.some((x) => x !== 0);
const frameFields = { positionMm: vec3("请给出安装点的 X、Y、Z 三个位置分量，单位为毫米（mm）"),
  quatWxyz: z.tuple([finite, finite, finite, finite], "请按 W、X、Y、Z 顺序给出安装点的四元数").refine(nonzero, "四元数不能为零") };
const frameSchema = z.strictObject(frameFields, { error: (issue) => issue.code === "invalid_type" ? "请提供输入安装点的位置与朝向" : undefined });
const movement = { axis: vec3("请给出关节在部件本地坐标中的三个方向分量").refine(nonzero, "关节轴方向不能为零"),
  range: z.tuple([finite, finite], "请给出关节限位的最小值和最大值").refine(([min, max]) => min < max, "限位下界须小于上界") };
const jointSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("fixed") }),
  z.strictObject({ type: z.literal("hinge"), unit: z.literal("deg", "转动关节的指令和限位请使用 deg（度）"), ...movement }),
  z.strictObject({ type: z.literal("slide"), unit: z.literal("mm", "移动关节的指令和限位请使用 mm（毫米）"), ...movement }),
], "请选择 fixed、hinge 或 slide 关节类型");
const partSchema = z.strictObject({
  kind: z.literal("part"), input: frameSchema, joint: jointSchema,
  outputs: z.array(z.strictObject({ id: signalIdSchema, ...frameFields }), "请提供输出安装点列表，列出各点的标识、位置和朝向").max(MECHANICAL_LIMITS.outputs)
    .refine((ports) => new Set(ports.map((p) => p.id)).size === ports.length, "机械输出安装点标识重复"),
});
const pendingId = z.union([signalIdSchema, z.literal("")]);
const connection = z.strictObject({ node: pendingId, mount: pendingId });
const nodes = z.array(z.strictObject({
  id: signalIdSchema, packageKey: z.string().trim().max(4096), parent: connection.nullable(), materialId: z.string().trim().min(1).max(128).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  explodeStep: z.number().int().min(0).max(16).optional(),
  explodeVectorMm: vec3("请给出爆炸偏移的 X、Y、Z 毫米分量").optional(),
  coupledTo: z.strictObject({
    path: z.string().trim().min(1).max(240),
    ratio: finite,
    offset: finite.optional(),
  }).optional(),
})).min(1).max(MECHANICAL_LIMITS.nodes).refine((items) => new Set(items.map((n) => n.id)).size === items.length, "机械实例标识重复");

const commands = z.unknown().superRefine((source, ctx) => {
  if (!source || typeof source !== "object") return;
  const keys = Object.keys(source);
  if (keys.length > MECHANICAL_LIMITS.expandedNodes) { ctx.addIssue({ code: "custom", message: "关节指令数超过展开容量" }); return; }
  for (const key of keys) {
    const ids = key.length <= 81 * (MECHANICAL_LIMITS.depth + 1) ? key.split("/") : [];
    if (!ids.length || ids.length > MECHANICAL_LIMITS.depth + 1 || ids.some((id) => !signalIdSchema.safeParse(id).success)) {
      ctx.addIssue({ code: "custom", path: [key], message: "关节指令键必须是合法实例路径" });
    }
  }
}).pipe(z.record(z.string(), finite)).transform((values) =>
  Object.fromEntries(Object.keys(values).sort().map((path) => [path, values[path]])));

export const mechanicalAssemblySchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("mechanical-assembly"), id: signalIdSchema, name: z.string().trim().min(1).max(160),
  nodes, output: connection, commands,
});
export type MechanicalAssembly = z.infer<typeof mechanicalAssemblySchema>;
export type MechanicalFrame = z.infer<typeof frameSchema>;
export type MechanicalPart = z.infer<typeof partSchema>;
export const mechanismListSchema = z.array(mechanicalAssemblySchema).max(MECHANICAL_LIMITS.assemblies)
  .refine((items) => new Set(items.map((a) => a.id)).size === items.length, "工程中的机械装配标识重复");

/** 工程草稿允许连接待补；求解与封装复用这套根、父子关系与观察端点检查。 */
export function mechanicalTopology(a: MechanicalAssembly) {
  const byId = new Set(a.nodes.map((n) => n.id)), children = new Map<string, MechanicalAssembly["nodes"]>();
  const issues: string[] = [], ordered: MechanicalAssembly["nodes"] = [];
  const roots = a.nodes.filter((n) => !n.parent);
  if (roots.length !== 1) issues.push(`需要唯一根实例，当前有 ${roots.length} 个${roots.length ? "（" + roots.map((r) => r.id).join("、") + "）" : ""}。`);
  for (const node of a.nodes) {
    if (!node.packageKey) issues.push(`节点 ${node.id} 尚未选择设备修订。`);
    if (!node.parent) { ordered.push(node); continue; }
    const p = node.parent;
    if (!p.mount) issues.push(`节点 ${node.id} 尚未选择父安装点。`);
    if (!byId.has(p.node)) { issues.push(`节点 ${node.id} 引用的父节点“${p.node || "未选择"}”不存在。`); ordered.push(node); continue; }
    const list = children.get(p.node);
    if (list) list.push(node); else children.set(p.node, [node]);
  }
  for (let i = 0; i < ordered.length; i++) ordered.push(...(children.get(ordered[i].id) ?? []));
  if (ordered.length < a.nodes.length) {
    const reachable = new Set(ordered.map((n) => n.id));
    issues.push(`存在连接环，下列节点无法按父子顺序展开：${a.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id).join("、")}。`);
  }
  if (!byId.has(a.output.node) || !a.output.mount) issues.push(`观察点“${a.output.node}/${a.output.mount}”尚未连接到有效的实例和安装点。`);
  return { ordered, issues };
}

const packagedAssembly = mechanicalAssemblySchema.superRefine((a, ctx) => {
  for (const issue of mechanicalTopology(a).issues) ctx.addIssue({ code: "custom", message: issue });
  for (const [i, node] of a.nodes.entries()) {
    if (node.materialId !== undefined) ctx.addIssue({ code: "custom", path: ["nodes", i, "materialId"], message: "封装设备应使用固定设备修订，不能依赖源工程的 BOM 行" });
    if (!isPackageKey(node.packageKey)) ctx.addIssue({ code: "custom", path: ["nodes", i, "packageKey"], message: `节点 ${node.id} 请引用已锁定制造商、型号和版本的完整设备修订` });
  }
  const ids = new Set(a.nodes.map((n) => n.id));
  for (const path of Object.keys(a.commands)) if (!ids.has(path.split("/")[0])) ctx.addIssue({ code: "custom", path: ["commands", path], message: "没有对应的机械实例" });
});
export const mechanicsSchema = z.discriminatedUnion("kind", [
  partSchema, z.strictObject({ kind: z.literal("assembly"), assembly: packagedAssembly }),
]);
