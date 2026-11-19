import { getDeviceParts } from "@contracts/device-composition";
import { packageIdentityFields } from "@contracts/package-identity";
import type { DevicePackage } from "@contracts/twin-device";

export interface CompositionRoot {
  id: string;
  label: string;
  packageKey: string;
  quantity: number;
  parameters?: Record<string, number>;
}
export interface CompositionLine { id: string; name: string; resourceIds: readonly string[] }
export interface PartOccurrence {
  id: string;
  label: string;
  packageKey: string;
  quantity: number;
  cumulative: bigint;
  device?: DevicePackage;
}

export function visibleCompositionRoots(roots: readonly CompositionRoot[], ids?: readonly string[]) {
  if (!ids) return roots;
  const used = new Set(ids);
  return roots.filter(root => used.has(root.id));
}

export function firstPartPath(installed: ReadonlyMap<string, DevicePackage>, rootKey: string, target: string): string[] | undefined {
  const visited = new Set<string>();
  function find(key: string): string[] | undefined {
    if (key === target) return [];
    const pkg = installed.get(key);
    if (!pkg || visited.has(key)) return;
    visited.add(key);
    for (const child of getDeviceParts(pkg)) {
      const suffix = find(child.packageKey);
      if (suffix) return [child.id, ...suffix];
    }
  }
  return find(rootKey);
}

/** A path is a sequence of physical installation slots, including repeated uses of one revision. */
export function compositionTrail(installed: ReadonlyMap<string, DevicePackage>, root: CompositionRoot, path: readonly string[]) {
  let node: PartOccurrence = { ...root, cumulative: BigInt(root.quantity), device: installed.get(root.packageKey) };
  const trail = [node];
  for (const id of path) {
    const slot = node.device && getDeviceParts(node.device).find(part => part.id === id);
    if (!slot) break;
    node = { ...slot, cumulative: node.cumulative * BigInt(slot.quantity), device: installed.get(slot.packageKey) };
    trail.push(node);
  }
  return trail;
}

export function deviceIdentity(key: string, device?: DevicePackage): [string, string, string] {
  if (device) return [device.manufacturer, device.model, device.revision];
  return packageIdentityFields(key) ?? ["", key || "未指定设备", ""];
}
