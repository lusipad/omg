import type { ModelBundle } from "./import-catalog";

export const IMPORTED_PHYSICS_LIMITS = { maxDurationS: 20, maxSteps: 20_000 } as const;
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
  // 每个 geom 的世界位姿为米制 xyz 和 xyzw 四元数。
  geomPoses: Float32Array;
}
export interface ImportedModelInfo {
  timestepS: number;
  gravity: ImportedVector;
  joints: { name: string; kind: "hinge" | "slide" | "ball" | "free"; range: ImportedRange }[];
  actuators: { name: string; range: ImportedRange; initial: number; unit: string }[];
  positions: { name: string; unit: string }[];
  velocities: { name: string; unit: string }[];
  points: { id: string; name: string; kind: "site" | "body"; initialM: ImportedVector }[];
  geometry: ImportedGeometry;
  warnings: string[];
  initial: ImportedSample;
}
export interface ImportedRunSettings { durationS: number; controls: number[]; pointId: string }
export interface ImportedPhysics {
  info: ImportedModelInfo;
  run(settings: ImportedRunSettings): Promise<ImportedSample[]>;
  dispose(): void;
}
export type ImportedWorkerRequest = { type: "open"; bundle: ModelBundle } | { type: "run"; settings: ImportedRunSettings };
export type ImportedWorkerResponse = { type: "loaded"; info: ImportedModelInfo } | { type: "ran"; samples: ImportedSample[] } | { type: "error"; message: string };
