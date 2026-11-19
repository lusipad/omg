import { parseFactoryLayout, type FactoryLayout } from "./factory";
import { deviceCompositionClosure, rollupDeviceParts } from "./device-composition";
import { packageKey } from "./twin-device";
import { emptyWorkspace, installDeviceDependencies, type TwinWorkspace } from "./twin-simulation";

/** Count physical installations once, including a robot shared by more than one line. */
export function factoryStructureRoots(layout: FactoryLayout) {
  return layout.resources.map(({ id, name, packageKey, parameters }) => ({
    id, label: name, packageKey, quantity: 1, ...(parameters && { parameters }),
  }));
}

export function factoryStructureSnapshot(workspace: TwinWorkspace, layout: FactoryLayout) {
  const roots = factoryStructureRoots(layout);
  const { packages } = deviceCompositionClosure(workspace.packages, roots.map(root => root.packageKey));
  const referenced = new Set(layout.resources.map(r => r.materialId).filter(Boolean));
  const materials = workspace.catalog?.materials.filter(row => referenced.has(row.id)) ?? [];
  const snapshot: TwinWorkspace = { ...emptyWorkspace(), packages, factories: [layout],
    ...(materials.length && { catalog: { models: [], materials } }) };
  return { workspace: snapshot, report: rollupDeviceParts(packages, roots) };
}

/** Apply a copy-on-write component edit to one installation. A BOM row stays associated only if its revision still agrees. */
export function applyFactoryStructureRevision(workspace: TwinWorkspace, definition: FactoryLayout, resourceId: string,
  oldRootKey: string, revised: TwinWorkspace, newRootKey: string) {
  const resource = definition.resources.find(r => r.id === resourceId);
  if (!resource || resource.packageKey !== oldRootKey) throw new Error("设备实例或所用修订已经改变，请重新选取要修改的设备。");
  const previous = workspace.packages.find(pkg => packageKey(pkg) === oldRootKey);
  const nextRoot = revised.packages.find(pkg => packageKey(pkg) === newRootKey);
  if (!previous?.factory || !nextRoot?.factory || previous.manufacturer !== nextRoot.manufacturer || previous.model !== nextRoot.model ||
      previous.factory.modelRef.id !== nextRoot.factory.modelRef.id || previous.factory.modelRef.version !== nextRoot.factory.modelRef.version) {
    throw new Error("部件编辑需要所选设备的结构修订。更换整机型号请使用设备布局。");
  }
  const next = installDeviceDependencies(workspace, revised.packages, [newRootKey]);
  const updated = { ...resource, packageKey: newRootKey };
  if (resource.materialId && oldRootKey !== newRootKey) {
    const matching = next.catalog?.materials.filter(r => r.binding?.kind === "device" && r.binding.key === newRootKey) ?? [];
    if (matching.length === 1) updated.materialId = matching[0].id;
    else delete updated.materialId;
  }
  return { workspace: next, layout: parseFactoryLayout({ ...definition, resources: definition.resources.map(r => r.id === resourceId ? updated : r) }) };
}
