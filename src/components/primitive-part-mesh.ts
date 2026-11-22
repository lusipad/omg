import * as THREE from "three";
import {
  EXTRUSION_SERIES_SECTION_MM,
  primitiveBoundingBoxMm,
  type AxisDir,
  type PrimitiveFinish,
  type PrimitivePartSpec,
} from "@contracts/primitive-parts";
import type { DevicePackage } from "@contracts/twin-device";
import { readStoredModel } from "@/lib/model-store";

const FINISH_CONFIG: Record<PrimitiveFinish, { color: number; metalness: number; roughness: number }> = {
  aluminum: { color: 0xb9c5cc, metalness: 0.45, roughness: 0.36 },
  anodized_black: { color: 0x262c33, metalness: 0.3, roughness: 0.54 },
  steel: { color: 0x8b98a2, metalness: 0.62, roughness: 0.32 },
  brass: { color: 0xc99c52, metalness: 0.58, roughness: 0.34 },
  spindle_red: { color: 0xc94a3f, metalness: 0.28, roughness: 0.4 },
  workpiece_alloy: { color: 0x6cb8a6, metalness: 0.36, roughness: 0.44 },
  sensor_amber: { color: 0xe39b3b, metalness: 0.2, roughness: 0.45 },
};

function makeMaterial(finish: PrimitiveFinish, selected?: boolean): THREE.MeshStandardMaterial {
  const cfg = FINISH_CONFIG[finish];
  return new THREE.MeshStandardMaterial({
    color: cfg.color,
    metalness: cfg.metalness,
    roughness: cfg.roughness,
    emissive: selected ? new THREE.Color(0x1f6f5b) : new THREE.Color(0x000000),
    emissiveIntensity: selected ? 0.55 : 0,
  });
}

function axisQuaternion(axis: AxisDir): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (axis === "x") {
    // local X -> +Y, local Y -> +Z, local Z -> +X
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    );
    q.setFromRotationMatrix(m);
  } else if (axis === "y") {
    // local X -> +X, local Y -> -Z, local Z -> +Y
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  }
  return q;
}

function addCenteredBox(
  parent: THREE.Object3D,
  w: number,
  d: number,
  h: number,
  mat: THREE.Material,
  edgeColor?: number,
) {
  const geo = new THREE.BoxGeometry(w, d, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  if (edgeColor !== undefined) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.35 }),
    );
    mesh.add(edges);
  }
  return mesh;
}

function buildRoundedPlateShape(w: number, d: number, r: number): THREE.Shape {
  const radius = Math.min(r, w * 0.45, d * 0.45);
  const hw = w / 2;
  const hd = d / 2;
  const s = new THREE.Shape();
  if (radius <= 0.1) {
    s.moveTo(-hw, -hd);
    s.lineTo(hw, -hd);
    s.lineTo(hw, hd);
    s.lineTo(-hw, hd);
    s.closePath();
    return s;
  }
  s.moveTo(-hw + radius, -hd);
  s.lineTo(hw - radius, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + radius);
  s.lineTo(hw, hd - radius);
  s.quadraticCurveTo(hw, hd, hw - radius, hd);
  s.lineTo(-hw + radius, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - radius);
  s.lineTo(-hw, -hd + radius);
  s.quadraticCurveTo(-hw, -hd, -hw + radius, -hd);
  return s;
}

function buildSlottedProfileMesh(series: keyof typeof EXTRUSION_SERIES_SECTION_MM, lengthMm: number, mat: THREE.Material) {
  const [secW, secH] = EXTRUSION_SERIES_SECTION_MM[series];
  const hw = secW / 2;
  const hh = secH / 2;
  const shape = new THREE.Shape();
  const c = 1.2;
  shape.moveTo(-hw + c, -hh);
  shape.lineTo(hw - c, -hh);
  shape.lineTo(hw, -hh + c);
  shape.lineTo(hw, hh - c);
  shape.lineTo(hw - c, hh);
  shape.lineTo(-hw + c, hh);
  shape.lineTo(-hw, hh - c);
  shape.lineTo(-hw, -hh + c);
  shape.closePath();

  const cols = Math.max(1, Math.round(secW / 20));
  const rows = Math.max(1, Math.round(secH / 20));
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const px = -hw + 10 + cx * 20;
      const py = -hh + 10 + cy * 20;
      const bore = new THREE.Path();
      bore.absarc(px, py, 2.5, 0, Math.PI * 2, true);
      shape.holes.push(bore);
    }
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: lengthMm, bevelEnabled: false, curveSegments: 8 });
  geo.translate(0, 0, -lengthMm / 2);
  const group = new THREE.Group();
  const main = new THREE.Mesh(geo, mat);
  main.castShadow = true;
  main.receiveShadow = true;
  group.add(main);

  // T-slot groove accent strips
  const grooveMat = new THREE.MeshStandardMaterial({ color: 0x15191d, roughness: 0.75 });
  for (let cx = 0; cx < cols; cx++) {
    const px = -hw + 10 + cx * 20;
    const gTop = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.4, lengthMm - 2), grooveMat);
    gTop.position.set(px, hh - 0.5, 0);
    group.add(gTop);
    const gBot = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.4, lengthMm - 2), grooveMat);
    gBot.position.set(px, -hh + 0.5, 0);
    group.add(gBot);
  }
  return group;
}

async function loadExternalMeshIntoGroup(
  container: THREE.Group,
  placeholder: THREE.Object3D,
  modelId: string,
  meshPath: string,
  unitScaleMm: number,
  mat: THREE.Material,
  onLoaded?: () => void,
) {
  try {
    const bundle = await readStoredModel(modelId);
    const file =
      bundle.files.find((f) => f.path === meshPath)
      ?? bundle.files.find((f) => f.path.toLowerCase().endsWith(meshPath.toLowerCase()));
    if (!file) return;

    const ab = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
    let loadedObj: THREE.Object3D | null = null;
    if (/\.stl$/i.test(file.path)) {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geo = new STLLoader().parse(ab);
      geo.computeVertexNormals();
      loadedObj = new THREE.Mesh(geo, mat);
    } else if (/\.obj$/i.test(file.path)) {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      loadedObj = new OBJLoader().parse(new TextDecoder().decode(file.data));
      loadedObj.traverse((child) => {
        if (child instanceof THREE.Mesh) child.material = mat;
      });
    } else if (/\.(?:glb|gltf)$/i.test(file.path)) {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(ab, "");
      loadedObj = gltf.scene;
    }
    if (!loadedObj) return;
    loadedObj.scale.setScalar(unitScaleMm);
    const box = new THREE.Box3().setFromObject(loadedObj);
    const center = box.getCenter(new THREE.Vector3());
    loadedObj.position.sub(center);
    container.remove(placeholder);
    container.add(loadedObj);
    onLoaded?.();
  } catch {
    // Keep wireframe approxBoundsMm fallback if IndexedDB entry is unavailable in clean workspace
  }
}

export function createPrimitivePartGroup(
  pkg: DevicePackage | undefined,
  options?: { selected?: boolean; onAsyncLoaded?: () => void },
): THREE.Group {
  const root = new THREE.Group();
  const selected = Boolean(options?.selected);

  if (!pkg?.primitive) {
    // 兼容无 primitive 描述的旧 MechanicalPart 设备包
    const m = pkg?.mechanics;
    const mat = makeMaterial("aluminum", selected);
    if (m?.kind === "part") {
      const target = m.outputs[0]?.positionMm ?? [40, 0, 0];
      const len = Math.max(24, Math.hypot(...target));
      const box = new THREE.Mesh(new THREE.BoxGeometry(Math.max(22, len), 24, 18), mat);
      box.position.set(target[0] / 2, target[1] / 2, target[2] / 2);
      root.add(box);
      const portMat = makeMaterial("brass", selected);
      for (const out of m.outputs) {
        const pin = new THREE.Mesh(new THREE.SphereGeometry(5, 14, 10), portMat);
        pin.position.set(...out.positionMm);
        root.add(pin);
      }
    } else {
      addCenteredBox(root, 40, 40, 30, mat, 0x4b5c58);
    }
    return root;
  }

  const spec: PrimitivePartSpec = pkg.primitive;
  const finish: PrimitiveFinish = spec.finish ?? (
    spec.shape === "extrusion_profile" ? "anodized_black"
      : spec.shape === "servo_motor_body" ? "anodized_black"
      : spec.shape === "spindle_cutter" ? "spindle_red"
      : spec.shape === "linear_rail_block" || spec.shape === "lead_screw" || spec.shape === "bearing_pillow" ? "steel"
      : "aluminum"
  );
  const mainMat = makeMaterial(finish, selected);
  const steelMat = makeMaterial("steel", selected);
  const darkMat = makeMaterial("anodized_black", selected);
  const brassMat = makeMaterial("brass", selected);

  switch (spec.shape) {
    case "box": {
      addCenteredBox(root, spec.widthMm, spec.depthMm, spec.heightMm, mainMat, 0x384844);
      break;
    }
    case "cylinder": {
      const geo = new THREE.CylinderGeometry(spec.radiusMm, spec.radiusMm, spec.lengthMm, 28);
      geo.rotateX(Math.PI / 2);
      const holder = new THREE.Group();
      holder.quaternion.copy(axisQuaternion(spec.axis));
      holder.add(new THREE.Mesh(geo, mainMat));
      root.add(holder);
      break;
    }
    case "tube": {
      const outer = new THREE.Shape();
      outer.absarc(0, 0, spec.outerRadiusMm, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, spec.innerRadiusMm, 0, Math.PI * 2, true);
      outer.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(outer, { depth: spec.lengthMm, bevelEnabled: false, curveSegments: 24 });
      geo.translate(0, 0, -spec.lengthMm / 2);
      const holder = new THREE.Group();
      holder.quaternion.copy(axisQuaternion(spec.axis));
      holder.add(new THREE.Mesh(geo, mainMat));
      root.add(holder);
      break;
    }
    case "plate": {
      const plateShape = buildRoundedPlateShape(spec.widthMm, spec.depthMm, spec.cornerRadiusMm ?? 4);
      const holeR = (spec.holeDiameterMm ?? 6) / 2;
      const inset = spec.holeInsetMm ?? 12;
      if (spec.widthMm > inset * 2 + holeR * 2 && spec.depthMm > inset * 2 + holeR * 2) {
        const hx = spec.widthMm / 2 - inset;
        const hy = spec.depthMm / 2 - inset;
        for (const [cx, cy] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
          const bore = new THREE.Path();
          bore.absarc(cx, cy, holeR, 0, Math.PI * 2, true);
          plateShape.holes.push(bore);
        }
      }
      const geo = new THREE.ExtrudeGeometry(plateShape, { depth: spec.thicknessMm, bevelEnabled: false, curveSegments: 16 });
      geo.translate(0, 0, -spec.thicknessMm / 2);
      const mesh = new THREE.Mesh(geo, mainMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      break;
    }
    case "angle_bracket": {
      const a = spec.legAMm;
      const b = spec.legBMm;
      const t = Math.min(spec.thicknessMm, a * 0.45, b * 0.45);
      const side = new THREE.Shape();
      side.moveTo(-a / 2, -b / 2);
      side.lineTo(a / 2, -b / 2);
      side.lineTo(a / 2, -b / 2 + t);
      side.lineTo(-a / 2 + t, b / 2);
      side.lineTo(-a / 2, b / 2);
      side.closePath();
      const geo = new THREE.ExtrudeGeometry(side, { depth: spec.widthMm, bevelEnabled: false });
      geo.translate(0, 0, -spec.widthMm / 2);
      // Side profile drawn in X-Y; rotate so extruded depth runs along world X and profile lies in Y-Z
      geo.applyMatrix4(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, 0, 0),
        ),
      );
      const mesh = new THREE.Mesh(geo, mainMat);
      mesh.castShadow = true;
      root.add(mesh);
      break;
    }
    case "extrusion_profile": {
      const holder = new THREE.Group();
      holder.quaternion.copy(axisQuaternion(spec.axis));
      holder.add(buildSlottedProfileMesh(spec.series, spec.lengthMm, mainMat));
      root.add(holder);
      break;
    }
    case "linear_rail_block": {
      if (spec.axis === "z") {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(spec.railWidthMm, spec.heightMm * 0.48, spec.railLengthMm), steelMat);
        rail.position.set(0, spec.heightMm * 0.24, 0);
        root.add(rail);
        const block = new THREE.Mesh(new THREE.BoxGeometry(spec.blockWidthMm, spec.heightMm * 0.62, spec.blockLengthMm), darkMat);
        block.position.set(0, -spec.heightMm * 0.16, 0);
        root.add(block);
      } else if (spec.axis === "y") {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(spec.railWidthMm, spec.railLengthMm, spec.heightMm * 0.48), steelMat);
        rail.position.set(0, 0, -spec.heightMm * 0.24);
        root.add(rail);
        const block = new THREE.Mesh(new THREE.BoxGeometry(spec.blockWidthMm, spec.blockLengthMm, spec.heightMm * 0.62), darkMat);
        block.position.set(0, 0, spec.heightMm * 0.16);
        root.add(block);
      } else {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(spec.railLengthMm, spec.railWidthMm, spec.heightMm * 0.48), steelMat);
        rail.position.set(0, 0, -spec.heightMm * 0.24);
        root.add(rail);
        const block = new THREE.Mesh(new THREE.BoxGeometry(spec.blockLengthMm, spec.blockWidthMm, spec.heightMm * 0.62), darkMat);
        block.position.set(0, 0, spec.heightMm * 0.16);
        root.add(block);
      }
      break;
    }
    case "lead_screw": {
      const holder = new THREE.Group();
      holder.quaternion.copy(axisQuaternion(spec.axis));
      const coreR = spec.diameterMm * 0.42;
      const coreGeo = new THREE.CylinderGeometry(coreR, coreR, spec.lengthMm, 20);
      coreGeo.rotateX(Math.PI / 2);
      holder.add(new THREE.Mesh(coreGeo, mainMat));

      const nutLen = Math.max(22, spec.diameterMm * 1.8);
      const nutGeo = new THREE.CylinderGeometry(spec.diameterMm * 0.9, spec.diameterMm * 0.9, nutLen, 20);
      nutGeo.rotateX(Math.PI / 2);
      holder.add(new THREE.Mesh(nutGeo, brassMat));

      // Visible helical ridge so coupled rotation stands out immediately in 3D
      const turns = Math.min(48, Math.max(6, Math.round(spec.lengthMm / Math.max(4, spec.leadMm))));
      const pts: THREE.Vector3[] = [];
      const steps = turns * 10;
      const ridgeR = spec.diameterMm * 0.56;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const z = (t - 0.5) * (spec.lengthMm - 8);
        const angle = t * turns * Math.PI * 2;
        pts.push(new THREE.Vector3(ridgeR * Math.cos(angle), ridgeR * Math.sin(angle), z));
      }
      const helixGeo = new THREE.BufferGeometry().setFromPoints(pts);
      holder.add(new THREE.Line(helixGeo, new THREE.LineBasicMaterial({ color: 0x3b484d })));
      root.add(holder);
      break;
    }
    case "servo_motor_body": {
      const holder = new THREE.Group();
      holder.quaternion.copy(axisQuaternion(spec.axis));
      const body = new THREE.Mesh(new THREE.BoxGeometry(spec.flangeMm, spec.flangeMm, spec.bodyLengthMm), mainMat);
      body.castShadow = true;
      holder.add(body);
      const flange = new THREE.Mesh(new THREE.BoxGeometry(spec.flangeMm + 2, spec.flangeMm + 2, 6), steelMat);
      flange.position.set(0, 0, spec.bodyLengthMm / 2 - 3);
      holder.add(flange);
      const shaftGeo = new THREE.CylinderGeometry(spec.shaftDiameterMm / 2, spec.shaftDiameterMm / 2, spec.shaftLengthMm, 20);
      shaftGeo.rotateX(Math.PI / 2);
      const shaft = new THREE.Mesh(shaftGeo, steelMat);
      shaft.position.set(0, 0, spec.bodyLengthMm / 2 + spec.shaftLengthMm / 2);
      holder.add(shaft);
      root.add(holder);
      break;
    }
    case "spindle_cutter": {
      const housingGeo = new THREE.CylinderGeometry(spec.bodyDiameterMm / 2, spec.bodyDiameterMm / 2, spec.bodyLengthMm, 28);
      housingGeo.rotateX(Math.PI / 2);
      const housing = new THREE.Mesh(housingGeo, mainMat);
      housing.castShadow = true;
      root.add(housing);

      const nutGeo = new THREE.CylinderGeometry(spec.bodyDiameterMm * 0.28, spec.bodyDiameterMm * 0.22, 16, 8);
      nutGeo.rotateX(Math.PI / 2);
      const nut = new THREE.Mesh(nutGeo, darkMat);
      nut.position.set(0, 0, -spec.bodyLengthMm / 2 - 6);
      root.add(nut);

      const cutterGeo = new THREE.CylinderGeometry(spec.toolDiameterMm / 2, spec.toolDiameterMm / 2, spec.toolStickoutMm, 18);
      cutterGeo.rotateX(Math.PI / 2);
      const cutter = new THREE.Mesh(cutterGeo, brassMat);
      cutter.position.set(0, 0, -spec.bodyLengthMm / 2 - spec.toolStickoutMm / 2);
      root.add(cutter);

      // Visual flute blade fin so spindle hinge spin is unmistakable
      const flute = new THREE.Mesh(new THREE.BoxGeometry(spec.toolDiameterMm * 1.15, 1.5, spec.toolStickoutMm * 0.8), darkMat);
      flute.position.set(0, 0, -spec.bodyLengthMm / 2 - spec.toolStickoutMm / 2);
      root.add(flute);
      break;
    }
    case "bearing_pillow": {
      addCenteredBox(root, spec.widthMm, spec.depthMm, spec.heightMm, mainMat, 0x3b4844);
      const sleeveHolder = new THREE.Group();
      sleeveHolder.quaternion.copy(axisQuaternion(spec.axis));
      const sleeveGeo = new THREE.CylinderGeometry(spec.boreDiameterMm * 0.65, spec.boreDiameterMm * 0.65, spec.widthMm + 6, 20);
      sleeveGeo.rotateX(Math.PI / 2);
      sleeveHolder.add(new THREE.Mesh(sleeveGeo, brassMat));
      root.add(sleeveHolder);
      break;
    }
    case "external_mesh": {
      const [bx, by, bz] = primitiveBoundingBoxMm(spec);
      const proxyGeo = new THREE.BoxGeometry(bx, by, bz);
      const placeholder = new THREE.LineSegments(
        new THREE.EdgesGeometry(proxyGeo),
        new THREE.LineBasicMaterial({ color: 0x5bdeb0 }),
      );
      proxyGeo.dispose();
      root.add(placeholder);
      void loadExternalMeshIntoGroup(
        root,
        placeholder,
        spec.modelId,
        spec.meshPath,
        spec.unitScaleMm,
        mainMat,
        options?.onAsyncLoaded,
      );
      break;
    }
  }

  return root;
}

export function disposeGroupResources(group: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      geometries.add(obj.geometry);
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
      else if (mat) materials.add(mat);
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}
