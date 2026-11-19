import { applyMiloBomImport, mergeImportedMaterials } from "@contracts/import-apply";
import type { MaterialRow } from "@contracts/import-catalog";
import { inspectLinearAssembly, upsertLinearAssembly, type LinearAssembly } from "@contracts/linear-assembly";
import { inspectFactoryLayout, upsertFactoryLayout } from "@contracts/factory";
import { assembleMiloAxis, miloAxisIds } from "@contracts/milo-bom";
import { planMiloProgram, type MiloMotionPlan } from "@contracts/milo-motion";
import { parseMiloWorkspace } from "@contracts/milo-workspace";
import { assembleServoAxis } from "@contracts/servo-axis";
import { DEFAULT_SO101_MOTION, parseSo101Assembly, SO101_MODEL_ID } from "@contracts/so101";
import { modelicaServoProjectPath, type StudioExampleKind } from "@contracts/studio-navigation";
import { createTwinDemo } from "@contracts/twin-demo";
import { packageKey } from "@contracts/twin-device";
import { emptyWorkspace, installDeviceDependencies, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { decodeImportUtf8, parseImportText } from "@contracts/workbench-import";
import { miloBomSource, so101BomSource } from "./bom-sources";

export type StudioBenchKind = Exclude<StudioExampleKind, "physics">;
export interface LoadedStudioExample { workspace: TwinWorkspace; plan?: MiloMotionPlan }
export const miloPocketPath = "machines/milo-v1-5/circular-pocket.nc";
async function readStudioExampleText(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取 ${url.split("/").at(-1)} 失败（HTTP ${response.status}）。`);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return decodeImportUtf8(bytes);
}

async function readSo101ExampleBom(signal: AbortSignal) {
  const text = await readStudioExampleText(import.meta.env.BASE_URL + so101BomSource.localPath, signal);
  const result = parseImportText(text, "follower-bom.md", { hint: "bom" });
  if (result.kind !== "so101-bom") throw new Error("本地示例未识别为 SO-101 Follower 清单。");
  return result.bom;
}

async function loadMiloPocket(signal: AbortSignal) {
  const [programText, facts] = await Promise.all([
    readStudioExampleText(import.meta.env.BASE_URL + miloPocketPath, signal),
    readStudioExampleText(import.meta.env.BASE_URL + miloBomSource.localPath, signal),
  ]);
  signal.throwIfAborted();
  const inventory = parseImportText(facts, "bom-facts.md", { hint: "bom" });
  const nc = parseImportText(programText, "circular-pocket.nc", { hint: "gcode" });
  if (inventory.kind !== "milo-bom" || nc.kind !== "gcode") throw new Error("圆槽示例需要 Milo 采购表和 G 代码程序。");
  const base = applyMiloBomImport(emptyWorkspace(), inventory.bom, `本站核对表 · ${miloBomSource.documentUrl}`);
  const assembled = miloAxisIds.reduce((axes, axis) => assembleMiloAxis(inventory.bom, axes, axis), base.milo.assembled);
  return { workspace: { ...base, milo: { ...base.milo, assembled, program: nc.program } }, plan: planMiloProgram(nc.program) };
}

export async function loadStudioExample(kind: StudioBenchKind, signal: AbortSignal, download?: string): Promise<LoadedStudioExample> {
  signal.throwIfAborted();
  switch (kind) {
    case "wiring": return { workspace: createTwinDemo() };
    case "servo":
    case "factory":
    case "linear-assembly": {
      const path = download ?? (kind === "servo" ? modelicaServoProjectPath : undefined);
      if (!path) throw new Error("示例缺少可下载的装配工程。");
      const text = await readStudioExampleText(import.meta.env.BASE_URL + path, signal);
      const result = parseImportText(text, path);
      if (result.kind !== "project") throw new Error("示例文件不是可导入的设备工程。");
      if (kind === "servo" && !result.workspace.servoAxis) throw new Error("示例工程中缺少已装配的伺服轴。");
      if (kind === "linear-assembly" && result.workspace.assemblies?.length !== 1) throw new Error("每个直线装配示例须指定一份可编辑的装配。");
      if (kind === "factory" && result.workspace.factories?.length !== 1) throw new Error("每个工厂示例须指定一份可编辑的工厂布局。");
      return { workspace: result.workspace };
    }
    case "so101": {
      const bom = await readSo101ExampleBom(signal);
      const so101 = parseSo101Assembly({ modelId: SO101_MODEL_ID, bom, waypoints: DEFAULT_SO101_MOTION });
      return { workspace: { ...emptyWorkspace(), so101 } };
    }
    case "milo": return loadMiloPocket(signal);
  }
}

function orderedFields(_key: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
}
const same = (left: unknown, right: unknown) => JSON.stringify(left, orderedFields) === JSON.stringify(right, orderedFields);
type ExampleJoin = { next: TwinWorkspace; replacement?: string };

function bomReferences(rows: MaterialRow[]) {
  const ids = new Map<string, string | undefined>();
  for (const row of rows) ids.set(row.name, ids.has(row.name) ? undefined : row.id);
  for (const row of rows) ids.set(row.id, row.id);
  return ids;
}

/** 仅在合并清单会改变名称解析时，用原来的行 ID 保留各自的选料。 */
function preserveBomSelection(assembly: LinearAssembly, before: ReturnType<typeof bomReferences>, after: ReturnType<typeof bomReferences>) {
  const keep = (ref: string) => {
    const id = before.get(ref);
    return id && id !== after.get(ref) ? id : ref;
  };
  return { ...assembly, modules: assembly.modules.map(module => ({
    ...module, drive: keep(module.drive), motor: keep(module.motor), screw: keep(module.screw),
    ...(module.table && { table: keep(module.table) }),
  })) };
}

function joinMaterials(project: TwinWorkspace, sample: TwinWorkspace, extra: string[] = []) {
  const rows = sample.catalog?.materials ?? [];
  const used = rows.flatMap(row => row.binding?.kind === "device" ? [row.binding.key] : []);
  const merged = mergeImportedMaterials(installDeviceDependencies(project, sample.packages, [...used, ...extra]), rows);
  const materials = new Map(merged.catalog!.materials.map(row => [row.id, row]));
  for (const row of rows) {
    if (row.binding && !same(materials.get(row.id)?.binding, row.binding)) {
      throw new Error(`“${row.name}”在当前工程已绑定其他修订，请先在工程资源核对该物料。`);
    }
  }
  const after = bomReferences(merged.catalog!.materials);
  if (!project.assemblies?.length) return merged;
  const before = bomReferences(project.catalog?.materials ?? []);
  return { ...merged, assemblies: project.assemblies.map(a => preserveBomSelection(a, before, after)) };
}

/** 仅计算拟议变更。提交与覆盖确认由工作台处理。 */
export function prepareStudioExampleJoin(kind: StudioBenchKind, project: TwinWorkspace, sample: TwinWorkspace): ExampleJoin {
  switch (kind) {
    case "wiring": {
      const base = installDeviceDependencies(project, sample.packages, sample.instances.map(instance => instance.packageKey));
      const { instances, connections } = parseWorkspace({ ...emptyWorkspace(), packages: base.packages,
        instances: sample.instances, connections: sample.connections });
      if (same(project.instances, instances) && same(project.connections, connections)) return { next: base };
      const replacement = project.instances.length || project.connections.length
        ? `当前接线中的 ${project.instances.length} 个实例和 ${project.connections.length} 条接线将替换为示例的 ${instances.length} 个实例和 ${connections.length} 条接线。实例的输入值也将采用示例设置。` : undefined;
      return { next: { ...base, instances, connections }, replacement };
    }
    case "servo": {
      const axis = sample.servoAxis;
      if (!axis) throw new Error("请先组装示例伺服轴。");
      const base = installDeviceDependencies(project, sample.packages, [axis.driveKey, axis.motorKey]);
      const next = assembleServoAxis(base, axis);
      if (same(project.servoAxis, next.servoAxis)) return { next: base };
      const deviceNames = new Map(base.packages.map(device => [packageKey(device), `${device.model} · ${device.revision}`]));
      const describe = (config: typeof axis) => [
        `${deviceNames.get(config.driveKey)} / ${deviceNames.get(config.motorKey)}`, `目标 ${config.targetDeg}°`, `负载惯量比 ${config.loadInertiaRatio}`,
        config.modelRef ? `${config.modelRef.id} @ ${config.modelRef.version}` : "工作台刚性轴模型",
      ].join("，");
      const replacement = project.servoAxis
        ? `当前伺服轴（${describe(project.servoAxis)}）将被示例配置（${describe(axis)}）替换。` : undefined;
      return { next, replacement };
    }
    case "linear-assembly": {
      const definition = sample.assemblies?.[0], rows = sample.catalog?.materials ?? [];
      if (!definition) throw new Error("请先载入直线装配。");
      const issues = inspectLinearAssembly(sample, definition);
      if (issues.length) throw new Error(issues.join("\n"));
      const merged = joinMaterials(project, sample);
      const assembly = preserveBomSelection(definition, bomReferences(rows), bomReferences(merged.catalog!.materials));
      const previous = merged.assemblies?.find(item => item.id === assembly.id);
      const replacement = previous && !same(previous, assembly)
        ? `将用示例中的“${assembly.name}”更新当前工程的“${previous.name}”，包含模块选料和 ${assembly.axes.length} 根轴的目标位移。` : undefined;
      return { next: upsertLinearAssembly(merged, assembly), replacement };
    }
    case "factory": {
      const layout = sample.factories?.[0];
      if (!layout) throw new Error("请先载入工厂布局。");
      const issues = inspectFactoryLayout(sample, layout);
      if (issues.length) throw new Error(issues.join("\n"));
      const merged = joinMaterials(project, sample, layout.resources.map(r => r.packageKey));
      const previous = merged.factories?.find(f => f.id === layout.id);
      const replacement = previous && !same(previous, layout)
        ? `将以“${layout.name}”的 ${layout.lines.length} 条产线和 ${layout.resources.length} 台设备更新当前工程中的“${previous.name}”。` : undefined;
      return { next: upsertFactoryLayout(merged, layout), replacement };
    }
    case "so101": {
      const so101 = parseSo101Assembly(sample.so101);
      if (same(project.so101, so101)) return { next: project };
      const replacement = project.so101
        ? `当前 SO-101 的装配清单和 ${project.so101.waypoints.length} 个示教路点将被替换。示例包含 ${so101.waypoints.length} 个路点。` : undefined;
      return { next: { ...project, so101 }, replacement };
    }
    case "milo": {
      const milo = parseMiloWorkspace(sample.milo);
      if (same(project.milo, milo)) return { next: project };
      const replacement = project.milo
        ? `当前 Milo 的清单、已装 ${project.milo.assembled.length} 根轴和 G 代码程序将被替换。示例中已装 ${milo.assembled.length} 根轴。` : undefined;
      return { next: { ...project, milo }, replacement };
    }
  }
}
