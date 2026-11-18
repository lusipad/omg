import type { MiloVec3 } from "./milo-motion";

export interface MiloArc {
  centerMm: [number, number];
  radiusMm: number;
  startAngleRad: number;
  sweepRad: number;
  /** 输入小数舍入时，用不超过 1 µm 的最小圆心修正使两端落在同一个圆上。 */
  requestedCenterMm?: [number, number];
  centerAdjustmentMm?: number;
}

export const fullTurn = 2 * Math.PI;
const cardinal = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
const centerToleranceMm = 0.001;

function resolution(...values: number[]) {
  const tol = 32 * Number.EPSILON * Math.max(1, ...values.map(Math.abs));
  if (!Number.isFinite(tol) || tol > 0.0001) throw new Error("圆弧半径或圆心过大，数值精度不足。");
  return tol;
}

/** G17，由 +Z 观察。G90/G91 管理端点，I/J 始终从起点量起。 */
export function createMiloArc(start: MiloVec3, end: MiloVec3, clockwise: boolean,
  i: number | undefined, j: number | undefined, r: number | undefined): MiloArc {
  const sign = clockwise ? -1 : 1;
  const dx = end[0] - start[0], dy = end[1] - start[1], chord = Math.hypot(dx, dy);
  const centered = i !== undefined || j !== undefined;
  if (r !== undefined) {
    if (centered) throw new Error("同一圆弧不能同时指定 R 和 I/J。");
    if (r === 0) throw new Error("R 圆弧的半径绝对值必须大于零。");
    if (!chord) throw new Error("R 格式的圆弧端点重合，整圆请用 I/J 指定圆心。");
    const half = chord / 2, tol = resolution(r, chord, ...start, ...end);
    if (Math.abs(r) < half - tol) throw new Error("R 半径过小，圆弧端点间距超过直径。");
    const radius = Math.max(half, Math.abs(r));
    if (radius <= tol) throw new Error("R 圆弧半径低于坐标可表示的精度。");
    const height = Math.sqrt((radius - half) * (radius + half));
    const side = sign * Math.sign(r);
    const ox = dx / 2 - side * (dy / chord) * height, oy = dy / 2 + side * (dx / chord) * height;
    const minor = 2 * Math.asin(Math.min(1, half / radius));
    const magnitude = r > 0 ? minor : fullTurn - minor;
    if (minor <= 16 * Number.EPSILON || (r < 0 && magnitude === fullTurn)) throw new Error("R 圆弧端点过近，无法可靠区分扫角。");
    return { centerMm: [start[0] + ox, start[1] + oy], radiusMm: radius, startAngleRad: Math.atan2(-oy, -ox), sweepRad: sign * magnitude };
  }
  if (!centered) throw new Error("圆弧须给出本段的 I/J 圆心偏置或 R 半径。");
  let ox = i ?? 0, oy = j ?? 0, adjustment = 0;
  const requested: [number, number] = [start[0] + ox, start[1] + oy];
  const tol = resolution(...requested, ...start, ...end, ox, oy);
  let radius = Math.hypot(ox, oy);
  if (radius <= tol) throw new Error("圆弧半径为零或过小，圆心须与起点分离。");
  let sweep = sign * fullTurn;
  if (chord) {
    const endRadius = Math.hypot(dx - ox, dy - oy);
    if (Math.abs(radius - endRadius) > tol) {
      // 投影到弦的中垂线。极短弦的近整圆尤其不能仅凭半径差接受。
      const ux = dx / chord, uy = dy / chord;
      const shift = (dx / 2 - ox) * ux + (dy / 2 - oy) * uy;
      if (Math.abs(radius - endRadius) > centerToleranceMm || Math.abs(shift) > centerToleranceMm) {
        throw new Error("圆弧起终点到所给圆心的半径不一致，请核对 X/Y 与 I/J。");
      }
      ox += shift * ux; oy += shift * uy;
      adjustment = Math.abs(shift);
      radius = Math.hypot(ox, oy);
      if (radius <= tol) throw new Error("舍入修正后圆弧退化。");
    }
    const sx = -ox / radius, sy = -oy / radius;
    const ux = dx / radius, uy = dy / radius;
    const signedMinor = Math.atan2(sx * uy - sy * ux, 1 + sx * ux + sy * uy);
    sweep = sign * signedMinor < 0 ? signedMinor + sign * fullTurn : signedMinor;
    if (Math.abs(sweep) <= 16 * Number.EPSILON || Math.abs(sweep) >= fullTurn) throw new Error("圆弧端点过近，无法可靠区分扫角。");
  }
  const arc: MiloArc = { centerMm: [start[0] + ox, start[1] + oy], radiusMm: radius, startAngleRad: Math.atan2(-oy, -ox), sweepRad: sweep };
  if (adjustment) { arc.requestedCenterMm = requested; arc.centerAdjustmentMm = adjustment; }
  return arc;
}

/** 扫过的四向角囊括 XY 坐标极值，也囊括 XY 单位切向量各分量的极值。 */
export function arcCardinals(arc: MiloArc, startMm?: MiloVec3) {
  const points: { fraction: number; x: number; y: number }[] = [];
  cardinal.forEach(([x, y], k) => {
    let delta = (Math.sign(arc.sweepRad) * (k * Math.PI / 2 - arc.startAngleRad)) % fullTurn;
    if (delta < 0) delta += fullTurn;
    if (delta >= fullTurn - 16 * Number.EPSILON) delta = 0;
    if (delta <= Math.abs(arc.sweepRad) + 16 * Number.EPSILON) {
      const fraction = Math.min(1, delta / Math.abs(arc.sweepRad));
      const [px, py] = startMm ? arcXYFromStart(arc, startMm, fraction)
        : [arc.centerMm[0] + arc.radiusMm * x, arc.centerMm[1] + arc.radiusMm * y];
      points.push({ fraction, x: px, y: py });
    }
  });
  return points;
}

function arcXYFromStart(arc: MiloArc, start: MiloVec3, fraction: number): [number, number] {
  // 用三角函数的半角差式，不用巨大圆心坐标与半径相减求近直线弧的位移。
  const half = arc.sweepRad * fraction / 2, mid = arc.startAngleRad + half, chord = 2 * arc.radiusMm * Math.sin(half);
  return [start[0] - chord * Math.sin(mid), start[1] + chord * Math.cos(mid)];
}

export function pointOnMiloArc(arc: MiloArc, start: MiloVec3, end: MiloVec3, fraction: number): MiloVec3 {
  return [...arcXYFromStart(arc, start, fraction), start[2] + (end[2] - start[2]) * fraction];
}

export function arcTangent(arc: MiloArc, dz: number, length: number, fraction: number): MiloVec3 {
  const angle = arc.startAngleRad + fraction * arc.sweepRad;
  const xyRate = arc.radiusMm * arc.sweepRad / length, sin = Math.sin(angle), cos = Math.cos(angle);
  return [Math.abs(sin) < 16 * Number.EPSILON ? 0 : -xyRate * sin, Math.abs(cos) < 16 * Number.EPSILON ? 0 : xyRate * cos, dz / length];
}
