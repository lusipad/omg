import { z } from "zod";
import { factoryParameterIssues, factoryParametersSchema, getFactoryModel, type FactoryModel } from "./factory-model";
import { isMeasuredMaterialUnit } from "./material-import";
import { packageKey, readTwinData, signalIdSchema, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export { FACTORY_MODELS, getFactoryModel, type FactoryModel, type FactoryRole } from "./factory-model";
export const FACTORY_LIMITS = { factories: 32, resources: 32, lines: 16, stages: 16, jobs: 64 } as const;

const nameSchema = z.string().trim().min(1).max(160);
const finite = z.number().finite();
const resourceSchema = z.strictObject({
  id: signalIdSchema, name: nameSchema, packageKey: z.string().trim().max(4096),
  positionM: z.tuple([finite, finite]), materialId: z.string().trim().min(1).max(128).optional(),
  parameters: factoryParametersSchema.optional(),
});
const resourceRefs = z.array(signalIdSchema).max(FACTORY_LIMITS.resources)
  .refine(ids => new Set(ids).size === ids.length, "候选设备标识重复");
const stageSchema = z.strictObject({
  id: signalIdSchema, name: nameSchema, operation: z.enum(["handle", "machine"]), stations: resourceRefs, carriers: resourceRefs,
});
const uniqueIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const lineSchema = z.strictObject({
  id: signalIdSchema, name: nameSchema,
  batch: z.strictObject({ quantity: finite.int().positive().max(FACTORY_LIMITS.jobs), releaseIntervalS: finite.nonnegative() }),
  stages: z.array(stageSchema).max(FACTORY_LIMITS.stages).refine(uniqueIds, "同一产线中的工序标识重复"),
});
const layoutSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("factory-layout"), id: signalIdSchema, name: nameSchema,
  resources: z.array(resourceSchema).max(FACTORY_LIMITS.resources).refine(uniqueIds, "工厂中的设备实例标识重复"),
  lines: z.array(lineSchema).max(FACTORY_LIMITS.lines).refine(uniqueIds, "工厂中的产线标识重复"),
}).superRefine(({ lines }, ctx) => {
  const stages = lines.reduce((sum, line) => sum + line.stages.length, 0);
  const jobs = lines.reduce((sum, line) => sum + line.batch.quantity, 0);
  if (stages > FACTORY_LIMITS.stages) ctx.addIssue({ code: "custom", path: ["lines"], message: `一个工厂最多支持 ${FACTORY_LIMITS.stages} 道工序。` });
  if (jobs > FACTORY_LIMITS.jobs) ctx.addIssue({ code: "custom", path: ["lines"], message: `本次仿真所有产线合计最多投放 ${FACTORY_LIMITS.jobs} 件工件。` });
});
export const factoryListSchema = z.array(layoutSchema).max(FACTORY_LIMITS.factories).refine(uniqueIds, "工程中的工厂标识重复");
export type FactoryLayout = z.infer<typeof layoutSchema>;
export type FactoryResource = FactoryLayout["resources"][number];
export type FactoryLine = FactoryLayout["lines"][number];
export type FactoryStage = FactoryLine["stages"][number];

export interface ResolvedFactoryLayout {
  resources: { resource: FactoryResource; device: DevicePackage; model: FactoryModel; parameters: Record<string, number> }[];
  stages: { line: FactoryLine; stage: FactoryStage }[];
  /** firstStage / lastStage 是展平工序表中的一基闭区间，serial 是产线内的一基工件号。 */
  jobs: { line: FactoryLine; serial: number; firstStage: number; lastStage: number; releaseS: number }[];
}

export function parseFactoryLayout(raw: unknown): FactoryLayout {
  return readTwinData(layoutSchema, raw, "工厂装配");
}

export function upsertFactoryLayout(workspace: TwinWorkspace, value: FactoryLayout): TwinWorkspace {
  const layout = parseFactoryLayout(value), existing = workspace.factories ?? [];
  if (existing.some(item => item.id === layout.id))
    return { ...workspace, factories: existing.map(item => item.id === layout.id ? layout : item) };
  if (existing.length >= FACTORY_LIMITS.factories) throw new Error(`单个工程最多保存 ${FACTORY_LIMITS.factories} 座工厂。`);
  return { ...workspace, factories: [...existing, layout] };
}

export function replaceFactoryResourcePackage(resource: FactoryResource, device: DevicePackage): FactoryResource {
  if (!device.factory || !getFactoryModel(device.factory.modelRef)) throw new Error("请选择已安装且模型版本可用的工厂设备修订。");
  const key = packageKey(device);
  if (resource.packageKey === key) return resource;
  return { id: resource.id, name: resource.name, positionM: resource.positionM, packageKey: key };
}

function bindResources(workspace: TwinWorkspace, layout: FactoryLayout, issues: Set<string>) {
  const devices = new Map(workspace.packages.map(p => [packageKey(p), p]));
  const materials = new Map(workspace.catalog?.materials.map(row => [row.id, row]));
  const usage = new Map<string, number>();
  const resolved: ResolvedFactoryLayout["resources"] = [];
  for (const resource of layout.resources) {
    const label = `设备 ${resource.id}（${resource.name}）`;
    if (resource.materialId) {
      const row = materials.get(resource.materialId);
      if (!row) issues.add(`${label}引用的 BOM 行“${resource.materialId}”不存在。`);
      else {
        usage.set(row.id, (usage.get(row.id) ?? 0) + 1);
        if (row.binding?.kind !== "device" || row.binding.key !== resource.packageKey)
          issues.add(`${label}的 BOM 行“${row.name}”须绑定到此实例选用的设备修订。`);
        if (isMeasuredMaterialUnit(row.unit) || (row.unit === "份" && row.id.startsWith("doc-")))
          issues.add(`BOM 行“${row.name}”的单位为 ${row.unit}，请选取按件数统计的设备物料。`);
      }
    }
    const device = devices.get(resource.packageKey);
    if (!device?.factory) {
      issues.add(`${label}需要绑定已安装的工厂设备修订。`);
      continue;
    }
    const ref = device.factory.modelRef, model = getFactoryModel(ref);
    if (!model) {
      issues.add(`${label}引用的过程模型 ${ref.id} @ ${ref.version} 尚未安装。`);
      continue;
    }
    const parameters = { ...device.factory.parameters, ...resource.parameters };
    for (const issue of factoryParameterIssues(model, parameters, true)) issues.add(`${label}：${issue}`);
    resolved.push({ resource, device, model, parameters });
  }
  for (const [rowId, count] of usage) {
    const row = materials.get(rowId)!;
    if (row.quantity < count) issues.add(`“${row.name}”库存不足，工厂安装 ${count} 台，BOM 数量为 ${row.quantity}。`);
  }
  return resolved;
}

type XY = FactoryResource["positionM"];
const samePosition = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];

function resolve(workspace: TwinWorkspace, layout: FactoryLayout) {
  const issues = new Set<string>();
  if (!layout.resources.length) issues.add("请先添加工厂设备实例。");
  if (!layout.lines.length) issues.add("请添加至少一条产线并编排工序。");
  const resources = bindResources(workspace, layout, issues);
  const byId = new Map(resources.map(bound => [bound.resource.id, bound]));
  const ids = new Set(layout.resources.map(r => r.id));
  const belts = new Map<string, { from: XY; to: XY }>();
  const stages: ResolvedFactoryLayout["stages"] = [], jobs: ResolvedFactoryLayout["jobs"] = [];
  for (const line of layout.lines) {
    const firstStage = stages.length + 1;
    if (!line.stages.length) issues.add(`产线“${line.name}”还没有工序。`);
    let previous: XY[] = [];
    for (const [index, stage] of line.stages.entries()) {
      stages.push({ line, stage });
      const label = `产线“${line.name}”的工序“${stage.name}”`;
      if (!stage.stations.length) issues.add(`${label}需要至少一个候选工位。`);
      if (!index && stage.carriers.length) issues.add(`${label}是首道工序，请清空入站载具。`);
      for (const id of [...stage.stations, ...stage.carriers]) {
        if (!ids.has(id)) issues.add(`${label}引用的设备“${id}”不存在。`);
      }
      const fixed = stage.stations.flatMap(id => byId.get(id) ?? []);
      for (const item of fixed) {
        if (item.model.role !== stage.operation)
          issues.add(`${label}需要${stage.operation === "handle" ? "上下料" : "加工"}能力，所选设备“${item.resource.name}”使用${item.model.label}。`);
      }
      const current = fixed.map(item => item.resource.positionM);
      const from = previous[0], to = current[0];
      const onePair = from && to && previous.every(p => samePosition(p, from)) && current.every(p => samePosition(p, to));
      if (index && !stage.carriers.length && from && to && !(onePair && samePosition(from, to)))
        issues.add(`${label}与上一工序不在同一位置，请配置入站运输设备。`);
      for (const id of stage.carriers) {
        const bound = byId.get(id);
        if (!bound || bound.model.role === "mobile") continue;
        if (bound.model.role !== "conveyor") {
          issues.add(`${label}选择的设备“${bound.resource.name}”不具备搬运能力。`);
          continue;
        }
        if (!index || !from || !to) continue;
        const route = belts.get(id);
        if (!onePair || samePosition(from, to) || (route && (!samePosition(route.from, from) || !samePosition(route.to, to))))
          issues.add(`${label}使用的固定输送带“${bound.resource.name}”必须连接同一对有方向、位置不同的端点。`);
        else belts.set(id, { from, to });
      }
      previous = current;
    }
    const lastStage = stages.length;
    for (let serial = 1; serial <= line.batch.quantity; serial++) {
      const releaseS = (serial - 1) * line.batch.releaseIntervalS;
      if (!Number.isFinite(releaseS)) issues.add(`产线“${line.name}”的投料时间超出可计算范围。`);
      jobs.push({ line, serial, firstStage, lastStage, releaseS });
    }
  }
  return { result: { resources, stages, jobs }, issues: [...issues] };
}

export function inspectFactoryLayout(workspace: TwinWorkspace, value: FactoryLayout): string[] {
  try { return resolve(workspace, parseFactoryLayout(value)).issues; }
  catch (error) { return [error instanceof Error ? error.message : "工厂装配参数无效。"]; }
}

export function resolveFactoryLayout(workspace: TwinWorkspace, value: FactoryLayout): ResolvedFactoryLayout {
  const { result, issues } = resolve(workspace, parseFactoryLayout(value));
  if (issues.length) throw new Error(issues.join("\n"));
  return result;
}
