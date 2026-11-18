import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { IMPORTED_PHYSICS_LIMITS, type ImportedModelInfo, type ImportedRange, type ImportedRunSettings, type ImportedSample } from "@contracts/imported-physics";
import { importedGeometry, vector } from "./imported-physics-geometry";

function compiledName(mj: MainModule, model: MjModel, type: number, address: number, id: number, fallback: string) {
  return address >= 0 && model.names[address] ? mj.mj_id2name(model, type, id) : `${fallback} ${id}`;
}

function range(limited: ArrayLike<number>, values: ArrayLike<number>, id: number): ImportedRange {
  return limited[id] ? [values[2 * id], values[2 * id + 1]] : null;
}

function jointInfo(mj: MainModule, m: MjModel) {
  const joints: ImportedModelInfo["joints"] = [], positions: ImportedModelInfo["positions"] = [], velocities: ImportedModelInfo["velocities"] = [];
  const kinds = ["free", "ball", "slide", "hinge"] as const;
  for (let i = 0; i < m.njnt; i++) {
    const kind = kinds[m.jnt_type[i] as number];
    const name = compiledName(mj, m, mj.mjtObj.mjOBJ_JOINT.value, m.name_jntadr[i], i, "关节");
    joints.push({ name, kind, range: range(m.jnt_limited, m.jnt_range, i) });
    const pos = m.jnt_qposadr[i], vel = m.jnt_dofadr[i];
    if (kind === "hinge" || kind === "slide") {
      positions[pos] = { name, unit: kind === "hinge" ? "rad" : "m" };
      velocities[vel] = { name, unit: kind === "hinge" ? "rad/s" : "m/s" };
    } else {
      const translation = kind === "free" ? 3 : 0;
      if (translation) ["X", "Y", "Z"].forEach((axis, j) => {
        positions[pos + j] = { name: `${name} · ${axis}`, unit: "m" };
        velocities[vel + j] = { name: `${name} · ${axis}`, unit: "m/s" };
      });
      ["w", "x", "y", "z"].forEach((axis, j) => { positions[pos + translation + j] = { name: `${name} · q${axis}`, unit: "1" }; });
      ["X", "Y", "Z"].forEach((axis, j) => { velocities[vel + translation + j] = { name: `${name} · ω${axis}`, unit: "rad/s" }; });
    }
  }
  return { joints, positions, velocities };
}

function controlUnit(mj: MainModule, m: MjModel, i: number): string {
  const joint = m.actuator_trnid[2 * i];
  if (m.actuator_trntype[i] !== mj.mjtTrn.mjTRN_JOINT.value || joint < 0 || m.actuator_gear[6 * i] !== 1 ||
    m.actuator_gaintype[i] !== mj.mjtGain.mjGAIN_FIXED.value || m.actuator_biastype[i] !== mj.mjtBias.mjBIAS_AFFINE.value ||
    m.actuator_dyntype[i] !== mj.mjtDyn.mjDYN_NONE.value) return "原生 ctrl";
  const kind = m.jnt_type[joint];
  if (kind !== mj.mjtJoint.mjJNT_HINGE.value && kind !== mj.mjtJoint.mjJNT_SLIDE.value) return "原生 ctrl";
  const length = kind === mj.mjtJoint.mjJNT_HINGE.value ? "rad" : "m";
  const k = m.actuator_gainprm[10 * i], bias = m.actuator_biasprm;
  if (k <= 0 || bias[10 * i] !== 0) return "原生 ctrl";
  if (bias[10 * i + 1] === -k && bias[10 * i + 2] <= 0) return length;
  if (bias[10 * i + 1] === 0 && bias[10 * i + 2] === -k) return length + "/s";
  return "原生 ctrl";
}

function observe(d: MjData, point: { kind: "body" | "site"; index: number }) {
  return vector(point.kind === "body" ? d.xpos : d.site_xpos, 3 * point.index);
}

// 调用方拥有 model；每次运行单独分配并释放 mjData，起点来自模型的 qpos0。
export function createImportedPhysics(mj: MainModule, model: MjModel) {
  const warnings: string[] = [];
  const { geometry, ids } = importedGeometry(mj, model, warnings);
  const { joints, positions, velocities } = jointInfo(mj, model);
  const options = model.opt;
  const dt = options.timestep, gravity = vector(options.gravity, 0);
  options.delete();
  if (!Number.isFinite(dt) || dt <= 0 || dt > IMPORTED_PHYSICS_LIMITS.maxDurationS) throw new Error("模型积分步长超出本地仿真的时间范围。");
  const targets: { id: string; name: string; kind: "body" | "site"; index: number }[] = [];
  for (let i = 0; i < model.nsite; i++) targets.push({ id: `site:${i}`, kind: "site", index: i,
    name: compiledName(mj, model, mj.mjtObj.mjOBJ_SITE.value, model.name_siteadr[i], i, "标记点") });
  for (let k = 1; k <= model.nbody; k++) {
    const i = k % model.nbody;
    targets.push({ id: `body:${i}`, kind: "body", index: i,
      name: compiledName(mj, model, mj.mjtObj.mjOBJ_BODY.value, model.name_bodyadr[i], i, "刚体") });
  }

  function readSample(d: MjData, point: typeof targets[number]): ImportedSample {
    // mj_step 积分后刷新派生运动学，观测点、几何与反馈处于同一仿真时刻。
    mj.mj_kinematics(model, d);
    const p: Float64Array = d.geom_xpos, q: Float64Array = d.geom_xquat, poses = new Float32Array(7 * ids.length);
    ids.forEach((id, i) => {
      const a = 3 * id, b = 4 * id, off = 7 * i;
      poses.set([p[a], p[a + 1], p[a + 2], q[b + 1], q[b + 2], q[b + 3], q[b]], off);
    });
    const qpos = Array.from(d.qpos as Float64Array), qvel = Array.from(d.qvel as Float64Array), pointM = observe(d, point);
    if (!qpos.every(Number.isFinite) || !qvel.every(Number.isFinite) || !pointM.every(Number.isFinite) || !poses.every(Number.isFinite)) throw new Error("积分产生了超出数值范围的反馈。");
    return { timeS: d.time, qpos, qvel, pointM, geomPoses: poses };
  }

  let info: ImportedModelInfo;
  const start = new mj.MjData(model);
  try {
    const initial = readSample(start, targets[0]);
    const actuators = Array.from({ length: model.nu }, (_, i) => {
      const limits = range(model.actuator_ctrllimited, model.actuator_ctrlrange, i), initialCtrl: number = start.ctrl[i];
      return {
        name: compiledName(mj, model, mj.mjtObj.mjOBJ_ACTUATOR.value, model.name_actuatoradr[i], i, "执行器"),
        range: limits, initial: limits ? Math.max(limits[0], Math.min(limits[1], initialCtrl)) : initialCtrl, unit: controlUnit(mj, model, i),
      };
    });
    info = { timestepS: dt, gravity, joints, actuators, positions, velocities, geometry, warnings, initial,
      points: targets.map(({ id, name, kind, index }) => ({ id, name, kind, initialM: observe(start, { kind, index }) })) };
  } finally { start.delete(); }

  function run({ durationS, controls, pointId }: ImportedRunSettings): ImportedSample[] {
    const point = targets.find((p) => p.id === pointId);
    if (!point) throw new Error("模型中找不到指定的观测点。");
    if (!Number.isFinite(durationS) || durationS <= 0 || durationS > IMPORTED_PHYSICS_LIMITS.maxDurationS) throw new Error("仿真时长须大于零且最多 20 秒。");
    const steps = Math.max(1, Math.ceil(durationS / dt - 1e-10));
    if (steps > IMPORTED_PHYSICS_LIMITS.maxSteps) throw new Error("本次运行超过 20000 个物理步，请缩短时长。");
    if (!Array.isArray(controls) || controls.length !== info.actuators.length) throw new Error("控制值数量与模型执行器不一致。");
    info.actuators.forEach((actuator, i) => {
      const value = controls[i], bounds = actuator.range;
      if (!Number.isFinite(value) || (bounds && (value < bounds[0] || value > bounds[1]))) throw new Error(`执行器「${actuator.name}」的控制值无效或超出范围。`);
    });
    const width = 7 * ids.length + model.nq + model.nv + 4;
    const intervals = Math.min(500, Math.max(1, Math.floor(1_000_000 / width) - 1));
    const stride = Math.max(1, Math.round(0.02 / dt), Math.ceil(steps / intervals));
    const data = new mj.MjData(model);
    try {
      (data.ctrl as Float64Array).set(controls);
      const samples = [readSample(data, point)];
      for (let step = 1; step <= steps; step++) {
        mj.mj_step(model, data);
        if (step % stride === 0 || step === steps) {
          if (Math.abs(data.time - step * dt) > 1e-7) throw new Error("MuJoCo 因数值异常复位，请检查模型或控制输入。");
          samples.push(readSample(data, point));
        }
      }
      return samples;
    } finally { data.delete(); }
  }
  return { info, run };
}
