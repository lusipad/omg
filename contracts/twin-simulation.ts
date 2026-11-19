import { z } from "zod";
import { assembleServoAxis, servoAxisConfigSchema, type ServoAxisConfig } from "./servo-axis";
import { parseSo101Assembly, type So101Assembly } from "./so101";
import { parseMiloWorkspace, type MiloWorkspaceState } from "./milo-workspace";
import { parseImportCatalog, type ImportCatalog } from "./import-catalog";
import { linearAssemblyListSchema, type LinearAssembly } from "./linear-assembly";
import { factoryListSchema, type FactoryLayout } from "./factory";
import { mechanismListSchema, type MechanicalAssembly } from "./mechanical-types";
import { packageKey, parseDevicePackage, readTwinData, signalIdSchema, type DevicePackage, type SignalPort } from "./twin-device";

export type SignalValue = number | boolean;
export const maxPackages = 128;
const maxInstances = 256, maxConnections = 2048;
const nameSchema = z.string().trim().min(1).max(160);
const endpointSchema = z.strictObject({ instanceId: signalIdSchema, portId: signalIdSchema });
const connectionSchema = z.strictObject({ from: endpointSchema, to: endpointSchema });
const inputsSchema = z.unknown().refine((value) => !value || typeof value !== "object" || !Object.hasOwn(value, "__proto__"), "输入含有保留属性名")
  .pipe(z.record(signalIdSchema, z.union([z.number().finite(), z.boolean()])));
const instanceSchema = z.strictObject({
  id: signalIdSchema, name: nameSchema, packageKey: z.string().min(1).max(4096), inputs: inputsSchema,
});
const workspaceSchema = z.strictObject({
  schemaVersion: z.literal(1), packages: z.array(z.unknown()).max(maxPackages),
  instances: z.array(instanceSchema).max(maxInstances), connections: z.array(connectionSchema).max(maxConnections),
  servoAxis: servoAxisConfigSchema.optional(),
  so101: z.unknown().optional(),
  milo: z.unknown().optional(),
  catalog: z.unknown().optional(),
  assemblies: linearAssemblyListSchema.optional(),
  mechanisms: mechanismListSchema.optional(),
  factories: factoryListSchema.optional(),
});

export type TwinInstance = z.infer<typeof instanceSchema>;
export type TwinConnection = z.infer<typeof connectionSchema>;
export interface TwinWorkspace {
  schemaVersion: 1;
  packages: DevicePackage[];
  instances: TwinInstance[];
  connections: TwinConnection[];
  servoAxis?: ServoAxisConfig;
  so101?: So101Assembly;
  milo?: MiloWorkspaceState;
  catalog?: ImportCatalog;
  assemblies?: LinearAssembly[];
  mechanisms?: MechanicalAssembly[];
  factories?: FactoryLayout[];
}
export interface SimulationState {
  timeMs: number;
  outputs: Record<string, Record<string, SignalValue>>;
  pendingMs: Record<string, Record<string, number>>;
}

export function emptyWorkspace(): TwinWorkspace {
  return { schemaVersion: 1, packages: [], instances: [], connections: [] };
}

/** 导入路由只认工程结构的身份，缺项与类型错误由 parseWorkspace 给出诊断。 */
export function hasWorkspaceShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coreKeys = ["packages", "instances", "connections"].filter((key) => Object.hasOwn(value, key)).length;
  return coreKeys >= 2 || (coreKeys === 1 && Object.hasOwn(value, "schemaVersion"));
}

function checkInput(port: SignalPort | undefined, id: string, value: SignalValue) {
  if (port?.direction !== "input") throw new Error(`找不到输入端口 ${id}`);
  if (typeof value !== port.type || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(`端口 ${id} 的值必须是${port.type === "boolean" ? "布尔值" : "有限数值"}`);
  }
}

interface NodePlan {
  instance: TwinInstance;
  pkg: DevicePackage;
  ports: Map<string, SignalPort>;
  incoming: Map<string, TwinConnection["from"]>;
  downstream: NodePlan[];
  dependencies: number;
}

function evaluationOrder(ws: TwinWorkspace): NodePlan[] {
  const catalog = new Map(ws.packages.map((pkg) => [packageKey(pkg), {
    pkg, ports: new Map(pkg.ports.map((port) => [port.id, port])),
  }]));
  if (catalog.size !== ws.packages.length) throw new Error("场景含有重复的设备修订");
  const nodes = new Map<string, NodePlan>();
  for (const instance of ws.instances) {
    if (nodes.has(instance.id)) throw new Error(`重复的实例标识 ${instance.id}`);
    const definition = catalog.get(instance.packageKey);
    if (!definition) throw new Error(`实例「${instance.name}」引用的设备修订尚未安装`);
    if (definition.pkg.factory) throw new Error("请将工厂设备用于产线工序或运输装配。");
    if (definition.pkg.servo) throw new Error("请将伺服设备装配到伺服轴");
    if (definition.pkg.feed) throw new Error("请将丝杠或工作台用于直线轴装配。");
    if (!definition.pkg.ports.length) throw new Error("纯机械设备没有信号端口，请使用机械装配。");
    for (const [id, value] of Object.entries(instance.inputs)) checkInput(definition.ports.get(id), id, value);
    nodes.set(instance.id, { ...definition, instance, incoming: new Map(), downstream: [], dependencies: 0 });
  }
  for (const { from, to } of ws.connections) {
    const source = nodes.get(from.instanceId), target = nodes.get(to.instanceId);
    if (!source || !target) throw new Error("接线引用的设备实例不存在");
    const output = source.ports.get(from.portId), input = target.ports.get(to.portId);
    if (output?.direction !== "output" || input?.direction !== "input") throw new Error("接线必须从已声明的输出端口连向输入端口");
    if (output.type !== input.type || output.unit !== input.unit) throw new Error("连接两端的信号类型与单位必须相同");
    if (target.incoming.has(input.id)) throw new Error(`输入 ${target.instance.name} · ${input.label} 已有接线`);
    target.incoming.set(input.id, from);
    target.dependencies++;
    source.downstream.push(target);
  }

  const ordered = [...nodes.values()].filter((node) => node.dependencies === 0);
  for (const node of ordered) {
    for (const next of node.downstream) {
      next.dependencies--;
      if (next.dependencies === 0) ordered.push(next);
    }
  }
  if (ordered.length !== nodes.size) throw new Error("场景包含信号回路，当前仿真只支持无环接线");
  return ordered;
}

export function parseWorkspace(value: unknown): TwinWorkspace {
  const { so101, milo, catalog, ...data } = readTwinData(workspaceSchema, value, "仿真场景");
  const ws: TwinWorkspace = { ...data, packages: data.packages.map(parseDevicePackage) };
  if (so101 !== undefined) ws.so101 = parseSo101Assembly(so101);
  if (milo !== undefined) ws.milo = parseMiloWorkspace(milo);
  if (catalog !== undefined) ws.catalog = parseImportCatalog(catalog, ws.packages);
  evaluationOrder(ws);
  return ws.servoAxis ? assembleServoAxis(ws, ws.servoAxis) : ws;
}

export function installPackage(ws: TwinWorkspace, value: unknown): TwinWorkspace {
  const pkg = parseDevicePackage(value), key = packageKey(pkg);
  const existing = ws.packages.find((entry) => packageKey(entry) === key);
  if (existing) {
    // 正在使用的旧装配也按当前指令映射顺序比较，保留真正的数值和数组差异。
    const stored = existing.mechanics?.kind === "assembly" ? parseDevicePackage(existing) : existing;
    if (JSON.stringify(stored) !== JSON.stringify(pkg)) throw new Error("该型号的相同修订已有不同内容，请核对版本后安装");
    return ws;
  }
  if (ws.packages.length >= maxPackages) throw new Error(`单个工作区最多安装 ${maxPackages} 个设备修订`);
  return { ...ws, packages: [...ws.packages, pkg] };
}

export function addInstance(ws: TwinWorkspace, key: string, name: string): TwinWorkspace {
  const pkg = ws.packages.find((entry) => packageKey(entry) === key);
  if (!pkg) throw new Error("请先安装设备包");
  if (pkg.factory) throw new Error("请将工厂设备用于产线工序或运输装配。");
  if (pkg.servo) throw new Error("请将伺服设备装配到伺服轴");
  if (pkg.feed) throw new Error("请将丝杠或工作台用于直线轴装配。");
  if (!pkg.ports.length) throw new Error("纯机械设备没有信号端口，请使用机械装配。");
  if (ws.instances.length >= maxInstances) throw new Error(`单个场景最多容纳 ${maxInstances} 个设备实例`);
  const label = readTwinData(nameSchema, name, "实例名称");
  const ids = new Set(ws.instances.map((instance) => instance.id));
  let serial = 1;
  while (ids.has(`node-${serial}`)) serial++;
  const instance = { id: `node-${serial}`, name: label, packageKey: key, inputs: {} };
  return { ...ws, instances: [...ws.instances, instance] };
}

export function nextInstanceName(ws: TwinWorkspace, model: string): string {
  const names = new Set(ws.instances.map((instance) => instance.name));
  for (let index = 1; ; index++) {
    const suffix = ` #${index}`;
    const name = model.slice(0, 160 - suffix.length) + suffix;
    if (!names.has(name)) return name;
  }
}

export function removeInstance(ws: TwinWorkspace, id: string): TwinWorkspace {
  return {
    ...ws, instances: ws.instances.filter((node) => node.id !== id),
    connections: ws.connections.filter(({ from, to }) => from.instanceId !== id && to.instanceId !== id),
  };
}

export function connectPorts(ws: TwinWorkspace, connection: TwinConnection): TwinWorkspace {
  if (ws.connections.length >= maxConnections) throw new Error(`单个场景最多容纳 ${maxConnections} 条接线`);
  const result = { ...ws, connections: [...ws.connections, readTwinData(connectionSchema, connection, "接线")] };
  evaluationOrder(result);
  return result;
}

export function disconnectPorts(ws: TwinWorkspace, connection: TwinConnection): TwinWorkspace {
  const connections = ws.connections.filter(({ from, to }) =>
    from.instanceId !== connection.from.instanceId || from.portId !== connection.from.portId ||
    to.instanceId !== connection.to.instanceId || to.portId !== connection.to.portId);
  return { ...ws, connections };
}

export function setInput(ws: TwinWorkspace, instanceId: string, portId: string, value: SignalValue): TwinWorkspace {
  const node = ws.instances.find((instance) => instance.id === instanceId);
  if (!node) throw new Error("设备实例不存在");
  const pkg = ws.packages.find((entry) => packageKey(entry) === node.packageKey);
  checkInput(pkg?.ports.find((port) => port.id === portId), portId, value);
  if (ws.connections.some(({ to }) => to.instanceId === instanceId && to.portId === portId)) throw new Error("该输入已由接线驱动");
  const updated = { ...node, inputs: { ...node.inputs, [portId]: value } };
  return { ...ws, instances: ws.instances.map((instance) => instance === node ? updated : instance) };
}

export function initialSimulation(ws: TwinWorkspace): SimulationState {
  return advanceSimulation(ws, { timeMs: 0, outputs: {}, pendingMs: {} }, 0);
}

// 外部输入在一步内保持恒定。数值通路只做组合运算，数字滤波的布尔输出可继续驱动布尔通路。
export function advanceSimulation(ws: TwinWorkspace, previous: SimulationState, deltaMs: number): SimulationState {
  const timeMs = previous.timeMs + deltaMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 0 || timeMs > Number.MAX_SAFE_INTEGER) throw new Error("步进时间超出有效范围");
  const state: SimulationState = { timeMs, outputs: {}, pendingMs: {} };
  for (const { instance, pkg, ports, incoming } of evaluationOrder(ws)) {
    const { id } = instance;
    const outputs: Record<string, SignalValue> = {}, pending: Record<string, number> = {};
    state.outputs[id] = outputs;
    state.pendingMs[id] = pending;
    for (const rule of pkg.rules) {
      const from = incoming.get(rule.input);
      const input = from ? state.outputs[from.instanceId][from.portId]
        : instance.inputs[rule.input] ?? (ports.get(rule.input)?.type === "boolean" ? false : 0);
      if (rule.op === "copy") {
        outputs[rule.output] = input;
      } else if (rule.op === "linear") {
        const result = (input as number) * rule.gain + rule.offset;
        if (!Number.isFinite(result)) throw new Error(`实例「${instance.name}」的 ${rule.output} 运算超出数值范围`);
        outputs[rule.output] = result;
      } else {
        const active = previous.outputs[id]?.[rule.output] === true;
        const changing = active ? (input as number) < rule.offBelow : (input as number) > rule.onAbove;
        const elapsed = changing ? (previous.pendingMs[id]?.[rule.output] ?? 0) + deltaMs : 0;
        const settled = changing && elapsed >= rule.filterMs;
        outputs[rule.output] = settled ? !active : active;
        if (changing && !settled) pending[rule.output] = elapsed;
      }
    }
  }
  return state;
}
