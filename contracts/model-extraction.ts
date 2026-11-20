import { z } from "zod";
import {
  evaluateBindingReadiness,
  type BindingReadiness,
} from "./device-model-binding";
import {
  requireRegisteredModel,
  type ModelParameterSpec,
  type RegisteredModel,
} from "./model-registry";
import {
  findEvidencePage,
  normalizeSourceQuote,
  sourceArtifactPageSchema,
} from "./source-artifact";
import {
  modelRefSchema,
  parseDevicePackage,
  type DeviceModelBinding,
  type DevicePackage,
  type DeviceParameterEntry,
} from "./twin-device";
import { areUnitsCompatible, convertUnit, parseUnitSpec } from "./units";

const fieldText = (label: string, max: number) =>
  z.string().trim().min(1, `请填写${label}。`).max(max, `${label}最多允许 ${max} 个字符。`);

export const modelExtractionRequestSchema = z.strictObject({
  manufacturer: fieldText("制造商", 160),
  model: fieldText("型号", 160),
  revision: fieldText("修订", 160),
  modelRef: modelRefSchema,
  artifact: z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    title: fieldText("资料标题", 512),
    sourceUrl: z.string().trim().max(2048).pipe(z.url({ protocol: /^https?$/ })).optional(),
    documentVersion: z.string().trim().min(1).max(160).optional(),
    pages: z.array(sourceArtifactPageSchema).min(1).max(200).optional(),
    text: fieldText("用于 AI 提取的规格原文", 120_000),
  }),
  compatiblePeerModels: z.array(fieldText("配套型号", 160)).max(256).optional(),
});

export type ModelExtractionRequest = z.infer<typeof modelExtractionRequestSchema>;

const candidateValueSchema = z.union([z.number().finite(), z.boolean()]);
const extractedFieldSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("confirmed"),
    value: candidateValueSchema,
    rawUnit: z.string().trim().min(1).max(40).optional(),
    page: z.number().int().positive().max(2000).optional(),
    tableLocation: z.string().trim().min(1).max(240).optional(),
    condition: z.string().trim().min(1).max(240).optional(),
    excerpt: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    status: z.literal("ambiguous"),
    rawUnit: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(512),
    candidates: z.array(z.strictObject({
      option: z.string().trim().min(1).max(160),
      value: candidateValueSchema,
      rawUnit: z.string().trim().min(1).max(40).optional(),
      page: z.number().int().positive().max(2000).optional(),
      tableLocation: z.string().trim().min(1).max(240).optional(),
      excerpt: z.string().trim().min(1).max(4000),
    })).min(2).max(16),
  }),
  z.strictObject({
    status: z.literal("missing"),
    reason: z.string().trim().min(1).max(512),
  }),
]);

export const rawModelExtractionSchema = z.strictObject({
  fields: z.record(z.string().trim().min(1).max(80), extractedFieldSchema),
  compatiblePeerModels: z.strictObject({
    models: z.array(z.string().trim().min(1).max(160)).min(1).max(256),
    page: z.number().int().positive().max(2000).optional(),
    tableLocation: z.string().trim().min(1).max(240).optional(),
    excerpt: z.string().trim().min(1).max(4000),
  }).optional(),
  unmodeledPhysicsNotes: z.array(z.string().trim().min(1).max(300)).max(32).optional(),
});

export type RawModelExtraction = z.infer<typeof rawModelExtractionSchema>;

export interface ModelExtractionResult {
  device: DevicePackage;
  readiness: BindingReadiness;
  warnings: string[];
}

function componentModel(ref: ModelExtractionRequest["modelRef"]): RegisteredModel {
  const model = requireRegisteredModel(ref, "目标行为模型");
  if (model.kind !== "component") {
    throw new Error(`模型 ${ref.id} @ ${ref.version} 是系统级求解内核，资料提取请选择单个部件模型。`);
  }
  return model;
}

export function modelExtractionPrompt(req: ModelExtractionRequest): string {
  const model = componentModel(req.modelRef);
  const parameterLines = model.parameters.map((p) => {
    const reqTag = p.optional ? "可选" : "必填";
    const typeTag = p.valueType === "boolean" ? "布尔 true/false" : `数值（标准单位 ${p.unit}，量纲 ${p.dimension}）`;
    return `- ${p.key}（${p.label}，${reqTag}）：${typeTag}`;
  });
  const textPayload = req.artifact.pages?.length
    ? req.artifact.pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join("\n\n")
    : req.artifact.text;

  return [
    "你是工业机电设备资料提取助手。只能依据所给资料原文提取指定型号的参数，禁止编造、推算或跨系列猜测。",
    `目标设备：制造商="${req.manufacturer}"，型号="${req.model}"，设备包版本="${req.revision}"`,
    `目标模型：${model.id} @ ${model.version}（${model.label}）`,
    `模型用途：${model.simPurpose.summary}`,
    "待提取参数列表：",
    ...parameterLines,
    "",
    "输出严格 JSON（不要附加 Markdown 解释），结构为：",
    '{ "fields": { "<paramKey>": ... }, "compatiblePeerModels"?: { "models": [...], "page"?: number, "tableLocation"?: string, "excerpt": "..." } /* 仅原文明确列出配套型号时填写；无则省略 */, "unmodeledPhysicsNotes"?: [...] }',
    "每个字段值只能是以下三种形式之一：",
    '1. 确定单值：{"status":"confirmed","value":数值或布尔,"rawUnit":"手册原始单位(含倍率如 10^-4 kg·m²、kW、r/min、Arms)","page"?:页码,"tableLocation"?:表名或行列,"condition"?:适用选件或工况,"excerpt":"连续原文摘录"}',
    '2. 存在选件歧义（例如缺少是否带抱闸字符导致同一列出现两个候选值）：{"status":"ambiguous","rawUnit":"原始单位","reason":"歧义说明","candidates":[{"option":"选件条件","value":数值,"rawUnit"?:原始单位,"page"?:页码,"tableLocation"?:表名,"excerpt":"对应原文摘录"}, ...]}',
    '3. 原文未提供该字段：{"status":"missing","reason":"缺失说明"}',
    "",
    "重要规则：",
    "- 必须原样保留手册表格里的数字和表头倍率（如表头写了 10^-4 kg·m²、单元格写了 0.254，就填 value: 0.254, rawUnit: \"10^-4 kg.m2\"），不要自行心算换算。",
    "- 每一条 excerpt 必须是原文逐字连续片段，且必须直接包含该数值。",
    "- 若目标型号缺少选件后缀导致多个候选值，绝不猜其中一个，必须输出 status: \"ambiguous\"。",
    "- 如果手册提到模型范围外的物理因素（如油封阻力、抱闸摩擦、温升），可写入 unmodeledPhysicsNotes。",
    "",
    `资料标题：${req.artifact.title}`,
    ...(req.artifact.documentVersion ? [`资料文件号/版本：${req.artifact.documentVersion}`] : []),
    ...(req.artifact.sourceUrl ? [`资料链接：${req.artifact.sourceUrl}`] : []),
    "资料正文：",
    textPayload,
  ].join("\n");
}

function verifyExcerptAndPage(
  artifact: ModelExtractionRequest["artifact"],
  normalizedFullText: string,
  excerpt: string,
  claimedPage: number | undefined,
  label: string,
): number | undefined {
  const lines = excerpt.split(/\r?\n/).map(normalizeSourceQuote).filter(Boolean);
  if (!lines.length || lines.some((line) => !normalizedFullText.includes(line))) {
    throw new Error(`${label}的证据摘录无法在提交的资料原文中逐行核对。`);
  }
  if (!artifact.pages?.length) return claimedPage;
  if (claimedPage !== undefined) {
    const page = artifact.pages.find((item) => item.pageNumber === claimedPage);
    if (!page) {
      throw new Error(`${label}标注的页码第 ${claimedPage} 页超出资料总页数（${artifact.pages.length} 页）。`);
    }
    const normalizedPage = normalizeSourceQuote(page.text);
    if (!lines.every((line) => normalizedPage.includes(line))) {
      throw new Error(`${label}的证据摘录在第 ${claimedPage} 页中未找到，请核对页码定位。`);
    }
    return claimedPage;
  }
  return findEvidencePage({ pages: artifact.pages }, excerpt);
}

function numberAppearsInExcerpt(value: number, excerpt: string): boolean {
  const normalized = excerpt
    .normalize("NFKC")
    .replace(/\u2212/g, "-")
    // 剔除 10^-4 / 10⁻⁴ 等数量级倍率中的底数和指数，防止误匹配
    .replace(/\b10\s*(?:\^|(?=-))\s*[+-]?\d+/g, " ");
  const tokenPattern = /(?:^|(?<![.\d]))([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?![.\d])/gi;
  for (const match of normalized.matchAll(tokenPattern)) {
    const parsed = Number(match[0].replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed === value) {
      return true;
    }
  }
  return false;
}

function checkValueAndUnit(
  spec: ModelParameterSpec,
  value: number | boolean,
  rawUnit: string | undefined,
  label: string,
) {
  if (spec.valueType === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${label}需要布尔值。`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}需要有限数值。`);
  }
  const effectiveUnit = rawUnit?.trim() || (spec.dimension === "dimensionless" ? "1" : "");
  if (!effectiveUnit) {
    throw new Error(`${label}缺少原始物理单位（模型需要 ${spec.unit}）。`);
  }
  const unitSpec = parseUnitSpec(effectiveUnit);
  if (!unitSpec) {
    throw new Error(`${label}的原始单位“${effectiveUnit}”无法识别。`);
  }
  if (!areUnitsCompatible(effectiveUnit, spec.unit)) {
    throw new Error(`${label}的单位“${effectiveUnit}”与模型参数 ${spec.key}（${spec.unit}）量纲不兼容。`);
  }
  const converted = convertUnit(value, effectiveUnit, spec.unit);
  if (spec.positive && !(converted > 0)) {
    throw new Error(`${label}换算后（${converted} ${spec.unit}）必须大于 0。`);
  }
  if (spec.min !== undefined && converted < spec.min) {
    throw new Error(`${label}换算后（${converted} ${spec.unit}）不能小于 ${spec.min} ${spec.unit}。`);
  }
  if (spec.max !== undefined && converted > spec.max) {
    throw new Error(`${label}换算后（${converted} ${spec.unit}）不能大于 ${spec.max} ${spec.unit}。`);
  }
  if (spec.integer && !Number.isSafeInteger(converted)) {
    throw new Error(`${label}换算后（${converted}）必须为整数。`);
  }
}

function formatLocator(
  documentVersion: string | undefined,
  page: number | undefined,
  tableLocation: string | undefined,
): string | undefined {
  const parts = [
    documentVersion,
    page !== undefined ? `第 ${page} 页` : undefined,
    tableLocation,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ").slice(0, 512) : undefined;
}

function resolveModelParamSpec(model: RegisteredModel, rawKey: string): ModelParameterSpec | undefined {
  return model.parameters.find((p) => p.key === rawKey || p.aliases?.includes(rawKey));
}

export function verifyAndBuildExtractedDevice(
  reqInput: ModelExtractionRequest,
  rawOutput: unknown,
): ModelExtractionResult {
  const req = modelExtractionRequestSchema.parse(reqInput);
  const model = componentModel(req.modelRef);
  const parsed = rawModelExtractionSchema.safeParse(rawOutput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`模型提取输出格式无效（${issue.path.map(String).join(".") || "根节点"}）：${issue.message}`);
  }

  const normalizedFullText = normalizeSourceQuote(req.artifact.text);
  const parameters: Record<string, DeviceParameterEntry> = {};
  const mappings: DeviceModelBinding["mappings"] = [];
  const locators = new Set<string>();
  const excerpts = new Set<string>();
  const warnings: string[] = [...(parsed.data.unmodeledPhysicsNotes ?? [])];

  for (const [rawKey, item] of Object.entries(parsed.data.fields)) {
    const spec = resolveModelParamSpec(model, rawKey);
    if (!spec) {
      throw new Error(`模型 ${model.id} @ ${model.version} 未声明参数 ${rawKey}。`);
    }
    if (Object.hasOwn(parameters, spec.key)) {
      throw new Error(`提取结果重复声明了参数 ${spec.key}。`);
    }
    const label = `参数 ${spec.label}（${spec.key}）`;

    if (item.status === "missing") {
      warnings.push(`${spec.label}（${spec.key}）未在资料中确认：${item.reason}`);
      continue;
    }

    if (item.status === "confirmed") {
      const page = verifyExcerptAndPage(req.artifact, normalizedFullText, item.excerpt, item.page, label);
      if (typeof item.value === "number" && !numberAppearsInExcerpt(item.value, item.excerpt)) {
        throw new Error(`${label}的提取数值 ${item.value} 未出现在其原文摘录中。`);
      }
      checkValueAndUnit(spec, item.value, item.rawUnit, label);
      const effectiveUnit = item.rawUnit?.trim() || (spec.dimension === "dimensionless" ? "1" : undefined);
      const locator = formatLocator(req.artifact.documentVersion, page, item.tableLocation);
      if (locator) locators.add(locator);
      excerpts.add(item.excerpt.trim());

      parameters[spec.key] = {
        status: "catalog",
        value: item.value,
        ...(effectiveUnit !== undefined && { unit: effectiveUnit }),
        label: spec.label,
        ...(item.condition !== undefined && { condition: item.condition }),
        ...(locator !== undefined && { locator }),
        excerpt: item.excerpt.trim(),
      };
      mappings.push({ kind: "parameter", source: spec.key, target: spec.key });
      continue;
    }

    // ambiguous
    if (!areUnitsCompatible(item.rawUnit, spec.unit)) {
      throw new Error(`${label}的待确认单位“${item.rawUnit}”与模型参数单位（${spec.unit}）量纲不兼容。`);
    }
    const verifiedCandidates = item.candidates.map((candidate, index) => {
      const candidateLabel = `${label}候选 #${index + 1}（${candidate.option}）`;
      const page = verifyExcerptAndPage(req.artifact, normalizedFullText, candidate.excerpt, candidate.page, candidateLabel);
      if (typeof candidate.value === "number" && !numberAppearsInExcerpt(candidate.value, candidate.excerpt)) {
        throw new Error(`${candidateLabel}的提取数值 ${candidate.value} 未出现在其原文摘录中。`);
      }
      const candidateUnit = candidate.rawUnit?.trim() || item.rawUnit;
      checkValueAndUnit(spec, candidate.value, candidateUnit, candidateLabel);
      const locator = formatLocator(req.artifact.documentVersion, page, candidate.tableLocation);
      if (locator) locators.add(locator);
      excerpts.add(candidate.excerpt.trim());
      return {
        option: candidate.option,
        value: candidate.value,
        unit: candidateUnit,
        ...(locator !== undefined && { locator }),
        excerpt: candidate.excerpt.trim(),
      };
    });

    parameters[spec.key] = {
      status: "pending",
      label: spec.label,
      unit: item.rawUnit,
      reason: item.reason,
      candidates: verifiedCandidates,
    };
    mappings.push({ kind: "parameter", source: spec.key, target: spec.key });
  }

  let compatiblePeerModels = req.compatiblePeerModels ? [...req.compatiblePeerModels] : undefined;
  if (parsed.data.compatiblePeerModels) {
    const peerInfo = parsed.data.compatiblePeerModels;
    const page = verifyExcerptAndPage(req.artifact, normalizedFullText, peerInfo.excerpt, peerInfo.page, "配套型号清单");
    const normPeerExcerpt = normalizeSourceQuote(peerInfo.excerpt);
    for (const peerModel of peerInfo.models) {
      if (/[*?□…]/u.test(peerModel)) {
        throw new Error(`配套型号“${peerModel}”包含通配符，请确认完整订货型号。`);
      }
      if (!normPeerExcerpt.includes(normalizeSourceQuote(peerModel))) {
        throw new Error(`配套型号“${peerModel}”未出现在对应的原文摘录中。`);
      }
    }
    const locator = formatLocator(req.artifact.documentVersion, page, peerInfo.tableLocation);
    if (locator) locators.add(locator);
    excerpts.add(peerInfo.excerpt.trim());
    compatiblePeerModels = [...new Set([...(compatiblePeerModels ?? []), ...peerInfo.models])];
  }

  const summaryLocator = [...locators].join("；").slice(0, 512)
    || formatLocator(req.artifact.documentVersion, undefined, req.artifact.title)
    || req.artifact.title;
  const summaryExcerpt = [...excerpts].join("\n").slice(0, 16_000)
    || req.artifact.text.trim().slice(0, 400);

  const device = parseDevicePackage({
    schemaVersion: 1,
    manufacturer: req.manufacturer,
    model: req.model,
    revision: req.revision,
    source: {
      title: req.artifact.title,
      url: req.artifact.sourceUrl ?? "",
      ...(req.artifact.sourceUrl ? {} : { kind: "local" as const }),
      locator: summaryLocator,
      excerpt: summaryExcerpt,
    },
    ports: [],
    rules: [],
    parameters,
    modelBindings: [
      {
        id: "primary",
        modelRef: req.modelRef,
        mappings,
        ...(compatiblePeerModels?.length ? { compatiblePeerModels } : {}),
      },
    ],
  });

  const readiness = evaluateBindingReadiness(device, "primary");
  return { device, readiness, warnings };
}
