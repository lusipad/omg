import { deriveDeviceCompositions } from "./device-composition-edit";
import { parseFactoryLayout, type FactoryLayout } from "./factory";
import { applyFactoryStructureRevision } from "./factory-structure";
import { inspectMotorAxisPort, resolveMotorAxis, resolveServoMotor } from "./motor-assembly";
import { packageKey, parseDevicePackage, type DevicePackage, type ModelReference, type MotorAxisPort } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export type { ContourProfile } from "./twin-device";
export const CONTOUR_AXES = ["x", "y", "z"] as const;
export const CONTOUR_REF: Readonly<ModelReference> = Object.freeze({ id: "GouyuanContour.TrackingAxis", version: "1.0.0" });
type Axis = typeof CONTOUR_AXES[number];

function xyz<T>(value: (axis: Axis, index: number) => T): [T, T, T] {
  return [value("x", 0), value("y", 1), value("z", 2)];
}
function sameModel(a: ModelReference, b: ModelReference) { return a.id === b.id && a.version === b.version; }
function prefix(a: readonly string[], b: readonly string[]) { return a.length <= b.length && a.every((step, i) => step === b[i]); }

/** A template supplies the new motion contract. Installed devices, paths, and existing servo tuning come from the machine. */
function contourPorts(machine: DevicePackage, candidate?: DevicePackage) {
  if (machine.contour) return { contour: machine.contour, axisPorts: machine.axisPorts!, requiresUpgrade: false };
  if (!candidate) throw new Error(`“${machine.model} @ ${machine.revision}”尚未声明三轴轮廓，请选择匹配的三轴机床修订来补充安装位。`);
  const template = parseDevicePackage(candidate);
  if (!template.contour || machine.manufacturer !== template.manufacturer || machine.model !== template.model ||
      !machine.factory || !template.factory || !sameModel(machine.factory.modelRef, template.factory.modelRef)) {
    throw new Error("补充三轴安装位需要同一制造商、机床型号和工厂行为模型的轮廓模板。");
  }
  const axisPorts = [...(machine.axisPorts ?? [])], axes = { ...template.contour.axes };
  for (const axis of CONTOUR_AXES) {
    const source = template.axisPorts!.find(port => port.id === axes[axis])!;
    const matches = axisPorts.filter(port => port.path.length === source.path.length && prefix(port.path, source.path));
    const old = matches[0];
    if (matches.length > 1 || (old && old.motorSlot !== source.motorSlot) || axisPorts.some(port => port.id === source.id && port !== old)) {
      throw new Error(`模板的 ${axis.toUpperCase()} 轴与已有端口的安装路径冲突。`);
    }
    if (old) {
      if (old.fit !== source.fit || !sameModel(old.modelRef, source.modelRef)) throw new Error(`已有 ${old.name} 的配合接口或模型版本与模板不一致。`);
      axes[axis] = old.id;
    } else {
      if (axis === "x") throw new Error("模板 X 轴与机床已有 X 电机的实际安装槽位不一致，无法沿用原来装好的电机。");
      axisPorts.push(source);
    }
  }
  return { contour: { ...template.contour, axes }, axisPorts, requiresUpgrade: true };
}

export function compatibleContourMotors(workspace: TwinWorkspace, ports: readonly [MotorAxisPort, MotorAxisPort, MotorAxisPort]) {
  return workspace.packages.filter(device => {
    if (device.motorPhysics?.kind !== "motor" || !ports.every(port => port.fit === device.motorPhysics!.fit)) return false;
    try { resolveServoMotor(workspace, packageKey(device)); return true; }
    catch { return false; }
  });
}

export function resolveContourMount(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, template?: DevicePackage) {
  const resource = layout.resources.find(item => item.id === resourceId);
  if (!resource) throw new Error(`工厂中没有机床实例 ${resourceId}。`);
  const root = workspace.packages.find(pkg => packageKey(pkg) === resource.packageKey);
  if (!root) throw new Error(`“${resource.name}”的机床修订尚未安装。`);
  const { contour, axisPorts, requiresUpgrade } = contourPorts(root, template);
  if (!sameModel(contour.modelRef, CONTOUR_REF)) throw new Error(`轮廓模型 ${contour.modelRef.id} @ ${contour.modelRef.version} 在当前运行器中不可用。`);
  const ports = xyz(axis => axisPorts.find(port => port.id === contour.axes[axis])!);
  const mounts = xyz((axis, index) => {
    const port = ports[index];
    if (!port) throw new Error(`缺少轮廓 ${axis.toUpperCase()} 轴所引用的电机端口。`);
    if (ports.slice(0, index).some(other => prefix(other.path, port.path) || prefix(port.path, other.path))) {
      throw new Error("三个坐标轴必须占用互相独立的物理轴槽位，不能重合或互为祖先。");
    }
    const mount = inspectMotorAxisPort(workspace, resource, root, port);
    if (!mount.motor) throw new Error(`“${port.name}”的安装路径 ${mount.installedPath.join(" / ")} 缺少原有电机修订，请补齐设备库。`);
    if (requiresUpgrade && mount.motor.motorPhysics && (mount.motor.motorPhysics.kind !== "motor" || mount.motor.motorPhysics.fit !== port.fit))
      throw new Error(`“${port.name}”槽位上已有部件的电机接口与轮廓模板不一致。`);
    return mount;
  });
  const compatibleMotors = compatibleContourMotors(workspace, ports);
  const xMotor = mounts[0].motor;
  const recommended = xMotor?.motorPhysics?.kind === "motor"
    ? compatibleMotors.find(device => packageKey(device) === mounts[0].motorKey)
    : compatibleMotors.length === 1 ? compatibleMotors[0] : undefined;
  return { resource, root, contour, axisPorts, ports, mounts, requiresUpgrade, compatibleMotors,
    recommendedMotorKey: recommended ? packageKey(recommended) : undefined };
}

export function mountContourMotors(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string,
  motorKey: string, newRootRevision: string, template?: DevicePackage) {
  const { root, contour, axisPorts, mounts, ports, requiresUpgrade } = resolveContourMount(workspace, layout, resourceId, template);
  const { motor } = resolveServoMotor(workspace, motorKey);
  const incompatible = ports.find(port => port.fit !== motor.motorPhysics!.fit);
  if (incompatible) throw new Error(`电机 ${motor.model} 的配合接口 ${motor.motorPhysics!.fit} 与 ${incompatible.name} 的 ${incompatible.fit} 不匹配。`);
  const edits = mounts.flatMap(mount => {
    if (mount.motorKey === motorKey) return [];
    const composition = mount.axis.composition;
    if (composition?.kind !== "assembly") throw new Error(`“${mount.port.name}”的电机槽由机械安装点维护，请核对轴装配关系。`);
    return [{ path: mount.port.path, composition: { ...composition, parts: composition.parts.map(slot =>
      slot.id === mount.port.motorSlot ? { ...slot, packageKey: motorKey } : slot) } }];
  });
  let next = { workspace, layout };
  if (edits.length || requiresUpgrade) {
    const rootKey = packageKey(root);
    const derived = deriveDeviceCompositions(workspace, rootKey, edits, newRootRevision, [], requiresUpgrade ? { contour, axisPorts } : undefined);
    next = applyFactoryStructureRevision(workspace, layout, resourceId, rootKey, derived.workspace, derived.rootKey);
  }
  for (const port of ports) resolveMotorAxis(next.workspace, next.layout, resourceId, port.id, 0);
  return next;
}

export function resolveContourAxes(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string) {
  const mount = resolveContourMount(workspace, layout, resourceId);
  const motorKey = mount.mounts[0].motorKey;
  if (mount.mounts.some(axis => axis.motorKey !== motorKey)) throw new Error("三根轴的电机修订不一致，请先将同一电机型号与修订装入 X、Y、Z。");
  const axes = xyz((_, i) => resolveMotorAxis(workspace, layout, resourceId, mount.ports[i].id, 0));
  return { ...mount, motorKey, motor: axes[0].motor, axes };
}

export function setContourProgram(layout: FactoryLayout, resourceId: string, program: string): FactoryLayout {
  if (!layout.resources.some(resource => resource.id === resourceId)) throw new Error(`工厂中没有机床实例 ${resourceId}。`);
  return parseFactoryLayout({ ...layout, resources: layout.resources.map(resource => resource.id === resourceId
    ? { ...resource, contourRun: { program } } : resource) });
}
