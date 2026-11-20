import { getDeviceParts } from "./device-composition";
import {
  MODEL_REGISTRY,
  getRegisteredModel,
  requireRegisteredModel,
  type ModelParameterSpec,
  type ProblemTier,
  type RegisteredModel,
} from "./model-registry";
import {
  packageKey,
  parseDevicePackage,
  type DeviceModelBinding,
  type DevicePackage,
  type DeviceParameterEntry,
  type ModelReference,
  type PendingParameterCandidate,
  type ServoDrive,
  type ServoMotor,
} from "./twin-device";
import { applyLinearTransform, convertUnit } from "./units";

export interface ResolvedParameterValue {
  readonly key: string;
  readonly value: number | boolean;
  readonly unit: string;
  readonly sourceStatus: "catalog" | "measured" | "derived" | "assumed" | "default" | "peer_fallback";
  readonly sourceValue?: number | boolean | string;
  readonly sourceUnit?: string;
  readonly locator?: string;
  readonly excerpt?: string;
  readonly condition?: string;
  readonly partPackageKey?: string;
  readonly partPath?: readonly string[];
}

export interface PendingParameterIssue {
  readonly key: string;
  readonly sourceKey: string;
  readonly label: string;
  readonly modelUnit: string;
  readonly reason: string;
  readonly candidates: readonly (PendingParameterCandidate & { readonly convertedValue?: number })[];
}

export interface MissingParameterIssue {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly affectedTier: ProblemTier;
  readonly reason: string;
}

export type ReadinessStatus =
  | "ready"
  | "ready_with_assumptions"
  | "pending"
  | "incomplete"
  | "uninstalled_model";

export interface BindingReadiness {
  readonly bindingId: string;
  readonly modelRef: ModelReference;
  readonly model?: RegisteredModel;
  readonly status: ReadinessStatus;
  readonly values: Record<string, number | boolean>;
  readonly resolved: Record<string, ResolvedParameterValue>;
  readonly pendingParameters: readonly PendingParameterIssue[];
  readonly missingParameters: readonly MissingParameterIssue[];
  readonly issues: readonly string[];
}

export interface DeviceCapabilitySummary {
  readonly bindingId: string;
  readonly modelRef: ModelReference;
  readonly modelLabel: string;
  readonly tier: ProblemTier;
  readonly status: ReadinessStatus;
  readonly available: boolean;
  readonly pendingParameters: readonly PendingParameterIssue[];
  readonly missingParameters: readonly MissingParameterIssue[];
  readonly issues: readonly string[];
}

export interface DeviceCapabilitiesReport {
  readonly geometryAvailable: boolean;
  readonly capabilities: readonly DeviceCapabilitySummary[];
  readonly availableTiers: readonly ProblemTier[];
  readonly blockedReasons: readonly string[];
}

function refKey(ref: ModelReference): string {
  return `${ref.id}@${ref.version}`;
}

function legacyEntry(
  value: number | boolean,
  unit: string | undefined,
  label: string,
  locator: string,
): DeviceParameterEntry {
  return { status: "catalog", value, ...(unit !== undefined && { unit }), label, locator };
}

/** 从传统专用字段无损合成参数字典（显式 pkg.parameters 同名键始终优先）。 */
function synthesizeLegacyParameters(pkg: DevicePackage): Record<string, DeviceParameterEntry> {
  const out: Record<string, DeviceParameterEntry> = {};
  const loc = pkg.source.locator;
  if (pkg.servo?.kind === "drive") {
    out.driveRatedCurrentA = legacyEntry(pkg.servo.ratedCurrentA, "A", "连续输出额定电流", loc);
    out.drivePeakCurrentA = legacyEntry(pkg.servo.peakCurrentA, "A", "最大瞬时输出电流", loc);
  } else if (pkg.servo?.kind === "motor") {
    out.rotorInertiaKgM2 = legacyEntry(pkg.servo.rotorInertiaKgM2, "kg.m2", "转子转动惯量", loc);
    out.ratedTorqueNm = legacyEntry(pkg.servo.ratedTorqueNm, "N.m", "额定输出转矩", loc);
    out.peakTorqueNm = legacyEntry(pkg.servo.peakTorqueNm, "N.m", "瞬时峰值转矩", loc);
    out.ratedPowerW = legacyEntry(pkg.servo.ratedPowerW, "W", "额定输出功率", loc);
    out.ratedSpeedRpm = legacyEntry(pkg.servo.ratedSpeedRpm, "rpm", "额定转速", loc);
    out.maxSpeedRpm = legacyEntry(pkg.servo.maxSpeedRpm, "rpm", "最高允许转速", loc);
    if (pkg.servo.ratedCurrentA !== undefined) {
      out.motorRatedCurrentA = legacyEntry(pkg.servo.ratedCurrentA, "A", "额定相电流", loc);
    }
  }
  if (pkg.feed?.kind === "lead-screw") {
    out.leadMmPerRev = legacyEntry(pkg.feed.leadMmPerRev, "mm/rev", "丝杠导程", loc);
  } else if (pkg.feed?.kind === "moving-table") {
    out.massKg = legacyEntry(pkg.feed.massKg, "kg", "移动总质量", loc);
  }
  if (pkg.factory) {
    for (const [key, value] of Object.entries(pkg.factory.parameters)) {
      const spec = getRegisteredModel(pkg.factory.modelRef)?.parameters.find((p) => p.key === key);
      out[key] = legacyEntry(value, spec?.unit, spec?.label ?? key, loc);
    }
  }
  if (pkg.composition?.ratings) {
    for (const [key, rating] of Object.entries(pkg.composition.ratings)) {
      out[key] = legacyEntry(rating.value, rating.unit, rating.label, loc);
    }
  }
  for (const rule of pkg.rules) {
    if (rule.op === "digitalInput") {
      out.onAbove = legacyEntry(rule.onAbove, "V", "导通高电平阈值", loc);
      out.offBelow = legacyEntry(rule.offBelow, "V", "关断低电平阈值", loc);
      out.filterMs = legacyEntry(rule.filterMs, "ms", "输入防抖滤波时间", loc);
      break;
    }
  }
  return { ...out, ...pkg.parameters };
}

function synthesizeLegacyBindings(pkg: DevicePackage): DeviceModelBinding[] {
  const bindings: DeviceModelBinding[] = [];
  if (pkg.servo?.kind === "drive") {
    bindings.push({
      id: "legacy-servo-drive",
      modelRef: pkg.servo.modelRef ?? { id: "Gouyuan.PositionDrive", version: "1.0.0" },
      mappings: [
        { kind: "parameter", source: "driveRatedCurrentA", target: "driveRatedCurrentA" },
        { kind: "parameter", source: "drivePeakCurrentA", target: "drivePeakCurrentA" },
      ],
    });
  } else if (pkg.servo?.kind === "motor") {
    const mappings: DeviceModelBinding["mappings"] = [
      { kind: "parameter", source: "rotorInertiaKgM2", target: "rotorInertiaKgM2" },
      { kind: "parameter", source: "ratedTorqueNm", target: "ratedTorqueNm" },
      { kind: "parameter", source: "peakTorqueNm", target: "peakTorqueNm" },
      { kind: "parameter", source: "ratedPowerW", target: "ratedPowerW" },
      { kind: "parameter", source: "ratedSpeedRpm", target: "ratedSpeedRpm" },
      { kind: "parameter", source: "maxSpeedRpm", target: "maxSpeedRpm" },
    ];
    if (pkg.servo.ratedCurrentA !== undefined) {
      mappings.push({ kind: "parameter", source: "motorRatedCurrentA", target: "motorRatedCurrentA" });
    }
    bindings.push({
      id: "legacy-servo-motor",
      modelRef: pkg.servo.modelRef ?? { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings,
      compatiblePeerModels: [...pkg.servo.compatibleDriveModels],
    });
  }
  if (pkg.feed?.kind === "lead-screw") {
    bindings.push({
      id: "legacy-feed-screw",
      modelRef: pkg.feed.modelRef,
      mappings: [{ kind: "parameter", source: "leadMmPerRev", target: "leadMmPerRev" }],
    });
  } else if (pkg.feed?.kind === "moving-table") {
    bindings.push({
      id: "legacy-feed-table",
      modelRef: pkg.feed.modelRef,
      mappings: [{ kind: "parameter", source: "massKg", target: "massKg" }],
    });
  }
  if (pkg.motorPhysics) {
    if (pkg.motorPhysics.kind === "motor") {
      const { statorPath, rotorPath, bearingPath } = pkg.motorPhysics;
      bindings.push({
        id: "legacy-motor-assembly",
        modelRef: pkg.motorPhysics.modelRef,
        mappings: [
          { kind: "part", partPath: statorPath, source: "phaseResistanceOhm", target: "phaseResistanceOhm" },
          { kind: "part", partPath: statorPath, source: "qInductanceH", target: "qInductanceH" },
          { kind: "part", partPath: statorPath, source: "windingTurns", target: "windingTurns" },
          { kind: "part", partPath: statorPath, source: "windingFactor", target: "windingFactor" },
          { kind: "part", partPath: statorPath, source: "windingCurrentLimitA", target: "windingCurrentLimitA" },
          { kind: "part", partPath: statorPath, source: "polePairs", target: "polePairs" },
          { kind: "part", partPath: rotorPath, source: "rotorFluxWb", target: "rotorFluxWb" },
          { kind: "part", partPath: rotorPath, source: "rotorInertiaKgM2", target: "rotorInertiaKgM2" },
          { kind: "part", partPath: bearingPath, source: "bearingViscousNmS", target: "bearingViscousNmS" },
          { kind: "slot_quantity", partPath: bearingPath, target: "bearingCount" },
        ],
      });
    } else {
      const model = getRegisteredModel(pkg.motorPhysics.modelRef);
      bindings.push({
        id: `legacy-motor-${pkg.motorPhysics.kind}`,
        modelRef: pkg.motorPhysics.modelRef,
        mappings: (model?.parameters ?? Object.keys(pkg.composition?.ratings ?? {}).map((key) => ({ key }))).map((p) => ({
          kind: "parameter" as const,
          source: p.key,
          target: p.key,
        })),
      });
    }
  }
  if (pkg.factory) {
    const mappings: DeviceModelBinding["mappings"] = [
      ...Object.keys(pkg.factory.parameters).map((key) => ({
        kind: "parameter" as const,
        source: key,
        target: key,
      })),
      ...Object.entries(pkg.factory.partParameters ?? {}).map(([key, ref]) => ({
        kind: "part" as const,
        partPath: ref.path,
        source: ref.rating,
        target: key,
      })),
    ];
    bindings.push({
      id: "legacy-factory",
      modelRef: pkg.factory.modelRef,
      mappings,
    });
  }
  for (const rule of pkg.rules) {
    if (rule.op === "digitalInput") {
      bindings.push({
        id: `legacy-di-${rule.output}`,
        modelRef: { id: "GouyuanSignal.DigitalInputChannel", version: "1.0.0" },
        mappings: [
          { kind: "parameter", source: "onAbove", target: "onAbove" },
          { kind: "parameter", source: "offBelow", target: "offBelow" },
          { kind: "parameter", source: "filterMs", target: "filterMs" },
        ],
      });
      break;
    }
  }
  return bindings;
}

/** 返回设备全部有效模型绑定：显式 modelBindings 优先，并保留对传统专用字段的零损投影。 */
export function effectiveModelBindings(pkg: DevicePackage): DeviceModelBinding[] {
  const explicit = pkg.modelBindings ?? [];
  const seenRefs = new Set(explicit.map((b) => refKey(b.modelRef)));
  const legacy = synthesizeLegacyBindings(pkg).filter((b) => !seenRefs.has(refKey(b.modelRef)));
  return [...explicit, ...legacy];
}

function resolvePartAlongPath(
  pkg: DevicePackage,
  partPath: readonly string[],
  workspacePackages?: readonly DevicePackage[],
): { part: DevicePackage; partKey: string; quantity: number } | { error: string } {
  const catalog = new Map((workspacePackages ?? []).map((p) => [packageKey(p), p]));
  let current: DevicePackage = pkg;
  let quantity = 1;
  for (const slotId of partPath) {
    const slot = getDeviceParts(current).find((part) => part.id === slotId);
    if (!slot) return { error: `找不到子件槽位路径“${partPath.join(" / ")}”。` };
    quantity *= slot.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return { error: `槽位路径“${partPath.join(" / ")}”的数量超出可表示范围。` };
    }
    const child = catalog.get(slot.packageKey);
    if (!child) return { error: `缺少槽位“${slotId}”引用的子件设备包（${slot.packageKey}）。` };
    current = child;
  }
  return { part: current, partKey: packageKey(current), quantity };
}

function validateNumericBounds(spec: ModelParameterSpec, value: number): string | undefined {
  if (!Number.isFinite(value)) return `${spec.label}（${spec.key}）必须是有限数值。`;
  if (spec.positive && !(value > 0)) return `${spec.label}（${spec.key}，${spec.unit}）必须大于 0。`;
  if (spec.min !== undefined && value < spec.min) return `${spec.label}（${spec.key}）不能小于 ${spec.min} ${spec.unit}。`;
  if (spec.max !== undefined && value > spec.max) return `${spec.label}（${spec.key}）不能大于 ${spec.max} ${spec.unit}。`;
  if (spec.integer && !Number.isSafeInteger(value)) return `${spec.label}（${spec.key}）必须为整数。`;
  return undefined;
}

function findBinding(
  pkg: DevicePackage,
  target: string | ModelReference,
): DeviceModelBinding | undefined {
  const bindings = effectiveModelBindings(pkg);
  if (typeof target === "string") {
    return bindings.find((b) => b.id === target);
  }
  return bindings.find((b) => b.modelRef.id === target.id && b.modelRef.version === target.version);
}

export function evaluateBindingReadiness(
  pkg: DevicePackage,
  target: string | ModelReference,
  options?: { workspacePackages?: readonly DevicePackage[]; peerValues?: Record<string, number> },
): BindingReadiness {
  const binding = findBinding(pkg, target);
  if (!binding) {
    const ref: ModelReference = typeof target === "string" ? { id: target, version: "unknown" } : target;
    const model = typeof target === "string" ? undefined : getRegisteredModel(target);
    return {
      bindingId: typeof target === "string" ? target : target.id,
      modelRef: ref,
      model,
      status: "incomplete",
      values: {},
      resolved: {},
      pendingParameters: [],
      missingParameters: [],
      issues: [`设备“${pkg.model}”未绑定所需模型 ${ref.id} @ ${ref.version}。`],
    };
  }

  const model = getRegisteredModel(binding.modelRef);
  if (!model) {
    const message = `设备“${pkg.model}”引用的模型 ${binding.modelRef.id} @ ${binding.modelRef.version} 在当前模型注册表中不可用。`;
    return {
      bindingId: binding.id,
      modelRef: binding.modelRef,
      status: "uninstalled_model",
      values: {},
      resolved: {},
      pendingParameters: [],
      missingParameters: [],
      issues: [message],
    };
  }

  const paramsMap = synthesizeLegacyParameters(pkg);
  const values: Record<string, number | boolean> = {};
  const resolved: Record<string, ResolvedParameterValue> = {};
  const pendingParameters: PendingParameterIssue[] = [];
  const missingParameters: MissingParameterIssue[] = [];
  const issues: string[] = [];
  const tier = model.simPurpose.tier;

  function findMapping(spec: ModelParameterSpec) {
    return binding!.mappings.find((m) => m.target === spec.key || spec.aliases?.includes(m.target));
  }

  for (const spec of model.parameters) {
    const mapping = findMapping(spec);

    // 未声明映射时的回退路径：先查同名直接参数，再查 peer fallback 与默认值
    let entry: DeviceParameterEntry | undefined;
    let sourceKey = spec.key;
    let factor = 1;
    let offset = 0;
    let suppressUnitConversion = false;
    let partPackageKey: string | undefined;
    let partPath: readonly string[] | undefined;

    if (!mapping) {
      if (Object.hasOwn(paramsMap, spec.key)) {
        entry = paramsMap[spec.key];
      } else {
        const aliasKey = spec.aliases?.find((alias) => Object.hasOwn(paramsMap, alias));
        if (aliasKey) {
          sourceKey = aliasKey;
          entry = paramsMap[aliasKey];
        }
      }
    } else if (mapping.kind === "parameter") {
      sourceKey = mapping.source;
      factor = mapping.factor ?? 1;
      offset = mapping.offset ?? 0;
      suppressUnitConversion = mapping.suppressUnitConversion === true;
      entry = paramsMap[mapping.source];
    } else if (mapping.kind === "part") {
      sourceKey = mapping.source;
      factor = mapping.factor ?? 1;
      offset = mapping.offset ?? 0;
      partPath = mapping.partPath;
      const found = resolvePartAlongPath(pkg, mapping.partPath, options?.workspacePackages);
      if ("error" in found) {
        missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason: found.error });
        issues.push(found.error);
        continue;
      }
      partPackageKey = found.partKey;
      const childParams = synthesizeLegacyParameters(found.part);
      entry = childParams[mapping.source];
    } else {
      // slot_quantity
      factor = mapping.factor ?? 1;
      offset = mapping.offset ?? 0;
      partPath = mapping.partPath;
      const found = resolvePartAlongPath(pkg, mapping.partPath, options?.workspacePackages);
      if ("error" in found) {
        missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason: found.error });
        issues.push(found.error);
        continue;
      }
      const val = applyLinearTransform(found.quantity, factor, offset);
      const boundIssue = validateNumericBounds(spec, val);
      if (boundIssue) {
        missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason: boundIssue });
        issues.push(boundIssue);
        continue;
      }
      values[spec.key] = val;
      resolved[spec.key] = {
        key: spec.key,
        value: val,
        unit: spec.unit,
        sourceStatus: "derived",
        sourceValue: found.quantity,
        sourceUnit: "1",
        partPackageKey: found.partKey,
        partPath: mapping.partPath,
      };
      continue;
    }

    if (!entry) {
      const peerVal = spec.fallbackFromPeer ? options?.peerValues?.[spec.fallbackFromPeer.parameter] : undefined;
      if (peerVal !== undefined && Number.isFinite(peerVal)) {
        values[spec.key] = peerVal;
        resolved[spec.key] = { key: spec.key, value: peerVal, unit: spec.unit, sourceStatus: "peer_fallback" };
        continue;
      }
      if (spec.defaultValue !== undefined) {
        values[spec.key] = spec.defaultValue;
        resolved[spec.key] = { key: spec.key, value: spec.defaultValue, unit: spec.unit, sourceStatus: "default" };
        continue;
      }
      if (spec.optional) continue;
      const reason = `缺少必填参数 ${spec.label}（${spec.key}，单位 ${spec.unit}）。`;
      missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason });
      issues.push(reason);
      continue;
    }

    if (entry.status === "pending") {
      const candidates = (entry.candidates ?? []).map((c) => {
        if (typeof c.value !== "number") return c;
        const unit = c.unit ?? entry.unit;
        try {
          const base = suppressUnitConversion
            ? c.value
            : unit !== undefined
              ? convertUnit(c.value, unit, spec.unit)
              : spec.dimension === "dimensionless"
                ? c.value
                : undefined;
          const convertedValue = base !== undefined ? applyLinearTransform(base, factor, offset) : undefined;
          return convertedValue !== undefined ? { ...c, convertedValue } : c;
        } catch {
          return c;
        }
      });
      pendingParameters.push({
        key: spec.key,
        sourceKey,
        label: entry.label ?? spec.label,
        modelUnit: spec.unit,
        reason: entry.reason,
        candidates,
      });
      issues.push(`${entry.label ?? spec.label}（${spec.key}）待确认：${entry.reason}`);
      continue;
    }

    if (spec.valueType === "boolean") {
      if (typeof entry.value !== "boolean") {
        const reason = `参数 ${spec.label}（${spec.key}）需要布尔值。`;
        missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason });
        issues.push(reason);
        continue;
      }
      values[spec.key] = entry.value;
      resolved[spec.key] = {
        key: spec.key,
        value: entry.value,
        unit: spec.unit,
        sourceStatus: entry.status,
        sourceValue: entry.value,
        locator: entry.locator,
        excerpt: entry.excerpt,
        condition: entry.condition,
        ...(partPackageKey && { partPackageKey }),
        ...(partPath && { partPath }),
      };
      continue;
    }

    if (typeof entry.value !== "number") {
      const reason = `参数 ${spec.label}（${spec.key}，${spec.unit}）当前为非数值文本“${String(entry.value)}”，不能直接参与求解。`;
      missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason });
      issues.push(reason);
      continue;
    }

    let converted: number;
    try {
      let base: number;
      if (suppressUnitConversion) {
        base = entry.value;
      } else if (entry.unit !== undefined) {
        base = convertUnit(entry.value, entry.unit, spec.unit);
      } else if (spec.dimension === "dimensionless") {
        base = entry.value;
      } else {
        throw new Error(`参数 ${sourceKey} 缺少物理单位，模型要求 ${spec.unit}。`);
      }
      converted = applyLinearTransform(base, factor, offset);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : `参数 ${spec.key} 单位换算失败。`;
      missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason });
      issues.push(reason);
      continue;
    }

    const boundIssue = validateNumericBounds(spec, converted);
    if (boundIssue) {
      missingParameters.push({ key: spec.key, label: spec.label, unit: spec.unit, affectedTier: tier, reason: boundIssue });
      issues.push(boundIssue);
      continue;
    }

    values[spec.key] = converted;
    resolved[spec.key] = {
      key: spec.key,
      value: converted,
      unit: spec.unit,
      sourceStatus: entry.status,
      sourceValue: entry.value,
      sourceUnit: entry.unit,
      locator: entry.locator,
      excerpt: entry.excerpt,
      condition: entry.condition,
      ...(partPackageKey && { partPackageKey }),
      ...(partPath && { partPath }),
    };
  }

  let status: ReadinessStatus;
  if (pendingParameters.length > 0) {
    status = "pending";
  } else if (missingParameters.length > 0) {
    status = "incomplete";
  } else if (Object.values(resolved).some((item) => item.sourceStatus === "assumed")) {
    status = "ready_with_assumptions";
  } else {
    status = "ready";
  }

  return {
    bindingId: binding.id,
    modelRef: binding.modelRef,
    model,
    status,
    values,
    resolved,
    pendingParameters,
    missingParameters,
    issues,
  };
}

export function resolveParameterChoice(
  pkg: DevicePackage,
  parameterKey: string,
  candidateIndex: number,
  nextRevision?: string,
): DevicePackage {
  const entry = pkg.parameters?.[parameterKey];
  if (!entry || entry.status !== "pending") {
    throw new Error(`参数 ${parameterKey} 当前不是待确认项。`);
  }
  const candidate = entry.candidates?.[candidateIndex];
  if (!candidate) {
    throw new Error(`参数 ${parameterKey} 没有编号为 ${candidateIndex} 的选件候选。`);
  }
  const unit = candidate.unit ?? entry.unit;
  const resolvedEntry: DeviceParameterEntry = {
    status: "catalog",
    value: candidate.value,
    ...(unit !== undefined && { unit }),
    ...(entry.label !== undefined && { label: entry.label }),
    condition: candidate.option,
    ...(candidate.locator !== undefined && { locator: candidate.locator }),
    ...(candidate.excerpt !== undefined && { excerpt: candidate.excerpt }),
  };
  return parseDevicePackage({
    ...pkg,
    revision: nextRevision ?? pkg.revision,
    parameters: {
      ...pkg.parameters,
      [parameterKey]: resolvedEntry,
    },
  });
}

export function capabilitiesForDevice(
  pkg: DevicePackage,
  workspacePackages?: readonly DevicePackage[],
): DeviceCapabilitiesReport {
  const geometryAvailable = Boolean(pkg.mechanics);
  const availableTiers = new Set<ProblemTier>();
  if (geometryAvailable) availableTiers.add("geometry");
  const blockedReasons: string[] = [];

  const capabilities: DeviceCapabilitySummary[] = effectiveModelBindings(pkg).map((binding) => {
    const r = evaluateBindingReadiness(pkg, binding.id, { workspacePackages });
    const tier = r.model?.simPurpose.tier ?? "dynamics";
    const available = r.status === "ready" || r.status === "ready_with_assumptions";
    if (available) availableTiers.add(tier);
    else blockedReasons.push(...r.issues);
    return {
      bindingId: r.bindingId,
      modelRef: r.modelRef,
      modelLabel: r.model?.label ?? r.modelRef.id,
      tier,
      status: r.status,
      available,
      pendingParameters: r.pendingParameters,
      missingParameters: r.missingParameters,
      issues: r.issues,
    };
  });

  return {
    geometryAvailable,
    capabilities,
    availableTiers: [...availableTiers],
    blockedReasons,
  };
}

// ---------------------------------------------------------------------------
// 面向现有伺服轴、直线进给轴与 UI 预览的角色识别及无损桥接
// ---------------------------------------------------------------------------

const SERVO_DRIVE_MODEL_ID = "Gouyuan.PositionDrive";
const SERVO_MOTOR_MODEL_ID = "Gouyuan.RatedTorqueMotor";
const LEAD_SCREW_MODEL_ID = "Gouyuan.IdealLeadScrew";
const MOVING_TABLE_MODEL_ID = "Modelica.Mechanics.Translational.Components.Mass";

export function bindingForModelId(pkg: DevicePackage, modelId: string): DeviceModelBinding | undefined {
  return effectiveModelBindings(pkg).find((b) => b.modelRef.id === modelId);
}

export function hasServoRole(pkg: DevicePackage | undefined, role: "drive" | "motor"): boolean {
  if (!pkg) return false;
  if (pkg.servo) return pkg.servo.kind === role;
  const targetId = role === "drive" ? SERVO_DRIVE_MODEL_ID : SERVO_MOTOR_MODEL_ID;
  return effectiveModelBindings(pkg).some((b) => b.modelRef.id === targetId);
}

export function hasFeedRole(pkg: DevicePackage | undefined, role: "screw" | "table"): boolean {
  if (!pkg) return false;
  if (pkg.feed) return pkg.feed.kind === (role === "screw" ? "lead-screw" : "moving-table");
  const targetId = role === "screw" ? LEAD_SCREW_MODEL_ID : MOVING_TABLE_MODEL_ID;
  return effectiveModelBindings(pkg).some((b) => b.modelRef.id === targetId);
}

export function compatibleDriveModelsForMotor(pkg: DevicePackage): readonly string[] {
  if (pkg.servo?.kind === "motor") return pkg.servo.compatibleDriveModels;
  return bindingForModelId(pkg, SERVO_MOTOR_MODEL_ID)?.compatiblePeerModels ?? [];
}

function requireReady(pkg: DevicePackage, binding: DeviceModelBinding, label: string): BindingReadiness {
  const readiness = evaluateBindingReadiness(pkg, binding.id);
  if (readiness.status === "uninstalled_model") {
    throw new Error(`${label}引用的模型 ${binding.modelRef.id} @ ${binding.modelRef.version} 在当前模型注册表中不可用。`);
  }
  if (readiness.status === "pending") {
    const first = readiness.pendingParameters[0];
    throw new Error(`${label}“${pkg.model}”存在待确认参数 ${first.label}（${first.key}）：${first.reason}`);
  }
  if (readiness.status === "incomplete") {
    throw new Error(`${label}“${pkg.model}”缺少或存在无效参数：\n${readiness.issues.join("\n")}`);
  }
  return readiness;
}

export function resolveServoDriveRatings(pkg: DevicePackage): ServoDrive {
  if (pkg.servo?.kind === "drive") {
    if (pkg.servo.modelRef) requireRegisteredModel(pkg.servo.modelRef, "驱动器");
    return pkg.servo;
  }
  const binding = bindingForModelId(pkg, SERVO_DRIVE_MODEL_ID);
  if (!binding) throw new Error("请选择已安装的伺服驱动器修订");
  const r = requireReady(pkg, binding, "驱动器");
  const ratedCurrentA = r.values.driveRatedCurrentA as number;
  const peakCurrentA = (r.values.drivePeakCurrentA as number | undefined) ?? ratedCurrentA;
  return {
    kind: "drive",
    ratedCurrentA,
    peakCurrentA,
    modelRef: binding.modelRef,
  };
}

export function resolveServoMotorRatings(pkg: DevicePackage): ServoMotor {
  if (pkg.servo?.kind === "motor") {
    if (pkg.servo.modelRef) requireRegisteredModel(pkg.servo.modelRef, "电机");
    return pkg.servo;
  }
  const binding = bindingForModelId(pkg, SERVO_MOTOR_MODEL_ID);
  if (!binding) throw new Error("请选择已安装的伺服电机修订");
  const r = requireReady(pkg, binding, "电机");
  const ratedTorqueNm = r.values.ratedTorqueNm as number;
  const ratedSpeedRpm = r.values.ratedSpeedRpm as number;
  return {
    kind: "motor",
    ratedPowerW: r.values.ratedPowerW as number,
    ratedTorqueNm,
    peakTorqueNm: (r.values.peakTorqueNm as number | undefined) ?? ratedTorqueNm,
    ratedSpeedRpm,
    maxSpeedRpm: (r.values.maxSpeedRpm as number | undefined) ?? ratedSpeedRpm,
    rotorInertiaKgM2: r.values.rotorInertiaKgM2 as number,
    ...(r.values.motorRatedCurrentA !== undefined && { ratedCurrentA: r.values.motorRatedCurrentA as number }),
    compatibleDriveModels: [...(binding.compatiblePeerModels ?? [])],
    modelRef: binding.modelRef,
  };
}

/** 仅在待确认/未缺项阻断时返回 undefined，供非求解的预览摘要渲染使用。 */
export function tryResolveServoDriveRatings(pkg: DevicePackage): ServoDrive | undefined {
  try {
    return hasServoRole(pkg, "drive") ? resolveServoDriveRatings(pkg) : undefined;
  } catch {
    return undefined;
  }
}

export function tryResolveServoMotorRatings(pkg: DevicePackage): ServoMotor | undefined {
  try {
    return hasServoRole(pkg, "motor") ? resolveServoMotorRatings(pkg) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveFeedPartRatings(pkg: DevicePackage): NonNullable<DevicePackage["feed"]> {
  if (pkg.feed) return pkg.feed;
  const screwBinding = bindingForModelId(pkg, LEAD_SCREW_MODEL_ID);
  if (screwBinding) {
    const r = requireReady(pkg, screwBinding, "丝杠");
    return {
      kind: "lead-screw",
      leadMmPerRev: r.values.leadMmPerRev as number,
      modelRef: screwBinding.modelRef,
    };
  }
  const tableBinding = bindingForModelId(pkg, MOVING_TABLE_MODEL_ID);
  if (tableBinding) {
    const r = requireReady(pkg, tableBinding, "工作台");
    return {
      kind: "moving-table",
      massKg: r.values.massKg as number,
      modelRef: tableBinding.modelRef,
    };
  }
  throw new Error(`设备“${pkg.model}”未绑定丝杠或工作台进给模型。`);
}

export function registeredModelSummary(ref: ModelReference): string {
  const model = MODEL_REGISTRY.get(refKey(ref));
  return model ? `${model.label}（${ref.id} @ ${ref.version}）` : `${ref.id} @ ${ref.version}`;
}
