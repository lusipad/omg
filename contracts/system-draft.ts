import {
  bindingForModelId,
  capabilitiesForDevice,
  hasFeedRole,
  hasServoRole,
} from "./device-model-binding";
import {
  parseTwinSystemAssembly,
  type LinkProvenance,
  type SystemAxisController,
  type SystemAxisUnit,
  type SystemDiChannelNode,
  type SystemLimitSensorNode,
  type SystemSignalWire,
  type TwinSystemAssembly,
} from "./system-twin";
import { packageKey, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export interface ParsedIniJoint {
  readonly index: number;
  readonly coordinate?: "X" | "Y" | "Z" | "A";
  readonly factor: 1 | -1;
  readonly minLimitMm?: number;
  readonly maxLimitMm?: number;
  readonly maxVelocityMmS?: number;
  readonly homeSearchVelMmS?: number;
}

export interface ParsedHalWireSpec {
  readonly signalName: string;
  readonly sourcePin: string;
  readonly invert: boolean;
  readonly targets: ReadonlyArray<{
    readonly jointIndex: number;
    readonly portId: "posLimitIn" | "negLimitIn" | "homeSwitchIn";
  }>;
  readonly debounceDelaySamples?: number;
}

export interface ParsedLinuxCncConfig {
  readonly commStepMs: number;
  readonly joints: readonly ParsedIniJoint[];
  readonly halWires: readonly ParsedHalWireSpec[];
  readonly debounceDelaysMs: Readonly<Record<string, number>>;
}

function stripIniComment(line: string): string {
  const hash = line.indexOf("#");
  const semi = line.indexOf(";");
  const cut = [hash, semi].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return (cut !== undefined ? line.slice(0, cut) : line).trim();
}

export function parseLinuxCncConfig(iniText: string, halText: string): ParsedLinuxCncConfig {
  let section = "";
  let commStepMs = 1;
  let linearScaleToMm = 1;
  const axisCoords = new Map<number, "X" | "Y" | "Z" | "A">();
  const jointMap = new Map<number, {
    index: number;
    coordinate?: "X" | "Y" | "Z" | "A";
    factor: 1 | -1;
    minLimitMm?: number;
    maxLimitMm?: number;
    maxVelocityMmS?: number;
    homeSearchVelMmS?: number;
  }>();

  const ensureJoint = (index: number) => {
    let entry = jointMap.get(index);
    if (!entry) {
      entry = { index, coordinate: axisCoords.get(index), factor: 1 };
      jointMap.set(index, entry);
    }
    return entry;
  };

  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = stripIniComment(rawLine);
    if (!line) continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      section = secMatch[1].trim().toUpperCase();
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toUpperCase();
    const rawVal = kv[2].trim();
    const numVal = Number(rawVal);

    if (section === "TRAJ") {
      if (key === "COORDINATES") {
        const letters = rawVal.replace(/\s+/g, "").toUpperCase();
        for (let i = 0; i < letters.length; i++) {
          const ch = letters[i];
          if (ch === "X" || ch === "Y" || ch === "Z" || ch === "A") {
            axisCoords.set(i, ch);
          }
        }
      } else if (key === "LINEAR_UNITS" && rawVal.toLowerCase() === "inch") {
        linearScaleToMm = 25.4;
      }
      continue;
    }

    if (section === "EMCMOT" && key === "SERVO_PERIOD" && Number.isFinite(numVal) && numVal > 0) {
      commStepMs = Math.max(1, Math.min(10, Math.round(numVal / 1_000_000)));
      continue;
    }

    const jointMatch = /^JOINT_(\d+)$/.exec(section);
    if (jointMatch) {
      const idx = Number(jointMatch[1]);
      const joint = ensureJoint(idx);
      if ((key === "ENCODER_SCALE" || key === "SCALE" || key === "STEP_SCALE") && Number.isFinite(numVal) && numVal !== 0) {
        joint.factor = numVal < 0 ? -1 : 1;
      } else if (key === "MIN_LIMIT" && Number.isFinite(numVal)) {
        joint.minLimitMm = numVal * linearScaleToMm;
      } else if (key === "MAX_LIMIT" && Number.isFinite(numVal)) {
        joint.maxLimitMm = numVal * linearScaleToMm;
      } else if (key === "MAX_VELOCITY" && Number.isFinite(numVal) && numVal > 0) {
        joint.maxVelocityMmS = numVal * linearScaleToMm;
      } else if (key === "HOME_SEARCH_VEL" && Number.isFinite(numVal)) {
        joint.homeSearchVelMmS = numVal * linearScaleToMm;
      }
    }
  }

  // 解析 HAL setp debounce 与 net 连线（支持多扇出和 -not 取反）
  const debounceDelays = new Map<string, number>();
  const signals = new Map<string, string[]>();

  for (const rawLine of halText.split(/\r?\n/)) {
    const line = stripIniComment(rawLine);
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const cmd = tokens[0]?.toLowerCase();
    if (cmd === "setp" && tokens.length >= 3) {
      const paramName = tokens[1];
      const delayMatch = /^(debounce\.(\d+))\.delay$/i.exec(paramName);
      const val = Number(tokens[2]);
      if (delayMatch && Number.isFinite(val) && val >= 0) {
        debounceDelays.set(delayMatch[1], val * commStepMs);
      }
    } else if (cmd === "net" && tokens.length >= 3) {
      const sigName = tokens[1];
      const pins = tokens.slice(2).filter((tok) => tok !== "<=" && tok !== "=>" && tok !== "<=>");
      if (!pins.length) continue;
      const existing = signals.get(sigName) ?? [];
      existing.push(...pins);
      signals.set(sigName, existing);
    }
  }

  // 建立 debounce channel -> signal 间接链路
  const debounceInToSource = new Map<string, { pin: string; delayMs?: number }>();
  for (const pins of signals.values()) {
    const sourcePin = pins.find((p) => !/^joint\.\d+\./.test(p) && !/^debounce\.\d+\.\d+\.in$/.test(p));
    if (!sourcePin) continue;
    for (const p of pins) {
      const dbIn = /^(debounce\.\d+)\.(\d+)\.in$/i.exec(p);
      if (dbIn) {
        debounceInToSource.set(`${dbIn[1]}.${dbIn[2]}.out`, {
          pin: sourcePin,
          delayMs: debounceDelays.get(dbIn[1]),
        });
      }
    }
  }

  const halWires: ParsedHalWireSpec[] = [];
  for (const [signalName, pins] of signals.entries()) {
    const targets: Array<{ jointIndex: number; portId: "posLimitIn" | "negLimitIn" | "homeSwitchIn" }> = [];
    let sourcePin: string | undefined;
    let debounceDelaySamples: number | undefined;

    for (const pin of pins) {
      const jMatch = /^joint\.(\d+)\.(pos-lim-sw-in|neg-lim-sw-in|home-sw-in)$/i.exec(pin);
      if (jMatch) {
        const jointIndex = Number(jMatch[1]);
        const portMap = {
          "pos-lim-sw-in": "posLimitIn",
          "neg-lim-sw-in": "negLimitIn",
          "home-sw-in": "homeSwitchIn",
        } as const;
        targets.push({ jointIndex, portId: portMap[jMatch[2].toLowerCase() as keyof typeof portMap] });
        ensureJoint(jointIndex);
        continue;
      }
      const dbOut = /^(debounce\.\d+)\.(\d+)\.out$/i.exec(pin);
      if (dbOut) {
        const upstream = debounceInToSource.get(`${dbOut[1]}.${dbOut[2]}.out`);
        sourcePin = upstream?.pin ?? pin;
        debounceDelaySamples = upstream?.delayMs ?? debounceDelays.get(dbOut[1]);
      } else if (!sourcePin) {
        sourcePin = pin;
      }
    }

    if (targets.length && sourcePin) {
      halWires.push({
        signalName,
        sourcePin,
        invert: /-not$/i.test(sourcePin),
        targets,
        ...(debounceDelaySamples !== undefined && { debounceDelaySamples }),
      });
    }
  }

  const debounceDelaysMs: Record<string, number> = {};
  for (const [k, v] of debounceDelays.entries()) debounceDelaysMs[k] = v;

  return {
    commStepMs,
    joints: [...jointMap.values()].sort((a, b) => a.index - b.index),
    halWires,
    debounceDelaysMs,
  };
}

export interface SystemDraftOptions {
  readonly id?: string;
  readonly name?: string;
  readonly iniText?: string;
  readonly halText?: string;
  readonly defaultTriggerPositionMm?: number;
  readonly defaultTargetMm?: number;
  readonly defaultCruiseVelocityMmS?: number;
  readonly durationMs?: number;
}

function axisDirectionFor(coordinate: "X" | "Y" | "Z" | "A" | undefined, index: number): [number, number, number] {
  if (coordinate === "X" || (coordinate === undefined && index === 0)) return [1, 0, 0];
  if (coordinate === "Y" || (coordinate === undefined && index === 1)) return [0, 1, 0];
  return [0, 0, 1];
}

export function draftSystemFromWorkspace(
  workspace: TwinWorkspace,
  options: SystemDraftOptions = {},
): TwinSystemAssembly {
  const drives = workspace.packages.filter((p) => hasServoRole(p, "drive"));
  const motors = workspace.packages.filter((p) => hasServoRole(p, "motor"));
  const screws = workspace.packages.filter((p) => hasFeedRole(p, "screw"));
  const tables = workspace.packages.filter((p) => hasFeedRole(p, "table"));
  const diPackages = workspace.packages.filter((p) =>
    Boolean(bindingForModelId(p, "GouyuanSignal.DigitalInputChannel")),
  );
  const sensorPackages = workspace.packages.filter((p) =>
    Boolean(bindingForModelId(p, "GouyuanSignal.PositionLimitSwitch")),
  );

  if (!drives.length || !motors.length || !screws.length || !tables.length) {
    const missing: string[] = [];
    if (!drives.length) missing.push("伺服驱动器");
    if (!motors.length) missing.push("伺服电机");
    if (!screws.length) missing.push("滚珠丝杠");
    if (!tables.length) missing.push("移动工作台/负载");
    throw new Error(`当前工程缺少组装机电系统所需的设备包：${missing.join("、")}。请先从资料库导入或安装对应设备。`);
  }

  const pickMotor = (drivePkg: DevicePackage): { pkg: DevicePackage; ambiguous: boolean } => {
    const compatible = motors.filter((m) => {
      const compat = m.servo?.kind === "motor"
        ? m.servo.compatibleDriveModels
        : bindingForModelId(m, "Gouyuan.RatedTorqueMotor")?.compatiblePeerModels ?? [];
      return !compat.length || compat.includes(drivePkg.model);
    });
    const pool = compatible.length ? compatible : motors;
    return { pkg: pool[0], ambiguous: pool.length > 1 || compatible.length === 0 };
  };

  const drivePkg = drives[0];
  const motorChoice = pickMotor(drivePkg);
  const screwPkg = screws[0];
  const tablePkg = tables[0];
  const diPkg = diPackages[0];
  const sensorPkg = sensorPackages[0];

  const multipleAxisCandidates =
    drives.length > 1 || motorChoice.ambiguous || screws.length > 1 || tables.length > 1;
  const diCapable = diPkg
    ? capabilitiesForDevice(diPkg, workspace.packages).capabilities.some(
        (c) => c.modelRef.id === "GouyuanSignal.DigitalInputChannel" && c.available,
      )
    : false;

  const hasIniOrHal = Boolean(options.iniText?.trim() || options.halText?.trim());
  const parsedConfig = hasIniOrHal
    ? parseLinuxCncConfig(options.iniText ?? "", options.halText ?? "")
    : undefined;

  const jointsToBuild: ParsedIniJoint[] = parsedConfig?.joints.length
    ? [...parsedConfig.joints]
    : [{ index: 0, coordinate: "X", factor: 1 }];

  const axes: SystemAxisUnit[] = [];
  const sensors: SystemLimitSensorNode[] = [];
  const diChannels: SystemDiChannelNode[] = [];
  const wires: SystemSignalWire[] = [];
  const controllers: SystemAxisController[] = [];

  const defaultDebounceMs = parsedConfig
    ? Object.values(parsedConfig.debounceDelaysMs)[0]
    : undefined;

  for (const joint of jointsToBuild) {
    const axisId = `axis-${joint.coordinate?.toLowerCase() ?? joint.index}-${joint.index}`;
    const ctrlId = `${axisId}-ctrl`;
    const sensorId = `${axisId}-limit-sw`;
    const diId = `${axisId}-di`;

    const axisProvenance: LinkProvenance = multipleAxisCandidates
      ? "pending"
      : parsedConfig
        ? "confirmed"
        : "inferred";

    axes.push({
      id: axisId,
      name: joint.coordinate ? `${joint.coordinate} 轴（Joint ${joint.index}）` : `进给轴 #${joint.index + 1}`,
      direction: axisDirectionFor(joint.coordinate, joint.index),
      originMm: [0, joint.index * 50, 0],
      factor: joint.factor,
      driveKey: packageKey(drivePkg),
      motorKey: packageKey(motorChoice.pkg),
      screwKey: packageKey(screwPkg),
      tableKey: packageKey(tablePkg),
      provenance: axisProvenance,
      ...(multipleAxisCandidates && { note: "存在多个候选伺服/丝杠部件，请人工确认实际装机型号。" }),
    });

    const halForJoint = parsedConfig?.halWires.filter((hw) =>
      hw.targets.some((t) => t.jointIndex === joint.index),
    ) ?? [];
    const primaryHal = halForJoint[0];
    const hasNegTarget = primaryHal?.targets.some((t) => t.portId === "negLimitIn") ?? false;
    const hasPosTarget = primaryHal?.targets.some((t) => t.portId === "posLimitIn") ?? true;

    let triggerPositionMm = options.defaultTriggerPositionMm;
    let sensorProvenance: LinkProvenance = triggerPositionMm !== undefined ? "confirmed" : "pending";
    if (triggerPositionMm === undefined && parsedConfig) {
      const inferredFromIni = hasNegTarget && !hasPosTarget ? joint.minLimitMm : joint.maxLimitMm;
      if (inferredFromIni !== undefined) {
        triggerPositionMm = inferredFromIni;
        sensorProvenance = "inferred";
      }
    }

    const triggerMode: SystemLimitSensorNode["triggerMode"] =
      hasNegTarget && !hasPosTarget ? "negative_overtravel" : "positive_overtravel";
    const normallyClosed = primaryHal ? primaryHal.invert : true;

    sensors.push({
      id: sensorId,
      name: sensorPkg ? `${sensorPkg.model} 限位开关` : "接近/限位开关（NC）",
      ...(sensorPkg && { packageKey: packageKey(sensorPkg) }),
      axisId,
      ...(triggerPositionMm !== undefined && { triggerPositionMm }),
      senseDistanceMm: 4,
      triggerMode,
      normallyClosed,
      supplyVoltageV: 24,
      provenance: sensorProvenance,
      ...(sensorProvenance === "pending" && { note: "请填写限位开关物理触发坐标 triggerPositionMm（mm）。" }),
      ...(sensorProvenance === "inferred" && { note: "触发坐标暂按 INI 软限位推断，请与实机开关安装位核对。" }),
    });

    const diFilterMs = primaryHal?.debounceDelaySamples ?? defaultDebounceMs;
    const diProvenance: LinkProvenance =
      diFilterMs !== undefined || (diPkg && diCapable) ? "confirmed" : diPkg ? "inferred" : "pending";

    diChannels.push({
      id: diId,
      name: diPkg ? `${diPkg.model} DI 通道` : "数字量输入滤波器",
      ...(diPkg ? { packageKey: packageKey(diPkg) } : {}),
      ...(!diPkg ? { onAboveV: 15, offBelowV: 5, filterMs: diFilterMs ?? 10 } : {}),
      ...(diPkg && diFilterMs !== undefined ? { filterMs: diFilterMs } : {}),
      provenance: diProvenance,
    });

    wires.push({
      id: `${axisId}-w-analog`,
      from: { kind: "sensor", nodeId: sensorId, portId: "voltageOut" },
      to: { kind: "di", nodeId: diId, portId: "voltageIn" },
      provenance: primaryHal ? "confirmed" : "inferred",
    });

    const ctrlTargets = primaryHal?.targets.filter((t) => t.jointIndex === joint.index) ?? [
      { jointIndex: joint.index, portId: "posLimitIn" as const },
    ];
    for (const target of ctrlTargets) {
      wires.push({
        id: `${axisId}-w-${target.portId}`,
        from: { kind: "di", nodeId: diId, portId: "stateOut" },
        to: { kind: "controller", nodeId: ctrlId, portId: target.portId },
        invert: primaryHal ? primaryHal.invert : normallyClosed,
        provenance: primaryHal ? "confirmed" : "inferred",
        ...(primaryHal && { note: `源自 HAL 信号 ${primaryHal.signalName} (${primaryHal.sourcePin})` }),
      });
    }

    const targetMm =
      options.defaultTargetMm ??
      (triggerMode === "negative_overtravel"
        ? (triggerPositionMm !== undefined ? triggerPositionMm - 10 : -40)
        : (triggerPositionMm !== undefined ? triggerPositionMm + 15 : 40));

    controllers.push({
      id: ctrlId,
      axisId,
      mode: ctrlTargets.some((t) => t.portId === "homeSwitchIn") && !ctrlTargets.some((t) => t.portId === "posLimitIn")
        ? "homing_search"
        : "move_with_limit_stop",
      targetMm,
      cruiseVelocityMmS: options.defaultCruiseVelocityMmS ?? joint.maxVelocityMmS ?? 60,
      initialPositionMm: 0,
      stopOnPosLimit: true,
      stopOnNegLimit: true,
      stopOnHome: ctrlTargets.some((t) => t.portId === "homeSwitchIn"),
    });
  }

  return parseTwinSystemAssembly({
    schemaVersion: 1,
    kind: "system-twin-assembly",
    id: options.id ?? `sys-${Date.now().toString(36)}`,
    name: options.name ?? "机电控限位急停系统",
    commStepMs: parsedConfig?.commStepMs ?? 1,
    durationMs: options.durationMs ?? 1000,
    axes,
    sensors,
    diChannels,
    wires,
    controllers,
  });
}
