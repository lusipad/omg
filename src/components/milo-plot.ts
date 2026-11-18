import { arcCardinals } from "@contracts/milo-arc";
import {
  MILO_MACHINE, miloPointOnSegment, sampleMiloMotion,
  type MiloMotionPlan, type MiloMotionSample, type MiloSegment, type MiloVec3,
} from "@contracts/milo-motion";

export const miloAxes = ["X", "Y", "Z"] as const;
export const miloAxisColors = ["#62dbab", "#80bfff", "#f0b66e"] as const;
export const miloNumber = (value: number) => String(Number(value.toPrecision(6)));

export function tickStep(span: number) {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  if (!magnitude) return span;
  const fraction = span / magnitude;
  return magnitude * (fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10);
}

type PathSpan = { segment: MiloSegment; first: number; fractions: number[] };
export interface MiloSpatialPath { vertices: MiloVec3[]; spans: Map<number, PathSpan>; min: MiloVec3; max: MiloVec3 }

export function makeMiloSpatialPath(plan: MiloMotionPlan): MiloSpatialPath {
  const start = plan.segments[0]?.startMm ?? MILO_MACHINE.initialWorkMm;
  const vertices: MiloVec3[] = [start], spans = new Map<number, PathSpan>();
  const min: MiloVec3 = [...start], max: MiloVec3 = [...start];
  const sweep = plan.segments.reduce((sum, segment) => sum + Math.abs(segment.arc?.sweepRad ?? 0), 0);
  const density = Math.min(64 / Math.PI, 32_000 / Math.max(sweep, 1));
  for (const segment of plan.segments) {
    let fractions = [0, 1];
    const arc = segment.arc;
    if (arc) {
      const steps = Math.max(4, Math.ceil(Math.abs(arc.sweepRad) * density));
      fractions = Array.from({ length: steps + 1 }, (_, i) => i / steps);
      // 加入扫过的四向极值，任意起始角和整圆都保留完整 XY 范围。
      for (const point of arcCardinals(arc)) fractions.push(point.fraction);
      fractions = [...new Set(fractions)].sort((a,b) => a-b);
    }
    spans.set(segment.line, { segment, first: vertices.length - 1, fractions });
    for (let j = 1; j < fractions.length; j++) {
      const point = miloPointOnSegment(segment, fractions[j]);
      vertices.push(point);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], point[a]); max[a] = Math.max(max[a], point[a]); }
    }
  }
  return { vertices, spans, min, max };
}

export function miloTraceSamples(plan: MiloMotionPlan): MiloMotionSample[] {
  if (!plan.segments.some((s) => s.arc)) return plan.samples;
  const samples = new Map(plan.samples.map((s) => [s.timeS, s]));
  for (const segment of plan.segments) {
    if (!segment.arc) continue;
    const span = segment.endS - segment.startS;
    const budget = Math.max(6, Math.ceil(1800 * (span / plan.durationS)));
    const count = Math.min(budget, Math.max(8, Math.ceil(Math.abs(segment.arc.sweepRad) * 24)));
    for (let j = 1; j < count; j++) {
      const time = segment.startS + span * (j / count);
      if (!samples.has(time)) samples.set(time, sampleMiloMotion(plan, time));
    }
  }
  return [...samples.values()].sort((a, b) => a.timeS - b.timeS);
}

export function miloLayerEnds(plan: MiloMotionPlan) {
  const layers: { z: number; time: number }[] = [];
  for (const s of plan.segments) {
    const z = s.endMm[2];
    if (s.mode === "G0" || s.startMm[2] !== z || z >= 0) continue;
    const previous = layers.at(-1);
    if (previous?.z === z) previous.time = s.endS;
    else if (!previous || z < previous.z) layers.push({ z, time: s.endS });
    else return []; // 非逐级加深的程序仍可用连续时间轴检查。
  }
  return layers;
}
