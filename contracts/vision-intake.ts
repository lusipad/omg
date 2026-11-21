import { z } from "zod";
import {
  listRegisteredModels,
  modelKey,
  requireRegisteredModel,
  type RegisteredModel,
} from "./model-registry";
import {
  packageKey,
  parseDevicePackage,
  type DeviceModelBinding,
  type DevicePackage,
  type DeviceParameterEntry,
  type ModelReference,
} from "./twin-device";
import {
  upsertTwinSystem,
  type SystemAxisUnit,
  type SystemDiChannelNode,
  type SystemLimitSensorNode,
  type SystemSignalWire,
  type TwinSystemAssembly,
} from "./system-twin";
import { modelRefSchema } from "./twin-device";
import { parseWorkspace, type TwinWorkspace } from "./twin-simulation";
import { areUnitsCompatible, parseQuantityText } from "./units";

export const visionImageInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataUrl: z
    .string()
    .min(32)
    .max(4_200_000)
    .refine(
      (s) => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
      "照片必须是 JPEG / PNG / WebP 的 Base64 Data URL。",
    ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

export const visionIntakeRequestSchema = z.strictObject({
  images: z.array(visionImageInputSchema).min(1).max(4),
  userGoal: z.string().trim().max(500).optional(),
  focusModelRef: modelRefSchema.optional(),
});

export const rawVisionExtractedParamSchema = z.strictObject({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().max(120).optional(),
  value: z.union([z.number().finite(), z.boolean(), z.string().trim().min(1).max(80)]),
  unit: z.string().trim().max(40).optional(),
  excerpt: z.string().trim().min(1).max(240),
});

export const rawVisionDeviceSchema = z.strictObject({
  deviceTypeLabel: z.string().trim().min(1).max(120),
  manufacturer: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(80).optional(),
  serialNumber: z.string().trim().max(120).optional(),
  role: z.enum(["drive", "motor", "screw", "table", "sensor", "di", "other"]),
  modelRef: modelRefSchema.nullable(),
  parameters: z.array(rawVisionExtractedParamSchema).max(32),
  uncoveredReason: z.string().trim().max(300).optional(),
});

export const rawVisionSystemSketchSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  targetMm: z.number().finite().optional(),
  cruiseVelocityMmS: z.number().finite().positive().optional(),
  sensorTriggerMm: z.number().finite().optional(),
  triggerMode: z.enum(["positive_overtravel", "negative_overtravel", "window"]).optional(),
  normallyClosed: z.boolean().optional(),
  wiringHint: z.string().trim().max(240).optional(),
});

export const rawVisionIntakeSchema = z.strictObject({
  sceneKind: z.enum(["nameplate", "wiring_sketch", "cad_layout", "mixed"]),
  transcribedText: z.string().trim().min(1).max(8000),
  devices: z.array(rawVisionDeviceSchema).min(1).max(16),
  systemSketch: rawVisionSystemSketchSchema.optional(),
  notes: z.array(z.string().trim().max(300)).max(16).optional(),
});

export type VisionImageInput = z.infer<typeof visionImageInputSchema>;
export type VisionIntakeRequest = z.infer<typeof visionIntakeRequestSchema>;
export type RawVisionExtractedParam = z.infer<typeof rawVisionExtractedParamSchema>;
export type RawVisionDevice = z.infer<typeof rawVisionDeviceSchema>;
export type RawVisionSystemSketch = z.infer<typeof rawVisionSystemSketchSchema>;
export type RawVisionIntake = z.infer<typeof rawVisionIntakeSchema>;

export interface VisionPendingItem {
  readonly packageKey: string;
  readonly deviceLabel: string;
  readonly parameterKey: string;
  readonly label: string;
  readonly unit: string;
  readonly reason: string;
}

export interface VisionUnmodeledRequest {
  readonly deviceLabel: string;
  readonly model: string;
  readonly role: RawVisionDevice["role"];
  readonly reason: string;
}

export interface VisionIntakeResult {
  readonly workspace: TwinWorkspace;
  readonly createdDevices: readonly DevicePackage[];
  readonly createdSystem?: TwinSystemAssembly;
  readonly pendingItems: readonly VisionPendingItem[];
  readonly unmodeledRequests: readonly VisionUnmodeledRequest[];
  readonly notes: readonly string[];
}

export const visionIntakeSystemPrompt =
  "你是工业机电控数字孪生视觉建模助理。" +
  "只能严格基于照片中的文字、标牌、箭头、标尺与接线关系输出 JSON，绝对禁止凭品牌猜型号或编造照片未写出的数值。" +
  "如果某个必填行为模型参数在照片中未出现或模糊不清，不要猜值，请将其省略并在 uncoveredReason 中如实说明。";

export function buildVisionIntakePrompt(options?: {
  userGoal?: string;
  focusModelRef?: ModelReference;
}): string {
  const catalog = listRegisteredModels()
    .map((m) => ({
      modelRef: { id: m.id, version: m.version },
      category: m.category,
      label: m.label,
      requiredParameters: m.parameters
        .filter((p) => !p.optional && p.defaultValue === undefined)
        .map((p) => `${p.key}(${p.label}, ${p.unit})`),
      optionalParameters: m.parameters
        .filter((p) => p.optional || p.defaultValue !== undefined)
        .map((p) => `${p.key}(${p.unit})`),
    }));

  return [
    "请先逐字转录上传照片中的可见文字、数值、单位与连线关系到 transcribedText，再输出严格 JSON。",
    "规则：",
    "1. 仅输出一个 JSON 对象，不要附加 markdown 代码块之外的闲聊文本。",
    "2. transcribedText 必须忠实记录照片中可见字符，禁止补全照片没写出的参数。",
    "3. 每个 extracted parameter 的 excerpt 必须是 transcribedText 中的连续原文片段，numeric value 必须与 excerpt 一致（例如 0.15×10⁻⁴ 写作 0.000015 与 unit='kg.m2'，或 0.15 与 unit='1e-4 kg.m2'）。",
    "4. 若照片中的部件（例如行星减速机、普通机械导轨、急停拍按钮等）无法映射到下方任一已注册行为模型，请令 modelRef 为 null，并在 uncoveredReason 说明原因。",
    "5. 型号字符串中若个别字符被遮挡/反光，请写“[未清晰]”，禁止输出 * ? □ … 通配符。",
    "6. 若照片体现整轴机械-传感-DI 接线关系或行程标注，请同时填写 systemSketch。",
    options?.focusModelRef ? `7. 优先关注绑定目标模型：${modelKey(options.focusModelRef)}。` : "",
    options?.userGoal ? `用户本次装配目标：${options.userGoal}` : "",
    "",
    "当前已注册可执行模型列表：",
    JSON.stringify(catalog, null, 2),
    "",
    "输出 JSON Schema 骨架：",
    JSON.stringify({
      sceneKind: "nameplate | wiring_sketch | cad_layout | mixed",
      transcribedText: "照片可见原文逐字转录",
      devices: [
        {
          deviceTypeLabel: "器件中文分类，如 伺服电机 / 伺服驱动器 / 滚珠丝杠",
          manufacturer: "品牌名（不可辨认则填 未知品牌）",
          model: "照片可见型号（禁止 * ? □）",
          serialNumber: "可选序列号（见于实物铭牌 S/N）",
          role: "drive | motor | screw | table | sensor | di | other",
          modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
          parameters: [
            {
              key: "ratedTorqueNm",
              value: 1.27,
              unit: "N.m",
              excerpt: "RATED TORQUE 1.27 N.m",
            },
          ],
          uncoveredReason: "照片未印出项的说明",
        },
      ],
      systemSketch: {
        name: "草图系统名称（可选，仅当照片含整轴接线/行程关系时填写）",
        targetMm: 120,
        cruiseVelocityMmS: 100,
        sensorTriggerMm: 115,
        triggerMode: "positive_overtravel",
        normallyClosed: true,
        wiringHint: "草图接线或控制关系说明",
      },
      notes: ["补充说明（可选）"],
    }, null, 2),
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\u2212/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractNumbersFromExcerpt(rawExcerpt: string): number[] {
  const text = rawExcerpt
    .normalize("NFKC")
    .replace(/\u2212/g, "-")
    .replace(/(?<=\d),(?=\d{3}\b)/g, "");
  const out: number[] = [];

  const sciRegex = /([+-]?\d+(?:\.\d+)?)\s*(?:[x*×]\s*10\s*\^?\s*([+-]?\d+)|[eE]([+-]?\d+))/g;
  for (const match of text.matchAll(sciRegex)) {
    const mantissa = Number(match[1]);
    const exp = Number(match[2] ?? match[3]);
    const computed = mantissa * 10 ** exp;
    if (Number.isFinite(computed)) out.push(computed);
  }

  const plainRegex = /(?<![a-zA-Z])[+-]?\d+(?:\.\d+)?/g;
  for (const match of text.matchAll(plainRegex)) {
    const num = Number(match[0]);
    if (Number.isFinite(num)) out.push(num);
  }
  return out;
}

function approxMatchesExcerpt(target: number, excerpt: string): boolean {
  const candidates = extractNumbersFromExcerpt(excerpt);
  return candidates.some(
    (num) => Math.abs(num - target) <= 1e-9 + 1e-6 * Math.max(Math.abs(num), Math.abs(target)),
  );
}

function sanitizeVisibleModelName(model: string, warnNotes: string[]): string {
  if (!/[*?□…]/u.test(model)) return model;
  warnNotes.push(`模型名称“${model}”包含未完整字符，已标记为“[待核]”以避免伪造完整选型码。`);
  return model.replace(/[*?□…]+/gu, "[待核]");
}

function pickUniquePackageRevision(existing: readonly DevicePackage[], candidate: DevicePackage): DevicePackage {
  const keyMap = new Map(existing.map((p) => [packageKey(p), p]));
  const initialKey = packageKey(candidate);
  const firstHit = keyMap.get(initialKey);
  if (!firstHit) return candidate;
  if (JSON.stringify(firstHit) === JSON.stringify(candidate)) return firstHit;

  for (let idx = 2; idx <= 32; idx++) {
    const next = parseDevicePackage({
      ...candidate,
      revision: `${candidate.revision}-v${idx}`,
    });
    const hit = keyMap.get(packageKey(next));
    if (!hit) return next;
    if (JSON.stringify(hit) === JSON.stringify(next)) return hit;
  }
  throw new Error(`设备“${candidate.model}”的拍照导入修订号发生冲突，请手动指定版本号。`);
}

function inferNumericBooleanValue(
  rawParam: RawVisionExtractedParam,
  expectedType: "number" | "boolean",
  expectedUnit: string,
  expectedDimension: RegisteredModel["parameters"][number]["dimension"],
): { value: number | boolean; unit: string } {
  if (expectedType === "boolean") {
    if (typeof rawParam.value === "boolean") return { value: rawParam.value, unit: "1" };
    if (typeof rawParam.value === "string") {
      const lowered = rawParam.value.trim().toLowerCase();
      if (["true", "yes", "1", "nc", "常闭"].includes(lowered)) return { value: true, unit: "1" };
      if (["false", "no", "0", "no(常开)", "常开"].includes(lowered)) return { value: false, unit: "1" };
    }
    throw new Error(`参数“${rawParam.key}”需要布尔值，当前值为 ${String(rawParam.value)}。`);
  }

  let numericVal: number;
  let numericUnit = rawParam.unit?.trim();
  if (typeof rawParam.value === "number") {
    numericVal = rawParam.value;
    if (!approxMatchesExcerpt(numericVal, rawParam.excerpt)) {
      throw new Error(
        `参数“${rawParam.key}”的提取值 ${numericVal} 未出现在引用原文“${rawParam.excerpt}”中，已拒绝猜测或编造数值。`,
      );
    }
  } else if (typeof rawParam.value === "string") {
    const parsed = parseQuantityText(rawParam.value);
    if (!parsed) {
      throw new Error(`参数“${rawParam.key}”的值“${rawParam.value}”无法解析为有效带单位物理量。`);
    }
    if (!approxMatchesExcerpt(parsed.value, rawParam.excerpt)) {
      throw new Error(
        `参数“${rawParam.key}”的解析值 ${parsed.value} 未出现在引用原文“${rawParam.excerpt}”中，已拒绝猜测或编造数值。`,
      );
    }
    numericVal = parsed.value;
    numericUnit = parsed.unit || numericUnit;
  } else {
    throw new Error(`参数“${rawParam.key}”期望数值类型。`);
  }

  const resolvedUnit = numericUnit ?? (expectedDimension === "dimensionless" ? "1" : undefined);
  if (!resolvedUnit) {
    throw new Error(`参数“${rawParam.key}”缺少物理单位（目标模型要求 ${expectedUnit} 量纲）。`);
  }
  if (!areUnitsCompatible(resolvedUnit, expectedUnit)) {
    throw new Error(`参数“${rawParam.key}”单位“${resolvedUnit}”与目标模型参数单位“${expectedUnit}”量纲不兼容。`);
  }
  return { value: numericVal, unit: resolvedUnit };
}

function buildPendingRoleDevice(
  role: "drive" | "motor" | "screw" | "table",
  sketchName: string,
): DevicePackage {
  const roleMeta: Record<
    "drive" | "motor" | "screw" | "table",
    {
      label: string;
      modelRef: ModelReference;
      bindingId: string;
      paramKey: string;
      paramLabel: string;
      unit: string;
    }
  > = {
    drive: {
      label: "待补全伺服驱动器（草图未写型号）",
      modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
      bindingId: "vision-pending-drive",
      paramKey: "driveRatedCurrentA",
      paramLabel: "连续输出额定电流",
      unit: "A",
    },
    motor: {
      label: "待补全伺服电机（草图未写型号）",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      bindingId: "vision-pending-motor",
      paramKey: "rotorInertiaKgM2",
      paramLabel: "转子转动惯量",
      unit: "kg.m2",
    },
    screw: {
      label: "待补全滚珠丝杠（草图未写导程）",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      bindingId: "vision-pending-screw",
      paramKey: "leadMmPerRev",
      paramLabel: "丝杠导程",
      unit: "mm/rev",
    },
    table: {
      label: "待补全工作台负载（草图未写质量）",
      modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
      bindingId: "vision-pending-table",
      paramKey: "massKg",
      paramLabel: "移动总质量",
      unit: "kg",
    },
  };
  const meta = roleMeta[role];
  const model = requireRegisteredModel(meta.modelRef, "拍照草图占位器件");
  const params: Record<string, DeviceParameterEntry> = {};
  const mappings: Array<{ kind: "parameter"; source: string; target: string }> = [];
  for (const spec of model.parameters) {
    if (spec.optional || spec.defaultValue !== undefined) continue;
    params[spec.key] = {
      status: "pending",
      unit: spec.unit,
      label: spec.label,
      reason: `手绘草图「${sketchName}」未标注${meta.label}的「${spec.label}」，请补全后解锁仿真。`,
    };
    mappings.push({ kind: "parameter", source: spec.key, target: spec.key });
  }
  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer: "草图占位",
    model: meta.label,
    revision: "photo-sketch-1",
    source: {
      kind: "local",
      url: "",
      title: `拍照草图待补全项：${sketchName}`,
      locator: "视觉导入占位",
      excerpt: sketchName,
    },
    ports: [],
    rules: [],
    parameters: params,
    modelBindings: [
      {
        id: meta.bindingId,
        modelRef: meta.modelRef,
        mappings,
      },
    ],
  });
}

function slugId(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

export function verifyAndApplyVisionIntake(
  baseWorkspace: TwinWorkspace,
  rawInput: unknown,
  options?: { sourceLabel?: string },
): VisionIntakeResult {
  const raw = rawVisionIntakeSchema.parse(rawInput);
  let ws = parseWorkspace(baseWorkspace);
  const normTranscript = normalizeForQuote(raw.transcribedText);
  const notes: string[] = [...(raw.notes ?? [])];
  const createdDevices: DevicePackage[] = [];
  const pendingItems: VisionPendingItem[] = [];
  const unmodeledRequests: VisionUnmodeledRequest[] = [];
  const byRole = new Map<RawVisionDevice["role"], DevicePackage[]>();
  const serialByPackageKey = new Map<string, string>();
  const sourceTitle = options?.sourceLabel?.trim() || "拍照/截图视觉识别导入";

  for (const dev of raw.devices) {
    for (const p of dev.parameters) {
      if (!normTranscript.includes(normalizeForQuote(p.excerpt))) {
        throw new Error(
          `参数“${p.key}”的原文片段“${p.excerpt}”未在照片转录文本中找到，系统已拒绝采信可能编造的数值。`,
        );
      }
    }

    if (dev.modelRef === null) {
      const reason =
        dev.uncoveredReason?.trim() ||
        `器件“${dev.manufacturer} ${dev.model}”（${dev.deviceTypeLabel}）尚未映射到当前已注册行为模型族，保留记录但不强行赋参。`;
      unmodeledRequests.push({
        deviceLabel: `${dev.manufacturer} ${dev.model}`,
        model: dev.model,
        role: dev.role,
        reason,
      });
      notes.push(reason);
      continue;
    }

    const registered = requireRegisteredModel(dev.modelRef, `照片设备“${dev.model}”`);
    const safeModel = sanitizeVisibleModelName(dev.model, notes);
    const paramsMap: Record<string, DeviceParameterEntry> = {};
    const mappings: Array<{ kind: "parameter"; source: string; target: string }> = [];
    const mappedKeys = new Set<string>();

    for (const rawParam of dev.parameters) {
      const spec = registered.parameters.find(
        (s) => s.key === rawParam.key || s.aliases?.includes(rawParam.key),
      );
      if (!spec) {
        notes.push(`已忽略与模型 ${registered.id} 无关的额外字段“${rawParam.key}”（原文：${rawParam.excerpt}）。`);
        continue;
      }
      if (mappedKeys.has(spec.key)) {
        throw new Error(`设备“${safeModel}”对参数“${spec.key}”提取了重复条目。`);
      }
      const checked = inferNumericBooleanValue(rawParam, spec.valueType ?? "number", spec.unit, spec.dimension);
      paramsMap[spec.key] = {
        status: "catalog",
        value: checked.value,
        unit: checked.unit,
        label: rawParam.label?.trim() || spec.label,
        locator: raw.sceneKind === "nameplate" ? "实物铭牌照片" : "工程图/草图照片",
        excerpt: rawParam.excerpt,
      };
      mappings.push({ kind: "parameter", source: spec.key, target: spec.key });
      mappedKeys.add(spec.key);
    }

    const pendingForThisDevice: VisionPendingItem[] = [];
    for (const spec of registered.parameters) {
      if (mappedKeys.has(spec.key)) continue;
      if (spec.optional || spec.defaultValue !== undefined) continue;
      const reason =
        dev.uncoveredReason?.trim() ||
        `照片中未清晰列出「${spec.label}」（${spec.key}），需对照样本手册或现场实测后补全。`;
      paramsMap[spec.key] = {
        status: "pending",
        unit: spec.unit,
        label: spec.label,
        reason,
      };
      mappings.push({ kind: "parameter", source: spec.key, target: spec.key });
      mappedKeys.add(spec.key);
      pendingForThisDevice.push({
        packageKey: "",
        deviceLabel: `${dev.manufacturer} ${safeModel}`,
        parameterKey: spec.key,
        label: spec.label,
        unit: spec.unit,
        reason,
      });
    }

    const binding: DeviceModelBinding = {
      id: `vision-${slugId(registered.category, "device")}`,
      modelRef: dev.modelRef,
      mappings,
    };

    const candidatePkg = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: dev.manufacturer,
      model: safeModel,
      revision: dev.revision?.trim() || "photo-1",
      source: {
        kind: "local",
        url: "",
        title: `${sourceTitle}（${dev.deviceTypeLabel}）`,
        locator: `场景=${raw.sceneKind}`,
        excerpt: dev.parameters[0]?.excerpt ?? raw.transcribedText.slice(0, 120),
      },
      ports: [],
      rules: [],
      parameters: paramsMap,
      modelBindings: [binding],
    });

    const installedPkg = pickUniquePackageRevision(ws.packages, candidatePkg);
    if (!ws.packages.some((p) => packageKey(p) === packageKey(installedPkg))) {
      ws = parseWorkspace({ ...ws, packages: [...ws.packages, installedPkg] });
    }
    const pkgId = packageKey(installedPkg);
    createdDevices.push(installedPkg);
    byRole.set(dev.role, [...(byRole.get(dev.role) ?? []), installedPkg]);
    if (dev.serialNumber?.trim()) {
      serialByPackageKey.set(pkgId, dev.serialNumber.trim());
    }
    for (const pending of pendingForThisDevice) {
      pendingItems.push({ ...pending, packageKey: pkgId });
    }
  }

  let createdSystem: TwinSystemAssembly | undefined;
  if (raw.systemSketch) {
    const sketch = raw.systemSketch;
    const ensureRolePkg = (role: "drive" | "motor" | "screw" | "table"): DevicePackage => {
      const fromPhoto = byRole.get(role)?.[0];
      if (fromPhoto) return fromPhoto;
      const modelIdByRole: Record<typeof role, string> = {
        drive: "Gouyuan.PositionDrive",
        motor: "Gouyuan.RatedTorqueMotor",
        screw: "Gouyuan.IdealLeadScrew",
        table: "Modelica.Mechanics.Translational.Components.Mass",
      };
      const existing = ws.packages.find((p) =>
        p.modelBindings?.some((b) => b.modelRef.id === modelIdByRole[role]),
      );
      if (existing) return existing;
      const placeholder = buildPendingRoleDevice(role, sketch.name);
      const stored = pickUniquePackageRevision(ws.packages, placeholder);
      if (!ws.packages.some((p) => packageKey(p) === packageKey(stored))) {
        ws = parseWorkspace({ ...ws, packages: [...ws.packages, stored] });
      }
      for (const [k, entry] of Object.entries(stored.parameters ?? {})) {
        if (entry.status === "pending") {
          pendingItems.push({
            packageKey: packageKey(stored),
            deviceLabel: `${stored.manufacturer} ${stored.model}`,
            parameterKey: k,
            label: entry.label ?? k,
            unit: entry.unit ?? "1",
            reason: entry.reason,
          });
        }
      }
      return stored;
    };

    const drivePkg = ensureRolePkg("drive");
    const motorPkg = ensureRolePkg("motor");
    const screwPkg = ensureRolePkg("screw");
    const tablePkg = ensureRolePkg("table");
    const sensorPkg = byRole.get("sensor")?.[0];
    const diPkg = byRole.get("di")?.[0];

    const existingSysIds = new Set((ws.systems ?? []).map((s) => s.id));
    let sysId = `vision-${slugId(sketch.name, "sketch")}`;
    let sysIdx = 2;
    while (existingSysIds.has(sysId)) {
      sysId = `vision-${slugId(sketch.name, "sketch")}-${sysIdx++}`;
    }

    const axisId = "axis_x";
    const ctrlId = "ctrl_x";
    const sensorId = "limit_pos";
    const diId = "di_00";

    const axes: [SystemAxisUnit, ...SystemAxisUnit[]] = [
      {
        id: axisId,
        name: `${sketch.name} 主轴`,
        direction: [1, 0, 0],
        originMm: [0, 0, 0],
        factor: 1,
        driveKey: packageKey(drivePkg),
        motorKey: packageKey(motorPkg),
        screwKey: packageKey(screwPkg),
        tableKey: packageKey(tablePkg),
        provenance: "inferred",
        note: sketch.wiringHint || "由上传照片草图结构推断",
      },
    ];

    const hasSensorTrigger = typeof sketch.sensorTriggerMm === "number" && Number.isFinite(sketch.sensorTriggerMm);
    const sensors: SystemLimitSensorNode[] = [
      {
        id: sensorId,
        name: sensorPkg ? `${sensorPkg.manufacturer} ${sensorPkg.model}` : "限位开关（草图识别）",
        ...(sensorPkg && { packageKey: packageKey(sensorPkg) }),
        axisId,
        ...(hasSensorTrigger ? { triggerPositionMm: sketch.sensorTriggerMm } : {}),
        senseDistanceMm: 4,
        triggerMode: sketch.triggerMode ?? "positive_overtravel",
        normallyClosed: sketch.normallyClosed ?? true,
        supplyVoltageV: 24,
        provenance: hasSensorTrigger ? "inferred" : "pending",
        note: hasSensorTrigger ? "触发位置来自草图标注" : "草图未写明限位开关触发坐标（mm）",
      },
    ];
    if (!hasSensorTrigger) {
      pendingItems.push({
        packageKey: packageKey(sensorPkg ?? drivePkg),
        deviceLabel: sensors[0].name,
        parameterKey: "triggerPositionMm",
        label: "限位触发安装坐标",
        unit: "mm",
        reason: "照片草图包含限位开关但未写明安装触发坐标 triggerPositionMm（mm）。",
      });
    }

    const diChannels: SystemDiChannelNode[] = [
      {
        id: diId,
        name: diPkg ? `${diPkg.manufacturer} ${diPkg.model} DI0` : "控制器数字量输入 DI0",
        ...(diPkg && { packageKey: packageKey(diPkg) }),
        onAboveV: 15,
        offBelowV: 5,
        filterMs: 10,
        provenance: diPkg ? "inferred" : "pending",
        note: diPkg ? "DI 阈值来自拍照设备包" : "草图未指明 DI 型号，暂按常规 24V 工业滞回初值占位",
      },
    ];

    const wires: SystemSignalWire[] = [
      {
        id: "wire_sensor_di",
        from: { kind: "sensor", nodeId: sensorId, portId: "voltageOut" },
        to: { kind: "di", nodeId: diId, portId: "voltageIn" },
        provenance: "inferred",
        note: sketch.wiringHint || "照片接线关系待现场核对",
      },
      {
        id: "wire_di_ctrl",
        from: { kind: "di", nodeId: diId, portId: "stateOut" },
        to: { kind: "controller", nodeId: ctrlId, portId: "posLimitIn" },
        invert: true,
        provenance: "inferred",
      },
    ];

    const serial = serialByPackageKey.get(packageKey(motorPkg)) ?? serialByPackageKey.get(packageKey(drivePkg));
    const draftSystem: TwinSystemAssembly = {
      schemaVersion: 1,
      kind: "system-twin-assembly",
      id: sysId,
      name: sketch.name,
      commStepMs: 1,
      durationMs: 2500,
      axes,
      sensors,
      diChannels,
      wires,
      controllers: [
        {
          id: ctrlId,
          axisId,
          mode: "move_with_limit_stop",
          targetMm: sketch.targetMm ?? 120,
          cruiseVelocityMmS: sketch.cruiseVelocityMmS ?? 100,
          initialPositionMm: 0,
          stopOnPosLimit: true,
          stopOnNegLimit: false,
          stopOnHome: false,
        },
      ],
      ...(serial
        ? {
            assetBindings: [
              {
                axisId,
                serialNumber: serial,
                assetTag: `PHOTO-${sysId}`,
                calibrationVersion: "photo-intake-1",
                note: "从实物铭牌照片 S/N 自动绑定资产编号",
              },
            ],
          }
        : {}),
    };
    ws = upsertTwinSystem(ws, draftSystem);
    createdSystem = draftSystem;
  }

  return {
    workspace: ws,
    createdDevices,
    ...(createdSystem && { createdSystem }),
    pendingItems,
    unmodeledRequests,
    notes,
  };
}

export interface VisionDemoPreset {
  readonly id: "nameplate-panasonic" | "sketch-closed-loop";
  readonly title: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly rawOutput: RawVisionIntake;
}

export const VISION_DEMO_PRESETS: readonly VisionDemoPreset[] = [
  {
    id: "nameplate-panasonic",
    title: "试玩 1：拍一张松下电机铭牌",
    subtitle: "功率/转矩/转速自动入库，铭牌未印出的转子惯量自动标为 pending 等待补全（不编造）",
    badge: "实物铭牌 → 部分参数入库 + 待补全门禁",
    rawOutput: {
      sceneKind: "nameplate",
      transcribedText:
        "Panasonic AC SERVO MOTOR  MODEL MSMF042L1V2M  S/N: PA24098812  400W  3000r/min  RATED TORQUE 1.27 N.m  CONT. CURRENT 2.6 A  IP65",
      devices: [
        {
          deviceTypeLabel: "交流伺服电机",
          manufacturer: "Panasonic",
          model: "MSMF042L1V2M",
          serialNumber: "PA24098812",
          role: "motor",
          modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
          parameters: [
            { key: "ratedPowerW", value: 400, unit: "W", excerpt: "400W" },
            { key: "ratedSpeedRpm", value: 3000, unit: "rpm", excerpt: "3000r/min" },
            { key: "ratedTorqueNm", value: 1.27, unit: "N.m", excerpt: "RATED TORQUE 1.27 N.m" },
            { key: "motorRatedCurrentA", value: 2.6, unit: "A", excerpt: "CONT. CURRENT 2.6 A" },
          ],
          uncoveredReason: "电机实物铭牌仅印刷了额定功率、转速、转矩与相电流，未印出转子转动惯量 rotorInertiaKgM2（kg.m2）。",
        },
      ],
      notes: ["已从铭牌 S/N PA24098812 记录资产序列号，待补全转子转动惯量后即可投入闭环轴仿真。"],
    },
  },
  {
    id: "sketch-closed-loop",
    title: "试玩 2：拍一张手绘机电控接线与行程草图",
    subtitle: "同时生成驱动+电机+丝杠+工作台+限位+DI 闭环草图；缺少触发坐标或惯量时在工作台内直接补全解锁",
    badge: "白板草图 → 一键装配系统工作台",
    rawOutput: {
      sceneKind: "wiring_sketch",
      transcribedText:
        "手绘X轴闭环测试台: 驱动 汇川 SV660N-2R8I 额定2.8A -> 电机 MS1H1-40B30CB 400W 3000rpm 1.27N.m -> 丝杠 SFU1610 导程10mm/rev -> 滑台负载 8kg; 目标行程 120mm 速度 100mm/s; 常闭限位 OMRON EE-SX670 (24V) 接 DI00(15V/5V/10ms) 接入 posLimitIn; 行星减速机 PG-10 (暂未建动力学模型)",
      devices: [
        {
          deviceTypeLabel: "伺服驱动器",
          manufacturer: "汇川",
          model: "SV660N-2R8I",
          role: "drive",
          modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
          parameters: [
            { key: "driveRatedCurrentA", value: 2.8, unit: "A", excerpt: "额定2.8A" },
          ],
        },
        {
          deviceTypeLabel: "永磁同步伺服电机",
          manufacturer: "汇川",
          model: "MS1H1-40B30CB",
          role: "motor",
          modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
          parameters: [
            { key: "ratedPowerW", value: 400, unit: "W", excerpt: "400W" },
            { key: "ratedSpeedRpm", value: 3000, unit: "rpm", excerpt: "3000rpm" },
            { key: "ratedTorqueNm", value: 1.27, unit: "N.m", excerpt: "1.27N.m" },
          ],
          uncoveredReason: "白板草图未抄录转子转动惯量 rotorInertiaKgM2（典型样本值为 0.000026 kg.m2），已标记为 pending。",
        },
        {
          deviceTypeLabel: "滚珠丝杠",
          manufacturer: "PMI",
          model: "SFU1610",
          role: "screw",
          modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
          parameters: [
            { key: "leadMmPerRev", value: 10, unit: "mm/rev", excerpt: "导程10mm/rev" },
          ],
        },
        {
          deviceTypeLabel: "平动滑台负载",
          manufacturer: "自制滑台",
          model: "X-STAGE-8KG",
          role: "table",
          modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
          parameters: [
            { key: "massKg", value: 8, unit: "kg", excerpt: "滑台负载 8kg" },
          ],
        },
        {
          deviceTypeLabel: "常闭槽型限位开关",
          manufacturer: "OMRON",
          model: "EE-SX670",
          role: "sensor",
          modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" },
          parameters: [
            { key: "supplyVoltageV", value: 24, unit: "V", excerpt: "(24V)" },
            { key: "normallyClosed", value: true, excerpt: "常闭限位" },
          ],
          uncoveredReason: "草图尚未标注限位安装触发坐标 triggerPositionMm（mm）。",
        },
        {
          deviceTypeLabel: "数字量输入通道",
          manufacturer: "汇川",
          model: "GL10-DI00",
          role: "di",
          modelRef: { id: "GouyuanSignal.DigitalInputChannel", version: "1.0.0" },
          parameters: [
            { key: "onAbove", value: 15, unit: "V", excerpt: "DI00(15V/5V/10ms)" },
            { key: "offBelow", value: 5, unit: "V", excerpt: "DI00(15V/5V/10ms)" },
            { key: "filterMs", value: 10, unit: "ms", excerpt: "DI00(15V/5V/10ms)" },
          ],
        },
        {
          deviceTypeLabel: "行星减速机",
          manufacturer: "未知品牌",
          model: "PG-10",
          role: "other",
          modelRef: null,
          parameters: [],
          uncoveredReason: "当前直驱丝杠闭环轴 Modelica 模型未包含减速机齿隙与传动比模块，保留记录但不强行赋参。",
        },
      ],
      systemSketch: {
        name: "白板手绘X轴闭环工作台",
        targetMm: 120,
        cruiseVelocityMmS: 100,
        normallyClosed: true,
        wiringHint: "EE-SX670 常闭接 DI00 -> posLimitIn（限位位置与转子惯量待工作台内补全）",
      },
      notes: ["已识别 1 个暂未建模部件 PG-10（归入未建模列表）；请在闭环工作台补全转子惯量与限位坐标后运行仿真。"],
    },
  },
];
