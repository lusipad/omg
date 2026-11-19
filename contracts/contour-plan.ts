import {
  miloPointOnSegment, miloSegmentFractionAtTime, miloTimeAtFraction, planCncPath, sampleCncPath,
  type CncCommandSample, type CncMotionPath, type CncMotionProfile, type MiloVec3,
} from "./milo-motion";

export type ContourProfile = CncMotionProfile;
export const CONTOUR_PLAN_LIMITS = { programSeconds: 120, holdSeconds: 1, referencePeriodMs: 1, referenceRows: 130_000 } as const;
export interface ContourPlan {
  plan: CncMotionPath;
  initialWorkMm: MiloVec3;
  programEndS: number;
  endS: number;
  timesS: Float64Array;
  /** 三轴共用时刻，连续三个数为同一时刻的 X、Y、Z 工件坐标，单位 mm。 */
  referenceMm: Float64Array;
}

/** 编辑时检查语法及安装机床的工况，不分配毫秒级求解输入。 */
export function previewContourProgram(program: string, profile: ContourProfile): CncMotionPath {
  for (const [i, axis] of ["X", "Y", "Z"].entries()) {
    const min = profile.minMm[i] - profile.workOriginMachineMm[i];
    const max = profile.maxMm[i] - profile.workOriginMachineMm[i];
    if (![min, max].every(Number.isFinite) || min >= max) throw new Error(`${axis} 轴行程或工件原点无效。`);
    const start = profile.initialWorkMm[i];
    if (!Number.isFinite(start) || start < min || start > max) throw new Error(`${axis} 轴初始工件位置超出行程。`);
    const speed = profile.maxFeedMmMin[i], accel = profile.accelerationMmS2[i];
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(accel) || accel <= 0) {
      throw new Error(`${axis} 轴进给与加速度上限须为正有限数。`);
    }
  }
  return planCncPath(program, profile, CONTOUR_PLAN_LIMITS.programSeconds);
}

function referenceTimes(plan: CncMotionPath, endS: number) {
  const ticksPerSecond = 1000 / CONTOUR_PLAN_LIMITS.referencePeriodMs;
  const knots: number[] = [];
  for (const s of plan.segments) {
    const sweep = Math.abs(s.arc?.sweepRad ?? 0), maxAngle = Math.PI / 8;
    // 极小的圆可能落在两个毫秒点之间。限制弦的扫角，整圆仍有方向和中间点。
    if (sweep * s.peakSpeedMmS / s.lengthMm / ticksPerSecond > maxAngle) {
      const divisions = Math.ceil(sweep / maxAngle);
      for (let i = 1; i < divisions; i++) {
        const t = miloTimeAtFraction(s, i / divisions);
        if (t > (knots.at(-1) ?? 0) && t < s.endS) knots.push(t);
      }
    }
    knots.push(s.endS);
  }
  knots.push(endS);
  const capacity = Math.min(Math.floor(endS * ticksPerSecond) + 1 + knots.length, CONTOUR_PLAN_LIMITS.referenceRows);
  const times = new Float64Array(capacity);
  let count = 1, tick = 1; // 第一个时刻为 0。
  function append(t: number) {
    if (count === capacity) throw new Error(`当前程序的插补输入超过 ${CONTOUR_PLAN_LIMITS.referenceRows.toLocaleString("zh-CN")} 个时刻，请缩短程序。`);
    times[count++] = t;
  }
  for (const t of knots) {
    const eps = 16 * Number.EPSILON * Math.max(1, t);
    while (tick / ticksPerSecond < t - eps) append(tick++ / ticksPerSecond);
    // 近乎重合的规则网格点由精确程序边界代替，避免产生数值噪声时间步。
    if (Math.abs(tick / ticksPerSecond - t) <= eps) tick++;
    append(t);
  }
  return times.subarray(0, count);
}

export function planContourProgram(program: string, profile: ContourProfile): ContourPlan {
  const plan = previewContourProgram(program, profile);
  const programEndS = plan.durationS, endS = programEndS + CONTOUR_PLAN_LIMITS.holdSeconds;
  const initialWorkMm: MiloVec3 = [...profile.initialWorkMm];
  const timesS = referenceTimes(plan, endS), referenceMm = new Float64Array(timesS.length * 3);
  const final = plan.segments.at(-1)?.endMm ?? initialWorkMm;
  let segmentIndex = 0;
  for (let i = 0; i < timesS.length; i++) {
    const t = timesS[i];
    while (segmentIndex < plan.segments.length && t > plan.segments[segmentIndex].endS) segmentIndex++;
    const s = plan.segments[segmentIndex];
    const position = s ? miloPointOnSegment(s, miloSegmentFractionAtTime(s, t)) : final;
    referenceMm.set(position, i * 3);
  }
  return { plan, initialWorkMm, programEndS, endS, timesS, referenceMm };
}

export function sampleContourCommand(contour: ContourPlan, timeS: number): CncCommandSample {
  if (!Number.isFinite(timeS)) throw new Error("采样时间必须为有限秒数。");
  if (timeS <= contour.programEndS) return sampleCncPath(contour.plan, contour.initialWorkMm, timeS);
  const last = contour.plan.segments.at(-1)?.endMm ?? contour.initialWorkMm;
  return { timeS: Math.min(timeS, contour.endS), positionMm: [...last], velocityMmS: [0, 0, 0],
    pathSpeedMmS: 0, line: null, mode: null };
}
