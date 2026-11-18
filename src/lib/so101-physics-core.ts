import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { SO101_JOINTS, parseSo101Motion, type So101Geometry, type So101Sample, type So101Waypoint } from "@contracts/so101";

export interface So101Physics {
  geometry: So101Geometry;
  initial: So101Sample;
  run(waypoints: So101Waypoint[]): So101Sample[];
}

// 调用方拥有编译后的 model。中间 VFS 仅在 XML 编译期间存活。
export async function compileSo101Model(mj: MainModule, readAsset: (path: string) => Promise<Uint8Array>): Promise<MjModel> {
  const [scene, arm] = await Promise.all([readAsset("scene.xml"), readAsset("so101_new_calib.xml")]);
  const xml = new TextDecoder().decode(arm);
  const files = [...new Set(Array.from(xml.matchAll(/<mesh\b[^>]*?\bfile="([\w-]+\.stl)"/g), (match) => `assets/${match[1]}`))];
  const meshBytes = await Promise.all(files.map(readAsset));
  const vfs = new mj.MjVFS();
  try {
    vfs.addBuffer("scene.xml", scene);
    vfs.addBuffer("so101_new_calib.xml", arm);
    files.forEach((file, i) => vfs.addBuffer(file, meshBytes[i]));
    return mj.MjModel.from_xml_path("scene.xml", vfs);
  } finally { vfs.delete(); }
}

function visualGeometry(mj: MainModule, model: MjModel) {
  const meshes: So101Geometry["meshes"] = [], geoms: So101Geometry["geoms"] = [], ids: number[] = [];
  const meshIndices = new Map<number, number>();
  const vertices: Float32Array = model.mesh_vert, faces: Int32Array = model.mesh_face;
  for (let id = 0; id < model.ngeom; id++) {
    if (model.geom_group[id] !== 2 || model.geom_type[id] !== mj.mjtGeom.mjGEOM_MESH.value) continue;
    const meshId: number = model.geom_dataid[id];
    let meshIndex = meshIndices.get(meshId);
    if (meshIndex === undefined) {
      const v = 3 * model.mesh_vertadr[meshId], f = 3 * model.mesh_faceadr[meshId];
      meshIndex = meshes.length;
      meshIndices.set(meshId, meshIndex);
      meshes.push({
        vertices: new Float32Array(vertices.subarray(v, v + 3 * model.mesh_vertnum[meshId])),
        indices: new Uint32Array(faces.subarray(f, f + 3 * model.mesh_facenum[meshId])),
      });
    }
    const material: number = model.geom_matid[id];
    const rgba: Float32Array = material >= 0 ? model.mat_rgba : model.geom_rgba;
    const c = 4 * (material >= 0 ? material : id);
    geoms.push({ meshIndex, color: [rgba[c], rgba[c + 1], rgba[c + 2]] });
    ids.push(id);
  }
  return { geometry: { meshes, geoms }, ids };
}

const radians = Math.PI / 180;
const zero = SO101_JOINTS.map(() => 0);
function targetAt(frames: So101Waypoint[], time: number): number[] {
  const next = frames.findIndex((frame) => frame.timeS > time);
  if (next < 0) return frames[frames.length - 1].anglesDeg;
  const start = next > 0 ? frames[next - 1] : { timeS: 0, anglesDeg: zero };
  const end = frames[next];
  const u = (time - start.timeS) / (end.timeS - start.timeS);
  const blend = u * u * (3 - 2 * u);
  return start.anglesDeg.map((angle, index) => angle + blend * (end.anglesDeg[index] - angle));
}

export function createSo101Physics(mj: MainModule, model: MjModel): So101Physics {
  const { geometry, ids: visualIds } = visualGeometry(mj, model);
  const axes = SO101_JOINTS.map(({ id }) => {
    const joint = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, id);
    const actuator = mj.mj_name2id(model, mj.mjtObj.mjOBJ_ACTUATOR.value, id);
    if (joint < 0 || actuator < 0) throw new Error(`SO-101 模型缺少关节或位置执行器 ${id}。`);
    return { qpos: Number(model.jnt_qposadr[joint]), qvel: Number(model.jnt_dofadr[joint]), actuator,
      min: Math.max(model.jnt_range[2 * joint], model.actuator_ctrlrange[2 * actuator]),
      max: Math.min(model.jnt_range[2 * joint + 1], model.actuator_ctrlrange[2 * actuator + 1]) };
  });
  const site = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "gripperframe");
  if (site < 0) throw new Error("SO-101 模型缺少 gripperframe 参考点。");
  const options = model.opt;
  const dt = options.timestep;
  options.delete();

  function sample(d: MjData, target: number[]): So101Sample {
    // mj_step 返回的派生位姿对应积分前的 qpos。同步到当前关节状态再交给三维视图。
    mj.mj_kinematics(model, d);
    const positions: Float64Array = d.geom_xpos, quaternions: Float64Array = d.geom_xquat, sites: Float64Array = d.site_xpos;
    const geomPoses: number[] = [];
    for (const id of visualIds) {
      const p = 3 * id, q = 4 * id;
      geomPoses.push(positions[p], positions[p + 1], positions[p + 2], quaternions[q + 1], quaternions[q + 2], quaternions[q + 3], quaternions[q]);
    }
    return {
      timeS: d.time, targetDeg: [...target], positionDeg: axes.map((axis) => d.qpos[axis.qpos] / radians),
      velocityDegS: axes.map((axis) => d.qvel[axis.qvel] / radians),
      tipMm: [1000 * sites[3 * site], 1000 * sites[3 * site + 1], 1000 * sites[3 * site + 2]], geomPoses,
    };
  }

  const start = new mj.MjData(model);
  let initial: So101Sample;
  try { initial = sample(start, zero); } finally { start.delete(); }
  function run(waypoints: So101Waypoint[]): So101Sample[] {
    const frames = parseSo101Motion(waypoints);
    for (const frame of frames) {
      axes.forEach((axis, i) => {
        const q = frame.anglesDeg[i] * radians;
        if (q < axis.min - 1e-12 || q > axis.max + 1e-12) throw new Error(`${SO101_JOINTS[i].label}超出当前模型的执行器范围。`);
      });
    }
    const data = new mj.MjData(model);
    try {
      const samples = [sample(data, zero)];
      const last = frames[frames.length - 1].timeS + 0.5;
      const steps = Math.ceil(last / dt - 1e-9), stride = Math.max(1, Math.round(0.02 / dt));
      const ctrl: Float64Array = data.ctrl;
      for (let step = 1; step <= steps; step++) {
        const target = targetAt(frames, (step - 1) * dt);
        axes.forEach((axis, i) => { ctrl[axis.actuator] = target[i] * radians; });
        mj.mj_step(model, data);
        if (step % stride === 0 || step === steps) {
          if (Math.abs(data.time - step * dt) > 1e-7) throw new Error("MuJoCo 在积分过程中复位，请检查当前动作。");
          samples.push(sample(data, targetAt(frames, step * dt)));
        }
      }
      return samples;
    } finally { data.delete(); }
  }
  return { geometry, initial, run };
}
