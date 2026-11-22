import { z } from "zod";
import { mechanicsSchema, signalIdSchema, type MechanicalFrame, type MechanicalPart } from "./mechanical-types";
import { factoryParameterIssues, factoryParametersSchema, getFactoryModel } from "./factory-model";
import { deviceCompositionSchema, factoryPartParametersSchema } from "./device-composition";
import { getRegisteredModel } from "./model-registry";
import { packageKey } from "./package-identity";
import { defaultPrimitiveMechanics, primitivePartSchema, type PrimitivePartSpec } from "./primitive-parts";
import { areUnitsCompatible, convertUnit, parseUnitSpec } from "./units";
export { signalIdSchema } from "./mechanical-types";
export { packageKey } from "./package-identity";
export { primitivePartSchema, type PrimitivePartSpec } from "./primitive-parts";

const text = (limit: number) => z.string().trim().min(1).max(limit);

const portSchema = z.strictObject({
  id: signalIdSchema, label: text(160), direction: z.enum(["input", "output"]),
  type: z.enum(["number", "boolean"]), unit: text(40).optional(),
});
const endpoints = { input: signalIdSchema, output: signalIdSchema };
const ruleSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("copy"), ...endpoints }),
  z.strictObject({ op: z.literal("linear"), ...endpoints, gain: z.number().finite(), offset: z.number().finite() }),
  z.strictObject({
    op: z.literal("digitalInput"), ...endpoints, onAbove: z.number().finite(), offBelow: z.number().finite(),
    filterMs: z.number().finite().nonnegative(),
  }),
]);

const positiveRating = z.number().finite().positive();
export const modelRefSchema = z.strictObject({ id: text(240), version: text(80) });
export type ModelReference = z.infer<typeof modelRefSchema>;
const partPath = z.array(signalIdSchema).min(1);
const physicalInterface = { fit: text(160), modelRef: modelRefSchema };
const motorPhysicsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stator"), ...physicalInterface }),
  z.strictObject({ kind: z.literal("rotor"), ...physicalInterface }),
  z.strictObject({ kind: z.literal("bearing"), ...physicalInterface }),
  z.strictObject({ kind: z.literal("motor"), ...physicalInterface, statorPath: partPath, rotorPath: partPath, bearingPath: partPath }),
]);
const axisPortSchema = z.strictObject({
  id: signalIdSchema, name: text(160), path: z.array(signalIdSchema), motorSlot: signalIdSchema, ...physicalInterface,
  leadMmPerRev: positiveRating, tableMassKg: positiveRating, driveVoltageLimitV: positiveRating,
  driveCurrentLimitA: positiveRating, driveSpeedLimitRpm: positiveRating, driveReferenceInertiaKgM2: positiveRating,
  currentGainOhm: positiveRating, source: text(2048),
});
export type MotorAxisPort = z.infer<typeof axisPortSchema>;
const finiteMm = z.number().finite();
const vector = z.tuple([finiteMm, finiteMm, finiteMm]);
const positiveVector = z.tuple([positiveRating, positiveRating, positiveRating]);
const contourSchema = z.strictObject({
  modelRef: modelRefSchema, axes: z.strictObject({ x: signalIdSchema, y: signalIdSchema, z: signalIdSchema }),
  minMm: vector, maxMm: vector, maxFeedMmMin: positiveVector, accelerationMmS2: positiveVector,
  workOriginMachineMm: vector, initialWorkMm: vector, source: text(2048), zBalance: z.literal("counterbalanced"),
}).superRefine((profile, ctx) => {
  if (new Set(Object.values(profile.axes)).size !== 3) ctx.addIssue({ code: "custom", path: ["axes"], message: "X、Y、Z 必须分别引用不同的轴端口。" });
  profile.minMm.forEach((low, i) => {
    const high = profile.maxMm[i], start = profile.workOriginMachineMm[i] + profile.initialWorkMm[i];
    if (low >= high || !Number.isFinite(start) || start < low || start > high)
      ctx.addIssue({ code: "custom", path: ["initialWorkMm", i], message: "请核对机床行程边界和工件零点，刀尖起点须位于行程内。" });
  });
});
export type ContourProfile = z.infer<typeof contourSchema>;
const feedSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lead-screw"), leadMmPerRev: positiveRating, modelRef: modelRefSchema }),
  z.strictObject({ kind: z.literal("moving-table"), massKg: positiveRating, modelRef: modelRefSchema }),
]);
const servoSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drive"), ratedCurrentA: positiveRating, peakCurrentA: positiveRating, modelRef: modelRefSchema.optional() }),
  z.strictObject({
    kind: z.literal("motor"), ratedPowerW: positiveRating, ratedTorqueNm: positiveRating, peakTorqueNm: positiveRating,
    ratedSpeedRpm: positiveRating, maxSpeedRpm: positiveRating, rotorInertiaKgM2: positiveRating,
    ratedCurrentA: positiveRating.optional(), compatibleDriveModels: z.array(text(160)).max(256), modelRef: modelRefSchema.optional(),
  }),
]);
const sourceUrl = text(2048).pipe(z.url({ protocol: /^https?$/ }));
const pointPair = z.tuple([z.number().finite(), z.number().finite()]);
const calibrationSchema = z.strictObject({ inputPoints: pointPair, outputPoints: pointPair });
const finiteNumber = z.number().finite();
const parameterValueSchema = z.union([finiteNumber, z.boolean(), text(240)]);
const pendingCandidateSchema = z.strictObject({
  option: text(160),
  value: parameterValueSchema,
  unit: text(40).optional(),
  locator: text(512).optional(),
  excerpt: text(4000).optional(),
});
const deviceParameterEntrySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["catalog", "measured", "derived", "assumed"]),
    value: parameterValueSchema,
    unit: text(40).optional(),
    label: text(160).optional(),
    condition: text(240).optional(),
    locator: text(512).optional(),
    excerpt: text(4000).optional(),
  }),
  z.strictObject({
    status: z.literal("pending"),
    reason: text(512),
    unit: text(40).optional(),
    label: text(160).optional(),
    candidates: z.array(pendingCandidateSchema).min(1).max(16).optional(),
  }),
]).superRefine((entry, ctx) => {
  if (entry.unit !== undefined && !parseUnitSpec(entry.unit)) {
    ctx.addIssue({ code: "custom", path: ["unit"], message: `未识别的物理单位“${entry.unit}”` });
  }
  if (entry.status !== "pending") {
    if (typeof entry.value === "number" && entry.unit !== undefined && !parseUnitSpec(entry.unit)) {
      ctx.addIssue({ code: "custom", path: ["unit"], message: `未识别的物理单位“${entry.unit}”` });
    }
    return;
  }
  entry.candidates?.forEach((candidate, idx) => {
    const unit = candidate.unit ?? entry.unit;
    if (typeof candidate.value === "number" && unit !== undefined && !parseUnitSpec(unit)) {
      ctx.addIssue({ code: "custom", path: ["candidates", idx, "unit"], message: `未识别的物理单位“${unit}”` });
    }
  });
});
const deviceParametersSchema = z.unknown()
  .refine(input => !input || typeof input !== "object" || !Object.hasOwn(input, "__proto__"), "设备参数表含有保留属性名。")
  .pipe(z.record(signalIdSchema, deviceParameterEntrySchema))
  .transform(record => Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])) as Record<string, z.output<typeof deviceParameterEntrySchema>>);
const parameterMappingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("parameter"),
    source: signalIdSchema,
    target: signalIdSchema,
    factor: finiteNumber.optional(),
    offset: finiteNumber.optional(),
    suppressUnitConversion: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("part"),
    partPath: z.array(signalIdSchema).min(1),
    source: signalIdSchema,
    target: signalIdSchema,
    factor: finiteNumber.optional(),
    offset: finiteNumber.optional(),
  }),
  z.strictObject({
    kind: z.literal("slot_quantity"),
    partPath: z.array(signalIdSchema).min(1),
    target: signalIdSchema,
    factor: finiteNumber.optional(),
    offset: finiteNumber.optional(),
  }),
]);
const modelBindingSchema = z.strictObject({
  id: signalIdSchema,
  modelRef: modelRefSchema,
  mappings: z.array(parameterMappingSchema).max(128),
  compatiblePeerModels: z.array(text(160)).max(256).optional(),
});
const packageSchema = z.strictObject({
  schemaVersion: z.literal(1), manufacturer: text(160), model: text(160), revision: text(160),
  source: z.strictObject({
    title: text(512), url: z.union([sourceUrl, z.literal("")]), locator: text(512), excerpt: text(16_000),
    productUrl: sourceUrl.optional(), kind: z.literal("local").optional(),
  }).refine(source => source.kind === "local" ? !source.url && !source.productUrl : Boolean(source.url),
    "本地资料请标为 local 并留空链接，在线资料须提供 HTTP 或 HTTPS 来源链接"),
  ports: z.array(portSchema).max(256), rules: z.array(ruleSchema).max(128), servo: servoSchema.optional(), feed: feedSchema.optional(),
  factory: z.strictObject({ modelRef: modelRefSchema, parameters: factoryParametersSchema, partParameters: factoryPartParametersSchema.optional() }).optional(),
  calibration: calibrationSchema.optional(), mechanics: mechanicsSchema.optional(),
  primitive: primitivePartSchema.optional(),
  composition: deviceCompositionSchema.optional(),
  motorPhysics: motorPhysicsSchema.optional(),
  axisPorts: z.array(axisPortSchema).refine(ports => new Set(ports.map(p => p.id)).size === ports.length, "同一设备的调试轴标识不能重复。").optional(),
  contour: contourSchema.optional(),
  parameters: deviceParametersSchema.optional(),
  modelBindings: z.array(modelBindingSchema).max(32).optional(),
});

export type SignalPort = z.infer<typeof portSchema>;
export type DeviceRule = z.infer<typeof ruleSchema>;
export type DevicePackage = z.infer<typeof packageSchema>;
export type ServoDrive = Extract<z.infer<typeof servoSchema>, { kind: "drive" }>;
export type ServoMotor = Extract<z.infer<typeof servoSchema>, { kind: "motor" }>;
export type DeviceParameterEntry = z.infer<typeof deviceParameterEntrySchema>;
export type PendingParameterCandidate = z.infer<typeof pendingCandidateSchema>;
export type ParameterMapping = z.infer<typeof parameterMappingSchema>;
export type DeviceModelBinding = z.infer<typeof modelBindingSchema>;

export function linearCoefficients({ inputPoints: [x1, x2], outputPoints: [y1, y2] }: z.infer<typeof calibrationSchema>) {
  if (x1 === x2) throw new Error("两组标定的输入值必须不同。");
  const dx = x2 - x1, dy = y2 - y1;
  const gain = dy / dx, offset = y1 - gain * x1;
  if (![dx, dy, gain, offset].every(Number.isFinite) || (dy !== 0 && gain === 0)) throw new Error("标定值超出可计算范围。");
  return { gain, offset };
}

export function readTwinData<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value, { error: z.locales.zhCN().localeError });
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`${label}格式有误（${issue.path.map(String).join(".") || "根节点"}）${issue.message}`);
}

export function parseDevicePackage(value: unknown): DevicePackage {
  const model = value && typeof value === "object" && "mechanics" in value && "model" in value && typeof value.model === "string" ? value.model.trim().slice(0, 160) : "";
  const pkg = readTwinData(packageSchema, value, model ? `设备包“${model}”` : "设备包");
  if (pkg.contour && Object.values(pkg.contour.axes).some(id => !pkg.axisPorts?.some(port => port.id === id))) {
    throw new Error(`设备包“${pkg.model}”的三轴轮廓定义引用了未声明的轴端口。`);
  }
  if (pkg.composition && pkg.mechanics?.kind === "assembly") {
    throw new Error(`设备包“${pkg.model}”已用机械装配节点声明组成，请通过安装点装配维护该层结构。`);
  }
  if (pkg.composition?.kind === "assembly" && pkg.composition.parts.some(p => p.packageKey === packageKey(pkg))) {
    throw new Error(`设备包“${pkg.model}”的子件直接引用本修订，会形成循环。`);
  }
  if (pkg.factory) {
    if (pkg.ports.length || pkg.rules.length) throw new Error("工厂设备使用工艺工位或搬运接口，请将信号端口和规则留空。");
    const template = getFactoryModel(pkg.factory.modelRef);
    for (const name of Object.keys(pkg.factory.partParameters ?? {})) {
      if (Object.hasOwn(pkg.factory.parameters, name)) throw new Error(`设备包“${pkg.model}”的工厂参数 ${name} 不能同时声明字面值和部件来源。`);
      if (template && !template.parameters.some(p => p.key === name)) throw new Error(`模型 ${template.id} 未声明工厂参数 ${name}。`);
    }
    if (template) {
      const issues = factoryParameterIssues(template, pkg.factory.parameters, false);
      if (issues.length) throw new Error(`设备包“${pkg.model}”的工厂模型参数有误。\n${issues.join("\n")}`);
    }
  }
  if (pkg.feed && pkg.servo) throw new Error("设备修订只能声明一种轴角色，请分别提供伺服设备包和进给部件包。");
  if (pkg.feed && (pkg.ports.length || pkg.rules.length)) throw new Error("进给部件通过机械接口连接，请将信号端口和规则留空。");
  if (pkg.calibration) {
    const { gain, offset } = linearCoefficients(pkg.calibration);
    const [rule] = pkg.rules;
    const agrees = (actual: number, expected: number) => Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected));
    if (pkg.rules.length !== 1 || rule?.op !== "linear" || !agrees(rule.gain, gain) || !agrees(rule.offset, offset)) {
      throw new Error("设备包的线性规则与记录的两点标定不相符。");
    }
  }
  if (pkg.modelBindings?.length) {
    const seenBindings = new Set<string>();
    for (const binding of pkg.modelBindings) {
      if (seenBindings.has(binding.id)) throw new Error(`设备包“${pkg.model}”的模型绑定标识 ${binding.id} 重复。`);
      seenBindings.add(binding.id);
      if (binding.compatiblePeerModels?.some((peer) => /[*?□…]/u.test(peer))) {
        throw new Error("配套驱动型号必须写完整");
      }
      const registered = getRegisteredModel(binding.modelRef);
      if (!registered) continue;
      if ((registered.category === "servo_drive" || registered.category === "servo_motor") && /[*?□…]/u.test(pkg.model)) {
        throw new Error("伺服设备需要完整型号");
      }
      const mappedTargets = new Set<string>();
      const numericValues: Record<string, number> = {};
      for (const mapping of binding.mappings) {
        const paramSpec = registered.parameters.find(
          (p) => p.key === mapping.target || p.aliases?.includes(mapping.target),
        );
        if (!paramSpec) {
          throw new Error(`模型 ${registered.id} @ ${registered.version} 未声明参数 ${mapping.target}。`);
        }
        if (mappedTargets.has(paramSpec.key)) {
          throw new Error(`模型绑定“${binding.id}”对参数 ${paramSpec.key} 存在重复映射。`);
        }
        mappedTargets.add(paramSpec.key);
        if (mapping.kind !== "parameter") continue;
        const entry = pkg.parameters?.[mapping.source];
        if (!entry) continue;
        const suppress = mapping.suppressUnitConversion === true;
        if (entry.unit !== undefined && !suppress && !areUnitsCompatible(entry.unit, paramSpec.unit)) {
          throw new Error(`参数 ${mapping.source} 的单位“${entry.unit}”与模型参数 ${paramSpec.key}（${paramSpec.unit}）量纲不兼容。`);
        }
        if (entry.status === "pending") {
          for (const candidate of entry.candidates ?? []) {
            const candidateUnit = candidate.unit ?? entry.unit;
            if (candidateUnit !== undefined && !suppress && !areUnitsCompatible(candidateUnit, paramSpec.unit)) {
              throw new Error(`参数 ${mapping.source} 候选值“${candidate.option}”的单位“${candidateUnit}”与模型参数 ${paramSpec.key}（${paramSpec.unit}）量纲不兼容。`);
            }
          }
          continue;
        }
        if (typeof entry.value === "number") {
          const base = suppress
            ? entry.value
            : entry.unit !== undefined
              ? convertUnit(entry.value, entry.unit, paramSpec.unit)
              : paramSpec.dimension === "dimensionless"
                ? entry.value
                : undefined;
          if (base !== undefined) {
            numericValues[paramSpec.key] = (mapping.factor ?? 1) * base + (mapping.offset ?? 0);
          }
        }
      }
      if (registered.category === "servo_drive") {
        if (numericValues.drivePeakCurrentA !== undefined && numericValues.driveRatedCurrentA !== undefined
          && numericValues.drivePeakCurrentA < numericValues.driveRatedCurrentA) {
          throw new Error("驱动器峰值电流不能低于额定电流");
        }
      }
      if (registered.category === "servo_motor") {
        if (numericValues.peakTorqueNm !== undefined && numericValues.ratedTorqueNm !== undefined
          && numericValues.peakTorqueNm < numericValues.ratedTorqueNm) {
          throw new Error("电机峰值转矩不能低于额定转矩");
        }
        if (numericValues.maxSpeedRpm !== undefined && numericValues.ratedSpeedRpm !== undefined
          && numericValues.maxSpeedRpm < numericValues.ratedSpeedRpm) {
          throw new Error("电机最高转速不能低于额定转速");
        }
      }
    }
  }
  if (pkg.servo) {
    if (pkg.ports.length || pkg.rules.length) throw new Error("伺服设备使用轴装配模型，请将信号端口和规则留空");
    const servo = pkg.servo;
    if (servo.kind === "drive" && servo.peakCurrentA < servo.ratedCurrentA) throw new Error("驱动器峰值电流不能低于额定电流");
    if (servo.kind === "motor") {
      if (servo.peakTorqueNm < servo.ratedTorqueNm) throw new Error("电机峰值转矩不能低于额定转矩");
      if (servo.maxSpeedRpm < servo.ratedSpeedRpm) throw new Error("电机最高转速不能低于额定转速");
      if (servo.compatibleDriveModels.some((model) => /[*?□…]/u.test(model))) throw new Error("配套驱动型号必须写完整");
    }
    if (/[*?□…]/u.test(pkg.model)) throw new Error("伺服设备需要完整型号");
    return pkg;
  }
  if (pkg.ports.length === 0 && !pkg.mechanics && !pkg.primitive && !pkg.feed && !pkg.factory && !pkg.composition && !pkg.motorPhysics && !pkg.axisPorts?.length && !pkg.modelBindings?.length) throw new Error("信号设备至少需要一个端口");
  const ports = new Map(pkg.ports.map((port) => [port.id, port]));
  if (ports.size !== pkg.ports.length) throw new Error("设备包内的端口标识必须唯一");
  for (const port of pkg.ports) {
    if (port.type === "boolean" && port.unit) throw new Error(`布尔端口 ${port.id} 不能带有物理单位`);
  }

  const driven = new Set<string>();
  for (const rule of pkg.rules) {
    const input = ports.get(rule.input), output = ports.get(rule.output);
    if (input?.direction !== "input" || output?.direction !== "output") {
      throw new Error(`规则 ${rule.input} → ${rule.output} 必须引用已声明的输入和输出端口`);
    }
    if (driven.has(output.id)) throw new Error(`输出端口 ${output.id} 只能有一条规则`);
    driven.add(output.id);
    if (rule.op === "copy" && (input.type !== output.type || input.unit !== output.unit)) {
      throw new Error(`复制规则 ${output.id} 的输入输出类型与单位必须相同`);
    }
    if (rule.op === "linear" && (input.type !== "number" || output.type !== "number")) {
      throw new Error(`线性规则 ${output.id} 需要数值输入和数值输出`);
    }
    if (rule.op === "digitalInput" && (input.type !== "number" || input.unit !== "V" || output.type !== "boolean" || rule.onAbove <= rule.offBelow)) {
      throw new Error(`数字输入规则 ${output.id} 需要单位为 V 的数值输入和布尔输出，接通阈值须大于断开阈值`);
    }
  }
  for (const port of pkg.ports) {
    if (port.direction === "output" && !driven.has(port.id)) throw new Error(`输出端口 ${port.id} 缺少行为规则`);
  }
  return pkg;
}

export type PrimitiveBehaviorPreset =
  | { kind: "lead_screw"; leadMmPerRev?: number }
  | {
      kind: "servo_motor";
      ratedPowerW: number;
      ratedTorqueNm: number;
      ratedSpeedRpm: number;
      rotorInertiaKgM2: number;
      motorRatedCurrentA?: number;
    }
  | { kind: "moving_table"; massKg: number };

export interface BuildPrimitivePartPackageOptions {
  manufacturer?: string;
  model: string;
  revision?: string;
  title?: string;
  locator?: string;
  excerpt?: string;
  primitive: PrimitivePartSpec;
  joint?: MechanicalPart["joint"];
  input?: MechanicalFrame;
  extraOutputs?: MechanicalPart["outputs"];
  behavior?: PrimitiveBehaviorPreset;
}

export function buildPrimitivePartPackage(options: BuildPrimitivePartPackageOptions): DevicePackage {
  const mechanics = defaultPrimitiveMechanics(options.primitive, {
    joint: options.joint,
    input: options.input,
    extraOutputs: options.extraOutputs,
  });

  const parameters: Record<string, DeviceParameterEntry> = {};
  const modelBindings: DeviceModelBinding[] = [];

  if (options.behavior?.kind === "lead_screw") {
    const lead = options.behavior.leadMmPerRev ?? (options.primitive.shape === "lead_screw" ? options.primitive.leadMm : 10);
    parameters.leadMmPerRev = { status: "catalog", value: lead, unit: "mm/rev", label: "丝杠导程" };
    modelBindings.push({
      id: "primitive-lead-screw",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      mappings: [{ kind: "parameter", source: "leadMmPerRev", target: "leadMmPerRev" }],
    });
  } else if (options.behavior?.kind === "moving_table") {
    parameters.massKg = { status: "catalog", value: options.behavior.massKg, unit: "kg", label: "移动总质量" };
    modelBindings.push({
      id: "primitive-moving-table",
      modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
      mappings: [{ kind: "parameter", source: "massKg", target: "massKg" }],
    });
  } else if (options.behavior?.kind === "servo_motor") {
    const b = options.behavior;
    parameters.ratedPowerW = { status: "catalog", value: b.ratedPowerW, unit: "W", label: "额定功率" };
    parameters.ratedTorqueNm = { status: "catalog", value: b.ratedTorqueNm, unit: "N.m", label: "额定转矩" };
    parameters.ratedSpeedRpm = { status: "catalog", value: b.ratedSpeedRpm, unit: "rpm", label: "额定转速" };
    parameters.rotorInertiaKgM2 = { status: "catalog", value: b.rotorInertiaKgM2, unit: "kg.m2", label: "转子转动惯量" };
    if (b.motorRatedCurrentA !== undefined) {
      parameters.motorRatedCurrentA = { status: "catalog", value: b.motorRatedCurrentA, unit: "A", label: "额定相电流" };
    }
    modelBindings.push({
      id: "primitive-servo-motor",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings: Object.keys(parameters).map((key) => ({ kind: "parameter" as const, source: key, target: key })),
    });
  }

  const label = options.title?.trim() || `${options.model}（参数化基本件）`;
  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer: options.manufacturer?.trim() || "基本件库",
    model: options.model.trim(),
    revision: options.revision?.trim() || "P1",
    source: {
      kind: "local",
      url: "",
      title: label,
      locator: options.locator?.trim() || "参数化三维基本件",
      excerpt: options.excerpt?.trim() || label,
    },
    ports: [],
    rules: [],
    primitive: options.primitive,
    mechanics,
    ...(Object.keys(parameters).length > 0 && { parameters }),
    ...(modelBindings.length > 0 && { modelBindings }),
  });
}
