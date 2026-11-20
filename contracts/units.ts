/**
 * 确定性物理量纲与单位换算。无数据库或 DOM 依赖，前后端、提取校验器与装配编译器共用。
 */

export type Dimension =
  | "dimensionless"
  | "length"
  | "lead"
  | "angle"
  | "linear_velocity"
  | "angular_velocity"
  | "linear_acceleration"
  | "mass"
  | "inertia"
  | "force"
  | "torque"
  | "power"
  | "current"
  | "voltage"
  | "time"
  | "resistance"
  | "inductance"
  | "magnetic_flux"
  | "rotational_damping";

export interface UnitSpec {
  readonly canonical: string;
  readonly dimension: Dimension;
  readonly toSiScale: number;
}

interface InternalUnitSpec extends UnitSpec {
  readonly pow10?: number;
}

const REGISTRY = new Map<string, InternalUnitSpec>();

function normalizeUnitKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\u2212/g, "-")
    .replace(/[\u00B7\u2022\u22C5*]/g, ".")
    .replace(/\s*\^\s*/g, "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*\/\s*/g, "/")
    .replace(/^[×x]\s*(?=10|1e)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function register(
  canonical: string,
  dimension: Dimension,
  toSiScale: number,
  aliases: readonly string[] = [],
  pow10?: number,
) {
  const spec: InternalUnitSpec = pow10 === undefined
    ? { canonical, dimension, toSiScale }
    : { canonical, dimension, toSiScale, pow10 };
  for (const name of [canonical, ...aliases]) {
    REGISTRY.set(normalizeUnitKey(name), spec);
  }
}

// 无量纲
register("1", "dimensionless", 1, ["count", "pcs", "件"], 0);
register("%", "dimensionless", 0.01, ["percent"], -2);

// 长度
register("m", "length", 1, [], 0);
register("mm", "length", 1e-3, [], -3);
register("cm", "length", 1e-2, [], -2);
register("um", "length", 1e-6, ["μm", "µm"], -6);
register("in", "length", 0.0254, ["inch", "inches"]);

// 丝杠导程（每转线位移，SI 基准取 m/rev）
register("m/rev", "lead", 1, ["m/r"], 0);
register("mm/rev", "lead", 1e-3, ["mm/r"], -3);

// 角度
register("rad", "angle", 1);
register("deg", "angle", Math.PI / 180, ["°"]);
register("rev", "angle", 2 * Math.PI, ["r"]);

// 线速度
register("m/s", "linear_velocity", 1, [], 0);
register("mm/s", "linear_velocity", 1e-3, [], -3);
register("m/min", "linear_velocity", 1 / 60);
register("mm/min", "linear_velocity", 1e-3 / 60);

// 角速度
register("rad/s", "angular_velocity", 1);
register("rpm", "angular_velocity", (2 * Math.PI) / 60, ["r/min", "rev/min"]);
register("deg/s", "angular_velocity", Math.PI / 180, ["°/s"]);

// 线加速度
register("m/s2", "linear_acceleration", 1, ["m/s²", "m/s^2"], 0);
register("mm/s2", "linear_acceleration", 1e-3, ["mm/s²", "mm/s^2"], -3);

// 质量
register("kg", "mass", 1, [], 0);
register("g", "mass", 1e-3, [], -3);
register("t", "mass", 1e3, [], 3);

// 转动惯量
register("kg.m2", "inertia", 1, ["kg·m²", "kg*m^2", "kg.m^2", "kgm2"], 0);
register("1e-4 kg.m2", "inertia", 1e-4, [
  "10^-4 kg.m2",
  "10⁻⁴ kg·m²",
  "×10⁻⁴ kg·m²",
  "10-4 kg.m2",
  "10-4 kg·m²",
  "10^-4kg.m2",
  "10-4kg.m2",
  "1e-4kg.m2",
], -4);
register("kg.cm2", "inertia", 1e-4, ["kg·cm²", "kg*cm^2", "kg.cm^2"], -4);
register("g.cm2", "inertia", 1e-7, ["g·cm²", "g*cm^2", "g.cm^2"], -7);
register("kg.mm2", "inertia", 1e-6, ["kg·mm²", "kg*mm^2", "kg.mm^2"], -6);

// 力
register("N", "force", 1, [], 0);
register("kN", "force", 1e3, [], 3);
register("mN", "force", 1e-3, [], -3);

// 转矩
register("N.m", "torque", 1, ["N·m", "Nm", "N*m"], 0);
register("mN.m", "torque", 1e-3, ["mN·m", "mNm", "mN*m"], -3);
register("kN.m", "torque", 1e3, ["kN·m", "kNm", "kN*m"], 3);

// 功率
register("W", "power", 1, [], 0);
register("kW", "power", 1e3, [], 3);
register("mW", "power", 1e-3, [], -3);

// 电流
register("A", "current", 1, ["Arms", "A(rms)", "A (rms)", "ADC", "A DC"], 0);
register("mA", "current", 1e-3, [], -3);

// 电压
register("V", "voltage", 1, ["VDC", "VAC", "Vrms", "V (rms)", "V DC", "V AC"], 0);
register("mV", "voltage", 1e-3, [], -3);
register("kV", "voltage", 1e3, [], 3);

// 时间
register("s", "time", 1, ["sec"], 0);
register("ms", "time", 1e-3, ["msec"], -3);
register("us", "time", 1e-6, ["μs", "µs", "usec"], -6);
register("min", "time", 60);

// 电阻
register("Ohm", "resistance", 1, ["Ω", "ohm"], 0);
register("mOhm", "resistance", 1e-3, ["mΩ", "mohm"], -3);
register("kOhm", "resistance", 1e3, ["kΩ", "kohm"], 3);

// 电感
register("H", "inductance", 1, [], 0);
register("mH", "inductance", 1e-3, [], -3);
register("uH", "inductance", 1e-6, ["μH", "µH"], -6);

// 磁链
register("Wb", "magnetic_flux", 1, [], 0);
register("mWb", "magnetic_flux", 1e-3, [], -3);

// 旋转阻尼
register("N.m.s/rad", "rotational_damping", 1, ["N·m·s/rad", "Nm.s/rad", "Nms/rad"]);

function lookupUnit(rawUnit: string): InternalUnitSpec | undefined {
  if (!rawUnit || typeof rawUnit !== "string") return undefined;
  return REGISTRY.get(normalizeUnitKey(rawUnit));
}

export function parseUnitSpec(rawUnit: string): UnitSpec | undefined {
  const found = lookupUnit(rawUnit);
  if (!found) return undefined;
  return { canonical: found.canonical, dimension: found.dimension, toSiScale: found.toSiScale };
}

export function areUnitsCompatible(fromUnit: string, toUnit: string): boolean {
  const from = lookupUnit(fromUnit);
  const to = lookupUnit(toUnit);
  return Boolean(from && to && from.dimension === to.dimension);
}

function shiftPow10(value: number, exp: number): number {
  if (exp === 0 || value === 0) return value;
  const match = value.toString().match(/^([+-]?\d+(?:\.\d+)?)(?:e([+-]?\d+))?$/i);
  if (!match) return value * 10 ** exp;
  return Number(`${match[1]}e${Number(match[2] ?? 0) + exp}`);
}

export function convertUnit(value: number, fromUnit: string, toUnit: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`参数数值无效，无法从“${fromUnit}”换算到“${toUnit}”。`);
  }
  const from = lookupUnit(fromUnit);
  if (!from) {
    throw new Error(`不支持的源单位“${fromUnit}”，无法换算到“${toUnit}”。`);
  }
  const to = lookupUnit(toUnit);
  if (!to) {
    throw new Error(`不支持的目标单位“${toUnit}”。`);
  }
  if (from.dimension !== to.dimension) {
    throw new Error(`量纲不匹配：不能将“${fromUnit}”（${from.dimension}）换算为“${toUnit}”（${to.dimension}）。`);
  }
  if (from.canonical === to.canonical) return value;

  const result = from.pow10 !== undefined && to.pow10 !== undefined
    ? shiftPow10(value, from.pow10 - to.pow10)
    : value * (from.toSiScale / to.toSiScale);

  if (!Number.isFinite(result)) {
    throw new Error(`数值 ${value} 从“${fromUnit}”换算到“${toUnit}”时超出可表示范围。`);
  }
  return result;
}

export function applyLinearTransform(value: number, factor = 1, offset = 0): number {
  if (!Number.isFinite(value) || !Number.isFinite(factor) || !Number.isFinite(offset)) {
    throw new Error("线性参数变换必须使用有限数值。");
  }
  const result = factor * value + offset;
  if (!Number.isFinite(result)) {
    throw new Error("线性参数变换结果超出可表示范围。");
  }
  return result;
}

export function parseQuantityText(text: string): { value: number; unit: string; spec: UnitSpec } | undefined {
  if (!text || typeof text !== "string") return undefined;
  const normalized = text.normalize("NFKC").replace(/\u2212/g, "-").trim();
  if (!normalized) return undefined;
  // 拒绝不等式、公差与显式范围文本，避免把条件或范围误当成确定单值
  if (/^[<>≤≥≈±]/.test(normalized) || /[~～至±]/.test(normalized)) return undefined;

  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*(.+)$/i);
  if (!match) return undefined;

  const value = Number(match[1]);
  const rawRest = match[2].trim();
  if (!Number.isFinite(value) || !rawRest) return undefined;
  // 拒绝类似 "10-20 mm"、"40 x 48 mm" 的区间或多维尺寸（允许 "×10-4 kg.m2" 倍率写法）
  if (/^[-–—]/.test(rawRest) || /^[×x]\s*(?!10(?:\^-?|-\d)|1e)/i.test(rawRest)) return undefined;

  const spec = parseUnitSpec(rawRest);
  if (!spec) return undefined;
  return { value, unit: spec.canonical, spec };
}
