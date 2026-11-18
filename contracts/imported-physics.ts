import type { ModelBundle } from "./import-catalog";

export const IMPORTED_PHYSICS_LIMITS = { maxDurationS: 20, maxSteps: 20_000, maxStages: 256, maxStageLabel: 160 } as const;
export type ImportedVector = [number, number, number];
export type ImportedRange = [number, number] | null;
export type ImportedGeomKind = "mesh" | "plane" | "box" | "sphere" | "capsule" | "cylinder" | "ellipsoid";

export interface ImportedGeometry {
  meshes: { vertices: Float32Array; indices: Uint32Array }[];
  geoms: { kind: ImportedGeomKind; meshIndex?: number; size: ImportedVector; color: ImportedVector; alpha: number }[];
  centerM: ImportedVector;
  extentM: number;
}
export interface ImportedSample {
  timeS: number;
  qpos: number[];
  qvel: number[];
  pointM: ImportedVector;
  referenceM?: ImportedVector;
  // 每个 geom 的世界位姿为米制 xyz 和 xyzw 四元数。
  geomPoses: Float32Array;
}
export interface ImportedInitialPose {
  initial: ImportedSample;
  controls: number[];
  pointsM: ImportedVector[];
}
export interface ImportedModelInfo {
  timestepS: number;
  gravity: ImportedVector;
  joints: { name: string; kind: "hinge" | "slide" | "ball" | "free"; range: ImportedRange }[];
  actuators: { name: string; range: ImportedRange; initial: number; unit: string }[];
  positions: { name: string; unit: string }[];
  velocities: { name: string; unit: string }[];
  points: { id: string; name: string; kind: "site" | "body"; initialM: ImportedVector }[];
  keyframes: string[];
  geometry: ImportedGeometry;
  warnings: string[];
  initial: ImportedSample;
}
export interface ImportedControlStage { timeS: number; controls: number[]; label?: string }
export interface ImportedRunSettings { durationS: number; controls: number[]; pointId: string; referencePointId?: string; keyframe?: string; sequence?: ImportedControlStage[] }

export function controlSequenceIssue(settings: Pick<ImportedRunSettings, "sequence" | "durationS" | "controls">, actuators?: ImportedModelInfo["actuators"]): string {
  const { sequence, controls, durationS } = settings;
  if (sequence === undefined) return "";
  if (!Array.isArray(sequence)) return "动作序列须为阶段列表。";
  if (sequence.length > IMPORTED_PHYSICS_LIMITS.maxStages) return `动作序列最多支持 ${IMPORTED_PHYSICS_LIMITS.maxStages} 个阶段。`;
  let previousTime = 0;
  for (const [index, stage] of sequence.entries()) {
    const at = `第 ${index + 1} 阶段`;
    if (!stage || !Number.isFinite(stage.timeS) || stage.timeS <= previousTime || stage.timeS > durationS) {
      return `${at}的到达时间必须晚于 ${previousTime} s，并且不超过运行时长 ${durationS} s。`;
    }
    if (stage.label !== undefined && (typeof stage.label !== "string" || !stage.label.trim() || stage.label.length > IMPORTED_PHYSICS_LIMITS.maxStageLabel)) {
      return `${at}的名称须为 1 到 ${IMPORTED_PHYSICS_LIMITS.maxStageLabel} 个字符。`;
    }
    if (!Array.isArray(stage.controls) || stage.controls.length !== controls.length) return `${at}的控制值数量与初始控制不符。`;
    for (const [i, value] of stage.controls.entries()) {
      const actuator = actuators?.[i], range = actuator?.range;
      if (!Number.isFinite(value)) return `${at}的控制值必须是有限数值。`;
      if (range && (value < range[0] || value > range[1])) return `${at}执行器“${actuator.name}”的控制范围为 ${range[0]} 至 ${range[1]} ${actuator.unit}。`;
    }
    previousTime = stage.timeS;
  }
  return "";
}
export interface ImportedPhysics {
  info: ImportedModelInfo;
  previewKeyframe(name: string): Promise<ImportedInitialPose>;
  run(settings: ImportedRunSettings): Promise<ImportedSample[]>;
  dispose(): void;
}
export type ImportedWorkerRequest = { type: "open"; bundle: ModelBundle } | { type: "pose"; name: string } | { type: "run"; settings: ImportedRunSettings };
export type ImportedWorkerResponse = { type: "loaded"; info: ImportedModelInfo } | { type: "pose"; state: ImportedInitialPose } | { type: "ran"; samples: ImportedSample[] } | { type: "error"; message: string };
