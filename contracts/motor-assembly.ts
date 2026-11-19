import library from "../public/modelica/motor-library.json";
import { getDeviceParts } from "./device-composition";
import { compositionPath, deriveDeviceComposition } from "./device-composition-edit";
import { parseFactoryLayout, type FactoryLayout } from "./factory";
import { applyFactoryStructureRevision } from "./factory-structure";
import { packageKey, parseDevicePackage, type DevicePackage, type ModelReference, type MotorAxisPort } from "./twin-device";
import { installPackage, type TwinWorkspace } from "./twin-simulation";

type PartRole = "stator" | "rotor" | "bearing";
const roleName = { stator: "定子", rotor: "转子", bearing: "轴承" } as const;
const portFields = ["leadMmPerRev", "tableMassKg", "driveVoltageLimitV", "driveCurrentLimitA",
  "driveSpeedLimitRpm", "driveReferenceInertiaKgM2", "currentGainOhm"] as const;
type Geometry = "statorBoreMm" | "rotorDiameterMm" | "bearingSeatMm" | "boreMm";
type PartRating<R extends PartRole> = keyof (typeof library.components)[R]["parameters"] & string;
type MotorKey = Exclude<PartRating<"stator"> | PartRating<"rotor"> | PartRating<"bearing">, Geometry> | "bearingCount";
export type MotorAxisParameters = Record<keyof typeof library.assembly.parameters, number>;
export interface MotorParameterSource {
  kind: "part" | "slot" | "axis" | "command";
  /** Relative to the motor when resolved alone, or to the installed CNC when testing an axis. */
  path: string[]; packagePath: string[]; packageKey: string; field: string; value: number; unit: string;
  slotQuantities?: { parentKey: string; slotId: string; quantity: number }[];
}
export interface ServoMotorSelection {
  manufacturer: string; model: string; revision: string; statorKey: string; rotorKey: string; bearingKey: string;
}

function requireRef(actual: ModelReference, id: string, label: string) {
  if (actual.id !== id || actual.version !== library.version) {
    throw new Error(`${label}引用的模型 ${actual.id} @ ${actual.version} 当前不可用。需要 ${id} @ ${library.version}。`);
  }
}

function occurrence(ws: TwinWorkspace, key: string, path: readonly string[]) {
  const trail = compositionPath(ws.packages, key, path);
  const slotQuantities: NonNullable<MotorParameterSource["slotQuantities"]> = [];
  let quantity = 1;
  for (const [i, id] of path.entries()) {
    const count = getDeviceParts(trail[i]).find(part => part.id === id)!.quantity;
    slotQuantities.push({ parentKey: packageKey(trail[i]), slotId: id, quantity: count });
    quantity *= count;
    if (!Number.isSafeInteger(quantity)) throw new Error(`槽位 ${path.join(" / ")} 的数量超出物理模型可表示范围。`);
  }
  return { part: trail[trail.length - 1], quantity, packagePath: trail.map(packageKey), slotQuantities };
}

function readPart<R extends PartRole>(ws: TwinWorkspace, motor: DevicePackage, role: R, path: string[],
  rootPath: string[], rootPackages: string[]) {
  const found = occurrence(ws, packageKey(motor), path);
  const part = found.part, declaration = part.motorPhysics;
  const fullPath = [...rootPath, ...path], packagePath = [...rootPackages, ...found.packagePath];
  const label = `${fullPath.join(" / ")} 的${roleName[role]}“${part.model} @ ${part.revision}”`;
  if (declaration?.kind !== role) throw new Error(`${label}缺少对应的电机部件模型。`);
  requireRef(declaration.modelRef, library.components[role].id, label);
  if (declaration.fit !== motor.motorPhysics?.fit) throw new Error(`${label}的配合接口 ${declaration.fit} 与电机的 ${motor.motorPhysics?.fit} 不一致。`);
  if (role !== "bearing" && found.quantity !== 1) throw new Error(`${label}的安装路径需要恰好一个${roleName[role]}。`);
  const ratings = part.composition?.ratings, origins: Record<string, MotorParameterSource> = {};
  for (const [key, spec] of Object.entries(library.components[role].parameters)) {
    const rating = ratings?.[spec.field];
    if (!rating) throw new Error(`${label}缺少 ${spec.field}（${spec.unit}），请补充实测值或设备资料。`);
    if (rating.unit !== spec.unit) throw new Error(`${label}的 ${spec.field} 单位为 ${rating.unit}，模型需要 ${spec.unit}。`);
    if (!Number.isFinite(rating.value) || (key === "bearingViscousNmS" ? rating.value < 0 : rating.value <= 0)) {
      throw new Error(`${label}的 ${spec.field} 必须是${key === "bearingViscousNmS" ? "非负" : "正"}有限数（${spec.unit}）。`);
    }
    if ((key === "windingTurns" || key === "polePairs") && !Number.isSafeInteger(rating.value)) {
      throw new Error(`${label}的 ${spec.field} 必须为正整数。`);
    }
    if (key === "windingFactor" && rating.value > 1) throw new Error(`${label}的绕组系数须在 (0, 1] 范围内。`);
    origins[key] = { kind: "part", packageKey: packageKey(part), path: fullPath, packagePath, field: spec.field, unit: spec.unit, value: rating.value };
  }
  return { ...found, ratings: origins as Record<PartRating<R>, MotorParameterSource> };
}

function numericValues<K extends string>(sources: Record<K, MotorParameterSource>): Record<K, number> {
  return Object.fromEntries(Object.entries<MotorParameterSource>(sources).map(([name, source]) => [name, source.value])) as Record<K, number>;
}

function motorParts(ws: TwinWorkspace, motor: DevicePackage, path: string[], prefixPackages: string[]) {
  const physics = motor.motorPhysics;
  if (physics?.kind !== "motor") throw new Error(`“${motor.model} @ ${motor.revision}”缺少可求解的伺服电机声明，请先组装电机。`);
  requireRef(physics.modelRef, library.components.motor.id, "电机");
  const s = readPart(ws, motor, "stator", physics.statorPath, path, prefixPackages);
  const r = readPart(ws, motor, "rotor", physics.rotorPath, path, prefixPackages);
  const b = readPart(ws, motor, "bearing", physics.bearingPath, path, prefixPackages);
  const { statorBoreMm, ...stator } = s.ratings;
  const { rotorDiameterMm, bearingSeatMm, polePairs, ...rotor } = r.ratings;
  if (stator.polePairs.value !== polePairs.value) throw new Error(`定子与转子的极对数不匹配（${stator.polePairs.value} / ${polePairs.value}）。`);
  if (rotorDiameterMm.value >= statorBoreMm.value) throw new Error(`转子外径 ${rotorDiameterMm.value} mm 须小于定子内径 ${statorBoreMm.value} mm，以留出气隙。`);
  if (bearingSeatMm.value !== b.ratings.boreMm.value) throw new Error(`转子名义轴颈 ${bearingSeatMm.value} mm 与轴承内径 ${b.ratings.boreMm.value} mm 不匹配。`);
  const bearing = b.ratings.bearingViscousNmS;
  const sources: Record<MotorKey, MotorParameterSource> = { ...stator, ...rotor, bearingViscousNmS: bearing,
    bearingCount: { ...bearing, kind: "slot", field: "quantity", unit: "1", value: b.quantity, slotQuantities: b.slotQuantities } };
  const parameters = numericValues(sources);
  const torquePerAmp = 1.5 * parameters.polePairs * parameters.windingTurns * parameters.windingFactor * parameters.rotorFluxWb;
  const peakTorque = torquePerAmp * parameters.windingCurrentLimitA;
  if (!(peakTorque > 0) || !Number.isFinite(peakTorque) || !Number.isFinite(parameters.bearingViscousNmS * parameters.bearingCount)) {
    throw new Error("所选绕组、转子或轴承组的组合参数超出模型可表示的数值范围。");
  }
  return { motor, stator: s.part, rotor: r.part, bearing: b.part, sources, parameters };
}

export function resolveServoMotor(workspace: TwinWorkspace, motorKey: string) {
  const motor = workspace.packages.find(pkg => packageKey(pkg) === motorKey);
  if (!motor) throw new Error(`请先安装所选电机修订 ${motorKey}。`);
  return motorParts(workspace, motor, [], []);
}

/** Create a reusable device definition. All ratings remain on their named part revisions. */
export function buildServoMotor(workspace: TwinWorkspace, selection: ServoMotorSelection): DevicePackage {
  const { manufacturer, model, revision, statorKey, rotorKey, bearingKey } = selection;
  const fit = workspace.packages.find(pkg => packageKey(pkg) === statorKey)?.motorPhysics?.fit;
  if (!fit) throw new Error("请选择已安装且声明配合接口的定子修订。");
  const device = parseDevicePackage({
    schemaVersion: 1, manufacturer, model, revision, ports: [], rules: [],
    source: { kind: "local", url: "", title: "设备库伺服电机装配", locator: model,
      excerpt: "组成清单记录定子、转子与一对轴承的安装槽及精确修订。电气、惯量与阻尼参数取自各部件资料。" },
    composition: { kind: "assembly", shape: "shaft", parts: [
      { id: "stator", label: "定子", packageKey: statorKey, quantity: 1 },
      { id: "rotor", label: "转子", packageKey: rotorKey, quantity: 1 },
      { id: "bearing", label: "支承轴承", packageKey: bearingKey, quantity: 2 },
    ] },
    motorPhysics: { kind: "motor", fit, modelRef: { id: library.components.motor.id, version: library.version },
      statorPath: ["stator"], rotorPath: ["rotor"], bearingPath: ["bearing"] },
  });
  resolveServoMotor(installPackage(workspace, device), packageKey(device));
  return device;
}

export function factoryMotorMount(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string) {
  const resource = layout.resources.find(item => item.id === resourceId);
  if (!resource) throw new Error(`工厂中没有设备实例 ${resourceId}。`);
  const root = workspace.packages.find(pkg => packageKey(pkg) === resource.packageKey);
  if (!root) throw new Error(`“${resource.name}”引用的设备修订尚未安装。`);
  const port = root.axisPorts?.find(p => p.id === axisId);
  if (!port) throw new Error(`“${root.model} @ ${root.revision}”未声明调试轴 ${axisId}。`);
  requireRef(port.modelRef, library.assembly.id, port.name);
  const occurrenceAtAxis = occurrence(workspace, resource.packageKey, port.path), axis = occurrenceAtAxis.part;
  const slot = getDeviceParts(axis).find(p => p.id === port.motorSlot), installedPath = [...port.path, port.motorSlot];
  if (!slot) throw new Error(`${root.model} / ${installedPath.join(" / ")} 缺少电机安装槽。`);
  if (occurrenceAtAxis.quantity !== 1 || slot.quantity !== 1) throw new Error(`“${port.name}”的电机安装路径包含成组槽位，请先拆出一个独立轴和电机位置。`);
  return { resource, root, port, axis, motorKey: slot.packageKey, motor: workspace.packages.find(p => packageKey(p) === slot.packageKey),
    installedPath, packagePath: occurrenceAtAxis.packagePath };
}

function checkAxisFit(motor: DevicePackage, port: MotorAxisPort) {
  if (motor.motorPhysics?.fit !== port.fit) throw new Error(`电机配合接口 ${motor.motorPhysics?.fit ?? "未声明"} 与 ${port.name} 的 ${port.fit} 不匹配。`);
}

export function installMotorOnFactoryAxis(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string,
  motorKey: string, newRootRevision: string) {
  const mount = factoryMotorMount(workspace, layout, resourceId, axisId);
  const { motor } = resolveServoMotor(workspace, motorKey);
  checkAxisFit(motor, mount.port);
  if (motorKey === mount.motorKey) return { workspace, layout };
  const composition = mount.axis.composition;
  if (composition?.kind !== "assembly") throw new Error("该电机槽由机械安装点维护，请核对对应安装关系。");
  const next = { ...composition, parts: composition.parts.map(part => part.id === mount.port.motorSlot ? { ...part, packageKey: motorKey } : part) };
  const derived = deriveDeviceComposition(workspace, mount.resource.packageKey, mount.port.path, next, newRootRevision);
  return applyFactoryStructureRevision(workspace, layout, resourceId, mount.resource.packageKey, derived.workspace, derived.rootKey);
}

export function setMotorAxisTarget(layout: FactoryLayout, resourceId: string, axisId: string, targetMm: number): FactoryLayout {
  const match = layout.resources.find(r => r.id === resourceId);
  if (!match) throw new Error(`工厂中没有设备实例 ${resourceId}。`);
  return parseFactoryLayout({ ...layout, resources: layout.resources.map(r => r !== match ? r : {
    ...r, axisTargetsMm: { ...r.axisTargetsMm, [axisId]: targetMm },
  }) });
}

export function resolveMotorAxis(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string, targetMm?: number) {
  const mount = factoryMotorMount(workspace, layout, resourceId, axisId);
  if (!mount.motor) throw new Error(`“${mount.port.name}”的电机修订 ${mount.motorKey} 尚未安装。`);
  const selected = motorParts(workspace, mount.motor, mount.installedPath, mount.packagePath);
  checkAxisFit(selected.motor, mount.port);
  const command = targetMm ?? mount.resource.axisTargetsMm?.[axisId] ?? 0;
  if (!Number.isFinite(command)) throw new Error("目标位移必须为有限的毫米数值。");
  const origin = { path: [] as string[], packagePath: [mount.resource.packageKey], packageKey: mount.resource.packageKey };
  const sources = { ...selected.sources, targetMm: { ...origin, kind: "command", field: `resources.${resourceId}.axisTargetsMm.${axisId}`,
    unit: library.assembly.parameters.targetMm.unit, value: command } } as Record<keyof MotorAxisParameters, MotorParameterSource>;
  for (const field of portFields) sources[field] = { ...origin, kind: "axis", field: `axisPorts.${axisId}.${field}`,
    value: mount.port[field], unit: library.assembly.parameters[field].unit };
  const parameters = numericValues(sources);
  const radiusM = parameters.leadMmPerRev / (2000 * Math.PI);
  const targetDeg = command / parameters.leadMmPerRev * 360;
  const reflectedJ = parameters.tableMassKg * radiusM ** 2;
  const tau = parameters.qInductanceH / (parameters.phaseResistanceOhm + parameters.currentGainOhm);
  if (!Number.isFinite(targetDeg) || (command !== 0 && targetDeg === 0) || !(reflectedJ > 0) ||
      !Number.isFinite(reflectedJ + parameters.rotorInertiaKgM2) ||
      !(tau > 0) || !Number.isFinite(tau)) {
    throw new Error("电机、丝杠、工作台或指令组合超出模型可表示的数值范围。");
  }
  return { ...mount, ...selected, parameters, sources };
}
