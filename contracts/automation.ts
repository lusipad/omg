import { z } from "zod";
import { calculateModule, type CalculationResult, type ModuleKey } from "./engineering";
import { MODULE_COMPONENT_ROLES } from "./module-catalog";

const projectFields = {
  code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/, "仅支持字母、数字、连字符与下划线"),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional(),
};

export const cncRequirementsSchema = z.object({
  travelXMm: z.number().finite().min(100).max(2000),
  travelYMm: z.number().finite().min(100).max(2000),
  travelZMm: z.number().finite().min(50).max(1000),
  movingMassKg: z.number().finite().min(1).max(2000),
  maxSpeedMmS: z.number().finite().min(1).max(1000),
  accelerationMss2: z.number().finite().min(0.05).max(10),
});

export const armRequirementsSchema = z.object({
  payloadKg: z.number().finite().min(0.1).max(200),
  reachMm: z.number().finite().min(200).max(4000),
  maxJointSpeedDegS: z.number().finite().min(1).max(360),
  jointAccelerationDegS2: z.number().finite().min(1).max(1440),
});

export const mobileRequirementsSchema = z.object({
  totalMassKg: z.number().finite().min(1).max(2000),
  maxSpeedMps: z.number().finite().min(0.05).max(5),
  accelerationMps2: z.number().finite().min(0.05).max(5),
  gradePercent: z.number().finite().min(0).max(30),
  wheelDiameterMm: z.number().finite().min(50).max(500),
});

export const autoProjectInputSchema = z.discriminatedUnion("template", [
  z.object({ ...projectFields, template: z.literal("cnc"), requirements: cncRequirementsSchema }),
  z.object({ ...projectFields, template: z.literal("arm"), requirements: armRequirementsSchema }),
  z.object({ ...projectFields, template: z.literal("mobile"), requirements: mobileRequirementsSchema }),
]);

export type AutoProjectInput = z.infer<typeof autoProjectInputSchema>;
export type AutoTemplate = AutoProjectInput["template"];
export type AutoRequirements = AutoProjectInput["requirements"];

export type AutomationRequirementField = {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  description: string;
};

export const AUTOMATION_DEVICES: Array<{
  key: AutoTemplate;
  name: string;
  shortName: string;
  moduleCount: number;
  summary: string;
  scope: string;
}> = [
  { key: "cnc", name: "三轴数控机床", shortName: "三轴 CNC", moduleCount: 3, summary: "由 X、Y、Z 三个丝杠直线进给轴组成", scope: "Z 轴按垂直进给处理；切削力、轴间质量叠加与主轴系统尚未自动建模。" },
  { key: "arm", name: "六轴机械臂", shortName: "六轴机械臂", moduleCount: 6, summary: "由 J1—J6 六个伺服减速旋转关节组成", scope: "J1 按竖直基座旋转处理；连杆自重、完整动力学与姿态相关载荷尚未自动建模。" },
  { key: "mobile", name: "差速轮式机器人", shortName: "差速平台", moduleCount: 2, summary: "由左、右两个电机减速驱动轮组成", scope: "双轮分担整车牵引需求；附着、制动、越障、轮体轴承与整机控制仍需验证。" },
];

export const AUTOMATION_DEFAULTS: Record<AutoTemplate, Record<string, number>> = {
  cnc: { travelXMm: 500, travelYMm: 400, travelZMm: 250, movingMassKg: 120, maxSpeedMmS: 200, accelerationMss2: 1.5 },
  arm: { payloadKg: 10, reachMm: 1200, maxJointSpeedDegS: 60, jointAccelerationDegS2: 180 },
  mobile: { totalMassKg: 80, maxSpeedMps: 1, accelerationMps2: 0.8, gradePercent: 10, wheelDiameterMm: 200 },
};

export const AUTOMATION_REQUIREMENT_FIELDS: Record<AutoTemplate, AutomationRequirementField[]> = {
  cnc: [
    { key: "travelXMm", label: "X 轴有效行程", unit: "mm", min: 100, max: 2000, step: 10, description: "直接写入 X 轴实例。" },
    { key: "travelYMm", label: "Y 轴有效行程", unit: "mm", min: 100, max: 2000, step: 10, description: "直接写入 Y 轴实例。" },
    { key: "travelZMm", label: "Z 轴有效行程", unit: "mm", min: 50, max: 1000, step: 10, description: "Z 轴自动按 90° 垂直轴初算。" },
    { key: "movingMassKg", label: "单轴初始运动质量", unit: "kg", min: 1, max: 2000, step: 1, description: "三轴暂用同一输入；不是轴间叠加质量的自动计算。" },
    { key: "maxSpeedMmS", label: "各轴最大进给速度", unit: "mm/s", min: 1, max: 1000, step: 5, description: "用于初算丝杠转速并分配导程。" },
    { key: "accelerationMss2", label: "各轴最大加速度", unit: "m/s²", min: 0.05, max: 10, step: 0.05, description: "用于惯性力初算，不代表整定后的控制参数。" },
  ],
  arm: [
    { key: "payloadKg", label: "末端负载", unit: "kg", min: 0.1, max: 200, step: 0.5, description: "应包含工件与末端工具；暂不含连杆和关节自重。" },
    { key: "reachMm", label: "最大工作半径", unit: "mm", min: 200, max: 4000, step: 10, description: "按明示比例分配各关节初始质心臂长。" },
    { key: "maxJointSpeedDegS", label: "关节最大角速度", unit: "°/s", min: 1, max: 360, step: 5, description: "六关节暂用同一速度需求。" },
    { key: "jointAccelerationDegS2", label: "关节最大角加速度", unit: "°/s²", min: 1, max: 1440, step: 10, description: "用于刚体惯量转矩初算，不代替完整逆动力学。" },
  ],
  mobile: [
    { key: "totalMassKg", label: "整车总质量", unit: "kg", min: 1, max: 2000, step: 1, description: "左右轮实例共同引用同一整车需求。" },
    { key: "maxSpeedMps", label: "最高直线速度", unit: "m/s", min: 0.05, max: 5, step: 0.05, description: "按轮径与减速比初算电机转速。" },
    { key: "accelerationMps2", label: "最大加速度", unit: "m/s²", min: 0.05, max: 5, step: 0.05, description: "用于加速牵引力初算。" },
    { key: "gradePercent", label: "最大坡度", unit: "%", min: 0, max: 30, step: 1, description: "仅做牵引力初算，不代表已通过附着或驻坡验证。" },
    { key: "wheelDiameterMm", label: "左右轮直径", unit: "mm", min: 50, max: 500, step: 5, description: "自动生成时保持左右一致；后续单侧修改不会自动同步。" },
  ],
};

export type PlannedModule = {
  key: ModuleKey;
  instanceName: string;
  configuration: Record<string, number>;
  result: CalculationResult;
  selectedComponentRevisionIds: Record<string, number>;
  candidateNotes: string[];
};

export type AutomationPlan = {
  ruleVersion: "0.2.0-auto-pilot";
  template: AutoTemplate;
  requirements: Record<string, number>;
  modules: PlannedModule[];
  assumptions: string[];
  warnings: string[];
  pendingConfirmations: string[];
};

export type AutomationCatalogEntry = {
  id: number;
  model: string;
  category: string;
  manufacturer: { name: string };
  revisions: Array<{
    id: number;
    verificationStatus: string;
    parameters: unknown;
  }>;
};

const roleNames: Record<string, string> = {
  ball_screw: "滚珠丝杠具体订货型号",
  linear_guide: "直线导向寿命与精度预压",
  servo_motor: "电机候选",
  servo_drive: "伺服驱动器",
  gearbox: "减速器候选",
  encoder: "编码器与反馈接口",
  wheel: "轮体、材质与轴承布置",
};

function linearConfiguration(travelMm: number, movingMassKg: number, maxSpeedMmS: number, accelerationMss2: number, inclinationDeg: number, screwLeadMm: number) {
  return {
    travelMm,
    movingMassKg,
    maxSpeedMmS,
    accelerationMmS2: accelerationMss2 * 1000,
    inclineDeg: inclinationDeg,
    leadMm: screwLeadMm,
    frictionCoefficient: 0.02,
    efficiency: 0.9,
    safetyFactor: 1.5,
    dutyCycle: 0.35,
  };
}

function chooseScrewLead(maxSpeedMmS: number) {
  return [5, 10, 16, 20, 25, 32].find((lead) => maxSpeedMmS / lead * 60 <= 2500) ?? 32;
}

function plannedModule(key: ModuleKey, instanceName: string, configuration: Record<string, number>): PlannedModule {
  return { key, instanceName, configuration, result: calculateModule(key, configuration), selectedComponentRevisionIds: {}, candidateNotes: [] };
}

export function generateAutomationPlan(input: AutoProjectInput): AutomationPlan {
  const parsed = autoProjectInputSchema.parse(input);
  const commonAssumptions = ["自动结果是由整机需求和明示默认值生成的可修改方案草案，不是最优选型、采购定型或制造定版。"];

  if (parsed.template === "cnc") {
    const req = parsed.requirements;
    const lead = chooseScrewLead(req.maxSpeedMmS);
    const axes = [
      { name: "X 轴 · 横向进给", travel: req.travelXMm, angle: 0 },
      { name: "Y 轴 · 纵向进给", travel: req.travelYMm, angle: 0 },
      { name: "Z 轴 · 主轴进给", travel: req.travelZMm, angle: 90 },
    ];
    return {
      ruleVersion: "0.2.0-auto-pilot",
      template: "cnc",
      requirements: { ...req },
      modules: axes.map((axis) => plannedModule("linear_axis", axis.name, linearConfiguration(axis.travel, req.movingMassKg, req.maxSpeedMmS, req.accelerationMss2, axis.angle, lead))),
      assumptions: [
        ...commonAssumptions,
        `三轴丝杠导程初始取 ${lead} mm，使目标丝杠转速尽量不超过 2500 rpm；这不是临界转速、寿命或精度选型结论。`,
        "三轴暂用同一运动质量、速度、加速度、摩擦系数 0.02、传动效率 0.90、安全系数 1.50 和占空比 0.35。",
        "Z 轴按 90° 垂直轴处理；X/Y 轴按水平轴处理。行程仅记录需求，未进入丝杠临界转速、压杆稳定或寿命校核。",
        "电机候选按电机与丝杠直连、无额外减速比进行目录额定转矩和转速初筛；若实际增加减速环节，必须重新计算。",
      ],
      warnings: ["未自动计入切削力、轴间运动质量叠加、主轴与滑台自重、导轨跨距和丝杠支承，相关结果必须由机械工程师复核。"],
      pendingConfirmations: ["确认各轴真实运动质量、切削载荷谱、定位精度、丝杠直径与支承、导轨寿命，以及 Z 轴制动和断电防坠落方案。"],
    };
  }

  if (parsed.template === "arm") {
    const req = parsed.requirements;
    const reachM = req.reachMm / 1000;
    const radiusFactors = [1, 0.8, 0.5, 0.25, 0.12, 0.06];
    return {
      ruleVersion: "0.2.0-auto-pilot",
      template: "arm",
      requirements: { ...req },
      modules: radiusFactors.map((factor, index) => plannedModule("rotary_joint", `J${index + 1} · 旋转关节`, {
        loadKg: req.payloadKg,
        centerOfMassM: Number((reachM * factor).toFixed(4)),
        maxSpeedDegS: req.maxJointSpeedDegS,
        accelerationDegS2: req.jointAccelerationDegS2,
        gravityFactor: index === 0 ? 0 : 1,
        gearRatio: 100,
        efficiency: 0.75,
        movingInertiaKgm2: 0,
        safetyFactor: 1.5,
        dutyCycle: 0.5,
      })),
      assumptions: [
        ...commonAssumptions,
        `J1—J6 的初始等效质心臂长按最大工作半径的 ${radiusFactors.join(" / ")} 倍分配，只用于草案初算。`,
        "J1 按竖直基座旋转取重力系数 0，J2—J6 暂取最不利重力系数 1；六关节初始减速比均取 100:1、减速效率 0.75。",
        "各关节暂以同一末端负载作为等效运动质量，附加惯量取 0；刚体模型仍包含 m·r²，但不包含连杆、电机、减速器和工具的自重分布。",
      ],
      warnings: ["当前不是完整机械臂逆动力学：姿态耦合、连杆自重、关节峰值/RMS 载荷谱、刚度、回差、制动和电缆走向均未验证。"],
      pendingConfirmations: ["确认各连杆与关节质量、真实质心和惯量张量、工作姿态谱、末端工具、减速比、制动器及机械/电气接口。"],
    };
  }

  const req = parsed.requirements;
  const wheelRadiusM = req.wheelDiameterMm / 2000;
  const wheelConfiguration = {
    vehicleMassKg: req.totalMassKg,
    maxSpeedMS: req.maxSpeedMps,
    accelerationMS2: req.accelerationMps2,
    gradePercent: req.gradePercent,
    wheelRadiusM,
    wheelCount: 2,
    rollingResistanceCoefficient: 0.02,
    gearRatio: 53,
    efficiency: 0.72,
    safetyFactor: 1.5,
    dutyCycle: 0.6,
  };
  return {
    ruleVersion: "0.2.0-auto-pilot",
    template: "mobile",
    requirements: { ...req },
    modules: ["左驱动轮", "右驱动轮"].map((name) => plannedModule("drive_wheel", name, { ...wheelConfiguration })),
    assumptions: [
      ...commonAssumptions,
      "左右轮按双驱动轮平均分担设计牵引力，共用整车质量、轮径、速度、坡度、53:1 减速比和 0.72 传动效率。",
      "初始滚阻系数取 0.02、安全系数取 1.50、占空比取 0.60；轮体材料、轴承和地面条件未自动确定。",
    ],
    warnings: ["未校核轮胎/地面附着、制动距离、驻坡、转向阻力、越障、轮轴径向载荷和左右轮实时同步。后续修改单侧实例不会自动同步另一侧。"],
    pendingConfirmations: ["确认重心与轮荷、地面与轮体材料、从动轮、制动和驻坡、电池与驱动器、轮体轴承及整机安全控制。"],
  };
}

function parametersRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function numberParameter(parameters: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = parameters[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw !== "string") continue;
    const value = Number(raw.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(value)) continue;
    if (/mN\s*[·*]?\s*m/i.test(raw)) return value / 1000;
    return value;
  }
  return undefined;
}

function eligibleRevision(component: AutomationCatalogEntry) {
  return component.revisions.find((revision) => revision.verificationStatus !== "obsolete");
}

function findComponent(catalog: AutomationCatalogEntry[], category: string, manufacturer?: string) {
  return catalog.find((component) => component.category === category && (!manufacturer || component.manufacturer.name === manufacturer) && eligibleRevision(component));
}

function chooseMotor(catalog: AutomationCatalogEntry[], requiredTorqueNm: number, requiredSpeedRpm: number, manufacturers: string[]) {
  const candidates = catalog.filter((component) => {
    if (component.category !== "servo_motor" || !manufacturers.includes(component.manufacturer.name)) return false;
    const revision = eligibleRevision(component);
    if (!revision) return false;
    const parameters = parametersRecord(revision.parameters);
    const ratedTorque = numberParameter(parameters, ["ratedTorque", "nominalTorque"]);
    const ratedSpeed = numberParameter(parameters, ["ratedSpeed", "nominalSpeed"]);
    return ratedTorque !== undefined && ratedSpeed !== undefined && ratedTorque >= requiredTorqueNm && ratedSpeed >= requiredSpeedRpm;
  }).sort((a, b) => {
    const aTorque = numberParameter(parametersRecord(eligibleRevision(a)!.parameters), ["ratedTorque", "nominalTorque"]) ?? Infinity;
    const bTorque = numberParameter(parametersRecord(eligibleRevision(b)!.parameters), ["ratedTorque", "nominalTorque"]) ?? Infinity;
    return aTorque - bTorque;
  });
  return candidates[0];
}

function chooseGearbox(catalog: AutomationCatalogEntry[], manufacturer: string, model: string, requiredOutputTorqueNm: number, requiredRatio: number, ratioKey: string, torqueKey: string) {
  const component = catalog.find((entry) => entry.category === "gearbox" && entry.manufacturer.name === manufacturer && entry.model === model);
  const revision = component ? eligibleRevision(component) : undefined;
  if (!component || !revision) return undefined;
  const parameters = parametersRecord(revision.parameters);
  const limit = numberParameter(parameters, [torqueKey]);
  const ratio = numberParameter(parameters, [ratioKey]);
  return limit !== undefined && ratio !== undefined && Math.abs(ratio - requiredRatio) < 0.001 && limit >= requiredOutputTorqueNm ? component : undefined;
}

function selectRevision(selection: Record<string, number>, role: string, component: AutomationCatalogEntry | undefined, notes: string[], note: string) {
  const revision = component ? eligibleRevision(component) : undefined;
  if (!component || !revision) return false;
  selection[role] = revision.id;
  notes.push(`${component.manufacturer.name} ${component.model}：${note}`);
  return true;
}

export function applyAutomationCandidates(plan: AutomationPlan, catalog: AutomationCatalogEntry[]): AutomationPlan {
  const modules = plan.modules.map((module) => ({
    ...module,
    configuration: { ...module.configuration },
    selectedComponentRevisionIds: {} as Record<string, number>,
    candidateNotes: [] as string[],
  }));
  const pending = [...plan.pendingConfirmations];

  for (const module of modules) {
    if (plan.template === "cnc") {
      selectRevision(module.selectedComponentRevisionIds, "ball_screw", findComponent(catalog, "ball_screw", "HIWIN"), module.candidateNotes, "仅作系列级候选；具体订货型号、导程、Ca/Coa、精度和支承仍待确认。");
      selectRevision(module.selectedComponentRevisionIds, "linear_guide", findComponent(catalog, "linear_guide", "THK"), module.candidateNotes, "仅作布局候选；尚未按实际滑块载荷、力矩和寿命完成选型。");
      const motor = chooseMotor(catalog, module.result.metrics.screwTorqueNm, module.result.metrics.screwSpeedRpm, ["Panasonic Industry", "Delta Electronics"]);
      if (!selectRevision(module.selectedComponentRevisionIds, "servo_motor", motor, module.candidateNotes, "仅按目录额定转矩和额定转速初筛；RMS/峰值转矩、惯量匹配、制动与驱动器接口待核验。")) {
        pending.push(`${module.instanceName}：现有已溯源电机资料未同时覆盖初算转矩与转速，未自动指定电机。`);
      }
    } else if (plan.template === "arm") {
      const gearbox = chooseGearbox(catalog, "Harmonic Drive", "CSG-25-100-2A", module.result.metrics.outputTorqueNm, 100, "reductionRatio", "ratedTorqueAt2000rpm");
      if (!selectRevision(module.selectedComponentRevisionIds, "gearbox", gearbox, module.candidateNotes, "仅在 100:1 且初算输出转矩不超过目录额定转矩时列为候选；旧版目录、寿命、刚度和接口仍待确认。")) {
        pending.push(`${module.instanceName}：现有 100:1 已溯源减速器未覆盖初算额定转矩，未自动改配其他速比或型号。`);
      }
      const motor = chooseMotor(catalog, module.result.metrics.motorTorqueNm, module.result.metrics.motorSpeedRpm, ["Panasonic Industry", "Delta Electronics"]);
      if (!selectRevision(module.selectedComponentRevisionIds, "servo_motor", motor, module.candidateNotes, "仅按目录额定转矩和额定转速初筛；完整载荷谱、制动、编码器和减速器接口待核验。")) {
        pending.push(`${module.instanceName}：现有已溯源电机资料未同时覆盖初算转矩与转速，未自动指定电机。`);
      }
    } else {
      const motor = chooseMotor(catalog, module.result.metrics.motorTorqueNm, module.result.metrics.motorSpeedRpm, ["maxon"]);
      const gearbox = chooseGearbox(catalog, "maxon", "GP 42 C · P/N 203121", module.result.metrics.wheelTorqueNm, 53, "reductionRatio", "maximumContinuousTorque");
      const motorSelected = selectRevision(module.selectedComponentRevisionIds, "servo_motor", motor, module.candidateNotes, "仅在与 GP 42 C 同组候选且目录连续转矩/转速覆盖初算需求时保留；组合热、电流和接口待核验。");
      const gearboxSelected = selectRevision(module.selectedComponentRevisionIds, "gearbox", gearbox, module.candidateNotes, "仅在 53:1 且轮端需求不超过目录连续转矩时保留；径向载荷、回差、寿命和轮体接口待核验。");
      if (!motorSelected || !gearboxSelected) {
        delete module.selectedComponentRevisionIds.servo_motor;
        delete module.selectedComponentRevisionIds.gearbox;
        module.candidateNotes = module.candidateNotes.filter((note) => !note.startsWith("maxon"));
        pending.push(`${module.instanceName}：maxon EC-i 40 / GP 42 C 候选组合未同时覆盖转矩与转速，未跨系列拼配电机构型。`);
      }
    }

    for (const role of MODULE_COMPONENT_ROLES[module.key]) {
      if (!module.selectedComponentRevisionIds[role]) pending.push(`${module.instanceName}：${roleNames[role] ?? role}待补充或确认。`);
    }
  }

  return { ...plan, modules, pendingConfirmations: [...new Set(pending)] };
}
