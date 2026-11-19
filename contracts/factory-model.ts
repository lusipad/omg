import { z } from "zod";
import library from "../public/modelica/factory-library.json";
import { signalIdSchema } from "./mechanical-types";
import type { ModelReference } from "./twin-device";

export type FactoryRole = "handle" | "machine" | "conveyor" | "mobile";
export interface FactoryModel {
  id: string;
  code: number;
  role: FactoryRole;
  label: string;
  interface: string;
  parameters: { key: string; label: string; unit: string; positive: boolean; default: number }[];
}
export const FACTORY_MODELS: readonly FactoryModel[] = library.models as FactoryModel[];

export function getFactoryModel(ref?: ModelReference): FactoryModel | undefined {
  return ref?.version === library.version ? FACTORY_MODELS.find(model => model.id === ref.id) : undefined;
}

export const factoryParametersSchema = z.unknown()
  .refine(value => !value || typeof value !== "object" || !Object.hasOwn(value, "__proto__"), "参数含有保留属性名")
  .pipe(z.record(signalIdSchema, z.number().finite()))
  .transform(values => Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]])) as Record<string, number>);

export function factoryParameterValueIssue(spec: FactoryModel["parameters"][number], value: number | undefined, requireValue: boolean) {
  const label = `${spec.label}（${spec.key}，${spec.unit}）`;
  if (value === undefined) return requireValue ? `缺少${label}。` : undefined;
  if (!Number.isFinite(value) || (spec.positive ? value <= 0 : value < 0))
    return `${label}必须为${spec.positive ? "正" : "非负"}有限数。`;
}

/** 厂家资料可暂缺参数。在实例上显式补齐后才能运行该模型。 */
export function factoryParameterIssues(model: FactoryModel, values: Record<string, number>, requireAll: boolean): string[] {
  const issues = Object.keys(values).filter(key => !model.parameters.some(p => p.key === key))
    .map(key => `模型 ${model.id} 未声明参数 ${key}。`);
  for (const spec of model.parameters) {
    const issue = factoryParameterValueIssue(spec, Object.hasOwn(values, spec.key) ? values[spec.key] : undefined, requireAll);
    if (issue) issues.push(issue);
  }
  return issues;
}
