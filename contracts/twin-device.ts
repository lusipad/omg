import { z } from "zod";

const text = (limit: number) => z.string().trim().min(1).max(limit);
export const signalIdSchema = z.string().max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "标识只支持字母、数字、连字符与下划线")
  .refine((id) => id !== "prototype" && !Object.hasOwn(Object.prototype, id), "标识使用了保留属性名");

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
const servoSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drive"), ratedCurrentA: positiveRating, peakCurrentA: positiveRating }),
  z.strictObject({
    kind: z.literal("motor"), ratedPowerW: positiveRating, ratedTorqueNm: positiveRating, peakTorqueNm: positiveRating,
    ratedSpeedRpm: positiveRating, maxSpeedRpm: positiveRating, rotorInertiaKgM2: positiveRating,
    ratedCurrentA: positiveRating.optional(), compatibleDriveModels: z.array(text(160)).max(256),
  }),
]);
const sourceUrl = text(2048).pipe(z.url({ protocol: /^https?$/ }));
const packageSchema = z.strictObject({
  schemaVersion: z.literal(1), manufacturer: text(160), model: text(160), revision: text(160),
  source: z.strictObject({
    title: text(512), url: sourceUrl, locator: text(512), excerpt: text(16_000), productUrl: sourceUrl.optional(),
  }),
  ports: z.array(portSchema).max(256), rules: z.array(ruleSchema).max(128), servo: servoSchema.optional(),
});

export type SignalPort = z.infer<typeof portSchema>;
export type DeviceRule = z.infer<typeof ruleSchema>;
export type DevicePackage = z.infer<typeof packageSchema>;
export type ServoDrive = Extract<z.infer<typeof servoSchema>, { kind: "drive" }>;
export type ServoMotor = Extract<z.infer<typeof servoSchema>, { kind: "motor" }>;

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
  const pkg = readTwinData(packageSchema, value, "设备包");
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
  if (pkg.ports.length === 0) throw new Error("信号设备至少需要一个端口");
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
