/** Milo v1.5 / reference-fly-cdyv3（limits.g、speed.g、drives.g）。
 * https://github.com/MillenniumMachines/RRF-Configs/tree/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3
 */
export type MiloVec3 = [number, number, number];
export type MiloMoveMode = "G0" | "G1";
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
  startMm: MiloVec3; endMm: MiloVec3; direction: MiloVec3;
  startS: number; endS: number; lengthMm: number;
  feedMmMin: number | null; accelerationMmS2: number; peakSpeedMmS: number;
  rampS: number; cruiseS: number;
}
export interface MiloMotionSample {
  timeS: number; line: number | null; mode: MiloMoveMode | null;
  positionMm: MiloVec3; machineMm: MiloVec3; velocityMmS: MiloVec3; stepCounts: MiloVec3; pathSpeedMmS: number;
}
export interface MiloMotionPlan {
  segments: MiloSegment[]; samples: MiloMotionSample[]; durationS: number; totalLengthMm: number;
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

function segment(from: MiloVec3, to: MiloVec3, mode: MiloMoveMode, feedMmMin: number | null, startS: number, line: number, column: number): MiloSegment {
  const delta = vector((i) => to[i] - from[i]), lengthMm = Math.hypot(...delta);
  const direction = vector((i) => delta[i] / lengthMm);
  let speedLimit = mode === "G0" ? Infinity : feedMmMin! / 60;
  let accelerationMmS2 = Infinity;
  for (let i = 0; i < 3; i++) {
    const component = Math.abs(direction[i]);
    if (!component) continue;
    speedLimit = Math.min(speedLimit, MILO_MACHINE.maxFeedMmMin[i] / 60 / component);
    accelerationMmS2 = Math.min(accelerationMmS2, MILO_MACHINE.accelerationMmS2[i] / component);
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
  return { line, mode, startMm: from, endMm: to, direction, lengthMm, startS, endS,
    feedMmMin: mode === "G1" ? feedMmMin : null, accelerationMmS2, peakSpeedMmS, rampS, cruiseS };
}

export function planMiloProgram(program: string): MiloMotionPlan {
  if (typeof program !== "string") throw new MiloProgramError(1, 1, "请输入 G 代码程序。");
  if (program.length > MILO_MAX_PROGRAM_CHARS) {
    const allowed = program.slice(0, MILO_MAX_PROGRAM_CHARS).split(/\r\n|[\r\n]/);
    throw new MiloProgramError(allowed.length, allowed[allowed.length - 1].length + 1, "程序长度超过 65,536 个字符。");
  }
  const lines = program.split(/\r\n|[\r\n]/);
  if (lines.length > 2000) throw new MiloProgramError(2001, 1, "程序超过 2,000 行。");
  const plan: MiloMotionPlan = { segments: [], samples: [], durationS: 0, totalLengthMm: 0 };
  let mode: MiloMoveMode | null = null, absolute = true, feedMmMin: number | null = null;
  let position: MiloVec3 = [...MILO_MACHINE.initialWorkMm], hasCode = false;
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
        if (!/^\d+$/.test(raw)) throw new MiloProgramError(line, column, `不支持 G${raw}。`);
        if (value === 2 || value === 3) throw new MiloProgramError(line, column, `不支持 G${raw} 圆弧插补。`);
        let group: string;
        switch (value) {
          case 0: case 1: group = "运动"; mode = value === 0 ? "G0" : "G1"; break;
          case 90: case 91: group = "坐标"; absolute = value === 90; break;
          case 21: group = "长度单位"; break;
          case 94: group = "进给单位"; break;
          default: throw new MiloProgramError(line, column, `不支持指令 G${raw}。`);
        }
        if (groups.has(group)) throw new MiloProgramError(line, column, `同一行重复指定${group}模式。`);
        groups.add(group);
      } else {
        if (!["X", "Y", "Z", "F"].includes(letter)) throw new MiloProgramError(line, column, `不支持地址字 ${letter}${raw}。`);
        if (fields.has(letter)) throw new MiloProgramError(line, column, `同一行重复指定 ${letter}。`);
        fields.set(letter, word);
      }
    }
    const feed = fields.get("F");
    if (feed) {
      if (feed.value <= 0) throw new MiloProgramError(line, feed.column, "进给 F 必须大于零，单位为 mm/min。");
      feedMmMin = feed.value;
    }
    const firstAxis = words.find((w) => w.letter === "X" || w.letter === "Y" || w.letter === "Z");
    if (!firstAxis) continue;
    if (!mode) throw new MiloProgramError(line, firstAxis.column, "轴移动之前须选择 G0 或 G1。");
    if (mode === "G1" && feedMmMin === null) throw new MiloProgramError(line, firstAxis.column, "首次 G1 移动需要正进给 F。");
    const to = vector((i) => {
      const word = fields.get(axes[i]);
      if (!word) return position[i];
      const value = absolute ? word.value : position[i] + word.value;
      const min = MILO_MACHINE.minMm[i] - MILO_MACHINE.workOriginMachineMm[i];
      const max = MILO_MACHINE.maxMm[i] - MILO_MACHINE.workOriginMachineMm[i];
      const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(min), Math.abs(max), 1);
      if (!Number.isFinite(value) || value < min - tolerance || value > max + tolerance) throw new MiloProgramError(line, word.column,
        `${axes[i]} 超出行程。该轴允许的工件坐标为 ${min} 至 ${max} mm，机床坐标为 ${MILO_MACHINE.minMm[i]} 至 ${MILO_MACHINE.maxMm[i]} mm。`);
      if (!absolute && word.value !== 0 && value === position[i]) throw new MiloProgramError(line, word.column, `${axes[i]} 增量低于当前坐标可表示的精度。`);
      return Math.min(max, Math.max(min, value));
    });
    if (to.every((v, i) => v === position[i])) continue;
    if (plan.segments.length >= 1000) throw new MiloProgramError(line, firstAxis.column, "程序超过 1,000 个位移段。");
    const next = segment(position, to, mode, feedMmMin, plan.durationS, line, firstAxis.column);
    plan.segments.push(next);
    plan.durationS = next.endS;
    plan.totalLengthMm += next.lengthMm;
    position = to;
  }
  if (!hasCode) throw new MiloProgramError(1, 1, "程序中没有可识别的指令或地址字。");
  const times = new Set<number>([0]);
  for (const s of plan.segments) {
    times.add(s.startS + s.rampS / 2);
    times.add(s.startS + s.rampS);
    if (s.cruiseS > 0) times.add(s.endS - s.rampS);
    times.add(s.endS - s.rampS / 2);
    times.add(s.endS);
  }
  plan.samples = [...times].sort((a, b) => a - b).map((t) => sampleMiloMotion(plan, t));
  return plan;
}

/** 每段精确起停。折点归入刚结束的程序块，超出回放区间的时刻固定在首末状态。 */
export function sampleMiloMotion(plan: MiloMotionPlan, timeS: number): MiloMotionSample {
  if (!Number.isFinite(timeS)) throw new Error("采样时间必须为有限秒数。");
  const t = Math.max(0, Math.min(plan.durationS, timeS));
  let lo = 0, hi = plan.segments.length - 1;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (t <= plan.segments[mid].endS) hi = mid; else lo = mid + 1;
  }
  const s = plan.segments[lo];
  let positionMm: MiloVec3 = [...MILO_MACHINE.initialWorkMm], pathSpeedMmS = 0;
  if (s) {
    const elapsed = t - s.startS, remaining = s.endS - t;
    if (elapsed <= 0) positionMm = [...s.startMm];
    else if (remaining <= 0) positionMm = [...s.endMm];
    else {
      let travelled: number;
      if (elapsed < s.rampS) {
        pathSpeedMmS = s.accelerationMmS2 * elapsed;
        travelled = pathSpeedMmS * elapsed / 2;
      } else if (remaining < s.rampS) {
        pathSpeedMmS = s.accelerationMmS2 * remaining;
        travelled = s.lengthMm - pathSpeedMmS * remaining / 2;
      } else {
        pathSpeedMmS = s.peakSpeedMmS;
        travelled = pathSpeedMmS * (elapsed - s.rampS / 2);
      }
      positionMm = vector((i) => s.startMm[i] + (s.endMm[i] - s.startMm[i]) * (travelled / s.lengthMm));
    }
  }
  const velocityMmS: MiloVec3 = s && pathSpeedMmS ? vector((i) => s.direction[i] * pathSpeedMmS) : [0, 0, 0];
  const machineMm = vector((i) => MILO_MACHINE.workOriginMachineMm[i] + positionMm[i]);
  const stepCounts = vector((i) => Math.sign(machineMm[i]) * Math.round(Math.abs(machineMm[i]) * MILO_MACHINE.stepsPerMm[i]) || 0);
  return { timeS: t, line: s?.line ?? null, mode: s?.mode ?? null, positionMm, machineMm, velocityMmS, stepCounts, pathSpeedMmS };
}
