import { Matrix4, Quaternion, Vector3 } from "three";
import type { ModelBundle } from "./import-catalog";
import type { MechanicalFrame, ResolvedMechanicalAssembly } from "./mechanical-assembly";

export const MECHANICAL_OUTPUT_SITE = "assembly_output";
export const mechanicalJointName = (nodeIndex: number) => `joint_${nodeIndex}`;
const toSI = (value: number, kind: "hinge" | "slide") => value * (kind === "hinge" ? Math.PI / 180 : 0.001);
const metres = (xyz: number[]) => new Vector3().fromArray(xyz).multiplyScalar(0.001);
const vector = (v: Vector3) => v.toArray().join(" ");
const quaternion = (q: Quaternion) => [q.w, q.x, q.y, q.z].join(" ");
const one = new Vector3(1, 1, 1);
function scaleForNormalization(values: number[]) {
  const max = Math.max(...values.map(Math.abs));
  return values.map(v => v / max);
}
function frameMatrix(frame: MechanicalFrame) {
  const [w, x, y, z] = scaleForNormalization(frame.quatWxyz);
  return new Matrix4().compose(metres(frame.positionMm), new Quaternion(x, y, z, w).normalize(), one);
}
function attributes(transform: Matrix4) {
  const position = new Vector3().setFromMatrixPosition(transform);
  const rotation = new Quaternion().setFromRotationMatrix(transform).normalize();
  return `pos="${vector(position)}" quat="${quaternion(rotation)}"`;
}

/** Compile the interface frames and joint commands into a kinematic MJCF with SI keyframes. */
export function compileMechanicalModel({ nodes, output }: ResolvedMechanicalAssembly): ModelBundle {
  const children = new Map<string | null, number[]>(), lengths: number[] = [];
  const used = new Map<string, Set<string>>();
  for (const ref of [output, ...nodes.flatMap(node => node.parent ? [node.parent] : [])]) {
    const mounts = used.get(ref.path);
    if (mounts) mounts.add(ref.mount); else used.set(ref.path, new Set([ref.mount]));
  }
  for (const [i, node] of nodes.entries()) {
    const parent = node.parent?.path ?? null, group = children.get(parent);
    if (group) group.push(i); else children.set(parent, [i]);
    for (const frame of [node.part.input, ...node.part.outputs.filter(m => used.get(node.path)?.has(m.id))]) {
      const size = Math.hypot(...frame.positionMm);
      if (size > 0) lengths.push(size);
    }
    if (node.part.joint.type === "slide" && node.value) lengths.push(Math.abs(node.value));
  }
  lengths.sort((a, b) => a - b);
  // Spheres, joint axes and rods are glyphs. Their thickness is independent of mass and travel.
  const radius = (lengths[Math.floor(lengths.length / 2)] ?? 20) * 0.000035;
  const zero = new Vector3();
  const portColor = "0.36 0.87 0.69 1", rodColor = "0.61 0.70 0.69 1";
  const channels: { start: number; target: number }[] = [];
  const marker = (p: Vector3, size: number, rgba: string) =>
    `<geom type="sphere" pos="${vector(p)}" size="${size}" rgba="${rgba}"/>`;
  const rod = (a: Vector3, b: Vector3, size: number, rgba: string, type = "capsule") => a.distanceToSquared(b) > 1e-24
    ? `<geom type="${type}" fromto="${vector(a)} ${vector(b)}" size="${size}" rgba="${rgba}"/>` : "";

  function branch(i: number, parentMount: Matrix4): string {
    const { path, part, value } = nodes[i], { joint } = part;
    const neutral = parentMount.clone().multiply(frameMatrix(part.input).invert());
    const reference = neutral.clone();
    let guide = "", jointXml = "", glyph = marker(zero, radius * 1.6, "0.60 0.65 0.65 1");
    if (joint.type !== "fixed") {
      const axis = new Vector3().fromArray(scaleForNormalization(joint.axis)).normalize();
      const [min, max] = joint.range.map(v => toSI(v, joint.type));
      const start = Math.min(max, Math.max(min, 0)), target = toSI(value, joint.type);
      channels.push({ start, target }); // MuJoCo assigns qpos in kinematic tree order.
      jointXml = `<joint name="${mechanicalJointName(i)}" type="${joint.type}" axis="${vector(axis)}" range="${min} ${max}" ref="${start}"/>`;
      // MuJoCo applies qpos - ref. Place the reference body at J(ref), also for ranges excluding zero.
      if (joint.type === "hinge") reference.multiply(new Matrix4().makeRotationAxis(axis, start));
      else {
        reference.multiply(new Matrix4().makeTranslation(...axis.clone().multiplyScalar(start).toArray()));
        if (part.input.positionMm.every(v => v === 0)) guide = rod(axis.clone().multiplyScalar(start).applyMatrix4(neutral), axis.clone().multiplyScalar(target).applyMatrix4(neutral),
          radius * 0.54, "0.35 0.49 0.54 1");
      }
      const half = axis.clone().multiplyScalar(radius * 2.5);
      glyph = rod(half.clone().negate(), half, radius * 1.35, joint.type === "hinge" ? "0.98 0.66 0.33 1" : "0.39 0.72 0.98 1", "cylinder");
    }
    // Moving MuJoCo bodies require positive inertial data even for mj_kinematics only.
    const inertial = joint.type === "fixed" ? "" : '<inertial pos="0 0 0" mass="1" diaginertia="1 1 1"/>';
    const input = metres(part.input.positionMm);
    const interfaceGeometry = [rod(zero, input, radius, rodColor)];
    const mounts = new Map(part.outputs.map(mount => [mount.id, mount]));
    part.outputs.forEach((mount, k) => {
      if (!used.get(path)?.has(mount.id)) return;
      const p = metres(mount.positionMm), selected = output.path === path && output.mount === mount.id;
      interfaceGeometry.push(rod(zero, p, radius, rodColor), marker(p, radius * 1.25, portColor),
        `<site name="${selected ? MECHANICAL_OUTPUT_SITE : `port_${i}_${k}`}" ${attributes(frameMatrix(mount))} size="${radius}"/>`);
    });
    const descendants = (children.get(path) ?? []).map(child => {
      const mount = mounts.get(nodes[child].parent!.mount)!;
      return branch(child, frameMatrix(mount));
    });
    return `${guide}<body name="node_${i}" ${attributes(reference)}>${inertial}${jointXml}${glyph}${interfaceGeometry.join("")}${descendants.join("")}</body>`;
  }
  const bodies = (children.get(null) ?? []).map(i => branch(i, new Matrix4())).join("");
  const intervals = channels.some(c => c.start !== c.target) ? 24 : 1;
  const keys = Array.from({ length: intervals + 1 }, (_, step) => {
    const name = step === 0 ? "start" : step === intervals ? "target" : `pose_${step}`;
    const qpos = channels.map(c => step === intervals ? c.target : c.start + (c.target - c.start) * step / intervals);
    return `<key name="${name}"${qpos.length ? ` qpos="${qpos.join(" ")}"` : ""}/>`;
  });
  const xml = `<mujoco model="Mechanical assembly kinematics"><compiler angle="radian" fusestatic="false" inertiafromgeom="false"/>
<option gravity="0 0 0"/><default><geom contype="0" conaffinity="0" group="2"/></default>
<custom><text name="use" data="Kinematic schematic. Marker sizes and compiler inertias are illustrative."/></custom>
<worldbody>${bodies}</worldbody><keyframe>${keys.join("")}</keyframe></mujoco>`;
  const entry = "assembly.xml";
  return { entry, files: [{ path: entry, data: new TextEncoder().encode(xml) }] };
}
