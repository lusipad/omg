import * as THREE from "three";
import { MILO_MACHINE, type MiloMotionSample, type MiloVec3 } from "@contracts/milo-motion";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM } from "@contracts/milo-stock";

type Axis = "x" | "y" | "z";
type Point = [number, number];
type Parent = THREE.Object3D;
const xyz = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const unit = { x: xyz(1, 0, 0), y: xyz(0, 1, 0), z: xyz(0, 0, 1) };
const pitch = 8; // TR8×8 每转轴向行程，单位 mm。

function outline(points: Point[]) { return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))); }
function extrude(shape: THREE.Shape, depth: number) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
}

// 型材不是平面贴图，顶面每 20 mm 的槽口带有内侧退让。
function slottedProfile(length: number, width: number, height: number, axis: Axis) {
  const half = width / 2;
  const points: Point[] = [[-half, -height + 1], [-half, -1], [-half + 1, 0]];
  for (let u = -half + 10; u < half; u += 20) points.push(
    [u - 2, 0], [u - 2, -2], [u - 4, -2], [u - 4, -5], [u + 4, -5], [u + 4, -2], [u + 2, -2], [u + 2, 0],
  );
  points.push([half - 1, 0], [half, -1], [half, -height + 1], [half - 1, -height], [-half + 1, -height]);
  const g = extrude(outline(points), length).translate(0, 0, -length / 2);
  const basis = axis === "x" ? [unit.y, unit.z, unit.x] : axis === "y" ? [xyz(-1, 0, 0), unit.z, unit.y] : [xyz(-1, 0, 0), xyz(0, -1, 0), unit.z];
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2]));
}

function flatCutter(radius: number) {
  const vertices: number[] = [], indices: number[] = [];
  const rings = 16, sides = 36;
  for (let row = 0; row <= rings; row++) {
    const z = 15 * row / rings;
    for (let i = 0; i < sides; i++) {
      const a = 2 * Math.PI * i / sides;
      const r = radius * (0.72 + 0.28 * (0.5 + 0.5 * Math.cos(3 * a)) ** 2);
      vertices.push(r * Math.cos(a + z * 0.115), r * Math.sin(a + z * 0.115), z);
      if (row === rings) continue;
      const here = row * sides + i, next = row * sides + (i + 1) % sides;
      indices.push(here, next, here + sides, next, next + sides, here + sides);
    }
  }
  const center = vertices.length / 3;
  vertices.push(0, 0, 0);
  for (let i = 0; i < sides; i++) indices.push(center, (i + 1) % sides, i);
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  mesh.setIndex(indices); mesh.computeVertexNormals();
  return mesh;
}

/** 展示用简化构型。尺寸和位姿以 mm 表示，世界 Z 向上。 */
export function createMiloMachine3D() {
  const group = new THREE.Group(); group.name = "milo-v1.5";
  const geometries = new Set<THREE.BufferGeometry>(), materials: THREE.Material[] = [], instances: THREE.InstancedMesh[] = [];
  const own = <T extends THREE.BufferGeometry>(g: T): T => { geometries.add(g); return g; };
  function metal(color: number, metalness = 0.42, roughness = 0.43) {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness }); materials.push(m); return m;
  }
  const rail = metal(0xb3bec4), aluminum = metal(0x757f86), graphite = metal(0x383e43);
  const black = metal(0x23292e, 0.22, 0.54), rubber = metal(0x272b2b, 0.02, 0.75);
  const red = metal(0xd44d40, 0.12), redDark = metal(0xad3a31, 0.15), bronze = metal(0xc59c62, 0.55), cutterGold = metal(0xe3b779, 0.52);
  const cube = own(new THREE.BoxGeometry(1, 1, 1));
  const cylinder = own(new THREE.CylinderGeometry(1, 1, 1, 28));
  const hex = own(new THREE.CylinderGeometry(1, 1, 1, 6));
  function node(parent: Parent, name: string) { const n = new THREE.Group(); n.name = name; parent.add(n); return n; }
  function mesh(parent: Parent, g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o;
  }
  function shadow(o: THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; return o; }
  function box(p: Parent, x: number, y: number, z: number, w: number, d: number, h: number, m: THREE.Material) {
    const o = mesh(p, cube, m, x, y, z); o.scale.set(w, d, h); return o;
  }
  function shaft(p: Parent, x: number, y: number, z: number, axis: Axis, r: number, length: number, m: THREE.Material) {
    const o = mesh(p, cylinder, m, x, y, z); o.scale.set(r, length, r); o.quaternion.setFromUnitVectors(unit.y, unit[axis]); return o;
  }
  function bolts(p: Parent, pts: MiloVec3[], axis: Axis, radius = 3.3, depth = 2) {
    const bolts = new THREE.InstancedMesh(hex, black, pts.length), t = new THREE.Object3D();
    t.quaternion.setFromUnitVectors(unit.y, unit[axis]); t.scale.set(radius, depth, radius);
    pts.forEach(([x, y, z], i) => { t.position.set(x, y, z); t.updateMatrix(); bolts.setMatrixAt(i, t.matrix); });
    p.add(bolts); instances.push(bolts);
  }
  function profile(p: Parent, axis: Axis, length: number, width: number, h: number, x: number, y: number, z: number, m: THREE.Material) {
    return shadow(mesh(p, own(slottedProfile(length, width, h, axis)), m, x, y, z));
  }
  function screw(p: Parent, name: string, pos: MiloVec3, axis: Axis, length: number) {
    const mounting = node(p, name + "-mount"); mounting.position.set(...pos); mounting.quaternion.setFromUnitVectors(unit.z, unit[axis]);
    const spindle = node(mounting, name);
    shaft(spindle, 0, 0, 0, "z", 3.6, length, rail);
    const rib: number[] = [];
    const count = Math.ceil(8 * length / pitch);
    for (let start = 0; start < 4; start++) {
      for (let i = 0; i < count; i++) {
        for (let j = i; j <= i + 1; j++) {
          const z = length * (j / count - 0.5), a = z / pitch * 2 * Math.PI + start * Math.PI / 2;
          rib.push(3.95 * Math.cos(a), 3.95 * Math.sin(a), z);
        }
      }
    }
    const g = own(new THREE.BufferGeometry()); g.setAttribute("position", new THREE.Float32BufferAttribute(rib, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x737d80 }); materials.push(lineMaterial);
    spindle.add(new THREE.LineSegments(g, lineMaterial));
    return spindle;
  }
  function motor(p: Parent, name: string, pos: MiloVec3, axis: Axis) {
    const n = node(p, name); n.position.set(...pos); n.quaternion.setFromUnitVectors(unit.z, unit[axis]);
    const section: Point[] = [[-22,-28], [22,-28], [28,-22], [28,22], [22,28], [-22,28], [-28,22], [-28,-22]];
    shadow(mesh(n, own(extrude(outline(section), 44)), black, 0, 0, -22));
    box(n, 0, 0, -24, 57, 57, 5, aluminum); box(n, 0, 0, 24, 57, 57, 5, graphite);
    bolts(n, [[-22,-22,27], [22,-22,27], [22,22,27], [-22,22,27]], "z", 2.5);
    return n;
  }
  function wheel(p: Parent, name: string, pos: MiloVec3, normal: THREE.Vector3) {
    const mount = node(p, name + "-mount"); mount.position.set(...pos); mount.quaternion.setFromUnitVectors(unit.z, normal);
    const n = node(mount, name);
    shadow(shaft(n, 0, 0, 0, "z", 30, 6, graphite));
    mesh(n, own(new THREE.TorusGeometry(26.5, 3.8, 9, 32)), black, 0, 0, 3);
    shaft(n, 0, 0, 4.5, "z", 8.5, 6, aluminum);
    shaft(n, 22, 0, 13, "z", 3.2, 20, rail); shaft(n, 22, 0, 20, "z", 5, 20, black);
    return n;
  }
  function plate(p: Parent, points: Point[], depth: number, pos: MiloVec3, orientation: "xz" | "yz", m: THREE.Material, hole?: Point[]) {
    const shape = outline(points);
    if (hole) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    const g = own(extrude(shape, depth));
    if (orientation === "xz") g.rotateX(Math.PI / 2);
    else g.applyMatrix4(new THREE.Matrix4().makeBasis(unit.y, unit.z, unit.x));
    return mesh(p, g, m, ...pos);
  }

  const frame = node(group, "machine-frame"), saddle = node(frame, "y-saddle"), table = node(saddle, "xy-table");
  const head = node(group, "z-head"), housing = node(head, "spindle-housing"), tool = node(head, "end-mill");
  const workOrigin = node(group, "work-origin"); node(tool, "tool-tip");

  // 固定机座为三条 2080×550 和两条 2040×580。双层滑台在其上独立运动。
  for (const x of [-80, 0, 80]) profile(frame, "y", 550, 80, 20, x, 10, -99, graphite);
  for (const x of [-130, 130]) profile(frame, "y", 580, 20, 40, x, 10, -98, graphite);
  for (const y of [-267, 287]) {
    shadow(box(frame, 0, y, -120, 259, 17, 37, black));
    for (const side of [-1, 1]) {
      const holder = plate(frame, [[0,0],[29,0],[29,7],[2,37],[0,37]], 13, [side * 132, y + 6, -139], "xz", redDark,
        [[5,6],[20,6],[5,23]]);
      holder.scale.x = side;
      shadow(shaft(frame, side * 147, y, -143, "z", 13, 7, rubber));
    }
  }
  shaft(frame, 32, -279, -118, "y", 14, 7, bronze); shaft(frame, 32, -284, -118, "y", 11, 9, red);

  // Y 丝杠固定于底梁，Y 滑鞍带动整条 X 台。导轨位于 C 型梁两侧。
  const yRailCenter = -24;
  box(frame, 0, yRailCenter, -95, 80, 470, 8, graphite);
  for (const x of [-30, 30]) {
    box(frame, x, yRailCenter, -80, 20, 470, 26, graphite);
    box(frame, x, yRailCenter, -64, 15, 350, 6, rail);
    for (const y of [-40, 40]) box(saddle, x, y, -55, 31, 40, 13, black);
  }
  const yScrew = screw(frame, "y-lead-screw", [0, yRailCenter, -77], "y", 535);
  for (const y of [yRailCenter - 240, yRailCenter + 240]) {
    box(frame, 0, y, -79, 72, 13, 44, redDark); shaft(frame, 0, y, -77, "y", 11, 16, rail);
  }
  const yWheel = wheel(frame, "y-handwheel", [0, -301, -77], xyz(0, -1, 0));
  motor(frame, "y-stepper", [0, 274, -77], "y");
  shaft(frame, 0, 245, -77, "y", 9, 23, aluminum);
  box(saddle, 0, 0, -46, 138, 113, 8, graphite); shaft(saddle, 0, 0, -77, "y", 9, 23, bronze);

  // 500 mm C 梁和两条外侧型材形成横向槽台。X 导轨、丝杠和两端座随台移动。
  profile(table, "x", 500, 160, 18, 0, 0, 0, aluminum);
  for (const y of [-30, 30]) {
    box(table, 0, y, -23, 500, 18, 12, graphite);
    box(table, 0, y, -32, 500, 15, 6, rail);
    for (const x of [-43, 43]) box(saddle, x, y, -37, 40, 29, 10, black);
  }
  const xScrew = screw(table, "x-lead-screw", [0, 0, -29], "x", 550);
  for (const x of [-255, 255]) {
    box(table, x, 0, -20, 10, 163, 42, graphite); shaft(table, x, 0, -29, "x", 12, 14, rail);
    bolts(table, [[x + Math.sign(x)*6,-69,-11], [x + Math.sign(x)*6,69,-11]], "x", 3);
  }
  shaft(saddle, 0, 0, -29, "x", 8, 22, bronze);
  motor(table, "x-stepper", [-309, 0, -29], "x"); shaft(table, -275, 0, -29, "x", 9, 22, aluminum);
  const xWheel = wheel(table, "x-handwheel", [277, 0, -29], unit.x);

  // 后置单柱与前 Z 导向梁组成 C 型机架。顶架电机偏置，由同步带驱动丝杠。
  for (const y of [152, 192]) profile(frame, "z", 260, 80, 40, 0, y, 31, graphite);
  profile(frame, "z", 120, 80, 40, 0, 112, 106, graphite);
  profile(frame, "z", 250, 80, 40, 0, 72, 185, graphite);
  for (const side of [-1, 1]) {
    const x = side < 0 ? -46 : 40;
    plate(frame, [[0,0],[119,0],[119,98],[66,98],[0,40]], 6, [x, 114,-95], "yz", graphite);
    plate(frame, [[0,0],[76,0],[76,34],[0,153]], 6, [x, 114,157], "yz", black, [[10,29],[57,29],[10,113]]);
    bolts(frame, [[x + (side < 0 ? -1 : 7), 130,-76], [x + (side < 0 ? -1 : 7), 194,-76],
      [x + (side < 0 ? -1 : 7), 207,-14], [x + (side < 0 ? -1 : 7), 129,294]], "x", 3.7);
    box(frame, side * 29, 68, 185, 15, 8, 250, rail);
    bolts(frame, [80, 151, 222, 292].map((z) => [side * 29, 63, z]), "y", 2.4, 1.5);
    for (const z of [106, 165]) box(housing, side * 29, 61, z, 29, 12, 38, black);
  }
  const zScrew = screw(frame, "z-lead-screw", [0, 65, 186], "z", 300);
  box(frame, 0, 76, 51, 79, 31, 17, redDark); shaft(frame, 0, 65, 52, "z", 10, 21, rail);
  box(frame, 0, 102, 310, 90, 104, 9, graphite);
  motor(frame, "z-stepper", [0, 135, 274], "z");
  const gearR = 40 / Math.PI, motorR = 20 / Math.PI, centers = 70;
  shaft(frame, 0, 65, 322, "z", gearR, 13, rail); shaft(frame, 0, 135, 322, "z", motorR, 13, rail);
  const beltLoop = (a: number, b: number): Point[] => {
    const theta = Math.asin((a - b) / centers), points: Point[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = theta + (Math.PI - 2 * theta) * i / 16;
      points.push([b * Math.cos(t), centers + b * Math.sin(t)]);
    }
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI - theta + (Math.PI + 2 * theta) * i / 16;
      points.push([a * Math.cos(t), a * Math.sin(t)]);
    }
    return points;
  };
  const belt = outline(beltLoop(gearR + 1.4, motorR + 1.4));
  belt.holes.push(new THREE.Path(beltLoop(gearR, motorR).reverse().map(([x,y]) => new THREE.Vector2(x,y))));
  mesh(frame, own(extrude(belt, 6)), rubber, 0, 65, 319).name = "z-timing-belt";

  // 主轴组全部以刀尖为局部 Z0。夹座为带棱角的分体外壳，主轴直径取官方 80 mm。
  box(housing, 0, 49, 136, 81, 20, 112, graphite);
  shadow(shaft(housing, 0, 0, 148, "z", 40, 182, rail)); shaft(housing, 0, 0, 237, "z", 40.5, 25, black);
  shaft(housing, 0, 0, 251, "z", 39, 4, aluminum);
  for (const x of [-14, 14]) shaft(housing, x, 5, 258, "z", 5.3, 12, rail);
  for (const x of [-42,42]) {
    box(housing, x, 3, 142, 9, 80, 111, black);
    box(housing, x, 36, 145, 22, 33, 13, redDark);
    bolts(housing, [[x + Math.sign(x) * 11.5,36,145]], "x", 3.3);
  }
  const face: Point[] = [[-34,74],[34,74],[50,89],[50,193],[35,209],[-35,209],[-50,193],[-50,89]];
  shadow(plate(housing, face, 10, [0,-37,0], "xz", red));
  bolts(housing, [[-36,-48,93],[36,-48,93],[-36,-48,188],[36,-48,188]], "y", 4.3, 2.8);
  shaft(housing, 0, 0, 54, "z", 28, 11, aluminum);
  const nose = own(new THREE.CylinderGeometry(24, 15, 21, 28)).rotateX(Math.PI / 2);
  shadow(mesh(housing, nose, graphite, 0, 0, 39));
  const nut = own(new THREE.CylinderGeometry(15, 13, 12, 6)).rotateX(Math.PI / 2);
  mesh(housing, nut, black, 0, 0, 25);
  const toolRadius = MILO_TOOL_DIAMETER_MM / 2;
  const flutes = mesh(tool, own(flatCutter(toolRadius)), cutterGold, 0, 0, 0);
  flutes.name = "flat-flutes"; flutes.castShadow = true;
  shaft(tool, 0, 0, 20, "z", toolRadius, 10, rail).castShadow = true;
  shaft(housing, 0, 65, 138, "z", 9, 23, bronze);

  // 右侧 Z 拖链长度恒定，移动端随主轴，折返半圆沿直段滑动。
  const links = new THREE.InstancedMesh(cube, black, 28), transform = new THREE.Object3D();
  links.name = "z-cable-chain"; links.frustumCulled = false; instances.push(links); frame.add(links);
  function poseChain(tipZ: number) {
    const lower = tipZ + 156, fixed = 186, r = 15, total = 280, up = (total - Math.PI*r + fixed-lower)/2;
    for (let i = 0; i < links.count; i++) {
      const distance = (i + .5) * total / links.count, arc = Math.max(0, Math.min(Math.PI, (distance - up) / r));
      const z = distance <= up ? lower + distance : distance <= up + Math.PI*r ? lower + up + r*Math.sin(arc) : lower + up - (distance-up-Math.PI*r);
      transform.position.set(52, 47 + r * (1 - Math.cos(arc)), z);
      transform.rotation.set(-arc, 0, 0); transform.scale.set(10,9,8.3); transform.updateMatrix();
      links.setMatrixAt(i, transform.matrix);
    }
    links.instanceMatrix.needsUpdate = true;
  }
  const datumX = (MILO_MACHINE.maxMm[0] + MILO_MACHINE.minMm[0]) / 2 - MILO_MACHINE.workOriginMachineMm[0];
  const datumY = 80 - MILO_MACHINE.workOriginMachineMm[1]; // 工件前缘距 160 mm 台面的前边 10 mm。
  let disposed = false;
  function setPose(sample: Pick<MiloMotionSample, "positionMm">, focus: "stock" | "machine") {
    if (disposed) return;
    const [x, y, z] = sample.positionMm, full = focus === "machine";
    frame.visible = full; housing.visible = full;
    if (full) {
      if (workOrigin.parent !== table) table.add(workOrigin);
      workOrigin.position.set(-datumX, -datumY, MILO_STOCK.thicknessMm);
      saddle.position.y = datumY - y; table.position.x = datumX - x;
      head.position.set(0, 0, MILO_STOCK.thicknessMm + z);
      xScrew.rotation.z = xWheel.rotation.z = -x * 2 * Math.PI / pitch;
      yScrew.rotation.z = y * 2 * Math.PI / pitch; yWheel.rotation.z = -yScrew.rotation.z;
      zScrew.rotation.z = -z * 2 * Math.PI / pitch;
      poseChain(head.position.z);
    } else {
      if (workOrigin.parent !== group) group.add(workOrigin);
      workOrigin.position.set(0,0,0); head.position.set(x,y,z);
    }
  }
  setPose({ positionMm: [...MILO_MACHINE.initialWorkMm] }, "stock");
  return { group, workOrigin, setPose, dispose() {
    if (disposed) return;
    disposed = true;
    // 视窗挂在 workOrigin 的毛坯和刀路由视窗拥有，仅脱开该坐标组。
    group.removeFromParent(); workOrigin.removeFromParent();
    for (const obj of instances) obj.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    group.clear();
  } };
}
