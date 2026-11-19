import { getDeviceParts } from "./device-composition";
import { factoryParameterValueIssue, type FactoryModel } from "./factory-model";
import { packageKey, type DevicePackage } from "./twin-device";

type PartParameter = { path: string[]; rating: string };
type ValueOrigin = { value: number; unit: string; packageKey: string };
export type FactoryParameterSource = ValueOrigin & (
  | { kind: "device" }
  | { kind: "instance"; overridesPart?: PartParameter }
  | { kind: "part"; path: string[]; packagePath: string[]; rating: string; label: string }
);

function followRating(root: DevicePackage, binding: PartParameter, spec: FactoryModel["parameters"][number],
  installed: ReadonlyMap<string, DevicePackage>): { source: FactoryParameterSource } | { issue: string } {
  const at = `参数 ${spec.key} 的部件路径 ${root.model} @ ${root.revision} / ${binding.path.join(" / ")}（额定值 ${binding.rating}）`;
  let part = root;
  const packagePath = [packageKey(root)];
  for (const id of binding.path) {
    const slot = getDeviceParts(part).find(s => s.id === id);
    if (!slot) return { issue: `${at}：${part.model} @ ${part.revision} 缺少槽位 ${id}。` };
    const child = installed.get(slot.packageKey);
    if (!child) return { issue: `${at}：槽位 ${id} 所需的设备修订 ${slot.packageKey} 尚未安装。` };
    if (packagePath.includes(slot.packageKey)) return { issue: `${at}：槽位 ${id} 形成循环引用。` };
    part = child;
    packagePath.push(slot.packageKey);
  }
  const rating = part.composition?.ratings?.[binding.rating];
  if (!rating) return { issue: `${at}：${part.model} @ ${part.revision} 缺少此额定值。` };
  if (rating.unit !== spec.unit) return { issue: `${at}：${part.model} @ ${part.revision} 给出的单位为 ${rating.unit}，模型要求 ${spec.unit}。` };
  const issue = factoryParameterValueIssue(spec, rating.value, true);
  if (issue) return { issue: `${at}：${issue}` };
  return { source: { kind: "part", packageKey: packageKey(part), packagePath, path: binding.path, rating: binding.rating,
    label: rating.label, unit: rating.unit, value: rating.value } };
}

/** 单件额定参数沿明确槽位取值。实例主动覆盖某项参数时，仍记下被覆盖的来源。 */
export function resolveFactoryParameters(device: DevicePackage, model: FactoryModel, installed: ReadonlyMap<string, DevicePackage>,
  overrides: Readonly<Record<string, number>> = {}, requireAll = true) {
  const parameters: Record<string, number> = {}, parameterSources: Record<string, FactoryParameterSource> = {}, issues: string[] = [];
  const factory = device.factory;
  if (!factory) return { parameters, parameterSources, issues: [`设备 ${device.model} 缺少工厂模型。`] };
  const rootKey = packageKey(device), bindings = factory.partParameters ?? {};
  const declared = new Set([...Object.keys(factory.parameters), ...Object.keys(bindings), ...Object.keys(overrides)]);
  for (const key of declared) {
    if (!model.parameters.some(spec => spec.key === key)) issues.push(`模型 ${model.id} 未声明参数 ${key}。`);
  }
  for (const spec of model.parameters) {
    const key = spec.key, binding = bindings[key];
    if (binding && Object.hasOwn(factory.parameters, key)) {
      issues.push(`参数 ${key} 同时声明了设备固定值和部件绑定，请选定一个来源。`); continue;
    }
    if (binding && !Object.hasOwn(overrides, key)) {
      const res = followRating(device, binding, spec, installed);
      if ("issue" in res) { issues.push(res.issue); continue; }
      parameters[key] = res.source.value;
      parameterSources[key] = res.source;
      continue;
    }
    const override = Object.hasOwn(overrides, key);
    const value = override ? overrides[key] : factory.parameters[key];
    const issue = factoryParameterValueIssue(spec, value, requireAll);
    if (issue) { issues.push(issue); continue; }
    if (value === undefined) continue;
    parameters[key] = value;
    const origin = { value, unit: spec.unit, packageKey: rootKey };
    parameterSources[key] = override ? { ...origin, kind: "instance", ...(binding && { overridesPart: binding }) } : { ...origin, kind: "device" };
  }
  return { parameters, parameterSources, issues };
}
