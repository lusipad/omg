import { z } from "zod";
import {
  evaluateBindingReadiness,
  resolveFeedPartRatings,
  resolveServoDriveRatings,
  resolveServoMotorRatings,
} from "./device-model-binding";
import { FEED_TRACKING_KERNEL_REF } from "./model-registry";
import { packageKey, signalIdSchema, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export const linkProvenanceSchema = z.enum(["confirmed", "inferred", "pending"]);
export type LinkProvenance = z.infer<typeof linkProvenanceSchema>;

const nameSchema = z.string().trim().min(1).max(160);
const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const optionalNoteSchema = z.string().trim().max(400).optional();

export const systemAxisUnitSchema = z.strictObject({
  id: signalIdSchema,
  name: nameSchema,
  direction: vec3Schema.refine(([x, y, zVal]) => Math.hypot(x, y, zVal) > 1e-6, "轴运动方向向量长度不能为零"),
  originMm: vec3Schema.optional(),
  factor: z.union([z.literal(1), z.literal(-1)]).optional(),
  driveKey: z.string().min(1).max(4096),
  motorKey: z.string().min(1).max(4096),
  screwKey: z.string().min(1).max(4096),
  tableKey: z.string().min(1).max(4096),
  overrideLeadMmPerRev: z.number().finite().positive().optional(),
  overrideTableMassKg: z.number().finite().positive().optional(),
  provenance: linkProvenanceSchema,
  note: optionalNoteSchema,
});

export const systemLimitSensorNodeSchema = z.strictObject({
  id: signalIdSchema,
  name: nameSchema,
  packageKey: z.string().min(1).max(4096).optional(),
  axisId: signalIdSchema,
  triggerPositionMm: z.number().finite().optional(),
  senseDistanceMm: z.number().finite().positive().optional(),
  triggerMode: z.enum(["positive_overtravel", "negative_overtravel", "window"]),
  normallyClosed: z.boolean(),
  supplyVoltageV: z.number().finite().positive().optional(),
  provenance: linkProvenanceSchema,
  note: optionalNoteSchema,
});

export const systemDiChannelNodeSchema = z.strictObject({
  id: signalIdSchema,
  name: nameSchema,
  packageKey: z.string().min(1).max(4096).optional(),
  onAboveV: z.number().finite().optional(),
  offBelowV: z.number().finite().optional(),
  filterMs: z.number().finite().nonnegative().optional(),
  provenance: linkProvenanceSchema,
  note: optionalNoteSchema,
});

export const wireEndpointFromSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sensor"),
    nodeId: signalIdSchema,
    portId: z.enum(["voltageOut", "triggeredOut"]),
  }),
  z.strictObject({
    kind: z.literal("di"),
    nodeId: signalIdSchema,
    portId: z.literal("stateOut"),
  }),
]);

export const wireEndpointToSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("di"),
    nodeId: signalIdSchema,
    portId: z.literal("voltageIn"),
  }),
  z.strictObject({
    kind: z.literal("controller"),
    nodeId: signalIdSchema,
    portId: z.enum(["posLimitIn", "negLimitIn", "homeSwitchIn"]),
  }),
]);

export const systemSignalWireSchema = z.strictObject({
  id: signalIdSchema,
  from: wireEndpointFromSchema,
  to: wireEndpointToSchema,
  invert: z.boolean().optional(),
  provenance: linkProvenanceSchema,
  note: optionalNoteSchema,
});

export const systemAxisControllerSchema = z.strictObject({
  id: signalIdSchema,
  axisId: signalIdSchema,
  mode: z.enum(["move_with_limit_stop", "homing_search"]),
  targetMm: z.number().finite(),
  cruiseVelocityMmS: z.number().finite().positive(),
  initialPositionMm: z.number().finite().optional(),
  stopOnPosLimit: z.boolean().optional(),
  stopOnNegLimit: z.boolean().optional(),
  stopOnHome: z.boolean().optional(),
});

export const systemAssetBindingSchema = z.strictObject({
  axisId: signalIdSchema,
  serialNumber: z.string().trim().min(1).max(120),
  assetTag: z.string().trim().max(120).optional(),
  calibrationVersion: z.string().trim().min(1).max(64),
  calibratedAt: z.string().trim().max(64).optional(),
  note: optionalNoteSchema,
});

export const twinSystemAssemblySchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("system-twin-assembly"),
  id: signalIdSchema,
  name: nameSchema,
  commStepMs: z.number().int().min(1).max(10),
  durationMs: z.number().int().min(50).max(10000),
  axes: z.array(systemAxisUnitSchema).min(1).max(16),
  sensors: z.array(systemLimitSensorNodeSchema).max(64),
  diChannels: z.array(systemDiChannelNodeSchema).max(64),
  wires: z.array(systemSignalWireSchema).max(256),
  controllers: z.array(systemAxisControllerSchema).min(1).max(16),
  assetBindings: z.array(systemAssetBindingSchema).max(16).optional(),
});

export const twinSystemListSchema = z.array(twinSystemAssemblySchema).max(32);

export type SystemAssetBinding = z.infer<typeof systemAssetBindingSchema>;
export type SystemAxisUnit = z.infer<typeof systemAxisUnitSchema>;
export type SystemLimitSensorNode = z.infer<typeof systemLimitSensorNodeSchema>;
export type SystemDiChannelNode = z.infer<typeof systemDiChannelNodeSchema>;
export type SystemSignalWire = z.infer<typeof systemSignalWireSchema>;
export type SystemAxisController = z.infer<typeof systemAxisControllerSchema>;
export type TwinSystemAssembly = z.infer<typeof twinSystemAssemblySchema>;

export interface TrackingFeedParameters {
  readonly leadMmPerRev: number;
  readonly tableMassKg: number;
  readonly rotorInertiaKgM2: number;
  readonly ratedTorqueNm: number;
  readonly ratedPowerW: number;
  readonly ratedSpeedRpm: number;
  readonly driveRatedCurrentA: number;
  readonly motorRatedCurrentA: number;
}

export interface ResolvedAxisRuntimeSpec {
  readonly axis: SystemAxisUnit;
  readonly unitDirection: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly factor: 1 | -1;
  readonly parameters: TrackingFeedParameters;
  readonly controller: {
    readonly id: string;
    readonly axisId: string;
    readonly mode: "move_with_limit_stop" | "homing_search";
    readonly targetMm: number;
    readonly cruiseVelocityMmS: number;
    readonly initialPositionMm: number;
    readonly stopOnPosLimit: boolean;
    readonly stopOnNegLimit: boolean;
    readonly stopOnHome: boolean;
  };
}

export interface ResolvedSensorRuntimeSpec {
  readonly sensor: SystemLimitSensorNode;
  readonly triggerPositionMm: number;
  readonly senseDistanceMm: number;
  readonly triggerMode: "positive_overtravel" | "negative_overtravel" | "window";
  readonly normallyClosed: boolean;
  readonly supplyVoltageV: number;
}

export interface ResolvedDiRuntimeSpec {
  readonly di: SystemDiChannelNode;
  readonly onAboveV: number;
  readonly offBelowV: number;
  readonly filterMs: number;
}

export interface ResolvedTwinSystem {
  readonly system: TwinSystemAssembly;
  readonly axes: readonly ResolvedAxisRuntimeSpec[];
  readonly sensors: readonly ResolvedSensorRuntimeSpec[];
  readonly diChannels: readonly ResolvedDiRuntimeSpec[];
}

export interface ProvenanceAuditItem {
  readonly id: string;
  readonly scope: "axis" | "sensor" | "di" | "wire";
  readonly status: LinkProvenance;
  readonly summary: string;
}

export interface SystemReadinessReport {
  readonly ready: boolean;
  readonly confirmedItems: readonly ProvenanceAuditItem[];
  readonly inferredItems: readonly ProvenanceAuditItem[];
  readonly pendingItems: readonly string[];
  readonly blockingErrors: readonly string[];
  readonly resolved?: ResolvedTwinSystem;
}

export interface AxisFrameState {
  readonly axisId: string;
  readonly commandMm: number;
  readonly positionMm: number;
  readonly velocityMmS: number;
  readonly motorTorqueNm: number;
  readonly axialForceN: number;
  readonly angleDeg: number;
  readonly speedRpm: number;
  readonly worldPoseMm: readonly [number, number, number];
  readonly stopLatched: boolean;
}

export interface RuntimeSignalEvent {
  readonly timeMs: number;
  readonly sourceId: string;
  readonly channel: string;
  readonly value: boolean;
  readonly detail: string;
}

export interface RuntimeTraceFrame {
  readonly timeMs: number;
  readonly tipPoseMm: readonly [number, number, number];
  readonly axes: Readonly<Record<string, AxisFrameState>>;
  readonly sensorTriggered: Readonly<Record<string, boolean>>;
  readonly sensorVoltageV: Readonly<Record<string, number>>;
  readonly diState: Readonly<Record<string, boolean>>;
  readonly controllerInputs: Readonly<Record<string, { posLimitIn: boolean; negLimitIn: boolean; homeSwitchIn: boolean }>>;
}

export interface AxisRunSummary {
  readonly axisId: string;
  readonly axisName: string;
  readonly initialPositionMm: number;
  readonly commandedTargetMm: number;
  readonly finalPositionMm: number;
  readonly peakSpeedMmS: number;
  readonly peakTorqueNm: number;
  readonly stopTriggeredAtMs: number | null;
  readonly stopTriggerPositionMm: number | null;
  readonly brakingDistanceMm: number | null;
}

export interface RuntimeTrace {
  readonly schemaVersion: 1;
  readonly kind: "system-runtime-trace";
  readonly systemId: string;
  readonly systemName: string;
  readonly modelRef: { readonly id: string; readonly version: string };
  readonly commStepMs: number;
  readonly durationMs: number;
  readonly frames: readonly RuntimeTraceFrame[];
  readonly events: readonly RuntimeSignalEvent[];
  readonly axisSummaries: readonly AxisRunSummary[];
}

export interface SystemSubsystemTemplate {
  readonly schemaVersion: 1;
  readonly kind: "system-axis-subsystem-template";
  readonly sourceAxis: SystemAxisUnit;
  readonly sourceController: SystemAxisController;
  readonly sensors: readonly SystemLimitSensorNode[];
  readonly diChannels: readonly SystemDiChannelNode[];
  readonly wires: readonly SystemSignalWire[];
}

export function parseTwinSystemAssembly(value: unknown): TwinSystemAssembly {
  return twinSystemAssemblySchema.parse(value);
}

export function upsertTwinSystem(ws: TwinWorkspace, system: TwinSystemAssembly): TwinWorkspace {
  const parsed = parseTwinSystemAssembly(system);
  const existing = ws.systems ?? [];
  const next = existing.some((item) => item.id === parsed.id)
    ? existing.map((item) => (item.id === parsed.id ? parsed : item))
    : [...existing, parsed];
  return { ...ws, systems: next };
}

export function removeTwinSystem(ws: TwinWorkspace, systemId: string): TwinWorkspace {
  const next = (ws.systems ?? []).filter((item) => item.id !== systemId);
  return { ...ws, systems: next.length ? next : undefined };
}

function unitDirection(direction: readonly [number, number, number]): readonly [number, number, number] {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  return [direction[0] / len, direction[1] / len, direction[2] / len];
}

function uniqueIdCheck(ids: readonly string[], label: string, errors: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`存在重复的${label}标识“${id}”。`);
    seen.add(id);
  }
}

export function evaluateSystemReadiness(workspace: TwinWorkspace, system: TwinSystemAssembly): SystemReadinessReport {
  const catalog = new Map<string, DevicePackage>(workspace.packages.map((pkg) => [packageKey(pkg), pkg]));
  const confirmedItems: ProvenanceAuditItem[] = [];
  const inferredItems: ProvenanceAuditItem[] = [];
  const pendingItems: string[] = [];
  const blockingErrors: string[] = [];

  uniqueIdCheck(system.axes.map((a) => a.id), "轴", blockingErrors);
  uniqueIdCheck(system.sensors.map((s) => s.id), "传感器", blockingErrors);
  uniqueIdCheck(system.diChannels.map((d) => d.id), "DI 通道", blockingErrors);
  uniqueIdCheck(system.wires.map((w) => w.id), "信号连线", blockingErrors);
  uniqueIdCheck(system.controllers.map((c) => c.id), "控制器", blockingErrors);

  const axisIds = new Set(system.axes.map((a) => a.id));
  const controllerByAxis = new Map<string, SystemAxisController>();
  for (const ctrl of system.controllers) {
    if (!axisIds.has(ctrl.axisId)) {
      blockingErrors.push(`控制器“${ctrl.id}”指向了不存在的轴“${ctrl.axisId}”。`);
    } else if (controllerByAxis.has(ctrl.axisId)) {
      blockingErrors.push(`轴“${ctrl.axisId}”关联了多个控制器。`);
    } else {
      controllerByAxis.set(ctrl.axisId, ctrl);
    }
  }
  for (const axis of system.axes) {
    if (!controllerByAxis.has(axis.id)) {
      blockingErrors.push(`轴“${axis.name}”（${axis.id}）缺少运动与急停控制器。`);
    }
  }

  const recordProvenance = (item: ProvenanceAuditItem) => {
    if (item.status === "confirmed") confirmedItems.push(item);
    else if (item.status === "inferred") inferredItems.push(item);
    else pendingItems.push(`待确认${item.summary}`);
  };

  const resolvedAxes: ResolvedAxisRuntimeSpec[] = [];
  for (const axis of system.axes) {
    recordProvenance({ id: axis.id, scope: "axis", status: axis.provenance, summary: `轴装配「${axis.name}」` });
    const drivePkg = catalog.get(axis.driveKey);
    const motorPkg = catalog.get(axis.motorKey);
    const screwPkg = catalog.get(axis.screwKey);
    const tablePkg = catalog.get(axis.tableKey);
    if (!drivePkg) blockingErrors.push(`轴“${axis.name}”缺少驱动器设备包：${axis.driveKey}`);
    if (!motorPkg) blockingErrors.push(`轴“${axis.name}”缺少电机设备包：${axis.motorKey}`);
    if (!screwPkg) blockingErrors.push(`轴“${axis.name}”缺少丝杠设备包：${axis.screwKey}`);
    if (!tablePkg) blockingErrors.push(`轴“${axis.name}”缺少工作台设备包：${axis.tableKey}`);
    const ctrl = controllerByAxis.get(axis.id);
    if (!drivePkg || !motorPkg || !screwPkg || !tablePkg || !ctrl) continue;

    try {
      const drive = resolveServoDriveRatings(drivePkg);
      const motor = resolveServoMotorRatings(motorPkg);
      const screw = resolveFeedPartRatings(screwPkg);
      const table = resolveFeedPartRatings(tablePkg);
      if (screw.kind !== "lead-screw") {
        blockingErrors.push(`设备“${screwPkg.model}”不是滚珠丝杠部件。`);
        continue;
      }
      if (table.kind !== "moving-table") {
        blockingErrors.push(`设备“${tablePkg.model}”不是平动负载/工作台部件。`);
        continue;
      }
      if (
        motor.compatibleDriveModels.length > 0 &&
        !motor.compatibleDriveModels.includes(drivePkg.model)
      ) {
        blockingErrors.push(`电机“${motorPkg.model}”声明的配套驱动器不包含“${drivePkg.model}”。`);
        continue;
      }
      const leadMmPerRev = axis.overrideLeadMmPerRev ?? screw.leadMmPerRev;
      const tableMassKg = axis.overrideTableMassKg ?? table.massKg;
      const maxLoadInertiaRatio = 100;
      const loadRatio =
        (tableMassKg * (leadMmPerRev * 0.001) ** 2) /
        (4 * Math.PI ** 2 * motor.rotorInertiaKgM2);
      if (loadRatio > maxLoadInertiaRatio) {
        blockingErrors.push(
          `轴“${axis.name}”负载惯量比 ${loadRatio.toFixed(1)} 超过 Modelica 核准上限 ${maxLoadInertiaRatio}。`,
        );
        continue;
      }
      resolvedAxes.push({
        axis,
        unitDirection: unitDirection(axis.direction),
        originMm: axis.originMm ?? [0, 0, 0],
        factor: axis.factor ?? 1,
        parameters: {
          leadMmPerRev,
          tableMassKg,
          rotorInertiaKgM2: motor.rotorInertiaKgM2,
          ratedTorqueNm: motor.ratedTorqueNm,
          ratedPowerW: motor.ratedPowerW,
          ratedSpeedRpm: motor.ratedSpeedRpm,
          driveRatedCurrentA: drive.ratedCurrentA,
          motorRatedCurrentA: motor.ratedCurrentA ?? drive.ratedCurrentA,
        },
        controller: {
          id: ctrl.id,
          axisId: ctrl.axisId,
          mode: ctrl.mode,
          targetMm: ctrl.targetMm,
          cruiseVelocityMmS: ctrl.cruiseVelocityMmS,
          initialPositionMm: ctrl.initialPositionMm ?? 0,
          stopOnPosLimit: ctrl.stopOnPosLimit ?? true,
          stopOnNegLimit: ctrl.stopOnNegLimit ?? true,
          stopOnHome: ctrl.stopOnHome ?? false,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "轴参数未就绪";
      if (/待确认/.test(msg)) pendingItems.push(msg);
      else blockingErrors.push(msg);
    }
  }

  const resolvedSensors: ResolvedSensorRuntimeSpec[] = [];
  for (const sensor of system.sensors) {
    recordProvenance({ id: sensor.id, scope: "sensor", status: sensor.provenance, summary: `限位传感器「${sensor.name}」` });
    if (!axisIds.has(sensor.axisId)) {
      blockingErrors.push(`传感器“${sensor.name}”挂载到了不存在的轴“${sensor.axisId}”。`);
    }
    let pkgSenseDistanceMm: number | undefined;
    let pkgSupplyVoltageV: number | undefined;
    let pkgNormallyClosed: boolean | undefined;
    let pkgTriggerPositionMm: number | undefined;
    if (sensor.packageKey) {
      const pkg = catalog.get(sensor.packageKey);
      if (!pkg) {
        blockingErrors.push(`传感器“${sensor.name}”引用的设备包未安装：${sensor.packageKey}`);
      } else {
        const readiness = evaluateBindingReadiness(pkg, { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" });
        if (readiness.model) {
          for (const pend of readiness.pendingParameters) {
            if (pend.key === "triggerPositionMm" && sensor.triggerPositionMm !== undefined) continue;
            pendingItems.push(`传感器“${pkg.model}”待确认参数 ${pend.label}（${pend.key}）：${pend.reason}`);
          }
          if (typeof readiness.values.senseDistanceMm === "number") pkgSenseDistanceMm = readiness.values.senseDistanceMm;
          if (typeof readiness.values.supplyVoltageV === "number") pkgSupplyVoltageV = readiness.values.supplyVoltageV;
          if (typeof readiness.values.normallyClosed === "boolean") pkgNormallyClosed = readiness.values.normallyClosed;
          if (typeof readiness.values.triggerPositionMm === "number") pkgTriggerPositionMm = readiness.values.triggerPositionMm;
        }
      }
    }
    const triggerPositionMm = sensor.triggerPositionMm ?? pkgTriggerPositionMm;
    if (triggerPositionMm === undefined || !Number.isFinite(triggerPositionMm)) {
      pendingItems.push(`限位开关“${sensor.name}”缺少轴向安装触发坐标 triggerPositionMm（mm）。`);
      continue;
    }
    resolvedSensors.push({
      sensor,
      triggerPositionMm,
      senseDistanceMm: sensor.senseDistanceMm ?? pkgSenseDistanceMm ?? 4,
      triggerMode: sensor.triggerMode,
      normallyClosed: sensor.normallyClosed ?? pkgNormallyClosed ?? true,
      supplyVoltageV: sensor.supplyVoltageV ?? pkgSupplyVoltageV ?? 24,
    });
  }

  const resolvedDis: ResolvedDiRuntimeSpec[] = [];
  for (const di of system.diChannels) {
    recordProvenance({ id: di.id, scope: "di", status: di.provenance, summary: `数字量通道「${di.name}」` });
    let pkgOnAboveV: number | undefined;
    let pkgOffBelowV: number | undefined;
    let pkgFilterMs: number | undefined;
    if (di.packageKey) {
      const pkg = catalog.get(di.packageKey);
      if (!pkg) {
        blockingErrors.push(`数字量通道“${di.name}”引用的设备包未安装：${di.packageKey}`);
      } else {
        const readiness = evaluateBindingReadiness(pkg, { id: "GouyuanSignal.DigitalInputChannel", version: "1.0.0" });
        if (!readiness.model || readiness.status === "uninstalled_model") {
          blockingErrors.push(`设备“${pkg.model}”未绑定数字量输入通道模型。`);
        } else {
          for (const pend of readiness.pendingParameters) {
            pendingItems.push(`DI 模块“${pkg.model}”待确认参数 ${pend.label}（${pend.key}）：${pend.reason}`);
          }
          if (readiness.status === "incomplete" && (di.onAboveV === undefined || di.offBelowV === undefined || di.filterMs === undefined)) {
            blockingErrors.push(...readiness.issues);
          }
          if (typeof readiness.values.onAbove === "number") pkgOnAboveV = readiness.values.onAbove;
          if (typeof readiness.values.offBelow === "number") pkgOffBelowV = readiness.values.offBelow;
          if (typeof readiness.values.filterMs === "number") pkgFilterMs = readiness.values.filterMs;
        }
      }
    }
    const onAboveV = di.onAboveV ?? pkgOnAboveV;
    const offBelowV = di.offBelowV ?? pkgOffBelowV;
    const filterMs = di.filterMs ?? pkgFilterMs;
    if (onAboveV === undefined || offBelowV === undefined || filterMs === undefined) {
      pendingItems.push(`数字量通道“${di.name}”缺少滞回阈值或滤波时间（onAboveV / offBelowV / filterMs）。`);
      continue;
    }
    if (offBelowV > onAboveV) {
      blockingErrors.push(`数字量通道“${di.name}”的关断阈值（${offBelowV} V）不能大于导通阈值（${onAboveV} V）。`);
      continue;
    }
    resolvedDis.push({ di, onAboveV, offBelowV, filterMs });
  }

  const sensorIds = new Set(system.sensors.map((s) => s.id));
  const diIds = new Set(system.diChannels.map((d) => d.id));
  const ctrlIds = new Set(system.controllers.map((c) => c.id));
  const targetInputs = new Set<string>();

  for (const wire of system.wires) {
    recordProvenance({
      id: wire.id,
      scope: "wire",
      status: wire.provenance,
      summary: `信号线 ${wire.from.nodeId}.${wire.from.portId} → ${wire.to.nodeId}.${wire.to.portId}`,
    });
    if (wire.from.kind === "sensor" && !sensorIds.has(wire.from.nodeId)) {
      blockingErrors.push(`连线“${wire.id}”源传感器不存在：${wire.from.nodeId}`);
    }
    if (wire.from.kind === "di" && !diIds.has(wire.from.nodeId)) {
      blockingErrors.push(`连线“${wire.id}”源 DI 通道不存在：${wire.from.nodeId}`);
    }
    if (wire.to.kind === "di" && !diIds.has(wire.to.nodeId)) {
      blockingErrors.push(`连线“${wire.id}”目标 DI 通道不存在：${wire.to.nodeId}`);
    }
    if (wire.to.kind === "controller" && !ctrlIds.has(wire.to.nodeId)) {
      blockingErrors.push(`连线“${wire.id}”目标控制器不存在：${wire.to.nodeId}`);
    }
    const fromType = wire.from.kind === "sensor" && wire.from.portId === "voltageOut" ? "voltage" : "boolean";
    const toType = wire.to.kind === "di" ? "voltage" : "boolean";
    if (fromType !== toType) {
      blockingErrors.push(`连线“${wire.id}”信号类型不匹配：电压模拟量只能接入 DI voltageIn，布尔量只能接入控制器限位/回零输入。`);
    }
    if (wire.invert && fromType === "voltage") {
      blockingErrors.push(`连线“${wire.id}”的电压连线不支持布尔取反（invert）。`);
    }
    const targetKey = `${wire.to.kind}:${wire.to.nodeId}:${wire.to.portId}`;
    if (targetInputs.has(targetKey)) {
      blockingErrors.push(`目标输入端口 ${wire.to.nodeId}.${wire.to.portId} 存在多条接入连线。`);
    }
    targetInputs.add(targetKey);
  }

  const ready = pendingItems.length === 0 && blockingErrors.length === 0;
  return {
    ready,
    confirmedItems,
    inferredItems,
    pendingItems,
    blockingErrors,
    ...(ready && {
      resolved: {
        system,
        axes: resolvedAxes,
        sensors: resolvedSensors,
        diChannels: resolvedDis,
      },
    }),
  };
}

export function requireReadySystem(workspace: TwinWorkspace, system: TwinSystemAssembly): ResolvedTwinSystem {
  const report = evaluateSystemReadiness(workspace, system);
  if (!report.ready || !report.resolved) {
    const reasons = [...report.pendingItems, ...report.blockingErrors];
    throw new Error(`系统尚未就绪，请先核对缺失或待确认项：\n${reasons.join("\n")}`);
  }
  return report.resolved;
}

export function confirmSystemProvenance(system: TwinSystemAssembly, itemId?: string): TwinSystemAssembly {
  const confirmItem = (id: string, current: LinkProvenance): LinkProvenance =>
    !itemId || itemId === id ? "confirmed" : current;
  return {
    ...system,
    axes: system.axes.map((a) => ({ ...a, provenance: confirmItem(a.id, a.provenance) })),
    sensors: system.sensors.map((s) => {
      if (!itemId || itemId === s.id) {
        if (s.triggerPositionMm === undefined) {
          throw new Error(`限位开关“${s.name}”尚未填写触发坐标（mm），不能标记为已确认。`);
        }
        return { ...s, provenance: "confirmed" as const };
      }
      return s;
    }),
    diChannels: system.diChannels.map((d) => ({ ...d, provenance: confirmItem(d.id, d.provenance) })),
    wires: system.wires.map((w) => ({ ...w, provenance: confirmItem(w.id, w.provenance) })),
  };
}

export function packageAxisAsSubsystem(system: TwinSystemAssembly, axisId: string): SystemSubsystemTemplate {
  const sourceAxis = system.axes.find((a) => a.id === axisId);
  const sourceController = system.controllers.find((c) => c.axisId === axisId);
  if (!sourceAxis || !sourceController) {
    throw new Error(`找不到轴“${axisId}”及其控制器，无法打包为子系统。`);
  }
  const sensors = system.sensors.filter((s) => s.axisId === axisId);
  const sensorIds = new Set(sensors.map((s) => s.id));
  const diIds = new Set<string>();
  for (const w of system.wires) {
    if (w.from.kind === "sensor" && sensorIds.has(w.from.nodeId) && w.to.kind === "di") {
      diIds.add(w.to.nodeId);
    }
  }
  const diChannels = system.diChannels.filter((d) => diIds.has(d.id));
  const wires = system.wires.filter((w) => {
    const fromOwned =
      (w.from.kind === "sensor" && sensorIds.has(w.from.nodeId)) ||
      (w.from.kind === "di" && diIds.has(w.from.nodeId));
    const toOwned =
      (w.to.kind === "di" && diIds.has(w.to.nodeId)) ||
      (w.to.kind === "controller" && w.to.nodeId === sourceController.id);
    return fromOwned && toOwned;
  });
  return {
    schemaVersion: 1,
    kind: "system-axis-subsystem-template",
    sourceAxis,
    sourceController,
    sensors,
    diChannels,
    wires,
  };
}

export function appendSubsystemInstance(
  system: TwinSystemAssembly,
  template: SystemSubsystemTemplate,
  options: {
    axisId: string;
    axisName: string;
    direction: [number, number, number];
    originMm?: [number, number, number];
    factor?: 1 | -1;
    targetMm?: number;
    triggerPositionMm?: number;
  },
): TwinSystemAssembly {
  const prefix = options.axisId;
  const ctrlId = `${prefix}-ctrl`;
  const sensorIdMap = new Map<string, string>();
  const diIdMap = new Map<string, string>();

  const nextSensors: SystemLimitSensorNode[] = template.sensors.map((s, idx) => {
    const newId = `${prefix}-sw-${idx + 1}`;
    sensorIdMap.set(s.id, newId);
    return {
      ...s,
      id: newId,
      name: `${options.axisName} · ${s.name}`,
      axisId: options.axisId,
      triggerPositionMm: options.triggerPositionMm ?? s.triggerPositionMm,
    };
  });

  const nextDis: SystemDiChannelNode[] = template.diChannels.map((d, idx) => {
    const newId = `${prefix}-di-${idx + 1}`;
    diIdMap.set(d.id, newId);
    return {
      ...d,
      id: newId,
      name: `${options.axisName} · ${d.name}`,
    };
  });

  const nextWires: SystemSignalWire[] = template.wires.map((w, idx) => ({
    ...w,
    id: `${prefix}-wire-${idx + 1}`,
    from:
      w.from.kind === "sensor"
        ? { ...w.from, nodeId: sensorIdMap.get(w.from.nodeId) ?? w.from.nodeId }
        : { ...w.from, nodeId: diIdMap.get(w.from.nodeId) ?? w.from.nodeId },
    to:
      w.to.kind === "di"
        ? { ...w.to, nodeId: diIdMap.get(w.to.nodeId) ?? w.to.nodeId }
        : { ...w.to, nodeId: ctrlId },
  }));

  const nextAxis: SystemAxisUnit = {
    ...template.sourceAxis,
    id: options.axisId,
    name: options.axisName,
    direction: options.direction,
    ...(options.originMm && { originMm: options.originMm }),
    ...(options.factor && { factor: options.factor }),
  };

  const nextController: SystemAxisController = {
    ...template.sourceController,
    id: ctrlId,
    axisId: options.axisId,
    ...(options.targetMm !== undefined && { targetMm: options.targetMm }),
  };

  return parseTwinSystemAssembly({
    ...system,
    axes: [...system.axes, nextAxis],
    sensors: [...system.sensors, ...nextSensors],
    diChannels: [...system.diChannels, ...nextDis],
    wires: [...system.wires, ...nextWires],
    controllers: [...system.controllers, nextController],
  });
}

export function runtimeTraceToCsv(trace: RuntimeTrace): string {
  const axisIds = trace.axisSummaries.map((a) => a.axisId);
  const headers = [
    "timeMs",
    "tipXMm",
    "tipYMm",
    "tipZMm",
    ...axisIds.flatMap((id) => [
      `${id}_cmdMm`,
      `${id}_posMm`,
      `${id}_velMmS`,
      `${id}_torqueNm`,
      `${id}_stopLatched`,
    ]),
  ];
  const lines = [headers.join(",")];
  for (const frame of trace.frames) {
    const row: Array<string | number> = [
      frame.timeMs,
      frame.tipPoseMm[0].toFixed(6),
      frame.tipPoseMm[1].toFixed(6),
      frame.tipPoseMm[2].toFixed(6),
    ];
    for (const id of axisIds) {
      const a = frame.axes[id];
      row.push(
        a.commandMm.toFixed(6),
        a.positionMm.toFixed(6),
        a.velocityMmS.toFixed(6),
        a.motorTorqueNm.toFixed(6),
        a.stopLatched ? 1 : 0,
      );
    }
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

export const SYSTEM_KERNEL_REF = FEED_TRACKING_KERNEL_REF;
