import type { MainModule, MjModel } from "@mujoco/mujoco";
import type { ImportedGeomKind, ImportedGeometry, ImportedVector } from "@contracts/imported-physics";

export function vector(values: ArrayLike<number>, start: number): ImportedVector {
  return [values[start], values[start + 1], values[start + 2]];
}

export function importedGeometry(mj: MainModule, model: MjModel, warnings: string[]) {
  const g = mj.mjtGeom;
  const kinds = new Map<number, ImportedGeomKind>([
    [g.mjGEOM_PLANE.value, "plane"], [g.mjGEOM_SPHERE.value, "sphere"], [g.mjGEOM_CAPSULE.value, "capsule"],
    [g.mjGEOM_ELLIPSOID.value, "ellipsoid"], [g.mjGEOM_CYLINDER.value, "cylinder"],
    [g.mjGEOM_BOX.value, "box"], [g.mjGEOM_MESH.value, "mesh"],
  ]);
  const colors: Float32Array = model.geom_rgba, materials: Float32Array = model.mat_rgba;
  const ids: number[] = [], seen = new Set<string>(), visualBodies = new Set<number>();
  const meshMap = new Map<number, number>();
  const geoms: ImportedGeometry["geoms"] = [], meshes: ImportedGeometry["meshes"] = [];
  const info = Array.from({ length: model.ngeom }, (_, id) => {
    const material = model.geom_matid[id];
    const i = id * 4;
    const ownColor = material < 0 || colors[i] !== 0.5 || colors[i + 1] !== 0.5 || colors[i + 2] !== 0.5 || colors[i + 3] !== 1;
    const rgba = ownColor ? colors : materials;
    const offset = ownColor ? i : material * 4;
    const visual = model.geom_contype[id] === 0 && model.geom_conaffinity[id] === 0;
    const alpha = rgba[offset + 3];
    const kind = kinds.get(model.geom_type[id]);
    if (visual && kind && alpha > 0) visualBodies.add(model.geom_bodyid[id]);
    return { id, kind, visual, color: vector(rgba, offset), alpha };
  });

  let unsupported = 0;
  // 同一刚体、同一局部形状与姿态只保留一次。先保留显式视觉件，再考虑碰撞几何。
  for (const { id, kind, color, alpha, visual } of info.sort((a, b) => Number(b.visual) - Number(a.visual))) {
    if (alpha <= 0) continue;
    if (!kind) { unsupported++; continue; }
    if (!visual && model.geom_group[id] === 3 && visualBodies.has(model.geom_bodyid[id])) continue;
    const size = vector(model.geom_size, id * 3);
    const meshId: number = model.geom_dataid[id];
    const shapeKey = [
      model.geom_bodyid[id], kind, meshId, ...size, ...vector(model.geom_pos, id * 3),
      ...model.geom_quat.subarray(id * 4, id * 4 + 4),
    ].join(",");
    if (seen.has(shapeKey)) continue;
    seen.add(shapeKey);
    let meshIndex: number | undefined;
    if (kind === "mesh") {
      meshIndex = meshMap.get(meshId);
      if (meshIndex === undefined) {
        meshIndex = meshes.length;
        meshMap.set(meshId, meshIndex);
        const v = 3 * model.mesh_vertadr[meshId], f = 3 * model.mesh_faceadr[meshId];
        meshes.push({
          vertices: new Float32Array(model.mesh_vert.subarray(v, v + 3 * model.mesh_vertnum[meshId])),
          indices: new Uint32Array(model.mesh_face.subarray(f, f + 3 * model.mesh_facenum[meshId])),
        });
      }
    }
    ids.push(id);
    geoms.push({ kind, meshIndex, size, color, alpha });
  }
  if (unsupported || model.nflex || model.nskin) warnings.push(`视图省略 ${unsupported} 个未支持的几何、${model.nflex} 个柔性体和 ${model.nskin} 个蒙皮。物理模型保留它们。`);
  if (model.ntex) warnings.push("三维视图以模型材质颜色显示表面，未绘制纹理贴图。");
  if (!geoms.length) warnings.push("模型没有可绘制的可见几何，仍可查看关节和观测点数据。");
  const stat = model.stat;
  try {
    const geometry: ImportedGeometry = { meshes, geoms, centerM: vector(stat.center, 0), extentM: stat.extent };
    return { ids, geometry };
  } finally { stat.delete(); }
}
