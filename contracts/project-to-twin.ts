import { evaluateBindingReadiness } from "./device-model-binding";
import { calculateModule } from "./engineering";
import type { MaterialRow } from "./import-catalog";
import type { StudioTarget } from "./studio-navigation";
import { parseTwinSystemAssembly, type TwinSystemAssembly } from "./system-twin";
import {
  packageKey,
  parseDevicePackage,
  type DeviceModelBinding,
  type DevicePackage,
  type DeviceParameterEntry,
} from "./twin-device";
import { emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "./twin-simulation";
import { convertUnit, parseQuantityText } from "./units";

export interface ProjectComponentRevisionInput {
  readonly id: number;
  readonly manufacturer: string;
  readonly model: string;
  readonly category: string;
  readonly revisionLabel: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly sourceVersion?: string | null;
  readonly sourceLocator: string;
  readonly sourceEvidence: string;
  readonly parameters: Record<string, unknown>;
}

export interface ProjectModuleInput {
  readonly id: number;
  readonly moduleKey: string;
  readonly instanceName: string;
  readonly configuration: Record<string, number>;
  readonly selectedComponentRevisionIds: Record<string, number>;
}

function parseParameterEntry(
  rawValue: unknown,
  label: string,
  locator: string,
  targetUnit: string,
): DeviceParameterEntry | undefined {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return { status: "catalog", value: rawValue, unit: targetUnit, label, locator };
  }
  if (typeof rawValue !== "string") return undefined;
  const text = rawValue.trim();
  if (!text) return undefined;

  // 解析类似 "0.277 ×10⁻⁴ kg·m²（带制动 0.30）" 的含括注选件分支
  const dualMatch = /^([^（(]+)[（(]([^）)]+)[）)]$/.exec(text);
  if (dualMatch) {
    const baseQty = parseQuantityText(dualMatch[1].trim());
    const optNumMatch = /([+-]?\d+(?:\.\d+)?)\s*(.*)$/.exec(dualMatch[2].trim());
    if (baseQty && optNumMatch) {
      const optVal = Number(optNumMatch[1]);
      const optRawUnit = optNumMatch[2].trim();
      const optQty = optRawUnit ? parseQuantityText(`${optVal} ${optRawUnit}`) : undefined;
      const optUnit = optQty?.unit ?? baseQty.unit;
      try {
        convertUnit(baseQty.value, baseQty.unit, targetUnit);
        convertUnit(optVal, optUnit, targetUnit);
        return {
          status: "pending",
          unit: baseQty.unit,
          label,
          reason: `样本同一行存在多种订货选件，需确认当前选件（原值：${text}）。`,
          candidates: [
            { option: "标准 / 默认选件", value: baseQty.value, unit: baseQty.unit, locator, excerpt: text },
            { option: dualMatch[2].trim(), value: optVal, unit: optUnit, locator, excerpt: text },
          ],
        };
      } catch {
        // 量纲不一致时不按双选件生成
      }
    }
  }

  const qty = parseQuantityText(text);
  if (!qty) return undefined;
  try {
    convertUnit(qty.value, qty.unit, targetUnit);
  } catch {
    return undefined;
  }
  return {
    status: "catalog",
    value: qty.value,
    unit: qty.unit,
    label,
    locator,
    excerpt: text,
  };
}

function buildSourceObject(rev: ProjectComponentRevisionInput) {
  const safeUrl = /^https?:\/\//i.test(rev.sourceUrl.trim()) ? rev.sourceUrl.trim() : "";
  const baseLocator = rev.sourceLocator || rev.revisionLabel || "official-catalog";
  const locator = rev.sourceVersion ? `${baseLocator}（${rev.sourceVersion}）` : baseLocator;
  return safeUrl
    ? {
        url: safeUrl,
        title: rev.sourceTitle || `${rev.manufacturer} ${rev.model}`,
        locator,
        excerpt: rev.sourceEvidence || `${rev.manufacturer} ${rev.model}`,
      }
    : {
        kind: "local" as const,
        url: "",
        title: rev.sourceTitle || `${rev.manufacturer} ${rev.model}`,
        locator,
        excerpt: rev.sourceEvidence || `${rev.manufacturer} ${rev.model}`,
      };
}

const MOTOR_FIELD_MAP: ReadonlyArray<{
  readonly seedKeys: readonly string[];
  readonly targetKey: string;
  readonly label: string;
  readonly unit: string;
}> = [
  { seedKeys: ["rotorInertia", "rotorInertiaKgM2"], targetKey: "rotorInertiaKgM2", label: "转子转动惯量", unit: "kg.m2" },
  { seedKeys: ["ratedTorque", "nominalTorque", "ratedTorqueNm"], targetKey: "ratedTorqueNm", label: "额定转矩", unit: "N.m" },
  { seedKeys: ["momentaryPeakTorque", "maximumTorque", "stallTorque", "peakTorqueNm"], targetKey: "peakTorqueNm", label: "峰值转矩", unit: "N.m" },
  { seedKeys: ["ratedOutput", "ratedPower", "ratedPowerW"], targetKey: "ratedPowerW", label: "额定功率", unit: "W" },
  { seedKeys: ["ratedSpeed", "nominalSpeed", "ratedSpeedRpm"], targetKey: "ratedSpeedRpm", label: "额定转速", unit: "rpm" },
  { seedKeys: ["maximumSpeed", "maxSpeedRpm"], targetKey: "maxSpeedRpm", label: "最高转速", unit: "rpm" },
  { seedKeys: ["ratedCurrent", "nominalCurrent", "motorRatedCurrentA"], targetKey: "motorRatedCurrentA", label: "额定电流", unit: "A" },
];

const DRIVE_FIELD_MAP: ReadonlyArray<{
  readonly seedKeys: readonly string[];
  readonly targetKey: string;
  readonly label: string;
  readonly unit: string;
}> = [
  { seedKeys: ["ratedCurrent", "continuousCurrent", "driveRatedCurrentA"], targetKey: "driveRatedCurrentA", label: "驱动器额定电流", unit: "A" },
  { seedKeys: ["peakCurrent", "maximumCurrent", "drivePeakCurrentA"], targetKey: "drivePeakCurrentA", label: "驱动器峰值电流", unit: "A" },
];

const SCREW_FIELD_MAP: ReadonlyArray<{
  readonly seedKeys: readonly string[];
  readonly targetKey: string;
  readonly label: string;
  readonly unit: string;
}> = [
  { seedKeys: ["lead", "leadMmPerRev", "leadMm"], targetKey: "leadMmPerRev", label: "丝杠导程", unit: "mm/rev" },
];

export function componentRevisionToDevicePackage(rev: ProjectComponentRevisionInput): DevicePackage | undefined {
  const loc = rev.sourceLocator || rev.revisionLabel || "catalog";
  const parameters: Record<string, DeviceParameterEntry> = {};
  const bindings: DeviceModelBinding[] = [];

  if (rev.category === "servo_motor") {
    for (const def of MOTOR_FIELD_MAP) {
      for (const k of def.seedKeys) {
        if (k in rev.parameters) {
          const parsed = parseParameterEntry(rev.parameters[k], def.label, loc, def.unit);
          if (parsed) {
            parameters[def.targetKey] = parsed;
            break;
          }
        }
      }
    }
    bindings.push({
      id: "project-servo-motor",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      mappings: Object.keys(parameters).map((key) => ({
        kind: "parameter" as const,
        source: key,
        target: key,
      })),
    });
  } else if (rev.category === "servo_drive") {
    for (const def of DRIVE_FIELD_MAP) {
      for (const k of def.seedKeys) {
        if (k in rev.parameters) {
          const parsed = parseParameterEntry(rev.parameters[k], def.label, loc, def.unit);
          if (parsed) {
            parameters[def.targetKey] = parsed;
            break;
          }
        }
      }
    }
    bindings.push({
      id: "project-servo-drive",
      modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
      mappings: Object.keys(parameters).map((key) => ({
        kind: "parameter" as const,
        source: key,
        target: key,
      })),
    });
  } else if (rev.category === "ball_screw") {
    for (const def of SCREW_FIELD_MAP) {
      for (const k of def.seedKeys) {
        if (k in rev.parameters) {
          const parsed = parseParameterEntry(rev.parameters[k], def.label, loc, def.unit);
          if (parsed) {
            parameters[def.targetKey] = parsed;
            break;
          }
        }
      }
    }
    bindings.push({
      id: "project-ball-screw",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      mappings: Object.keys(parameters).map((key) => ({
        kind: "parameter" as const,
        source: key,
        target: key,
      })),
    });
  } else {
    // 非当前直驱丝杠闭环模型角色（如导轨/减速机/编码器）保留资料记录而不硬塞进不匹配模型
    return undefined;
  }

  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer: rev.manufacturer,
    model: rev.model,
    revision: rev.revisionLabel || `rev-${rev.id}`,
    source: buildSourceObject(rev),
    ports: [],
    rules: [],
    ...(Object.keys(parameters).length > 0 && { parameters }),
    modelBindings: bindings,
  });
}

function assumedPackage(
  manufacturer: string,
  model: string,
  revision: string,
  note: string,
  modelRef: { id: string; version: string },
  entries: Record<string, { value: number; unit: string; label: string }>,
): DevicePackage {
  const parameters: Record<string, DeviceParameterEntry> = {};
  for (const [k, spec] of Object.entries(entries)) {
    parameters[k] = {
      status: "assumed",
      value: spec.value,
      unit: spec.unit,
      label: spec.label,
      condition: note,
      locator: "项目一阶初算",
    };
  }
  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer,
    model,
    revision,
    source: {
      kind: "local",
      url: "",
      title: note,
      locator: "项目一阶初算草案",
      excerpt: note,
    },
    ports: [],
    rules: [],
    parameters,
    modelBindings: [
      {
        id: `assumed-${modelRef.id.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
        modelRef,
        mappings: Object.keys(parameters).map((key) => ({ kind: "parameter" as const, source: key, target: key })),
      },
    ],
  });
}

export interface ProjectToTwinConversionResult {
  readonly workspace: TwinWorkspace;
  readonly primaryTarget?: StudioTarget;
  readonly convertedPackages: number;
  readonly assumedRoles: readonly string[];
  readonly pendingDiagnostics: readonly string[];
}

export function convertProjectToTwinWorkspace(input: {
  readonly projectCode: string;
  readonly projectName: string;
  readonly modules: readonly ProjectModuleInput[];
  readonly componentRevisions: readonly ProjectComponentRevisionInput[];
  readonly baseWorkspace?: TwinWorkspace;
}): ProjectToTwinConversionResult {
  let ws = input.baseWorkspace ? parseWorkspace(input.baseWorkspace) : emptyWorkspace();
  const revMap = new Map<number, ProjectComponentRevisionInput>(input.componentRevisions.map((r) => [r.id, r]));
  const pkgByRevId = new Map<number, DevicePackage>();
  const materialRows: MaterialRow[] = [...(ws.catalog?.materials ?? [])];
  const existingMaterialIds = new Set(materialRows.map((m) => m.id));
  const pendingDiagnostics: string[] = [];
  let convertedPackages = 0;

  for (const rev of input.componentRevisions) {
    try {
      const pkg = componentRevisionToDevicePackage(rev);
      if (pkg) {
        ws = installPackage(ws, pkg);
        pkgByRevId.set(rev.id, pkg);
        convertedPackages++;
      }
    } catch (error) {
      pendingDiagnostics.push(
        `官方部件修订 ${rev.manufacturer} · ${rev.model} 尚未确定具体订货型号或完整模型参数（${error instanceof Error ? error.message : "待核对"}）。`,
      );
    }
    const matId = `proj-rev-${rev.id}`;
    if (!existingMaterialIds.has(matId)) {
      existingMaterialIds.add(matId);
      materialRows.push({
        id: matId,
        name: rev.model,
        quantity: 1,
        manufacturer: rev.manufacturer,
        model: rev.model,
        source: rev.sourceUrl || rev.sourceLocator,
      });
    }
  }

  const assumedRoles: string[] = [];
  const linearModules = input.modules.filter((m) => m.moduleKey === "linear_axis");

  const axes: TwinSystemAssembly["axes"] = [];
  const sensors: TwinSystemAssembly["sensors"] = [];
  const diChannels: TwinSystemAssembly["diChannels"] = [];
  const wires: TwinSystemAssembly["wires"] = [];
  const controllers: TwinSystemAssembly["controllers"] = [];

  for (const [idx, mod] of linearModules.entries()) {
    const axisId = `proj-axis-${mod.id}`;
    const cfg = mod.configuration;
    const calc = calculateModule("linear_axis", cfg);

    const estTorqueBase = calc.metrics.screwTorqueNm ?? calc.metrics.motorTorqueNm ?? 0.5;

    let drivePkg = mod.selectedComponentRevisionIds.servo_drive
      ? pkgByRevId.get(mod.selectedComponentRevisionIds.servo_drive)
      : undefined;
    if (!drivePkg) {
      const estCurrentA = Math.max(1.5, Number((estTorqueBase / 0.45).toFixed(2)));
      drivePkg = assumedPackage(
        "项目初算假设",
        `${mod.instanceName} 驱动草案`,
        `pilot-${mod.id}`,
        `未选定正式驱动器修订，按初算需求 ${estCurrentA} A 生成草案`,
        { id: "Gouyuan.PositionDrive", version: "1.0.0" },
        {
          driveRatedCurrentA: { value: estCurrentA, unit: "A", label: "初算等效额定电流" },
          drivePeakCurrentA: { value: Number((estCurrentA * 2.5).toFixed(2)), unit: "A", label: "初算等效峰值电流" },
        },
      );
      ws = installPackage(ws, drivePkg);
      assumedRoles.push(`${mod.instanceName} · 伺服驱动器`);
    }

    let motorPkg = mod.selectedComponentRevisionIds.servo_motor
      ? pkgByRevId.get(mod.selectedComponentRevisionIds.servo_motor)
      : undefined;
    if (!motorPkg) {
      const estPowerW = Math.max(100, Math.round(calc.metrics.peakPowerW || 200));
      const estTorqueNm = Math.max(0.32, Number(estTorqueBase.toFixed(3)));
      const estSpeedRpm = Math.max(1500, Math.round(calc.metrics.screwSpeedRpm || 3000));
      motorPkg = assumedPackage(
        "项目初算假设",
        `${mod.instanceName} 电机草案`,
        `pilot-${mod.id}`,
        "未选定正式伺服电机修订，按一阶初算峰值需求估算",
        { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
        {
          rotorInertiaKgM2: { value: 0.00002, unit: "kg.m2", label: "假设转子惯量" },
          ratedTorqueNm: { value: estTorqueNm, unit: "N.m", label: "初算需求转矩" },
          ratedPowerW: { value: estPowerW, unit: "W", label: "初算需求功率" },
          ratedSpeedRpm: { value: estSpeedRpm, unit: "rpm", label: "初算需求转速" },
        },
      );
      ws = installPackage(ws, motorPkg);
      assumedRoles.push(`${mod.instanceName} · 伺服电机`);
    }

    let screwPkg = mod.selectedComponentRevisionIds.ball_screw
      ? pkgByRevId.get(mod.selectedComponentRevisionIds.ball_screw)
      : undefined;
    if (!screwPkg) {
      const rev = mod.selectedComponentRevisionIds.ball_screw
        ? revMap.get(mod.selectedComponentRevisionIds.ball_screw)
        : undefined;
      if (rev) {
        pendingDiagnostics.push(`${mod.instanceName} 所选丝杠“${rev.model}”未能识别出有效导程。`);
      }
      screwPkg = assumedPackage(
        "项目初算假设",
        `${mod.instanceName} 丝杠草案 (${cfg.leadMm ?? 10} mm)`,
        `pilot-${mod.id}`,
        `源自项目直线轴配置 leadMm = ${cfg.leadMm ?? 10} mm/rev`,
        { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
        {
          leadMmPerRev: { value: cfg.leadMm ?? 10, unit: "mm/rev", label: "初算丝杠导程" },
        },
      );
      ws = installPackage(ws, screwPkg);
      assumedRoles.push(`${mod.instanceName} · 滚珠丝杠导程`);
    }

    const tablePkg = assumedPackage(
      "项目初算假设",
      `${mod.instanceName} 负载滑台 (${cfg.movingMassKg ?? 10} kg)`,
      `pilot-${mod.id}`,
      `源自项目直线轴配置 movingMassKg = ${cfg.movingMassKg ?? 10} kg`,
      { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
      {
        massKg: { value: cfg.movingMassKg ?? 10, unit: "kg", label: "初算移动总质量" },
      },
    );
    ws = installPackage(ws, tablePkg);

    // 核对各部件是否仍有待确认选件或缺失目录参数
    let axisPending = false;
    for (const [rolePkg, modelId] of [
      [drivePkg, "Gouyuan.PositionDrive"],
      [motorPkg, "Gouyuan.RatedTorqueMotor"],
      [screwPkg, "Gouyuan.IdealLeadScrew"],
    ] as const) {
      const readiness = evaluateBindingReadiness(rolePkg, { id: modelId, version: "1.0.0" });
      if (readiness.status === "pending" || readiness.status === "incomplete") {
        axisPending = true;
        pendingDiagnostics.push(`${mod.instanceName} · ${rolePkg.model}：${readiness.issues.join("；")}`);
      }
    }

    const direction: [number, number, number] =
      idx % 3 === 0 ? [1, 0, 0] : idx % 3 === 1 ? [0, 1, 0] : [0, 0, 1];
    const targetMm = Math.min(200, Math.max(10, cfg.travelMm ?? 100));
    const triggerMm = Number((targetMm * 0.85).toFixed(2));
    const swId = `${axisId}-sw`;
    const diId = `${axisId}-di`;
    const ctrlId = `${axisId}-ctrl`;

    axes.push({
      id: axisId,
      name: mod.instanceName,
      direction,
      originMm: [0, idx * 60, 0],
      factor: 1,
      driveKey: packageKey(drivePkg),
      motorKey: packageKey(motorPkg),
      screwKey: packageKey(screwPkg),
      tableKey: packageKey(tablePkg),
      provenance: axisPending ? "pending" : "inferred",
      note: `转入自客户项目 ${input.projectCode}（${mod.instanceName}）`,
    });

    sensors.push({
      id: swId,
      name: `${mod.instanceName} 限位草案开关 (NC)`,
      axisId,
      triggerPositionMm: triggerMm,
      senseDistanceMm: 4,
      triggerMode: "positive_overtravel",
      normallyClosed: true,
      supplyVoltageV: 24,
      provenance: "inferred",
      note: `按行程 85% (${triggerMm} mm) 自动预设，请在孪生工作台核对安装坐标`,
    });

    diChannels.push({
      id: diId,
      name: `${mod.instanceName} DI 滤波通道`,
      onAboveV: 15,
      offBelowV: 5,
      filterMs: 10,
      provenance: "inferred",
      note: "默认 10 ms 防抖延时（待对接实机 DI 模块型号）",
    });

    wires.push(
      {
        id: `${axisId}-w-v`,
        from: { kind: "sensor", nodeId: swId, portId: "voltageOut" },
        to: { kind: "di", nodeId: diId, portId: "voltageIn" },
        provenance: "inferred",
      },
      {
        id: `${axisId}-w-pos`,
        from: { kind: "di", nodeId: diId, portId: "stateOut" },
        to: { kind: "controller", nodeId: ctrlId, portId: "posLimitIn" },
        invert: true,
        provenance: "inferred",
      },
    );

    controllers.push({
      id: ctrlId,
      axisId,
      mode: "move_with_limit_stop",
      targetMm,
      cruiseVelocityMmS: Math.max(10, cfg.maxSpeedMmS ?? 120),
      initialPositionMm: 0,
      stopOnPosLimit: true,
      stopOnNegLimit: false,
      stopOnHome: false,
    });
  }

  let primaryTarget: StudioTarget | undefined;
  if (axes.length > 0) {
    const sysId = `proj-${input.projectCode.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`.slice(0, 60);
    const sys = parseTwinSystemAssembly({
      schemaVersion: 1,
      kind: "system-twin-assembly",
      id: sysId,
      name: `${input.projectName} · 联调孪生草案`,
      commStepMs: 1,
      durationMs: 1500,
      axes,
      sensors,
      diChannels,
      wires,
      controllers,
    });
    ws = { ...ws, systems: [...(ws.systems ?? []), sys] };
    primaryTarget = `system:${sys.id}`;
  }

  if (materialRows.length > 0) {
    ws = {
      ...ws,
      catalog: {
        models: ws.catalog?.models ?? [],
        materials: materialRows,
      },
    };
  }

  return {
    workspace: parseWorkspace(ws),
    primaryTarget,
    convertedPackages,
    assumedRoles,
    pendingDiagnostics,
  };
}
