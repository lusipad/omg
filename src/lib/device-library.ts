import { deviceCompositionClosure, getDeviceParts } from "@contracts/device-composition";
import { packageIdentityFields } from "@contracts/package-identity";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";

export function isStructureOnly(pkg: DevicePackage): boolean {
  return !!pkg.composition && !(pkg.factory || pkg.feed || pkg.mechanics || pkg.servo || pkg.motorPhysics || pkg.ports.length);
}

export const motorRoleNames = { stator: "定子", rotor: "转子", bearing: "轴承", motor: "自组伺服电机" } as const;

export function deviceLibraryGroups(packages: readonly DevicePackage[]) {
  const children = new Set(packages.flatMap(pkg => getDeviceParts(pkg).map(part => part.packageKey)));
  const roots: DevicePackage[] = [], parts: DevicePackage[] = [];
  for (const pkg of packages) (children.has(packageKey(pkg)) ? parts : roots).push(pkg);
  return { roots, parts };
}

/** 预览同一批文件的内部引用，且在相同修订冲突时展示用户带来的版本。 */
export function previewDevicePackages(workspace: TwinWorkspace, incoming: readonly DevicePackage[]): TwinWorkspace {
  const byKey = new Map(workspace.packages.map(pkg => [packageKey(pkg), pkg]));
  for (const pkg of incoming) byKey.set(packageKey(pkg), pkg);
  return { ...workspace, packages: [...byKey.values()] };
}

export function exportDeviceLibrary(packages: readonly DevicePackage[], roots: string | readonly string[]) {
  const keys = typeof roots === "string" ? [roots] : roots;
  if (!keys.length) throw new Error("请先选择要导出的设备。");
  const closure = deviceCompositionClosure(packages, keys);
  if (closure.missing.length) {
    const missing = closure.missing.map(key => packageIdentityFields(key)?.join(" · ") ?? (key || "未指定设备修订"));
    throw new Error(`尚缺 ${missing.length} 个引用修订：${missing.join("、")}。补齐后可导出含子件的设备库，也可先导出当前设备包。`);
  }
  return { schemaVersion: 1, kind: "device-library", packages: closure.packages };
}
