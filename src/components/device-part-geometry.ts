import * as THREE from "three";
import type { CompositionShape } from "@contracts/device-composition";

/** One shared teaching mesh per declared shape. The BOM supplies shape classes, never inferred dimensions. */
export function makePartMesh(shape?: CompositionShape) {
  const group = new THREE.Group();
  const colors = { body: 0x74a79f, steel: 0xadbfbb, bright: 0xd6e1da, dark: 0x384d49, copper: 0xc98955 };
  const material = (color: number) => new THREE.MeshPhongMaterial({ color, specular: 0x546b65, shininess: 44 });
  function add(geometry: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(x, y, z); group.add(mesh);
    return mesh;
  }
  const block = (w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0) =>
    add(new THREE.BoxGeometry(w, h, d), color, x, y, z);
  function axle(length: number, radius: number, color: number, x = 0) {
    add(new THREE.CylinderGeometry(radius, radius, length, 28), color, x).rotation.z = Math.PI / 2;
  }
  function rounded(w: number, h: number, r: number) {
    const s = new THREE.Shape(), x = w / 2, y = h / 2;
    s.moveTo(-x + r, -y); s.lineTo(x - r, -y); s.quadraticCurveTo(x, -y, x, -y + r);
    s.lineTo(x, y - r); s.quadraticCurveTo(x, y, x - r, y); s.lineTo(-x + r, y);
    s.quadraticCurveTo(-x, y, -x, y - r); s.lineTo(-x, -y + r); s.quadraticCurveTo(-x, -y, -x + r, -y);
    return s;
  }
  function bore(shape: THREE.Shape, r: number, x = 0, y = 0) {
    const hole = new THREE.Path(); hole.absarc(x, y, r, 0, 2 * Math.PI, true); shape.holes.push(hole);
  }
  function extrude(s: THREE.Shape, depth: number, color: number) {
    return add(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSegments: 1,
      steps: 1, bevelSize: 0.025, bevelThickness: 0.02, curveSegments: 24 }), color);
  }
  switch (shape) {
    case "box": {
      block(1.85, .85, 1.08, colors.body);
      block(1.92, .09, 1.15, colors.dark, 0, -.44);
      block(1.76, .06, .99, colors.steel, 0, .44);
      for (let i = -3; i <= 3; i++) block(.045, .025, .37, colors.dark, i * .14, .48);
      break;
    }
    case "plate": {
      const s = rounded(2.2, 1.55, .12);
      for (const x of [-.82, .82]) for (const y of [-.51, .51]) bore(s, .13, x, y);
      extrude(s, .15, colors.body).rotation.x = -Math.PI / 2;
      break;
    }
    case "shaft":
      axle(2.6, .14, colors.bright); axle(1.47, .24, colors.steel, -.11); axle(.43, .32, colors.bright);
      axle(.07, .245, colors.dark, -.70); block(.38, .06, .1, colors.dark, .83, .145); break;
    case "ring": {
      const s = new THREE.Shape(); s.absarc(0, 0, .94, 0, 2 * Math.PI, false); bore(s, .59);
      extrude(s, .26, colors.steel); group.rotation.y = -.25; break;
    }
    case "gear": {
      const s = new THREE.Shape(), radii = [.84, .86, 1, 1, .86, .84], offsets = [0, .12, .25, .47, .60, .82];
      for (let i = 0; i < 15; i++) {
        radii.forEach((r, k) => {
          const angle = 2 * Math.PI * (i + offsets[k]) / 15, x = r * Math.cos(angle), y = r * Math.sin(angle);
          if (!k && !i) s.moveTo(x, y); else s.lineTo(x, y);
        });
      }
      s.closePath(); bore(s, .26);
      for (let i = 0; i < 4; i++) bore(s, .115, .58 * Math.cos(i * Math.PI / 2), .58 * Math.sin(i * Math.PI / 2));
      extrude(s, .26, colors.steel); group.rotation.y = -.23; break;
    }
    case "coil": {
      const path = new THREE.CatmullRomCurve3(Array.from({ length: 142 }, (_, i) => {
        const t = i / 141, a = 14 * Math.PI * t;
        return new THREE.Vector3(2.4 * (t - .5), .44 * Math.cos(a), .44 * Math.sin(a));
      }));
      add(new THREE.TubeGeometry(path, 160, .083, 8, false), colors.copper);
      break;
    }
    case "ball": add(new THREE.SphereGeometry(.75, 30, 22), colors.steel); break;
    case "belt": {
      const s = rounded(2.55, 1.16, .54), aperture = rounded(2.21, .83, .40);
      s.holes.push(new THREE.Path(aperture.getPoints(20).reverse())); extrude(s, .19, colors.dark).rotation.x = -Math.PI / 2;
      break;
    }
    default: {
      const cube = new THREE.BoxGeometry(1.5, .95, 1.15);
      group.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube), new THREE.LineBasicMaterial({ color: 0x8b9c96 })));
      cube.dispose();
    }
  }
  const bounds = new THREE.Box3().setFromObject(group), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const normalized = new THREE.Group();
  const unit = 1.55 / Math.max(size.x, size.y, size.z);
  group.position.set(-center.x, -bounds.min.y, -center.z);
  normalized.add(group); normalized.scale.setScalar(unit);
  return normalized;
}
