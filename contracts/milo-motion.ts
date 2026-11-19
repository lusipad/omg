import { arcCardinals, arcTangent, createMiloArc, fullTurn, pointOnMiloArc, type MiloArc } from "./milo-arc";
export type { MiloArc } from "./milo-arc";

/** Milo v1.5 / reference-fly-cdyv3（limits.g、speed.g、drives.g）。
 * https://github.com/MillenniumMachines/RRF-Configs/tree/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3
 */
export type MiloVec3 = [number, number, number];
export type MiloMoveMode = "G0" | "G1" | "G2" | "G3";
export interface CncMotionProfile {
  minMm: MiloVec3; maxMm: MiloVec3; workOriginMachineMm: MiloVec3; initialWorkMm: MiloVec3;
  maxFeedMmMin: MiloVec3; accelerationMmS2: MiloVec3;
}
export const MILO_MACHINE = {
  minMm: [0, 0, -120], maxMm: [335, 208, 0],
  maxFeedMmMin: [1500, 1500, 1000], accelerationMmS2: [200, 200, 100], stepsPerMm: [800, 800, 1600],
  // 本次虚拟装夹。机床坐标 = 工件坐标 + 工件零点在机床系的位置。
  workOriginMachineMm: [10, 10, -20], initialWorkMm: [0, 0, 5],
} satisfies Record<string, MiloVec3>;
export const MILO_MAX_PROGRAM_CHARS = 65_536;
export const miloDemoGcode = `; Milo v1.5 三轴联动
G21 G90 G94
G0 Z8
G1 Z0 F180
G1 X30 Y40 F600
G91
G1 X-6 Y-8 Z3 F300
G90
G0 Z8
G0 X0 Y0`;

export class MiloProgramError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(line: number, column: number, reason: string) {
    super(`第 ${line} 行，第 ${column} 列：${reason}`);
    this.name = "MiloProgramError";
    this.line = line;
    this.column = column;
  }
}
export interface MiloSegment {
  line: number; mode: MiloMoveMode;
  startMm: MiloVec3; endMm: MiloVec3;
  /** 直线方向或曲线起点的单位切向向量。 */
  direction: MiloVec3;
  arc?: MiloArc;
  startS: number; endS: number; lengthMm: number;
  feedMmMin: number | null; accelerationMmS2: number; peakSpeedMmS: number;
  rampS: number; cruiseS: number;
}
export interface CncCommandSample {
  timeS: number; line: number | null; mode: MiloMoveMode | null;
  positionMm: MiloVec3; velocityMmS: MiloVec3; pathSpeedMmS: number;
}
export interface MiloMotionSample extends CncCommandSample {
  machineMm: MiloVec3; stepCounts: MiloVec3;
}
export interface CncMotionPath {
  segments: MiloSegment[]; durationS: number; totalLengthMm: number;
}
export interface MiloMotionPlan extends CncMotionPath {
  samples: MiloMotionSample[];
}

const axes = ["X", "Y", "Z"] as const;
const vector = (f: (axis: number) => number): MiloVec3 => [f(0), f(1), f(2)];
type Word = { letter: string; raw: string; value: number; column: number };

function readWords(text: string, line: number): Word[] {
  const words: Word[] = [], decimal = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/y;
  let i = 0;
  while (i < text.length) {
    const ch = text[i], column = i + 1;
    if (/\s/u.test(ch)) { i++; continue; }
    if (ch === ";") break;
    if (ch === "(") {
      let depth = 1;
      while (++i < text.length) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      if (depth) throw new MiloProgramError(line, column, "括号注释需要在本行闭合。");
      i++;
      continue;
    }
    if (!/[a-z]/i.test(ch)) throw new MiloProgramError(line, column, `无法识别字符“${ch}”。`);
    const letter = ch.toUpperCase();
    i++;
    while (i < text.length && /\s/u.test(text[i])) i++;
    decimal.lastIndex = i;
    const raw = decimal.exec(text)?.[0];
    if (!raw) throw new MiloProgramError(line, column, `${letter} 后需要十进制数值。`);
    const value = Number(raw);
    if (!Number.isFinite(value) || (value === 0 && /[1-9]/.test(raw))) throw new MiloProgramError(line, column, `${letter} 的数值超出可表示范围。`);
    words.push({ letter, raw, value, column });
    i = decimal.lastIndex;
  }
  return words;
}

function segment(profile: CncMotionProfile, from: MiloVec3, to: MiloVec3, mode: MiloMoveMode, feedMmMin: number | null, startS: number, line: number, column: number, arc?: MiloArc): MiloSegment {
  const delta = vector((i) => to[i] - from[i]);
  const xyArc = arc ? arc.radiusMm * Math.abs(arc.sweepRad) : 0;
  const lengthMm = arc ? Math.hypot(xyArc, delta[2]) : Math.hypot(...delta);
  const direction = arc ? arcTangent(arc, delta[2], lengthMm, 0) : vector((i) => delta[i] / lengthMm);
  const maxTangent = vector((i) => Math.abs(direction[i]));
  if (arc) {
    const bounds = arcCardinals(arc, from);
    for (const p of bounds) {
      for (const [i, value] of [p.x, p.y].entries()) {
        const machine = value + profile.workOriginMachineMm[i];
        // 极值与端点同处机床行程坐标系。远处圆心的量级不能放宽机床软限位。
        const eps = 32 * Number.EPSILON * Math.max(1, Math.abs(profile.minMm[i]), Math.abs(profile.maxMm[i]), Math.abs(machine));
        if (!Number.isFinite(machine) || machine < profile.minMm[i] - eps || machine > profile.maxMm[i] + eps) {
          throw new MiloProgramError(line, column, `圆弧途中的 ${axes[i]} 超出行程，机床坐标达到 ${Number(machine.toPrecision(9))} mm。`);
        }
      }
    }
    for (const f of [1, ...bounds.map((p) => p.fraction)]) {
      const tangent = arcTangent(arc, delta[2], lengthMm, f);
      for (let i = 0; i < 3; i++) maxTangent[i] = Math.max(maxTangent[i], Math.abs(tangent[i]));
    }
  }
  let speedLimit = mode === "G0" ? Infinity : feedMmMin! / 60;
  let accelerationMmS2 = Infinity;
  for (let i = 0; i < 3; i++) {
    const component = maxTangent[i];
    if (!component) continue;
    speedLimit = Math.min(speedLimit, profile.maxFeedMmMin[i] / 60 / component);
    accelerationMmS2 = Math.min(accelerationMmS2, profile.accelerationMmS2[i] / component);
  }
  if (arc) {
    // 螺旋平面投影比例 k，法向加速度为 k²v²/r，XY 切向分量为 k·a_t。
    // 高进给时为相互垂直的两项各留至多 A/√2，保证合成后的轴加速度限值。
    const k = xyArc / lengthMm, curvature = k * k / arc.radiusMm;
    const xyMax = Math.min(profile.accelerationMmS2[0], profile.accelerationMmS2[1]);
    speedLimit = Math.min(speedLimit, Math.sqrt((xyMax / Math.SQRT2) / curvature));
    const normal = curvature * speedLimit * speedLimit;
    accelerationMmS2 = Math.min(accelerationMmS2, Math.sqrt((xyMax - normal) * (xyMax + normal)) / k);
  }
  // 两个斜坡的总距离为 v²/a；短段在半程达到峰值后直接减速。
  const triangularPeak = Math.sqrt(lengthMm * accelerationMmS2);
  const peakSpeedMmS = Math.min(speedLimit, triangularPeak);
  const rampS = peakSpeedMmS / accelerationMmS2;
  const cruiseS = speedLimit >= triangularPeak ? 0 : Math.max(0, lengthMm / peakSpeedMmS - rampS);
  const endS = startS + 2 * rampS + cruiseS;
  if (!Number.isFinite(endS) || endS <= startS || endS > Number.MAX_SAFE_INTEGER / 1000) {
    throw new MiloProgramError(line, column, "该段进给与位移产生的时长超出可表示范围。");
  }
  return { line, mode, startMm: from, endMm: to, direction, ...(arc ? { arc } : {}), lengthMm, startS, endS,
    feedMmMin: mode === "G0" ? null : feedMmMin, accelerationMmS2, peakSpeedMmS, rampS, cruiseS };
}

export function planCncPath(program: string, profile: CncMotionProfile, maximumS = Infinity): CncMotionPath {
  if (typeof program !== "string") throw new MiloProgramError(1, 1, "请输入 G 代码程序。");
  if (program.length > MILO_MAX_PROGRAM_CHARS) {
    const allowed = program.slice(0, MILO_MAX_PROGRAM_CHARS).split(/\r\n|[\r\n]/);
    throw new MiloProgramError(allowed.length, allowed[allowed.length - 1].length + 1, "程序长度超过 65,536 个字符。");
  }
  const lines = program.split(/\r\n|[\r\n]/);
  if (lines.length > 2000) throw new MiloProgramError(2001, 1, "程序超过 2,000 行。");
  const plan: CncMotionPath = { segments: [], durationS: 0, totalLengthMm: 0 };
  let mode: MiloMoveMode | null = null, absolute = true, feedMmMin: number | null = null;
  let position: MiloVec3 = [...profile.initialWorkMm], hasCode = false;
  for (const [index, text] of lines.entries()) {
    const line = index + 1, words = readWords(text, line);
    const fields = new Map<string, Word>(), groups = new Set<string>();
    for (const [n, word] of words.entries()) {
      const { letter, value, raw, column } = word;
      if (letter === "N") {
        if (n !== 0 || !/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new MiloProgramError(line, column, "N 行号应是程序块开头的非负整数。");
        continue;
      }
      hasCode = true;
      if (letter === "G") {
        if (!/^\d+$/.test(raw) && !/^0*91\.1$/.test(raw)) throw new MiloProgramError(line, column, `不支持 G${raw}。`);
        let group: string;
        switch (value) {
          case 0: case 1: case 2: case 3: group = "运动"; mode = `G${value}`; break;
          case 17: group = "圆弧平面"; break;
          case 18: case 19: throw new MiloProgramError(line, column, `G${value} 平面暂未支持，请使用 G17 XY 平面。`);
          case 90: case 91: group = "坐标"; absolute = value === 90; break;
          case 91.1: group = "圆心偏置"; break;
          case 21: group = "长度单位"; break;
          case 94: group = "进给单位"; break;
          default: throw new MiloProgramError(line, column, `不支持指令 G${raw}。`);
        }
        if (groups.has(group)) throw new MiloProgramError(line, column, `同一行重复指定${group}模式。`);
        groups.add(group);
      } else {
        if (!["X", "Y", "Z", "I", "J", "R", "F"].includes(letter)) throw new MiloProgramError(line, column, `不支持地址字 ${letter}${raw}。`);
        if (fields.has(letter)) throw new MiloProgramError(line, column, `同一行重复指定 ${letter}。`);
        fields.set(letter, word);
      }
    }
    const feed = fields.get("F");
    if (feed) {
      if (feed.value <= 0) throw new MiloProgramError(line, feed.column, "进给 F 必须大于零，单位为 mm/min。");
      feedMmMin = feed.value;
    }
    const firstAxis = words.find((w) => ["X", "Y", "Z", "I", "J", "R"].includes(w.letter));
    if (!firstAxis) continue;
    if (!mode) throw new MiloProgramError(line, firstAxis.column, "轴移动之前须选择 G0、G1、G2 或 G3。");
    const circular = mode === "G2" || mode === "G3";
    const arcWord = fields.get("R") ?? fields.get("I") ?? fields.get("J");
    if (!circular && arcWord) throw new MiloProgramError(line, arcWord.column, `${arcWord.letter} 仅适用于 G2/G3 圆弧。`);
    if (mode !== "G0" && feedMmMin === null) throw new MiloProgramError(line, firstAxis.column, `首次 ${mode} 移动需要正进给 F。`);
    const to = vector((i) => {
      const word = fields.get(axes[i]);
      if (!word) return position[i];
      const value = absolute ? word.value : position[i] + word.value;
      const min = profile.minMm[i] - profile.workOriginMachineMm[i];
      const max = profile.maxMm[i] - profile.workOriginMachineMm[i];
      const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(min), Math.abs(max), 1);
      if (!Number.isFinite(value) || value < min - tolerance || value > max + tolerance) throw new MiloProgramError(line, word.column,
        `${axes[i]} 超出行程。该轴允许的工件坐标为 ${min} 至 ${max} mm，机床坐标为 ${profile.minMm[i]} 至 ${profile.maxMm[i]} mm。`);
      if (!absolute && word.value !== 0 && value === position[i]) throw new MiloProgramError(line, word.column, `${axes[i]} 增量低于当前坐标可表示的精度。`);
      return Math.min(max, Math.max(min, value));
    });
    let arc: MiloArc | undefined;
    if (circular) {
      try { arc = createMiloArc(position, to, mode === "G2", fields.get("I")?.value, fields.get("J")?.value, fields.get("R")?.value); }
      catch (error) { throw new MiloProgramError(line, arcWord?.column ?? firstAxis.column, error instanceof Error ? error.message : "圆弧参数无效。"); }
    } else if (to.every((v, i) => v === position[i])) continue;
    if (plan.segments.length >= 1000) throw new MiloProgramError(line, firstAxis.column, "程序超过 1,000 个位移段。");
    const next = segment(profile, position, to, mode, feedMmMin, plan.durationS, line, firstAxis.column, arc);
    if (next.endS > maximumS) throw new MiloProgramError(line, firstAxis.column, `程序累计时长超过 ${maximumS} s 的联动仿真范围。`);
    plan.segments.push(next);
    plan.durationS = next.endS;
    plan.totalLengthMm += next.lengthMm;
    position = to;
  }
  if (!hasCode) throw new MiloProgramError(1, 1, "程序中没有可识别的指令或地址字。");
  return plan;
}

export function planMiloProgram(program: string): MiloMotionPlan {
  const plan: MiloMotionPlan = { ...planCncPath(program, MILO_MACHINE), samples: [] };
  const times = new Set<number>([0]);
  const arcCount = plan.segments.filter((s) => s.arc).length;
  const perCircle = Math.max(4, Math.min(48, Math.floor(4000 / Math.max(1, arcCount))));
  for (const s of plan.segments) {
    times.add(s.startS + s.rampS / 2);
    times.add(s.startS + s.rampS);
    if (s.cruiseS > 0) times.add(s.endS - s.rampS);
    times.add(s.endS - s.rampS / 2);
    times.add(s.endS);
    if (s.arc) {
      const fractions = [0.25, 0.5, 0.75, ...arcCardinals(s.arc).map((p) => p.fraction)];
      const divisions = Math.max(2, Math.ceil(perCircle * Math.abs(s.arc.sweepRad) / fullTurn));
      for (let i = 1; i < divisions; i++) fractions.push(i / divisions);
      for (const fraction of fractions) if (fraction > 0 && fraction < 1) times.add(miloTimeAtFraction(s, fraction));
    }
  }
  plan.samples = [...times].sort((a, b) => a - b).map((t) => sampleMiloMotion(plan, t));
  return plan;
}

function pathState(s: MiloSegment, t: number) {
  const elapsed = t - s.startS, remaining = s.endS - t;
  const tolerance = Math.min((s.endS - s.startS) / 16, 8 * Number.EPSILON * Math.max(1, s.endS));
  if (elapsed <= tolerance) return { fraction: 0, speed: 0 };
  if (remaining <= tolerance) return { fraction: 1, speed: 0 };
  let travelled: number, speed: number;
  if (elapsed < s.rampS) {
    speed = s.accelerationMmS2 * elapsed;
    travelled = speed * elapsed / 2;
  } else if (remaining < s.rampS) {
    speed = s.accelerationMmS2 * remaining;
    travelled = s.lengthMm - speed * remaining / 2;
  } else {
    speed = s.peakSpeedMmS;
    travelled = speed * (elapsed - s.rampS / 2);
  }
  return { fraction: Math.min(1, Math.max(0, travelled / s.lengthMm)), speed };
}

export function miloTimeAtFraction(s: MiloSegment, fraction: number) {
  const distance = fraction * s.lengthMm, remaining = s.lengthMm - distance;
  const rampDistance = s.peakSpeedMmS * s.rampS / 2;
  if (distance <= rampDistance) return s.startS + Math.sqrt(2 * distance / s.accelerationMmS2);
  if (remaining <= rampDistance) return s.endS - Math.sqrt(2 * remaining / s.accelerationMmS2);
  return s.startS + s.rampS + (distance - rampDistance) / s.peakSpeedMmS;
}

export function miloSegmentFractionAtTime(segment: MiloSegment, timeS: number): number {
  if (!Number.isFinite(timeS)) throw new Error("采样时间必须为有限秒数。");
  return pathState(segment, timeS).fraction;
}

export function miloPointOnSegment(s: MiloSegment, fraction: number): MiloVec3 {
  if (!Number.isFinite(fraction)) throw new Error("路径比例必须为有限数。");
  if (fraction <= 0) return [...s.startMm];
  if (fraction >= 1) return [...s.endMm];
  return s.arc ? pointOnMiloArc(s.arc, s.startMm, s.endMm, fraction) :
    vector((i) => s.startMm[i] + (s.endMm[i] - s.startMm[i]) * fraction);
}

/** 每段精确起停。折点归入刚结束的程序块，超出回放区间的时刻固定在首末状态。 */
export function sampleCncPath(plan: CncMotionPath, initialWorkMm: MiloVec3, timeS: number): CncCommandSample {
  if (!Number.isFinite(timeS)) throw new Error("采样时间必须为有限秒数。");
  const t = Math.max(0, Math.min(plan.durationS, timeS));
  let lo = 0, hi = plan.segments.length - 1;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (t <= plan.segments[mid].endS) hi = mid; else lo = mid + 1;
  }
  const s = plan.segments[lo];
  const { fraction, speed: pathSpeedMmS } = s ? pathState(s, t) : { fraction: 0, speed: 0 };
  const positionMm: MiloVec3 = s ? miloPointOnSegment(s, fraction) : [...initialWorkMm];
  const tangent = s?.arc ? arcTangent(s.arc, s.endMm[2] - s.startMm[2], s.lengthMm, fraction) : s?.direction;
  const velocityMmS: MiloVec3 = tangent && pathSpeedMmS ? vector((i) => tangent[i] * pathSpeedMmS) : [0, 0, 0];
  return { timeS: t, line: s?.line ?? null, mode: s?.mode ?? null, positionMm, velocityMmS, pathSpeedMmS };
}

export function sampleMiloMotion(plan: MiloMotionPlan, timeS: number): MiloMotionSample {
  const sample = sampleCncPath(plan, MILO_MACHINE.initialWorkMm, timeS);
  const machineMm = vector((i) => MILO_MACHINE.workOriginMachineMm[i] + sample.positionMm[i]);
  const stepCounts = vector((i) => Math.sign(machineMm[i]) * Math.round(Math.abs(machineMm[i]) * MILO_MACHINE.stepsPerMm[i]) || 0);
  return { ...sample, machineMm, stepCounts };
}
