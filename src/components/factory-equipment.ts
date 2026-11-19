import * as THREE from "three";
import type { FactoryRunResource } from "@/lib/factory-runtime";

type Triple = [number, number, number];
const colors = {
  base: 0x283d42,
  steel: 0x739192,
  light: 0xc4d3ca,
  cabinet: 0x8ea5a1,
  teal: 0x377d7d,
  glass: 0x213d48,
  orange: 0xd58b4e,
  tire: 0x182727,
  cyan: 0x7cddd4,
  yellow: 0xe6b662,
};

/** 工艺符号的尺寸只用于辨认设备，场内坐标来自厂区布局。 */
export function factoryMeshes() {
  const boxGeo = new THREE.BoxGeometry(1, 1, 1),
    cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
  const palette = new Map<number, THREE.MeshStandardMaterial>();
  function material(color: number) {
    let value = palette.get(color);
    if (!value) {
      value = new THREE.MeshStandardMaterial({ color, roughness: 0.67, metalness: 0.19 });
      palette.set(color, value);
    }
    return value;
  }
  function solid(root: THREE.Object3D, shape: THREE.BufferGeometry, color: number, size: Triple, position: Triple) {
    const mesh = new THREE.Mesh(shape, material(color));
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  }
  const box = (root: THREE.Object3D, color: number, size: Triple, at: Triple) => solid(root, boxGeo, color, size, at);
  const cyl = (root: THREE.Object3D, color: number, size: Triple, at: Triple) => solid(root, cylGeo, color, size, at);
  function link(root: THREE.Object3D, a: Triple, b: Triple, width: number, color: number) {
    const start = new THREE.Vector3(...a),
      delta = new THREE.Vector3(...b).sub(start);
    const segment = cyl(root, color, [width, delta.length(), width], [0, 0, 0]);
    segment.position.copy(start).addScaledVector(delta, 0.5);
    segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  }
  function cnc(g: THREE.Group) {
    box(g, colors.base, [1.79, 0.18, 1.12], [0, 0.1, 0]);
    box(g, colors.teal, [1.75, 0.36, 1.04], [0, 0.33, 0]);
    box(g, colors.cabinet, [1.7, 0.77, 0.84], [0, 0.86, -0.08]);
    box(g, colors.light, [1.78, 0.12, 1.04], [0, 1.28, 0]);
    box(g, colors.light, [0.22, 0.81, 0.15], [-0.74, 0.87, 0.43]);
    box(g, colors.light, [0.31, 0.81, 0.15], [0.7, 0.87, 0.43]);
    box(g, colors.base, [1.16, 0.66, 0.13], [-0.02, 0.89, 0.39]);
    for (const x of [-0.31, 0.24]) {
      box(g, colors.teal, [0.53, 0.62, 0.1], [x, 0.88, 0.47]);
      box(g, colors.glass, [0.41, 0.37, 0.035], [x, 0.94, 0.531]);
      box(g, colors.steel, [0.05, 0.19, 0.06], [x + 0.19, 0.77, 0.54]);
    }
    box(g, colors.base, [0.28, 0.34, 0.115], [0.75, 0.84, 0.55]);
    box(g, colors.cyan, [0.19, 0.13, 0.014], [0.75, 0.91, 0.613]);
    for (const x of [0.69, 0.75, 0.81]) box(g, colors.cabinet, [0.035, 0.025, 0.018], [x, 0.79, 0.615]);
    for (const z of [-0.23, -0.12, -0.01, 0.1]) box(g, colors.base, [0.31, 0.012, 0.038], [0.48, 1.348, z]);
    cyl(g, colors.steel, [0.065, 0.23, 0.065], [-0.68, 1.43, -0.29]);
    return { beacon: cyl(g, colors.cyan, [0.11, 0.12, 0.11], [-0.68, 1.57, -0.29]), height: 1.7 };
  }
  function arm(g: THREE.Group) {
    box(g, colors.base, [1.34, 0.15, 0.98], [0, 0.08, 0]);
    box(g, colors.steel, [0.69, 0.43, 0.7], [-0.16, 0.35, 0]);
    cyl(g, colors.base, [0.62, 0.16, 0.62], [-0.16, 0.64, 0]);
    cyl(g, colors.orange, [0.48, 0.24, 0.48], [-0.16, 0.8, 0]);
    const joints: Triple[] = [
      [-0.16, 0.91, 0],
      [-0.43, 1.43, -0.02],
      [0.26, 1.52, 0.06],
      [0.47, 1.23, 0.14],
    ];
    link(g, joints[0], joints[1], 0.22, colors.orange);
    link(g, joints[1], joints[2], 0.19, colors.orange);
    link(g, joints[2], joints[3], 0.12, colors.steel);
    for (const p of joints.slice(0, 3)) {
      const cap = cyl(g, colors.base, [0.23, 0.25, 0.23], p);
      cap.rotation.x = Math.PI / 2;
    }
    box(g, colors.tire, [0.23, 0.075, 0.14], [0.47, 1.2, 0.14]);
    for (const x of [0.39, 0.55]) box(g, colors.steel, [0.04, 0.12, 0.11], [x, 1.13, 0.14]);
    return { beacon: box(g, colors.cyan, [0.28, 0.035, 0.035], [0.4, 0.13, 0.49]), height: 1.72 };
  }
  function conveyor(g: THREE.Group, length: number) {
    const belt = Math.max(1.15, length);
    for (const x of [-0.37 * belt, 0.37 * belt]) {
      for (const z of [-0.25, 0.25]) box(g, colors.steel, [0.09, 0.47, 0.09], [x, 0.255, z]);
      box(g, colors.base, [0.22, 0.045, 0.69], [x, 0.033, 0]);
    }
    box(g, colors.base, [belt, 0.13, 0.57], [0, 0.54, 0]);
    for (const z of [-0.3, 0.3]) box(g, colors.teal, [belt, 0.13, 0.058], [0, 0.59, z]);
    const n = Math.max(7, Math.min(40, Math.ceil(belt / 0.19)));
    for (let i = 0; i < n; i++) {
      const roller = cyl(g, colors.steel, [0.075, 0.5, 0.075], [(belt * (i + 0.5)) / n - belt / 2, 0.612, 0]);
      roller.rotation.x = Math.PI / 2;
    }
    return { beacon: box(g, colors.cyan, [0.18, 0.045, 0.04], [0, 0.59, 0.346]), height: 0.82 };
  }
  function mobile(g: THREE.Group) {
    box(g, colors.tire, [0.91, 0.17, 0.64], [0, 0.13, 0]);
    box(g, colors.yellow, [0.99, 0.25, 0.7], [0, 0.28, 0]);
    box(g, colors.base, [0.83, 0.1, 0.6], [0, 0.455, 0]);
    for (const x of [-0.25, 0.25])
      for (const z of [-0.34, 0.34]) {
        const wheel = cyl(g, colors.tire, [0.21, 0.054, 0.21], [x, 0.15, z]);
        wheel.rotation.x = Math.PI / 2;
      }
    box(g, colors.steel, [0.54, 0.035, 0.45], [-0.04, 0.523, 0]);
    cyl(g, colors.glass, [0.12, 0.08, 0.12], [0.33, 0.49, 0]);
    return { beacon: box(g, colors.cyan, [0.042, 0.055, 0.42], [0.5, 0.31, 0]), height: 0.68 };
  }
  function equipment(role: FactoryRunResource["role"], length = 1.8) {
    const body = new THREE.Group();
    const details =
      role === "machine" ? cnc(body) : role === "handle" ? arm(body) : role === "mobile" ? mobile(body) : conveyor(body, length);
    return { body, ...details };
  }
  return {
    equipment,
    box,
    material,
    dispose() {
      boxGeo.dispose();
      cylGeo.dispose();
      for (const m of palette.values()) m.dispose();
    },
  };
}
