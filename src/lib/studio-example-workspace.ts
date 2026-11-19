import { applyMiloBomImport } from "@contracts/import-apply";
import { assembleMiloAxis, miloAxisIds } from "@contracts/milo-bom";
import { planMiloProgram, type MiloMotionPlan } from "@contracts/milo-motion";
import { parseMiloWorkspace } from "@contracts/milo-workspace";
import { assembleServoAxis } from "@contracts/servo-axis";
import { DEFAULT_SO101_MOTION, parseSo101Assembly, SO101_MODEL_ID } from "@contracts/so101";
import { modelicaServoProjectPath, type StudioExampleKind } from "@contracts/studio-navigation";
import { createTwinDemo } from "@contracts/twin-demo";
import { packageKey } from "@contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { decodeImportUtf8, parseImportText } from "@contracts/workbench-import";
import { miloBomSource, so101BomSource } from "./bom-sources";

export type StudioBenchKind = Exclude<StudioExampleKind, "physics">;
export interface LoadedStudioExample { workspace: TwinWorkspace; plan?: MiloMotionPlan }
export const miloPocketPath = "machines/milo-v1-5/circular-pocket.nc";
async function readStudioExampleText(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取 ${url.split("/").at(-1)} 失败（HTTP ${response.status}）。`);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return decodeImportUtf8(bytes);
}

async function readSo101ExampleBom(signal: AbortSignal) {
  const text = await readStudioExampleText(import.meta.env.BASE_URL + so101BomSource.localPath, signal);
  const result = parseImportText(text, "follower-bom.md", { hint: "bom" });
  if (result.kind !== "so101-bom") throw new Error("本地示例未识别为 SO-101 Follower 清单。");
  return result.bom;
}

async function loadMiloPocket(signal: AbortSignal) {
  const [programText, facts] = await Promise.all([
    readStudioExampleText(import.meta.env.BASE_URL + miloPocketPath, signal),
    readStudioExampleText(import.meta.env.BASE_URL + miloBomSource.localPath, signal),
  ]);
  signal.throwIfAborted();
  const inventory = parseImportText(facts, "bom-facts.md", { hint: "bom" });
  const nc = parseImportText(programText, "circular-pocket.nc", { hint: "gcode" });
  if (inventory.kind !== "milo-bom" || nc.kind !== "gcode") throw new Error("圆槽示例需要 Milo 采购表和 G 代码程序。");
  const base = applyMiloBomImport(emptyWorkspace(), inventory.bom, `本站核对表 · ${miloBomSource.documentUrl}`);
  const assembled = miloAxisIds.reduce((axes, axis) => assembleMiloAxis(inventory.bom, axes, axis), base.milo.assembled);
  return { workspace: { ...base, milo: { ...base.milo, assembled, program: nc.program } }, plan: planMiloProgram(nc.program) };
}

export async function loadStudioExample(kind: StudioBenchKind, signal: AbortSignal): Promise<LoadedStudioExample> {
  signal.throwIfAborted();
  switch (kind) {
    case "wiring": return { workspace: createTwinDemo() };
    case "servo": {
      const text = await readStudioExampleText(import.meta.env.BASE_URL + modelicaServoProjectPath, signal);
      const result = parseImportText(text, modelicaServoProjectPath);
      if (result.kind !== "project" || !result.workspace.servoAxis) throw new Error("示例工程中缺少已装配的伺服轴。");
      return { workspace: result.workspace };
    }
    case "so101": {
      const bom = await readSo101ExampleBom(signal);
      const so101 = parseSo101Assembly({ modelId: SO101_MODEL_ID, bom, waypoints: DEFAULT_SO101_MOTION });
      return { workspace: { ...emptyWorkspace(), so101 } };
    }
    case "milo": return loadMiloPocket(signal);
  }
}

function installUsedPackages(project: TwinWorkspace, sample: TwinWorkspace, keys: string[]) {
  const available = new Map(sample.packages.map(device => [packageKey(device), device]));
  return [...new Set(keys)].reduce((next, key) => {
    const device = available.get(key);
    if (!device) throw new Error("示例引用的设备修订缺失，请重新打开示例。");
    return installPackage(next, device);
  }, project);
}

function orderedFields(_key: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
}
const same = (left: unknown, right: unknown) => JSON.stringify(left, orderedFields) === JSON.stringify(right, orderedFields);
type ExampleJoin = { next: TwinWorkspace; replacement?: string };

/** 仅计算拟议变更。提交与覆盖确认由工作台处理。 */
export function prepareStudioExampleJoin(kind: StudioBenchKind, project: TwinWorkspace, sample: TwinWorkspace): ExampleJoin {
  switch (kind) {
    case "wiring": {
      const base = installUsedPackages(project, sample, sample.instances.map(instance => instance.packageKey));
      const { instances, connections } = parseWorkspace({ ...emptyWorkspace(), packages: base.packages,
        instances: sample.instances, connections: sample.connections });
      if (same(project.instances, instances) && same(project.connections, connections)) return { next: base };
      const replacement = project.instances.length || project.connections.length
        ? `当前接线中的 ${project.instances.length} 个实例和 ${project.connections.length} 条接线将替换为示例的 ${instances.length} 个实例和 ${connections.length} 条接线。实例的输入值也将采用示例设置。` : undefined;
      return { next: { ...base, instances, connections }, replacement };
    }
    case "servo": {
      const axis = sample.servoAxis;
      if (!axis) throw new Error("请先组装示例伺服轴。");
      const base = installUsedPackages(project, sample, [axis.driveKey, axis.motorKey]);
      const next = assembleServoAxis(base, axis);
      if (same(project.servoAxis, next.servoAxis)) return { next: base };
      const deviceNames = new Map(base.packages.map(device => [packageKey(device), `${device.model} · ${device.revision}`]));
      const describe = (config: typeof axis) => [
        `${deviceNames.get(config.driveKey)} / ${deviceNames.get(config.motorKey)}`, `目标 ${config.targetDeg}°`, `负载惯量比 ${config.loadInertiaRatio}`,
        config.modelRef ? `${config.modelRef.id} @ ${config.modelRef.version}` : "工作台刚性轴模型",
      ].join("，");
      const replacement = project.servoAxis
        ? `当前伺服轴（${describe(project.servoAxis)}）将被示例配置（${describe(axis)}）替换。` : undefined;
      return { next, replacement };
    }
    case "so101": {
      const so101 = parseSo101Assembly(sample.so101);
      if (same(project.so101, so101)) return { next: project };
      const replacement = project.so101
        ? `当前 SO-101 的装配清单和 ${project.so101.waypoints.length} 个示教路点将被替换。示例包含 ${so101.waypoints.length} 个路点。` : undefined;
      return { next: { ...project, so101 }, replacement };
    }
    case "milo": {
      const milo = parseMiloWorkspace(sample.milo);
      if (same(project.milo, milo)) return { next: project };
      const replacement = project.milo
        ? `当前 Milo 的清单、已装 ${project.milo.assembled.length} 根轴和 G 代码程序将被替换。示例中已装 ${milo.assembled.length} 根轴。` : undefined;
      return { next: { ...project, milo }, replacement };
    }
  }
}
