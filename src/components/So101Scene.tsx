import { useMemo } from "react";
import type { So101Geometry, So101Sample } from "@contracts/so101";
import type { ImportedGeometry } from "@contracts/imported-physics";
import PhysicsScene, { type SceneSample } from "./PhysicsScene";

function sceneSample(sample: So101Sample): SceneSample {
  const [x, y, z] = sample.tipMm;
  return { pointM: [x / 1000, y / 1000, z / 1000], geomPoses: sample.geomPoses };
}

export default function So101Scene({ geometry, sample, trail }: { geometry: So101Geometry; sample: So101Sample; trail: So101Sample[] }) {
  const model = useMemo<ImportedGeometry>(() => ({
    meshes: geometry.meshes,
    geoms: geometry.geoms.map((geom) => ({ ...geom, kind: "mesh", size: [0, 0, 0], alpha: 1 })),
    centerM: [0.14, 0, 0.15], extentM: 0.5,
  }), [geometry]);
  const displayed = useMemo(() => sceneSample(sample), [sample]);
  const path = useMemo(() => trail.map(sceneSample), [trail]);
  return <PhysicsScene geometry={model} sample={displayed} trail={path} title="SO-101 Follower 三维机械臂"
    pointName="末端" coordinateLabel="夹爪末端世界坐标" unit="mm" worktable />;
}
