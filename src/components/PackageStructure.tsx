import { lazy, Suspense, useMemo } from "react";
import { deviceCompositionClosure } from "@contracts/device-composition";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";

const DeviceCompositionView = lazy(() => import("./DeviceCompositionView"));
export type ApplyDeviceRevision = (workspace: TwinWorkspace, newRootKey: string) => void;

export default function PackageStructure({ device, workspace, onApply, onEditingChange }: {
  device: DevicePackage; workspace: TwinWorkspace; onApply?: ApplyDeviceRevision; onEditingChange?: (editing: boolean) => void;
}) {
  const key = packageKey(device);
  const roots = useMemo(() => [{ id: device.model, label: device.model, packageKey: key, quantity: 1 }], [key, device.model]);
  const graphError = useMemo(() => {
    try { deviceCompositionClosure(workspace.packages, [key]); return ""; }
    catch (cause) { return cause instanceof Error ? cause.message : "无法展开此设备组成。"; }
  }, [workspace.packages, key]);
  if (graphError) return <p role="alert" className="break-all text-sm text-destructive">{graphError}</p>;
  return <Suspense fallback={<p role="status" className="p-3 text-sm text-muted-foreground">正在打开部件结构…</p>}>
    <DeviceCompositionView workspace={workspace} roots={roots}
      initialRootId={device.model} onEditingChange={onEditingChange} onApplyRevision={onApply && ((_id, next, root) => onApply(next, root))} />
  </Suspense>;
}
