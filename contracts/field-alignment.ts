import { parseTwinSystemAssembly, type RuntimeTrace, type TwinSystemAssembly } from "./system-twin";
import { packageKey, parseDevicePackage, type DevicePackage } from "./twin-device";
import { installPackage, type TwinWorkspace } from "./twin-simulation";
import { convertUnit } from "./units";

export interface FieldChannelMap {
  readonly timeColumn: string;
  readonly timeUnit: "ms" | "s";
  readonly positionColumn: string;
  readonly positionUnit: string;
  readonly velocityColumn?: string;
  readonly velocityUnit?: string;
  readonly limitSignalColumn?: string;
  readonly timeOffsetMs?: number;
  readonly positionZeroOffsetMm?: number;
  readonly polarityFactor?: 1 | -1;
}

export interface FieldTraceSample {
  readonly timeMs: number;
  readonly positionMm: number;
  readonly velocityMmS?: number;
  readonly limitTriggered?: boolean;
}

export interface FieldTraceDataset {
  readonly id: string;
  readonly label: string;
  readonly axisId: string;
  readonly profileRole: "primary_calibration" | "independent_reverify";
  readonly samples: readonly FieldTraceSample[];
}

export interface AlignmentToleranceSpec {
  readonly maxRmsPositionErrorMm: number;
  readonly maxPeakVelocityErrorMmS: number;
  readonly maxFinalPositionErrorMm: number;
  readonly maxTriggerTimeErrorMs: number;
}

export const DEFAULT_ALIGNMENT_TOLERANCES: AlignmentToleranceSpec = {
  maxRmsPositionErrorMm: 0.5,
  maxPeakVelocityErrorMmS: 6.0,
  maxFinalPositionErrorMm: 0.3,
  maxTriggerTimeErrorMs: 5.0,
};

export interface AlignedOverlayPoint {
  readonly timeMs: number;
  readonly simPositionMm: number;
  readonly measPositionMm: number;
  readonly errorMm: number;
}

export interface FieldComparisonReport {
  readonly datasetId: string;
  readonly datasetLabel: string;
  readonly profileRole: FieldTraceDataset["profileRole"];
  readonly axisId: string;
  readonly sampleCount: number;
  readonly overlapDurationMs: number;
  readonly rmsPositionErrorMm: number;
  readonly maxPositionErrorMm: number;
  readonly peakVelocitySimMmS: number;
  readonly peakVelocityMeasMmS: number;
  readonly peakVelocityErrorMmS: number;
  readonly finalPositionSimMm: number;
  readonly finalPositionMeasMm: number;
  readonly finalPositionErrorMm: number;
  readonly settleTimeSimMs: number | null;
  readonly settleTimeMeasMs: number | null;
  readonly settleTimeErrorMs: number | null;
  readonly limitTriggerSimMs: number | null;
  readonly limitTriggerMeasMs: number | null;
  readonly limitTriggerTimeErrorMs: number | null;
  readonly tolerances: AlignmentToleranceSpec;
  readonly withinTolerance: boolean;
  readonly failedChecks: readonly string[];
  readonly overlayPoints: readonly AlignedOverlayPoint[];
}

export type VerificationStatusKind =
  | "offline_simulation_only"
  | "primary_aligned_pending_reverify"
  | "deviation_exceeded"
  | "field_verified";

export interface SystemVerificationStatus {
  readonly status: VerificationStatusKind;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

function splitCsvRow(line: string): string[] {
  const delimiter = line.includes("\t") && !line.includes(",") ? "\t" : ",";
  return line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, "$1").trim());
}

function parseBoolToken(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "high" || normalized === "triggered") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "low" || normalized === "clear") {
    return false;
  }
  const num = Number(normalized);
  if (Number.isFinite(num)) return num > 0.5;
  return undefined;
}

export function parseFieldTraceCsv(
  csvText: string,
  channelMap: FieldChannelMap,
  meta: {
    readonly id: string;
    readonly label: string;
    readonly axisId: string;
    readonly profileRole: FieldTraceDataset["profileRole"];
  },
): FieldTraceDataset {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 3) {
    throw new Error("实测录波 CSV 至少需要表头行和 2 行采样数据。");
  }

  const headers = splitCsvRow(lines[0]);
  const colIndex = (name: string | undefined, required: boolean): number => {
    if (!name?.trim()) return -1;
    const exact = headers.indexOf(name.trim());
    if (exact >= 0) return exact;
    const lower = headers.findIndex((h) => h.toLowerCase() === name.trim().toLowerCase());
    if (lower >= 0) return lower;
    if (required) throw new Error(`实测 CSV 找不到映射列“${name}”。现有列名：${headers.join("、")}`);
    return -1;
  };

  const tIdx = colIndex(channelMap.timeColumn, true);
  const pIdx = colIndex(channelMap.positionColumn, true);
  const vIdx = colIndex(channelMap.velocityColumn, false);
  const limIdx = colIndex(channelMap.limitSignalColumn, false);

  const timeOffset = channelMap.timeOffsetMs ?? 0;
  const zeroOffset = channelMap.positionZeroOffsetMm ?? 0;
  const polarity = channelMap.polarityFactor ?? 1;

  const samples: FieldTraceSample[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]);
    if (cells.length <= Math.max(tIdx, pIdx)) continue;
    const rawT = Number(cells[tIdx]);
    const rawP = Number(cells[pIdx]);
    if (!Number.isFinite(rawT) || !Number.isFinite(rawP)) continue;
    const timeMs = convertUnit(rawT, channelMap.timeUnit, "ms") + timeOffset;
    if (timeMs < -1e-6) continue;
    const clampedTimeMs = Math.max(0, timeMs);
    const posMmRaw = convertUnit(rawP, channelMap.positionUnit, "mm");
    const posScaled = (posMmRaw - zeroOffset) * polarity;
    const positionMm = posScaled === 0 ? 0 : posScaled;

    let velocityMmS: number | undefined;
    if (vIdx >= 0 && cells[vIdx] !== undefined && cells[vIdx] !== "") {
      const rawV = Number(cells[vIdx]);
      if (Number.isFinite(rawV)) {
        velocityMmS = convertUnit(rawV, channelMap.velocityUnit ?? "mm/s", "mm/s") * polarity;
      }
    }
    const limitTriggered = limIdx >= 0 && cells[limIdx] !== undefined ? parseBoolToken(cells[limIdx]) : undefined;

    samples.push({
      timeMs: clampedTimeMs,
      positionMm,
      ...(velocityMmS !== undefined && { velocityMmS }),
      ...(limitTriggered !== undefined && { limitTriggered }),
    });
  }

  samples.sort((a, b) => a.timeMs - b.timeMs);
  if (samples.length < 2) {
    throw new Error("经过时间戳对齐与有效过滤后，实测采样不足 2 点。");
  }

  return {
    id: meta.id,
    label: meta.label,
    axisId: meta.axisId,
    profileRole: meta.profileRole,
    samples,
  };
}

export function parseOpenPnpStepTrace(
  xmlText: string,
  meta: {
    readonly id: string;
    readonly label: string;
    readonly axisId: string;
    readonly profileRole?: FieldTraceDataset["profileRole"];
    readonly timeUnit?: "ms" | "s";
    readonly positionUnit?: string;
  },
): FieldTraceDataset {
  const samples: FieldTraceSample[] = [];
  const timeUnit = meta.timeUnit ?? "s";
  const posUnit = meta.positionUnit ?? "mm";
  const tagPattern = /<data-point\b([^>]+)\/?>/gi;
  for (const match of xmlText.matchAll(tagPattern)) {
    const attrs = match[1];
    const tMatch = /\btime\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const vMatch = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!tMatch || !vMatch) continue;
    const t = Number(tMatch[1]);
    const p = Number(vMatch[1]);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    const timeMs = convertUnit(t, timeUnit, "ms");
    if (timeMs < -1e-6) continue;
    samples.push({
      timeMs: Math.max(0, timeMs),
      positionMm: convertUnit(p, posUnit, "mm"),
    });
  }
  samples.sort((a, b) => a.timeMs - b.timeMs);
  if (samples.length < 2) {
    throw new Error("未能在 XML 中识别出至少 2 个有效的 <data-point time=... value=.../> 实测点。");
  }
  return {
    id: meta.id,
    label: meta.label,
    axisId: meta.axisId,
    profileRole: meta.profileRole ?? "primary_calibration",
    samples,
  };
}

function interpolateAxisFrame(
  trace: RuntimeTrace,
  axisId: string,
  timeMs: number,
): { positionMm: number; velocityMmS: number } {
  const frames = trace.frames;
  if (timeMs <= frames[0].timeMs) {
    const a = frames[0].axes[axisId];
    return { positionMm: a.positionMm, velocityMmS: a.velocityMmS };
  }
  const last = frames[frames.length - 1];
  if (timeMs >= last.timeMs) {
    const a = last.axes[axisId];
    return { positionMm: a.positionMm, velocityMmS: a.velocityMmS };
  }
  let lo = 0;
  let hi = frames.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timeMs <= timeMs) lo = mid;
    else hi = mid;
  }
  const f0 = frames[lo];
  const f1 = frames[hi];
  const a0 = f0.axes[axisId];
  const a1 = f1.axes[axisId];
  const span = f1.timeMs - f0.timeMs;
  const alpha = span > 0 ? (timeMs - f0.timeMs) / span : 0;
  return {
    positionMm: a0.positionMm + alpha * (a1.positionMm - a0.positionMm),
    velocityMmS: a0.velocityMmS + alpha * (a1.velocityMmS - a0.velocityMmS),
  };
}

function estimateSettleTimeMs(
  points: ReadonlyArray<{ readonly timeMs: number; readonly positionMm: number }>,
  finalMm: number,
): number | null {
  if (points.length < 2) return null;
  const initialMm = points[0].positionMm;
  const band = Math.max(0.05, 0.02 * Math.abs(finalMm - initialMm));
  const tailDuration = points[points.length - 1].timeMs;
  for (let i = 0; i < points.length; i++) {
    let settled = true;
    for (let j = i; j < points.length; j++) {
      if (Math.abs(points[j].positionMm - finalMm) > band) {
        settled = false;
        break;
      }
    }
    if (settled && tailDuration - points[i].timeMs >= 10) {
      return points[i].timeMs;
    }
  }
  return null;
}

export function compareRuntimeWithFieldTrace(
  trace: RuntimeTrace,
  dataset: FieldTraceDataset,
  tolerances: Partial<AlignmentToleranceSpec> = {},
): FieldComparisonReport {
  const axisSummary = trace.axisSummaries.find((a) => a.axisId === dataset.axisId);
  if (!axisSummary) {
    throw new Error(`仿真轨迹“${trace.systemName}”中不存在实测指定的轴“${dataset.axisId}”。`);
  }

  const limits: AlignmentToleranceSpec = { ...DEFAULT_ALIGNMENT_TOLERANCES, ...tolerances };
  const overlapping = dataset.samples.filter((s) => s.timeMs >= 0 && s.timeMs <= trace.durationMs);
  if (overlapping.length < 2) {
    throw new Error(`实测数据与当前仿真时间范围 [0, ${trace.durationMs} ms] 重叠不足 2 点。`);
  }

  let sqSum = 0;
  let maxErr = 0;
  let peakVelSim = 0;
  let peakVelMeas = 0;
  const overlayPoints: AlignedOverlayPoint[] = [];

  for (let i = 0; i < overlapping.length; i++) {
    const s = overlapping[i];
    const sim = interpolateAxisFrame(trace, dataset.axisId, s.timeMs);
    const err = Math.abs(sim.positionMm - s.positionMm);
    sqSum += err * err;
    maxErr = Math.max(maxErr, err);
    peakVelSim = Math.max(peakVelSim, Math.abs(sim.velocityMmS));

    let measV = s.velocityMmS;
    if (measV === undefined) {
      if (i > 0 && overlapping[i].timeMs > overlapping[i - 1].timeMs) {
        const dtS = (overlapping[i].timeMs - overlapping[i - 1].timeMs) / 1000;
        measV = (overlapping[i].positionMm - overlapping[i - 1].positionMm) / dtS;
      } else {
        measV = 0;
      }
    }
    peakVelMeas = Math.max(peakVelMeas, Math.abs(measV));

    overlayPoints.push({
      timeMs: s.timeMs,
      simPositionMm: sim.positionMm,
      measPositionMm: s.positionMm,
      errorMm: sim.positionMm - s.positionMm,
    });
  }

  const rmsPositionErrorMm = Math.sqrt(sqSum / overlapping.length);
  const peakVelocityErrorMmS = Math.abs(peakVelSim - peakVelMeas);
  const overlapDurationMs = overlapping[overlapping.length - 1].timeMs - overlapping[0].timeMs;

  const finalSample = overlapping[overlapping.length - 1];
  const simAtEnd = interpolateAxisFrame(trace, dataset.axisId, finalSample.timeMs);
  const finalPositionSimMm = simAtEnd.positionMm;
  const finalPositionMeasMm = finalSample.positionMm;
  const finalPositionErrorMm = Math.abs(finalPositionSimMm - finalPositionMeasMm);

  const settleTimeSimMs = estimateSettleTimeMs(
    trace.frames.map((f) => ({ timeMs: f.timeMs, positionMm: f.axes[dataset.axisId].positionMm })),
    axisSummary.finalPositionMm,
  );
  const settleTimeMeasMs = estimateSettleTimeMs(
    overlapping.map((s) => ({ timeMs: s.timeMs, positionMm: s.positionMm })),
    finalPositionMeasMm,
  );
  const settleTimeErrorMs =
    settleTimeSimMs !== null && settleTimeMeasMs !== null
      ? Math.abs(settleTimeSimMs - settleTimeMeasMs)
      : null;

  const limitTriggerSimMs = axisSummary.stopTriggeredAtMs;
  const firstMeasTrigger = overlapping.find((s) => s.limitTriggered === true);
  const limitTriggerMeasMs = firstMeasTrigger ? firstMeasTrigger.timeMs : null;
  const limitTriggerTimeErrorMs =
    limitTriggerSimMs !== null && limitTriggerMeasMs !== null
      ? Math.abs(limitTriggerSimMs - limitTriggerMeasMs)
      : null;

  const failedChecks: string[] = [];
  if (rmsPositionErrorMm > limits.maxRmsPositionErrorMm) {
    failedChecks.push(`位置 RMS 误差 ${rmsPositionErrorMm.toFixed(3)} mm 超过容差 ${limits.maxRmsPositionErrorMm} mm`);
  }
  if (peakVelocityErrorMmS > limits.maxPeakVelocityErrorMmS) {
    failedChecks.push(`峰值速度偏差 ${peakVelocityErrorMmS.toFixed(2)} mm/s 超过容差 ${limits.maxPeakVelocityErrorMmS} mm/s`);
  }
  if (finalPositionErrorMm > limits.maxFinalPositionErrorMm) {
    failedChecks.push(`终停位置偏差 ${finalPositionErrorMm.toFixed(3)} mm 超过容差 ${limits.maxFinalPositionErrorMm} mm`);
  }
  if (limitTriggerTimeErrorMs !== null && limitTriggerTimeErrorMs > limits.maxTriggerTimeErrorMs) {
    failedChecks.push(`限位触发时刻差 ${limitTriggerTimeErrorMs.toFixed(1)} ms 超过容差 ${limits.maxTriggerTimeErrorMs} ms`);
  }

  return {
    datasetId: dataset.id,
    datasetLabel: dataset.label,
    profileRole: dataset.profileRole,
    axisId: dataset.axisId,
    sampleCount: overlapping.length,
    overlapDurationMs,
    rmsPositionErrorMm,
    maxPositionErrorMm: maxErr,
    peakVelocitySimMmS: peakVelSim,
    peakVelocityMeasMmS: peakVelMeas,
    peakVelocityErrorMmS,
    finalPositionSimMm,
    finalPositionMeasMm,
    finalPositionErrorMm,
    settleTimeSimMs,
    settleTimeMeasMs,
    settleTimeErrorMs,
    limitTriggerSimMs,
    limitTriggerMeasMs,
    limitTriggerTimeErrorMs,
    tolerances: limits,
    withinTolerance: failedChecks.length === 0,
    failedChecks,
    overlayPoints,
  };
}

export function evaluateSystemVerificationStatus(
  primaryComparison?: FieldComparisonReport | null,
  reverifyComparison?: FieldComparisonReport | null,
): SystemVerificationStatus {
  if (!primaryComparison) {
    return {
      status: "offline_simulation_only",
      label: "离线仿真验收（待实测对标）",
      passed: false,
      detail: "尚未导入同工况现场录波或测点 CSV，目前结论仅代表基于选定样本参数的离线数字仿真。",
    };
  }
  if (!primaryComparison.withinTolerance || (reverifyComparison && !reverifyComparison.withinTolerance)) {
    const reasons = [
      ...(!primaryComparison.withinTolerance ? primaryComparison.failedChecks : []),
      ...(reverifyComparison && !reverifyComparison.withinTolerance ? reverifyComparison.failedChecks : []),
    ];
    return {
      status: "deviation_exceeded",
      label: "实测偏差超差",
      passed: false,
      detail: reasons.join("；"),
    };
  }
  if (!reverifyComparison) {
    return {
      status: "primary_aligned_pending_reverify",
      label: "首段工况已对标（待独立工况复验）",
      passed: false,
      detail: "首段标定工况在容差内；请再提供一组不同目标位移或速度的独立实测录波完成交叉复验。",
    };
  }
  return {
    status: "field_verified",
    label: "已完成双工况实测复验",
    passed: true,
    detail: `主标定与独立复验工况均在容差内（RMS 误差 ${primaryComparison.rmsPositionErrorMm.toFixed(3)} mm / ${reverifyComparison.rmsPositionErrorMm.toFixed(3)} mm）。`,
  };
}

export interface CalibrationRevisionInput {
  readonly axisId: string;
  readonly serialNumber: string;
  readonly assetTag?: string;
  readonly calibrationVersion: string;
  readonly measuredTableMassKg?: number;
  readonly measuredTriggerPositionMm?: number;
  readonly measuredDiFilterMs?: number;
  readonly note: string;
}

export function applyFieldCalibrationRevision(
  workspace: TwinWorkspace,
  system: TwinSystemAssembly,
  input: CalibrationRevisionInput,
): { workspace: TwinWorkspace; system: TwinSystemAssembly } {
  const axis = system.axes.find((a) => a.id === input.axisId);
  if (!axis) {
    throw new Error(`找不到待标定的轴“${input.axisId}”。`);
  }

  let nextWorkspace = workspace;
  let nextTableKey = axis.tableKey;

  if (input.measuredTableMassKg !== undefined) {
    if (!(input.measuredTableMassKg > 0)) {
      throw new Error("实测标定移动总质量必须大于 0 kg。");
    }
    const baseTable = workspace.packages.find((p) => packageKey(p) === axis.tableKey);
    if (!baseTable) {
      throw new Error(`找不到当前工作台设备包：${axis.tableKey}`);
    }
    const baseWithoutFeed = { ...baseTable };
    delete (baseWithoutFeed as Partial<DevicePackage>).feed;
    const calibratedRevision = `${baseTable.revision}-${input.calibrationVersion}`;
    const calibratedPkg = parseDevicePackage({
      ...baseWithoutFeed,
      revision: calibratedRevision,
      source: {
        kind: "local",
        url: baseTable.source.url,
        title: `${baseTable.model} 实测标定修订`,
        locator: `资产 S/N ${input.serialNumber} · ${input.calibrationVersion}`,
        excerpt: `基于实机录波对标将等效移动质量标定为 ${input.measuredTableMassKg} kg（${input.note}）。`,
      },
      parameters: {
        ...(baseTable.parameters ?? {}),
        massKg: {
          status: "measured",
          value: input.measuredTableMassKg,
          unit: "kg",
          label: "实测标定移动总质量",
          condition: input.note,
          locator: `资产 S/N ${input.serialNumber} · ${input.calibrationVersion}`,
          excerpt: `measured massKg = ${input.measuredTableMassKg} kg`,
        },
      },
      modelBindings: [
        {
          id: "calibrated-table-mass",
          modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
          mappings: [{ kind: "parameter", source: "massKg", target: "massKg" }],
        },
      ],
    });
    nextWorkspace = installPackage(workspace, calibratedPkg);
    nextTableKey = packageKey(calibratedPkg);
  }

  const nextSensors = input.measuredTriggerPositionMm !== undefined
    ? system.sensors.map((s) =>
        s.axisId === input.axisId
          ? {
              ...s,
              triggerPositionMm: input.measuredTriggerPositionMm,
              provenance: "confirmed" as const,
              note: `S/N ${input.serialNumber} 实测开关坐标（${input.calibrationVersion}）`,
            }
          : s,
      )
    : system.sensors;

  const axisSensorIds = new Set(system.sensors.filter((s) => s.axisId === input.axisId).map((s) => s.id));
  const axisDiIds = new Set<string>();
  for (const w of system.wires) {
    if (w.from.kind === "sensor" && axisSensorIds.has(w.from.nodeId) && w.to.kind === "di") {
      axisDiIds.add(w.to.nodeId);
    }
  }
  const nextDis = input.measuredDiFilterMs !== undefined
    ? system.diChannels.map((d) =>
        axisDiIds.has(d.id)
          ? {
              ...d,
              filterMs: input.measuredDiFilterMs,
              provenance: "confirmed" as const,
              note: `S/N ${input.serialNumber} 实测通道滤波（${input.calibrationVersion}）`,
            }
          : d,
      )
    : system.diChannels;

  const bindingRecord = {
    axisId: input.axisId,
    serialNumber: input.serialNumber,
    ...(input.assetTag ? { assetTag: input.assetTag } : {}),
    calibrationVersion: input.calibrationVersion,
    note: input.note,
  };
  const prevBindings = system.assetBindings ?? [];
  const nextBindings = prevBindings.some((b) => b.axisId === input.axisId)
    ? prevBindings.map((b) => (b.axisId === input.axisId ? bindingRecord : b))
    : [...prevBindings, bindingRecord];

  const nextSystem = parseTwinSystemAssembly({
    ...system,
    axes: system.axes.map((a) =>
      a.id === input.axisId ? { ...a, tableKey: nextTableKey, provenance: "confirmed" as const } : a,
    ),
    sensors: nextSensors,
    diChannels: nextDis,
    assetBindings: nextBindings,
  });

  return { workspace: nextWorkspace, system: nextSystem };
}
