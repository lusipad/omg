import { z } from "zod";
import { mechanicsSchema, signalIdSchema } from "./mechanical-types";
export { signalIdSchema } from "./mechanical-types";

const text = (limit: number) => z.string().trim().min(1).max(limit);

const portSchema = z.strictObject({
  id: signalIdSchema, label: text(160), direction: z.enum(["input", "output"]),
  type: z.enum(["number", "boolean"]), unit: text(40).optional(),
});
const endpoints = { input: signalIdSchema, output: signalIdSchema };
const ruleSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("copy"), ...endpoints }),
  z.strictObject({ op: z.literal("linear"), ...endpoints, gain: z.number().finite(), offset: z.number().finite() }),
  z.strictObject({
    op: z.literal("digitalInput"), ...endpoints, onAbove: z.number().finite(), offBelow: z.number().finite(),
    filterMs: z.number().finite().nonnegative(),
  }),
]);

const positiveRating = z.number().finite().positive();
export const modelRefSchema = z.strictObject({ id: text(240), version: text(80) });
export type ModelReference = z.infer<typeof modelRefSchema>;
const feedSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lead-screw"), leadMmPerRev: positiveRating, modelRef: modelRefSchema }),
  z.strictObject({ kind: z.literal("moving-table"), massKg: positiveRating, modelRef: modelRefSchema }),
]);
const servoSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drive"), ratedCurrentA: positiveRating, peakCurrentA: positiveRating, modelRef: modelRefSchema.optional() }),
  z.strictObject({
    kind: z.literal("motor"), ratedPowerW: positiveRating, ratedTorqueNm: positiveRating, peakTorqueNm: positiveRating,
    ratedSpeedRpm: positiveRating, maxSpeedRpm: positiveRating, rotorInertiaKgM2: positiveRating,
    ratedCurrentA: positiveRating.optional(), compatibleDriveModels: z.array(text(160)).max(256), modelRef: modelRefSchema.optional(),
  }),
]);
const sourceUrl = text(2048).pipe(z.url({ protocol: /^https?$/ }));
const pointPair = z.tuple([z.number().finite(), z.number().finite()]);
const calibrationSchema = z.strictObject({ inputPoints: pointPair, outputPoints: pointPair });
const packageSchema = z.strictObject({
  schemaVersion: z.literal(1), manufacturer: text(160), model: text(160), revision: text(160),
  source: z.strictObject({
    title: text(512), url: z.union([sourceUrl, z.literal("")]), locator: text(512), excerpt: text(16_000),
    productUrl: sourceUrl.optional(), kind: z.literal("local").optional(),
  }).refine(source => source.kind === "local" ? !source.url && !source.productUrl : Boolean(source.url),
    "本地资料请标为 local 并留空链接，在线资料须提供 HTTP 或 HTTPS 来源链接"),
  ports: z.array(portSchema).max(256), rules: z.array(ruleSchema).max(128), servo: servoSchema.optional(), feed: feedSchema.optional(),
  calibration: calibrationSchema.optional(), mechanics: mechanicsSchema.optional(),
});

export type SignalPort = z.infer<typeof portSchema>;
export type DeviceRule = z.infer<typeof ruleSchema>;
export type DevicePackage = z.infer<typeof packageSchema>;
export type ServoDrive = Extract<z.infer<typeof servoSchema>, { kind: "drive" }>;
export type ServoMotor = Extract<z.infer<typeof servoSchema>, { kind: "motor" }>;

export function linearCoefficients({ inputPoints: [x1, x2], outputPoints: [y1, y2] }: z.infer<typeof calibrationSchema>) {
  if (x1 === x2) throw new Error("两组标定的输入值必须不同。");
  const dx = x2 - x1, dy = y2 - y1;
  const gain = dy / dx, offset = y1 - gain * x1;
  if (![dx, dy, gain, offset].every(Number.isFinite) || (dy !== 0 && gain === 0)) throw new Error("标定值超出可计算范围。");
  return { gain, offset };
}

export function readTwinData<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value, { error: z.locales.zhCN().localeError });
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`${label}格式有误（${issue.path.map(String).join(".") || "根节点"}）${issue.message}`);
}

export function packageKey(pkg: Pick<DevicePackage, "manufacturer" | "model" | "revision">): string {
  return JSON.stringify([pkg.manufacturer.trim(), pkg.model.trim(), pkg.revision.trim()]);
}

export function parseDevicePackage(value: unknown): DevicePackage {
  const model = value && typeof value === "object" && "mechanics" in value && "model" in value && typeof value.model === "string" ? value.model.trim().slice(0, 160) : "";
  const pkg = readTwinData(packageSchema, value, model ? `设备包“${model}”` : "设备包");
  if (pkg.feed && pkg.servo) throw new Error("设备修订只能声明一种轴角色，请分别提供伺服设备包和进给部件包。");
  if (pkg.feed && (pkg.ports.length || pkg.rules.length)) throw new Error("进给部件通过机械接口连接，请将信号端口和规则留空。");
  if (pkg.calibration) {
    const { gain, offset } = linearCoefficients(pkg.calibration);
    const [rule] = pkg.rules;
    const agrees = (actual: number, expected: number) => Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected));
    if (pkg.rules.length !== 1 || rule?.op !== "linear" || !agrees(rule.gain, gain) || !agrees(rule.offset, offset)) {
      throw new Error("设备包的线性规则与记录的两点标定不相符。");
    }
  }
  if (pkg.servo) {
    if (pkg.ports.length || pkg.rules.length) throw new Error("伺服设备使用轴装配模型，请将信号端口和规则留空");
    const servo = pkg.servo;
    if (servo.kind === "drive" && servo.peakCurrentA < servo.ratedCurrentA) throw new Error("驱动器峰值电流不能低于额定电流");
    if (servo.kind === "motor") {
      if (servo.peakTorqueNm < servo.ratedTorqueNm) throw new Error("电机峰值转矩不能低于额定转矩");
      if (servo.maxSpeedRpm < servo.ratedSpeedRpm) throw new Error("电机最高转速不能低于额定转速");
      if (servo.compatibleDriveModels.some((model) => /[*?□…]/u.test(model))) throw new Error("配套驱动型号必须写完整");
    }
    if (/[*?□…]/u.test(pkg.model)) throw new Error("伺服设备需要完整型号");
    return pkg;
  }
  if (pkg.ports.length === 0 && !pkg.mechanics && !pkg.feed) throw new Error("信号设备至少需要一个端口");
  const ports = new Map(pkg.ports.map((port) => [port.id, port]));
  if (ports.size !== pkg.ports.length) throw new Error("设备包内的端口标识必须唯一");
  for (const port of pkg.ports) {
    if (port.type === "boolean" && port.unit) throw new Error(`布尔端口 ${port.id} 不能带有物理单位`);
  }

  const driven = new Set<string>();
  for (const rule of pkg.rules) {
    const input = ports.get(rule.input), output = ports.get(rule.output);
    if (input?.direction !== "input" || output?.direction !== "output") {
      throw new Error(`规则 ${rule.input} → ${rule.output} 必须引用已声明的输入和输出端口`);
    }
    if (driven.has(output.id)) throw new Error(`输出端口 ${output.id} 只能有一条规则`);
    driven.add(output.id);
    if (rule.op === "copy" && (input.type !== output.type || input.unit !== output.unit)) {
      throw new Error(`复制规则 ${output.id} 的输入输出类型与单位必须相同`);
    }
    if (rule.op === "linear" && (input.type !== "number" || output.type !== "number")) {
      throw new Error(`线性规则 ${output.id} 需要数值输入和数值输出`);
    }
    if (rule.op === "digitalInput" && (input.type !== "number" || input.unit !== "V" || output.type !== "boolean" || rule.onAbove <= rule.offBelow)) {
      throw new Error(`数字输入规则 ${output.id} 需要单位为 V 的数值输入和布尔输出，接通阈值须大于断开阈值`);
    }
  }
  for (const port of pkg.ports) {
    if (port.direction === "output" && !driven.has(port.id)) throw new Error(`输出端口 ${port.id} 缺少行为规则`);
  }
  return pkg;
}
