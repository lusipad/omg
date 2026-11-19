import { compatibleContourMotors, mountContourMotors, resolveContourMount, setContourProgram } from "@contracts/cnc-contour";
import { nextStructureRevision } from "@contracts/device-composition-edit";
import { upsertFactoryLayout } from "@contracts/factory";
import { packageKey, parseDevicePackage } from "@contracts/twin-device";
import { installDeviceDependencies, installPackage, type TwinWorkspace } from "@contracts/twin-simulation";
import definition from "../../public/assemblies/cnc-factory/contour-template.device.json";
import standardMotor from "../../public/assemblies/cnc-factory/contour-motor.device.json";

export const contourTemplate = parseDevicePackage(definition);
const exampleMotor = parseDevicePackage(standardMotor);

/** Prefer the actual saved machine and motor, preserving its chosen revisions in the isolated trial. */
export function prepareContourTrial(current: TwinWorkspace, sample: TwinWorkspace, resourceId: string, program: string) {
  const example = sample.factories?.[0];
  if (!example) throw new Error("示例中缺少工厂。");
  const existing = current.factories?.find(f => f.id === example.id && f.resources.some(r => r.id === resourceId));
  let layout = existing ?? example, base = existing ? current : sample;
  const mount = resolveContourMount(base, layout, resourceId, contourTemplate);
  const hasUserMotors = current.packages.some(p => p.motorPhysics?.kind === "motor");
  const candidates = existing ? mount.compatibleMotors : compatibleContourMotors(current, mount.ports);
  if (!existing && candidates.length) base = installDeviceDependencies(base, current.packages, candidates.map(packageKey));
  let key = existing ? mount.recommendedMotorKey : candidates.length === 1 ? packageKey(candidates[0]) : undefined;
  let note: string;
  if (key) {
    note = existing && key === mount.mounts[0].motorKey ? "本次试用沿用当前工程 X 轴实际安装的电机修订。" : "本次试用采用设备库中唯一匹配的自组电机修订。";
  } else if (candidates.length) {
    note = "请在三轴安装区核对并选择要使用的电机修订。";
  } else if (existing || hasUserMotors) {
    note = "三轴保留原有电机。请在设备库组装或导入与三个槽位匹配、零件齐全的伺服电机，再选择安装。";
  } else {
    base = installPackage(base, exampleMotor);
    key = packageKey(exampleMotor);
    note = "本次使用教学标准组合，定子 S40-STD、转子 R40-STD、两只 B08-STD 轴承。";
  }
  if (key) {
    const revision = existing || hasUserMotors
      ? nextStructureRevision(base, mount.resource.packageKey) : mount.root.revision + "-contour-1";
    const changed = mountContourMotors(base, layout, resourceId, key, revision, contourTemplate);
    base = changed.workspace; layout = changed.layout;
  }
  layout = setContourProgram(layout, resourceId, program);
  return { workspace: upsertFactoryLayout({ ...base, factories: [] }, layout), note };
}
