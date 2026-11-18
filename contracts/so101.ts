import { z } from "zod";
import { readTwinData } from "./twin-device";
import { validateSo101Bom, type So101BomRow } from "./so101-bom";

export const SO101_REVISION = "a758567c3978dfeefe282ede0500085a48fe8f78";
export const SO101_MODEL_ID = `so101-follower-new-calib@${SO101_REVISION}`;
export const SO101_UPSTREAM = `https://github.com/TheRobotStudio/SO-ARM100/tree/${SO101_REVISION}/Simulation/SO101`;
// Command limits are the intersection of joint and actuator ranges in the pinned MJCF,
// expressed in degrees and rounded inward to two decimal places.
export const SO101_JOINTS = [
  { id: "shoulder_pan", label: "肩部回转", minDeg: -109.99, maxDeg: 109.99 },
  { id: "shoulder_lift", label: "肩部俯仰", minDeg: -99.99, maxDeg: 100 },
  { id: "elbow_flex", label: "肘部屈伸", minDeg: -96.82, maxDeg: 96.82 },
  { id: "wrist_flex", label: "腕部俯仰", minDeg: -94.99, maxDeg: 94.99 },
  { id: "wrist_roll", label: "腕部旋转", minDeg: -157.21, maxDeg: 162.78 },
  { id: "gripper", label: "夹爪开合", minDeg: -9.99, maxDeg: 99.99 },
] as const;

const waypointSchema = z.strictObject({
  timeS: z.number().finite().positive().max(20),
  anglesDeg: z.array(z.number().finite()).length(SO101_JOINTS.length),
});
const motionSchema = z.array(waypointSchema).min(1).max(20);
export type So101Waypoint = z.infer<typeof waypointSchema>;
export const DEFAULT_SO101_MOTION: So101Waypoint[] = [
  { timeS: 1.2, anglesDeg: [25, -18, 25, -12, 15, 30] },
  { timeS: 2.6, anglesDeg: [-20, -30, 35, 10, -20, 55] },
  { timeS: 4.0, anglesDeg: [10, -12, 15, -5, 10, 12] },
];

export function parseSo101Motion(raw: unknown): So101Waypoint[] {
  const motion = readTwinData(motionSchema, raw, "关节动作");
  let previousTime = 0;
  for (const [index, waypoint] of motion.entries()) {
    if (waypoint.timeS <= previousTime) throw new Error(`第 ${index + 1} 个关键帧的到达时间须晚于上一帧。`);
    previousTime = waypoint.timeS;
    SO101_JOINTS.forEach((joint, axis) => {
      const angle = waypoint.anglesDeg[axis];
      if (angle < joint.minDeg || angle > joint.maxDeg) {
        throw new Error(`第 ${index + 1} 帧的${joint.label}需在 ${joint.minDeg}° 至 ${joint.maxDeg}° 之间。`);
      }
    });
  }
  return motion;
}

export interface So101Sample {
  timeS: number;
  targetDeg: number[];
  positionDeg: number[];
  velocityDegS: number[];
  tipMm: [number, number, number];
  geomPoses: number[];
}

export interface So101Geometry {
  meshes: { vertices: Float32Array; indices: Uint32Array }[];
  geoms: { meshIndex: number; color: [number, number, number] }[];
}

export interface So101Assembly {
  modelId: typeof SO101_MODEL_ID;
  bom: So101BomRow[];
  waypoints: So101Waypoint[];
}

const assemblySchema = z.strictObject({ modelId: z.literal(SO101_MODEL_ID), bom: z.unknown(), waypoints: z.unknown() });

export function parseSo101Assembly(raw: unknown): So101Assembly {
  const data = readTwinData(assemblySchema, raw, "SO-101 从臂装配");
  return { modelId: data.modelId, bom: validateSo101Bom(data.bom), waypoints: parseSo101Motion(data.waypoints) };
}
