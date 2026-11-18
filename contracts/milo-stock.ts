import { miloPointOnSegment, miloSegmentFractionAtTime, type MiloMotionPlan, type MiloSegment, type MiloVec3 } from "./milo-motion";
import { arcCardinals, fullTurn } from "./milo-arc";

export const MILO_TOOL_DIAMETER_MM = 6;
const cellSizeMm = 0.5, widthMm = 75, heightMm = 60, thicknessMm = 10;
const columns = widthMm / cellSizeMm, rows = heightMm / cellSizeMm;
export const MILO_STOCK = { widthMm, heightMm, thicknessMm, cellSizeMm, columns, rows } as const;
const radius = MILO_TOOL_DIAMETER_MM / 2;
const edgeToleranceMm = 1e-10;

export interface MiloStockState {
  timeS: number;
  /** 行主序，格心工件坐标为 ((列+0.5)Δ, (行+0.5)Δ)。此顶面 Z 缓冲在下一次 seek 时复用。 */
  heights: Float32Array;
  columns: number; rows: number; cellSizeMm: number;
  removedVolumeMm3: number; maxDepthMm: number; revision: number;
}

interface Sweep {
  minX: number; maxX: number; minY: number; maxY: number;
  /** 刀盘接触此格心期间，使刀尖 Z 最低的段内比例。 */
  contact: (x: number, y: number) => number | undefined;
}

function lineSweep(s: MiloSegment, end: MiloVec3, until: number): Sweep {
  const [x0, y0, z0] = s.startMm, [x1, y1, z1] = s.endMm;
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  const nx = length ? dx / length : 0, ny = length ? dy / length : 0;
  const descending = z1 < z0;
  return {
    minX: Math.min(x0, end[0]), maxX: Math.max(x0, end[0]), minY: Math.min(y0, end[1]), maxY: Math.max(y0, end[1]),
    contact(x, y) {
      const px = x - x0, py = y - y0;
      if (!length) return Math.hypot(px, py) <= radius + edgeToleranceMm ? (descending ? until : 0) : undefined;
      const perpendicular = Math.abs(px * ny - py * nx);
      if (perpendicular > radius + edgeToleranceMm) return;
      const along = px * nx + py * ny;
      const half = Math.sqrt(Math.max(0, (radius - perpendicular) * (radius + perpendicular)));
      const first = Math.max(0, along - half), last = Math.min(length * until, along + half);
      if (first <= last + edgeToleranceMm) return Math.max(0, Math.min(until, (descending ? last : first) / length));
    },
  };
}

function arcSweep(s: MiloSegment, end: MiloVec3, until: number): Sweep {
  const arc = s.arc!;
  const { radiusMm: r, startAngleRad: start, sweepRad } = arc;
  const sign = Math.sign(sweepRad), angle = Math.abs(sweepRad), span = angle * until;
  const descending = s.endMm[2] < s.startMm[2];
  const tolerance = edgeToleranceMm / r + 16 * Number.EPSILON * angle;
  const ux = Math.cos(start), uy = Math.sin(start), limit = radius + edgeToleranceMm;
  const outer = (2 * r + limit) * limit, inner = r > limit ? (limit - 2 * r) * limit : -Infinity;
  const deepest = descending ? end : s.startMm;
  let minX = Math.min(s.startMm[0], end[0]), maxX = Math.max(s.startMm[0], end[0]);
  let minY = Math.min(s.startMm[1], end[1]), maxY = Math.max(s.startMm[1], end[1]);
  for (const p of arcCardinals(arc)) {
    if (p.fraction > until) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return {
    minX, maxX, minY, maxY,
    contact(x, y) {
      const ex = x - deepest[0], ey = y - deepest[1];
      if (ex * ex + ey * ey <= limit * limit) return descending ? until : 0;
      const dx = x - s.startMm[0], dy = y - s.startMm[1], along = dx * ux + dy * uy;
      // |P-C|²-r² 在起点局部坐标展开。大半径短弧也能分辨刀盘切线两侧的格心。
      const difference = 2 * r * along + dx * dx + dy * dy;
      if (difference < inner || difference > outer) return;
      const across = dy * ux - dx * uy, radial = Math.hypot(r + along, across);
      if (!radial || radial + r <= radius) return descending ? until : 0;
      const separation = Math.abs(difference / (radial + r));
      const sine = Math.sqrt(Math.max(0, (radius - separation) * (radius + separation) / r / radial)) / 2;
      const half = 2 * Math.asin(Math.min(1, sine));
      const center = sign * Math.atan2(across, r + along);
      const lower = center - half, upper = center + half;
      // 角窗可能跨过零度。下降选最后一次接触，上升选首次接触。
      const period = descending ? Math.floor((span - lower + tolerance) / fullTurn) : Math.ceil((-upper - tolerance) / fullTurn);
      const first = Math.max(0, lower + period * fullTurn), last = Math.min(span, upper + period * fullTurn);
      if (first <= last + tolerance) return Math.max(0, Math.min(until, (descending ? last : first) / angle));
    },
  };
}

function cut(heights: Float32Array, s: MiloSegment, until: number) {
  if (s.mode === "G0" || until <= 0) return;
  const end = miloPointOnSegment(s, until), z0 = s.startMm[2], dz = s.endMm[2] - z0;
  const lowest = Math.fround(Math.max(-thicknessMm, Math.min(z0, end[2])));
  if (lowest >= 0) return;
  const sweep = s.arc ? arcSweep(s, end, until) : lineSweep(s, end, until);
  const firstCell = (coordinate: number) => Math.max(0, Math.ceil((coordinate - radius - edgeToleranceMm) / cellSizeMm - 0.5));
  const lastCell = (coordinate: number, count: number) => Math.min(count - 1, Math.floor((coordinate + radius + edgeToleranceMm) / cellSizeMm - 0.5));
  const left = firstCell(sweep.minX), right = lastCell(sweep.maxX, columns);
  const bottom = firstCell(sweep.minY), top = lastCell(sweep.maxY, rows);
  for (let row = bottom; row <= top; row++) {
    const y = (row + 0.5) * cellSizeMm;
    for (let col = left; col <= right; col++) {
      const i = row * columns + col;
      if (heights[i] <= lowest) continue;
      const u = sweep.contact((col + 0.5) * cellSizeMm, y);
      if (u === undefined) continue;
      const z = Math.max(-thicknessMm, z0 + dz * u);
      if (z < heights[i]) heights[i] = z;
    }
  }
}

/** 已完成段存入底图；当前段从底图绘制，任意正反向 seek 使用同一几何定义。 */
export function createMiloStockPlayback(plan: MiloMotionPlan) {
  const committed = new Float32Array(rows * columns), heights = new Float32Array(committed.length);
  const stride = Math.max(1, Math.ceil(plan.segments.length / 16)), checkpoints = new Map<number, Float32Array>();
  let prefix = 0, revision = 0, lastFrame: MiloStockState | undefined;

  function seek(timeS: number): MiloStockState {
    if (!Number.isFinite(timeS)) throw new Error("去料回放时间必须为有限秒数。");
    const t = Math.max(0, Math.min(plan.durationS, timeS));
    if (lastFrame?.timeS === t) return lastFrame;
    let lo = 0, hi = plan.segments.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (plan.segments[mid].endS <= t) lo = mid + 1;
      else hi = mid;
    }
    const completed = lo, boundary = Math.floor(completed / stride) * stride;
    if (prefix > completed || (boundary > prefix && checkpoints.has(boundary))) {
      const saved = checkpoints.get(boundary);
      if (saved) committed.set(saved); else committed.fill(0);
      prefix = saved ? boundary : 0;
    }
    while (prefix < completed) {
      cut(committed, plan.segments[prefix++], 1);
      if (prefix % stride === 0 && !checkpoints.has(prefix)) checkpoints.set(prefix, committed.slice());
    }
    heights.set(committed);
    const active = plan.segments[completed];
    if (active) cut(heights, active, miloSegmentFractionAtTime(active, t));
    let removedHeight = 0, maxDepthMm = 0;
    for (const z of heights) { removedHeight -= z; maxDepthMm = Math.max(maxDepthMm, -z); }
    lastFrame = { timeS: t, heights, columns, rows, cellSizeMm, removedVolumeMm3: removedHeight * cellSizeMm ** 2, maxDepthMm, revision: ++revision };
    return lastFrame;
  }
  return { seek };
}
