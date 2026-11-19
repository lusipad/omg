import { z } from "zod";
import { packageKey, readTwinData, type DevicePackage } from "./twin-device";
import { controlSequenceIssue, IMPORTED_PHYSICS_LIMITS } from "./imported-physics";

export const MODEL_LIMITS = {
  maxFiles: 512,
  maxFileBytes: 32 * 1024 * 1024,
  maxBundleBytes: 64 * 1024 * 1024,
  maxProjectBytes: 192 * 1024 * 1024,
} as const;
export const MAX_PROJECT_JSON_BYTES = 8 * 1024 * 1024;

export interface ModelFile { path: string; data: Uint8Array }
export interface ModelBundle { entry: string; files: ModelFile[] }

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().regex(/^[a-f0-9]{64}$/, "物理模型 ID 必须为内容的 SHA-256");
const entry = text(1024).refine(value => !value.includes("\\") && !Array.from(value).some(char => char.charCodeAt(0) < 32)
  && !/^[a-z][a-z\d+.-]*:/i.test(value)
  && !value.split("/").some(part => !part || part === "." || part === ".."), "模型入口必须是包内的相对路径");
const controls = z.array(z.number().finite()).max(256);
const runSettings = z.strictObject({
  durationS: z.number().finite().positive().max(IMPORTED_PHYSICS_LIMITS.maxDurationS),
  controls,
  pointId: text(240),
  referencePointId: text(240).optional(),
  keyframe: z.string().min(1).optional(),
  sequence: z.array(z.strictObject({
    timeS: z.number().finite().positive(), controls, label: text(IMPORTED_PHYSICS_LIMITS.maxStageLabel).optional(),
  })).max(IMPORTED_PHYSICS_LIMITS.maxStages).optional(),
}).superRefine((settings, ctx) => {
  const issue = controlSequenceIssue(settings);
  if (issue) ctx.addIssue({ code: "custom", path: ["sequence"], message: issue });
});
const modelRefSchema = z.strictObject({ id, name: text(300), entry, run: runSettings.optional() });
const bindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("device"), key: text(4096) }),
  z.strictObject({ kind: z.literal("physics"), key: id }),
]);
const materialSchema = z.strictObject({
  id: text(128), name: text(300), quantity: z.number().finite().positive(),
  unit: text(80).optional(), manufacturer: text(240).optional(), model: text(240).optional(),
  leadMmPerRev: z.number().finite().positive().optional(),
  massKg: z.number().finite().positive().optional(),
  source: text(2048).optional(), notes: z.string().max(80_000).refine(value => value.trim().length > 0, "资料不能为空").optional(),
  binding: bindingSchema.optional(),
});
const catalogSchema = z.strictObject({
  models: z.array(modelRefSchema).max(128), materials: z.array(materialSchema).max(2000),
});

export type ModelRef = z.infer<typeof modelRefSchema>;
export type MaterialRow = z.infer<typeof materialSchema>;
export type ImportCatalog = z.infer<typeof catalogSchema>;

export function parseImportCatalog(raw: unknown, packages: DevicePackage[]): ImportCatalog {
  const catalog = readTwinData(catalogSchema, raw, "导入库");
  const modelIds = new Set(catalog.models.map(model => model.id));
  if (modelIds.size !== catalog.models.length) throw new Error("工程中存在重复的物理模型 ID。");
  const deviceKeys = new Set(packages.map(packageKey));
  const materialIds = new Set<string>();
  for (const row of catalog.materials) {
    if (materialIds.has(row.id)) throw new Error(`物料记录 ID 重复：${row.name}`);
    materialIds.add(row.id);
    const ref = row.binding;
    if (ref && !(ref.kind === "device" ? deviceKeys : modelIds).has(ref.key)) {
      throw new Error(`“${row.name}”绑定的模型未安装在此工程中。`);
    }
  }
  return catalog;
}
