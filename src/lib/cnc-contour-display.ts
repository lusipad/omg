import { MILO_STOCK, MILO_TOOL_DIAMETER_MM } from "@contracts/milo-stock";
import type { MiloVec3 } from "@contracts/milo-motion";
import type { CncContourResult, CncContourSample } from "./cnc-contour-runtime";

export const commandColor = "#7bd8ff", feedbackColor = "#ffbc68";
export type ContourFocus = "workpiece" | "cut";
export interface ContourBounds { min: MiloVec3; max: MiloVec3 }
export function fixedReading(value: number, digits = 3) {
  return (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toFixed(digits);
}

export function traceBounds(samples: readonly CncContourSample[], focus: ContourFocus): ContourBounds {
  const min: MiloVec3 = [Infinity, Infinity, Infinity], max: MiloVec3 = [-Infinity, -Infinity, -Infinity];
  for (const sample of samples) {
    for (const point of [sample.commandMm, sample.actualMm]) {
      if (focus === "cut" && point[2] > 0) continue;
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]); }
    }
  }
  if (focus === "workpiece" || !Number.isFinite(min[0])) {
    min[0] = Math.min(0, min[0]); min[1] = Math.min(0, min[1]); min[2] = Math.min(-MILO_STOCK.thicknessMm, min[2]);
    max[0] = Math.max(MILO_STOCK.widthMm, max[0]); max[1] = Math.max(MILO_STOCK.heightMm, max[1]); max[2] = Math.max(3, max[2]);
  }
  const margin = MILO_TOOL_DIAMETER_MM * .75;
  return { min: [min[0] - margin, min[1] - margin, min[2] - 1], max: [max[0] + margin, max[1] + margin, max[2] + 8] };
}

/** The slider selects an actual solver sample; never blend the two paths into one. */
export function contourTimeIndex(samples: readonly CncContourSample[], timeS: number) {
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].timeS < timeS) low = mid + 1;
    else high = mid;
  }
  return low > 0 && timeS - samples[low - 1].timeS < samples[low].timeS - timeS ? low - 1 : low;
}

export function contourStartIndex(result: CncContourResult) {
  const arcs = result.plan.plan.segments.filter(s => s.arc && Math.min(s.startMm[2], s.endMm[2]) < 0);
  const arc = arcs[Math.floor(arcs.length / 2)];
  return arc ? contourTimeIndex(result.samples, (arc.startS + arc.endS) / 2) : 0;
}
