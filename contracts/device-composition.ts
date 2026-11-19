import { z } from "zod";
import { signalIdSchema } from "./mechanical-types";
import { isPackageKey, packageIdentityFields, packageKey } from "./package-identity";
import type { DevicePackage } from "./twin-device";

const text = (max: number) => z.string().trim().min(1).max(max);
const shape = z.enum(["box", "plate", "shaft", "ring", "gear", "coil", "ball", "belt"]);
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const part = z.strictObject({
  id: signalIdSchema, label: text(160), quantity,
  packageKey: z.string().max(4096).refine(isPackageKey, "子件须锁定完整的制造商、型号与修订。"),
});

// 字典的键顺序不参与修订身份。保护用户提供的键，按可重复的顺序写入工程。
function namedFields<T extends z.ZodType>(value: T) {
  return z.unknown().refine(input => !input || typeof input !== "object" || !Object.hasOwn(input, "__proto__"), "额定参数含有保留属性名。")
    .pipe(z.record(signalIdSchema, value))
    .transform(record => Object.fromEntries(Object.keys(record).sort().map(k => [k, record[k]])) as Record<string, z.output<T>>);
}
const common = {
  shape: shape.optional(), note: text(2048).optional(),
  ratings: namedFields(z.strictObject({ label: text(160), value: z.number().finite(), unit: text(40) })).optional(),
};
export const deviceCompositionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("leaf"), ...common }),
  z.strictObject({ kind: z.literal("assembly"), ...common, parts: z.array(part).min(1, "总成至少需要一个子件槽位。")
    .refine(parts => new Set(parts.map(p => p.id)).size === parts.length, "同一父件中的槽位标识不能重复。") }),
]);
export const factoryPartParametersSchema = namedFields(z.strictObject({
  path: z.array(signalIdSchema).min(1, "部件参数来源须指定至少一个子件槽位。"), rating: signalIdSchema,
}));
export type CompositionShape = z.infer<typeof shape>;
export type DevicePart = z.infer<typeof part>;
export type DeviceComposition = z.infer<typeof deviceCompositionSchema>;

export function compositionKind(pkg: DevicePackage): "assembly" | "leaf" | "unknown" {
  return pkg.mechanics?.kind === "assembly" ? "assembly" : pkg.composition?.kind ?? "unknown";
}

export function getDeviceParts(pkg: DevicePackage): DevicePart[] {
  if (pkg.mechanics?.kind === "assembly") {
    return pkg.mechanics.assembly.nodes.map(node => ({ id: node.id, label: node.id, packageKey: node.packageKey, quantity: 1 }));
  }
  return pkg.composition?.kind === "assembly" ? pkg.composition.parts : [];
}

/** 每种修订只访问一次；路径上的回边形成循环，不同路径重用同件则合法。 */
function compositionGraph(packages: readonly DevicePackage[], rootKeys: readonly string[]) {
  const catalog = new Map(packages.map(pkg => [packageKey(pkg), pkg]));
  if (catalog.size !== packages.length) throw new Error("设备库含有重复的设备修订。");
  const reached = new Map<string, DevicePackage | undefined>(), finished: string[] = [];
  const path = new Map<string, string>();
  function visit(key: string, slot: string) {
    if (path.has(key)) {
      throw new Error(`设备组成出现循环：${[...path.values(), `${slot} → ${key}`].join(" / ")}。`);
    }
    if (reached.has(key)) return;
    const pkg = catalog.get(key);
    reached.set(key, pkg);
    if (pkg) {
      path.set(key, slot ? `${slot} → ${key}` : key);
      for (const child of getDeviceParts(pkg)) visit(child.packageKey, child.id);
      path.delete(key);
    }
    finished.push(key);
  }
  for (const key of rootKeys) visit(key, "");
  return { reached, finished };
}

export function deviceCompositionClosure(packages: readonly DevicePackage[], rootKeys: readonly string[]): { packages: DevicePackage[]; missing: string[] } {
  const { reached } = compositionGraph(packages, rootKeys);
  const included: DevicePackage[] = [], missing: string[] = [];
  for (const [key, pkg] of reached) {
    if (pkg) included.push(pkg);
    else missing.push(key);
  }
  return { packages: included, missing };
}

export interface DeviceDemand { packageKey: string; quantity: number }
export interface DeviceRollupRow { packageKey: string; status: "leaf" | "unknown" | "missing"; quantity: string }
export interface DeviceRollup { complete: boolean; leafQuantity: string; rows: DeviceRollupRow[] }

export function rollupDeviceParts(packages: readonly DevicePackage[], roots: readonly DeviceDemand[]): DeviceRollup {
  const { reached, finished } = compositionGraph(packages, roots.map(root => root.packageKey));
  const counts = new Map<string, bigint>();
  const add = (key: string, count: bigint) => counts.set(key, (counts.get(key) ?? 0n) + count);
  for (const root of roots) {
    if (!Number.isSafeInteger(root.quantity) || root.quantity <= 0) throw new Error("汇总的设备数量必须为正安全整数。");
    add(root.packageKey, BigInt(root.quantity));
  }
  // 完成序的反向为父先子后的拓扑序，父级的全部需求齐集后再乘各槽位数量。
  for (const key of finished.reverse()) {
    const pkg = reached.get(key);
    if (pkg) for (const child of getDeviceParts(pkg)) add(child.packageKey, counts.get(key)! * BigInt(child.quantity));
  }
  const rows: DeviceRollupRow[] = [];
  let leafQuantity = 0n, complete = true;
  for (const [key, pkg] of reached) {
    const status = pkg ? compositionKind(pkg) : "missing";
    if (status === "assembly") continue;
    const count = counts.get(key)!;
    if (status === "leaf") leafQuantity += count;
    else complete = false;
    rows.push({ packageKey: key, status, quantity: String(count) });
  }
  return { complete, leafQuantity: String(leafQuantity), rows };
}

export function compositionRollupCsv(report: DeviceRollup): string {
  function csvField(value: string) {
    const literal = /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(value.normalize("NFKC")) ? "'" + value : value;
    return /[,"\r\n]/.test(literal) ? '"' + literal.replaceAll('"', '""') + '"' : literal;
  }
  const lines = ["manufacturer,model,revision,status,quantity"];
  for (const row of report.rows) {
    const identity = packageIdentityFields(row.packageKey) ?? ["", row.packageKey, ""];
    lines.push([...identity, row.status, row.quantity].map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
