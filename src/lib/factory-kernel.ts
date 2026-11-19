import type { FactoryRole, ResolvedFactoryLayout } from "@contracts/factory";
import deviceManifest from "../../public/modelica/runtime/factory-models.json";
import scheduleManifest from "../../public/modelica/runtime/factory-scheduler.json";

export const factoryRoleCode: Record<FactoryRole, number> = { handle: 1, machine: 2, conveyor: 3, mobile: 4 };
export const recordWidth = scheduleManifest.recordColumns.length;
interface DeviceKernel extends WebAssembly.Exports {
  evaluate(code: number, ...parameters: number[]): number;
  serviceS(): number; emptySPerM(): number; loadedSPerM(): number; pickS(): number; dropS(): number;
}
interface Scheduler extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  factory_resources_ptr(): number; factory_mask_ptr(): number; factory_jobs_ptr(): number; factory_records_ptr(): number;
  factory_run(nr: number, ns: number, nj: number): number;
}

/** The exported Modelica model and the browser use the same one-based stage and resource indices. */
export function factoryTopology(factory: ResolvedFactoryLayout) {
  const { resources, stages, jobs } = factory;
  const mask = Int32Array.from(stages.flatMap(({ stage }) => resources.map(({ resource }) =>
    stage.stations.includes(resource.id) ? 1 : stage.carriers.includes(resource.id) ? 2 : 0)));
  const releases = Float64Array.from(jobs.flatMap(job => [job.firstStage, job.lastStage, job.releaseS]));
  return { nr: resources.length, ns: stages.length, nj: jobs.length, mask, releases };
}

export function factoryInputs(factory: ResolvedFactoryLayout, deviceModule: WebAssembly.Module) {
  const kernel = new WebAssembly.Instance(deviceModule).exports as DeviceKernel;
  const coefficients = Float64Array.from(factory.resources.flatMap(({ resource, model, parameters }) => {
    const args = model.parameters.map(p => parameters[p.key]);
    while (args.length < deviceManifest.parameterSlots) args.push(0);
    if (kernel.evaluate(model.code, ...args) !== 0) throw new Error(`设备“${resource.name}”的 Modelica 模型不能计算此组参数。`);
    return [factoryRoleCode[model.role], ...resource.positionM, kernel.serviceS(), kernel.emptySPerM(),
      kernel.loadedSPerM(), kernel.pickS(), kernel.dropS()];
  }));
  return { ...factoryTopology(factory), coefficients };
}
export type FactoryInputs = ReturnType<typeof factoryInputs>;

export function scheduleFactory(module: WebAssembly.Module, input: FactoryInputs) {
  const engine = new WebAssembly.Instance(module).exports as Scheduler;
  const { nr, ns, nj, coefficients, releases, mask } = input, buffer = engine.memory.buffer;
  new Float64Array(buffer, engine.factory_resources_ptr(), coefficients.length).set(coefficients);
  new Float64Array(buffer, engine.factory_jobs_ptr(), releases.length).set(releases);
  new Int32Array(buffer, engine.factory_mask_ptr(), mask.length).set(mask);
  const status = engine.factory_run(nr, ns, nj);
  if (status) throw new Error(`工厂调度未能完成（${status}），请核对工序、搬运连接和设备工况。`);
  return new Float64Array(buffer, engine.factory_records_ptr(), ns * nj * recordWidth).slice();
}
