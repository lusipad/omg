import { z } from "zod";
import type { MaterialRow } from "./import-catalog";
import { isMeasuredMaterialUnit } from "./material-import";
import { isCompatibleServoPair, servoAxisConfigSchema, simulateServoAxis, type ServoAxisConfig } from "./servo-axis";
import { packageKey, readTwinData, signalIdSchema } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export const LINEAR_ASSEMBLY_LIMITS = { assemblies: 64, modules: 64, axes: 32 } as const;
const materialRef = z.string().trim().max(300);
const finite = z.number().finite();
const moduleSchema = z.strictObject({
  id: signalIdSchema, drive: materialRef, motor: materialRef, screw: materialRef,
  leadMmPerRev: finite.positive().nullable(), loadInertiaRatio: finite.min(0).max(100),
});
const axisSchema = z.strictObject({
  id: signalIdSchema, module: signalIdSchema, targetMm: finite,
  direction: z.tuple([finite, finite, finite]).refine((v) => v.some((x) => x !== 0), "方向向量不能为零"),
});
const assemblySchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("linear-axis-assembly"), id: signalIdSchema, name: z.string().trim().min(1).max(160),
  modules: z.array(moduleSchema).min(1).max(LINEAR_ASSEMBLY_LIMITS.modules), axes: z.array(axisSchema).min(1).max(LINEAR_ASSEMBLY_LIMITS.axes),
}).superRefine((a, ctx) => {
  const modules = new Set<string>(), axes = new Set<string>();
  a.modules.forEach((m, i) => {
    if (modules.has(m.id)) ctx.addIssue({ code: "custom", path: ["modules", i, "id"], message: `模块标识 ${m.id} 重复` });
    modules.add(m.id);
  });
  a.axes.forEach((axis, i) => {
    if (axes.has(axis.id)) ctx.addIssue({ code: "custom", path: ["axes", i, "id"], message: `轴标识 ${axis.id} 重复` });
    if (!modules.has(axis.module)) ctx.addIssue({ code: "custom", path: ["axes", i, "module"], message: `没有定义模块 ${axis.module}` });
    axes.add(axis.id);
  });
});

export const linearAssemblyListSchema = z.array(assemblySchema).max(LINEAR_ASSEMBLY_LIMITS.assemblies).refine(
  (items) => new Set(items.map((a) => a.id)).size === items.length, "工程中的直线装配标识重复",
);
export type LinearAssembly = z.infer<typeof assemblySchema>;
type Vec3 = [number, number, number];
export interface LinearAssemblySample { timeMs: number; positionMm: number[]; velocityMmS: number[]; tipMm: Vec3 }
export interface LinearAssemblyResult { samples: LinearAssemblySample[]; settled: boolean }

export function parseLinearAssembly(raw: unknown): LinearAssembly {
  return readTwinData(assemblySchema, raw, "直线轴装配");
}

export function upsertLinearAssembly(workspace: TwinWorkspace, definition: LinearAssembly): TwinWorkspace {
  const assembly = parseLinearAssembly(definition), existing = workspace.assemblies ?? [];
  if (existing.some((a) => a.id === assembly.id)) {
    return { ...workspace, assemblies: existing.map((a) => a.id === assembly.id ? assembly : a) };
  }
  if (existing.length >= LINEAR_ASSEMBLY_LIMITS.assemblies) throw new Error(`单工程最多保存 ${LINEAR_ASSEMBLY_LIMITS.assemblies} 个直线装配。`);
  return { ...workspace, assemblies: [...existing, assembly] };
}

const roles = { drive: "驱动器", motor: "电机", screw: "丝杠" } as const;
type Role = keyof typeof roles;
interface AxisInput { id: string; direction: Vec3; lead: number; servo: ServoAxisConfig }

function unitVector([x, y, z]: Vec3): Vec3 {
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  const norm = Math.hypot(x / scale, y / scale, z / scale);
  return [x / scale / norm, y / scale / norm, z / scale / norm];
}

function resolveAxes(workspace: TwinWorkspace, assembly: LinearAssembly) {
  const issues = new Set<string>(), inputs: AxisInput[] = [];
  const materials = workspace.catalog?.materials ?? [], byId = new Map(materials.map((m) => [m.id, m]));
  const byName = new Map<string, MaterialRow[]>();
  for (const row of materials) {
    const list = byName.get(row.name);
    if (list) list.push(row); else byName.set(row.name, [row]);
  }
  const packages = new Map(workspace.packages.map((p) => [packageKey(p), p]));
  const usage = new Map<string, { row: MaterialRow; count: number; roles: Set<Role> }>();
  const copies = new Map<string, number>();
  for (const axis of assembly.axes) copies.set(axis.module, (copies.get(axis.module) ?? 0) + 1);
  const screwLeads = new Map<string, number>();
  const resolved = new Map<string, { drive?: string; motor?: string; lead: number | null; ratio: number }>();
  for (const mod of assembly.modules) {
    const count = copies.get(mod.id) ?? 0;
    if (!count) continue;
    function part(role: Role) {
      const ref = mod[role], label = `模块 ${mod.id} 的${roles[role]}`;
      if (!ref) { issues.add(`${label}尚未指定，请选择 BOM 行。`); return; }
      const byKey = byId.get(ref), matches = byName.get(ref);
      if (!byKey && matches && matches.length > 1) {
        const ids = matches.slice(0, 3).map((r) => r.source ? `${r.id}（${r.source.slice(0, 80)}）` : r.id);
        issues.add(`${label}“${ref}”对应多条物料，请用确切行 ID：${ids.join("、")}。`); return;
      }
      const row = byKey ?? matches?.[0];
      if (!row) { issues.add(`${label}“${ref}”未出现在通用 BOM，请导入物料或修正引用。`); return; }
      if (row.id.startsWith("doc-") && row.unit === "份" && row.notes) { issues.add(`${label}选中的是手册，请改选 BOM 部件。`); return; }
      const needed = usage.get(row.id) ?? { row, count: 0, roles: new Set<Role>() };
      needed.count += count; needed.roles.add(role); usage.set(row.id, needed);
      return row;
    }
    function device(role: "drive" | "motor") {
      const row = part(role);
      if (!row) return;
      const pkg = row.binding?.kind === "device" ? packages.get(row.binding.key) : undefined;
      if (pkg?.servo?.kind !== role) {
        issues.add(`模块 ${mod.id} 的“${row.name}”须绑定一个已安装的伺服${roles[role]}设备包。`); return;
      }
      return pkg;
    }
    const drive = device("drive"), motor = device("motor"), screw = part("screw");
    if (drive && motor && !isCompatibleServoPair(drive, motor)) issues.add(`模块 ${mod.id} 的 ${drive.model} 与 ${motor.model} 不在同厂配套清单中，请核对绑定型号。`);
    if (screw?.binding?.kind === "device" && !packages.get(screw.binding.key)?.mechanics) {
      issues.add(`模块 ${mod.id} 的“${screw.name}”已绑定电气设备，丝杠应选机械 BOM 行。`);
    }
    const lead = screw?.leadMmPerRev ?? mod.leadMmPerRev;
    if (lead === null) issues.add(`模块 ${mod.id} 缺少丝杠导程，请在 BOM 或模块中填写 mm/rev。`);
    if (screw && lead !== null) {
      if (screw.leadMmPerRev !== undefined && mod.leadMmPerRev !== null && screw.leadMmPerRev !== mod.leadMmPerRev) {
        issues.add(`模块 ${mod.id} 的导程不一致：BOM 为 ${screw.leadMmPerRev} mm/rev，模块填写 ${mod.leadMmPerRev} mm/rev。`);
      }
      if (screwLeads.has(screw.id) && screwLeads.get(screw.id) !== lead) issues.add(`同一丝杠行“${screw.name}”在不同模块中使用了不同导程，请核对。`);
      screwLeads.set(screw.id, lead);
    }
    resolved.set(mod.id, { drive: drive && packageKey(drive), motor: motor && packageKey(motor), lead, ratio: mod.loadInertiaRatio });
  }
  for (const { row, count, roles: usedRoles } of usage.values()) {
    if (usedRoles.size > 1) issues.add(`物料“${row.name}”不能同时用作${[...usedRoles].map((role) => roles[role]).join("和")}。`);
    if (isMeasuredMaterialUnit(row.unit)) {
      issues.add(`物料“${row.name}”的数量单位为 ${row.unit}，请补充可用部件的件数。`);
    } else if (row.quantity < count) issues.add(`物料“${row.name}”库存不足：按轴实例需 ${count} 件，BOM 数量为 ${row.quantity}。`);
  }
  for (const axis of assembly.axes) {
    const mod = resolved.get(axis.module)!;
    if (mod.lead === null) continue;
    const angle = axis.targetMm / mod.lead * 360;
    if (!servoAxisConfigSchema.shape.targetDeg.safeParse(angle).success || (axis.targetMm !== 0 && angle === 0)) {
      issues.add(`轴 ${axis.id} 的目标位移与导程超出伺服角度计算范围（±3600°），请调整目标或核对导程。`); continue;
    }
    if (mod.drive && mod.motor) inputs.push({ id: axis.id, direction: unitVector(axis.direction), lead: mod.lead,
      servo: { driveKey: mod.drive, motorKey: mod.motor, targetDeg: angle, loadInertiaRatio: mod.ratio } });
  }
  return { issues: [...issues], inputs };
}

export function inspectLinearAssembly(workspace: TwinWorkspace, definition: LinearAssembly): string[] {
  try { return resolveAxes(workspace, parseLinearAssembly(definition)).issues; }
  catch (error) { return [error instanceof Error ? error.message : "直线轴装配参数无效。"]; }
}

export function runLinearAssembly(workspace: TwinWorkspace, definition: LinearAssembly): LinearAssemblyResult {
  const { issues, inputs } = resolveAxes(workspace, parseLinearAssembly(definition));
  if (issues.length) throw new Error(issues.join("\n"));
  const times = new Set<number>();
  const axes = inputs.map((input) => {
    const trace = simulateServoAxis({ ...workspace, servoAxis: input.servo });
    for (const sample of trace.samples) times.add(sample.timeMs);
    return { ...input, trace, index: 0 };
  });
  const samples: LinearAssemblySample[] = [];
  for (const timeMs of [...times].sort((a, b) => a - b)) {
    const positionMm: number[] = [], velocityMmS: number[] = [], tipMm: Vec3 = [0, 0, 0];
    for (const axis of axes) {
      const data = axis.trace.samples;
      while (axis.index + 1 < data.length && data[axis.index + 1].timeMs <= timeMs) axis.index++;
      const a = data[axis.index], b = data[axis.index + 1];
      // 终端采样仍是求解器的实算值。只有后续时刻才将已到位轴的速度置零并保持末位置。
      const t = b ? (timeMs - a.timeMs) / (b.timeMs - a.timeMs) : 0;
      const degrees = b ? a.positionDeg + t * (b.positionDeg - a.positionDeg) : a.positionDeg;
      const rpm = b ? a.speedRpm + t * (b.speedRpm - a.speedRpm) : timeMs > a.timeMs && axis.trace.settled ? 0 : a.speedRpm;
      const position = degrees / 360 * axis.lead, velocity = rpm / 60 * axis.lead;
      if (!Number.isFinite(position) || !Number.isFinite(velocity)) throw new Error(`轴 ${axis.id} 的位移或速度超出数值范围，请核对丝杠导程。`);
      positionMm.push(position); velocityMmS.push(velocity);
      for (let i = 0; i < 3; i++) tipMm[i] += axis.direction[i] * position;
    }
    if (!tipMm.every(Number.isFinite)) throw new Error("各轴合成的末端位置超出数值范围。");
    samples.push({ timeMs, positionMm, velocityMmS, tipMm });
  }
  return { samples, settled: axes.every((axis) => axis.trace.settled) };
}
