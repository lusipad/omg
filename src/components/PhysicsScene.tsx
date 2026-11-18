import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RotateCcw } from "lucide-react";
import type { ImportedModelInfo } from "@contracts/imported-physics";
import { Button } from "@/components/ui/button";

type Geometry = ImportedModelInfo["geometry"];
export interface SceneSample { pointM: [number, number, number]; geomPoses: ArrayLike<number> }
type Props = {
  geometry: Geometry; sample: SceneSample; trail: SceneSample[];
  title: string; pointName: string; coordinateLabel: string; unit?: "m" | "mm"; worktable?: boolean; focus?: string;
};
const trailColor = "#62d9bd", tipColor = "#ff906c";

function primitive(geom: Geometry["geoms"][number], extent: number) {
  const [x, y, z] = geom.size;
  switch (geom.kind) {
    case "box": return new THREE.BoxGeometry(x * 2, y * 2, z * 2);
    case "sphere": return new THREE.SphereGeometry(x, 28, 18);
    case "ellipsoid": return new THREE.SphereGeometry(1, 28, 18).scale(x, y, z);
    case "cylinder": return new THREE.CylinderGeometry(x, x, 2 * y, 32).rotateX(Math.PI / 2);
    case "capsule": return new THREE.CapsuleGeometry(x, 2 * y, 8, 28).rotateX(Math.PI / 2);
    case "plane": return new THREE.PlaneGeometry(x ? 2 * x : 6 * extent, y ? 2 * y : 6 * extent);
    default: throw new Error("模型包含无法绘制的几何类型");
  }
}

function createView(host: HTMLDivElement, renderer: THREE.WebGLRenderer, geometry: Geometry, title: string, worktable: boolean) {
  const scene = new THREE.Scene();
  const background = 0x121d1b;
  scene.background = new THREE.Color(background);
  scene.fog = new THREE.Fog(background, 1.4, 3.0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "block h-full w-full focus-visible:outline-offset-[-3px]";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", title);
  canvas.setAttribute("aria-description", "拖动或使用方向键旋转视角，滚轮、双指或加减键缩放，Home 键复位。");
  canvas.tabIndex = 0;
  canvas.dataset.meshes = String(geometry.meshes.length);
  canvas.dataset.visualGeoms = String(geometry.geoms.length);
  host.appendChild(canvas);

  const camera = new THREE.OrthographicCamera(-0.35, 0.35, 0.25, -0.25, 0.005, 5);
  camera.up.set(0, 0, 1);
  camera.position.set(0.55, -0.68, 0.45);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minZoom = 0.35;
  controls.maxZoom = 8;
  controls.maxPolarAngle = worktable ? Math.PI * 0.49 : Math.PI - 0.001;
  controls.target.set(0.14, 0, 0.15);
  controls.update();

  scene.add(new THREE.HemisphereLight(0xfffcf4, 0x6f827b, 1.35));
  const key = new THREE.DirectionalLight(0xfff6e4, 1.95);
  key.position.set(0.5, -0.65, 1.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -0.65, right: 0.65, top: 0.65, bottom: -0.65, near: 0.05, far: 2.5 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.00035;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc8eaff, 1.15);
  rim.position.set(-0.45, 0.7, 0.65);
  scene.add(rim);
  // Imported models supply their own floor, world placement and size.
  const extent = Math.max(geometry.extentM, 1e-6);
  const centerM = new THREE.Vector3().fromArray(geometry.centerM);
  if (!worktable) {
    scene.fog = null;
    key.position.set(1, -1.4, 2.2).multiplyScalar(extent).add(centerM);
    rim.position.set(-1.1, 1.8, 1.2).multiplyScalar(extent).add(centerM);
    key.target.position.copy(centerM); rim.target.position.copy(centerM);
    scene.add(key.target, rim.target);
    Object.assign(key.shadow.camera, { left: -2 * extent, right: 2 * extent, top: 2 * extent, bottom: -2 * extent, near: extent / 1000, far: 7 * extent });
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.normalBias = extent / 1500;
  }

  const floor = worktable ? new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0x23322e, roughness: 1 })) : null;
  const grid = worktable ? new THREE.GridHelper(2, 40, 0x637970, 0x344b42) : null;
  if (floor && grid) {
    floor.position.z = -0.001;
    floor.receiveShadow = true;
    grid.rotation.x = Math.PI / 2;
    scene.add(floor, grid);
  }
  const axes = new THREE.AxesHelper(worktable ? 0.085 : extent * 0.18);
  axes.position.z = worktable ? 0.0004 : 0;
  scene.add(axes);

  const buffers = geometry.meshes.map(({ vertices, indices }) => {
    const mesh = new THREE.BufferGeometry();
    mesh.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    mesh.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.computeVertexNormals();
    mesh.computeBoundingBox();
    return mesh;
  });
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const robot = new THREE.Group();
  const pieces = geometry.geoms.map((geom) => {
    const { meshIndex, color, alpha } = geom;
    const faceted = geom.kind === "mesh";
    const id = [...color, alpha, faceted].join(",");
    let material = materials.get(id);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace),
        roughness: 0.62, metalness: 0.12, flatShading: faceted, transparent: alpha < 1, opacity: alpha,
        side: worktable ? THREE.FrontSide : THREE.DoubleSide,
      });
      materials.set(id, material);
    }
    const buffer = geom.kind === "mesh" ? buffers[meshIndex!] : primitive(geom, extent);
    if (geom.kind !== "mesh") { buffer.computeBoundingBox(); buffers.push(buffer); }
    const piece = new THREE.Mesh(buffer, material);
    piece.castShadow = true;
    piece.receiveShadow = worktable || geom.kind === "plane";
    robot.add(piece);
    return piece;
  });
  scene.add(robot);
  const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: trailColor }));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(worktable ? 0.0037 : 1, 12, 8),
    new THREE.MeshBasicMaterial({ color: tipColor, depthTest: worktable, depthWrite: worktable }));
  if (!worktable) tip.renderOrder = 2;
  const direction = new THREE.Vector3(0.32, -1, 0.43).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right);
  const cameraBasis = new THREE.Matrix4().makeBasis(right, up, direction);
  const toCameraBasis = cameraBasis.clone().transpose();
  const motionBounds = new THREE.Box3();
  // A MuJoCo plane may be unlimited. Keep finite model geometry in frame.
  const subject = pieces.map((piece, index) => ({ piece, index })).filter(({ index }) => geometry.geoms[index].kind !== "plane");
  const fitted = subject.length ? subject : pieces.map((piece, index) => ({ piece, index }));
  scene.add(path, tip);

  let frame = 0, positioned = false, framed = false, userCamera = false;
  let aspect = 1, halfHeight = 0.25;
  function updateFrustum() {
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }
  function resetView() {
    if (!positioned) return;
    const bounds = motionBounds.clone();
    const box = new THREE.Box3(), matrix = new THREE.Matrix4();
    for (const {piece} of fitted) {
      piece.updateMatrix();
      matrix.multiplyMatrices(toCameraBasis, piece.matrix);
      bounds.union(box.copy(piece.geometry.boundingBox!).applyMatrix4(matrix));
    }
    bounds.expandByPoint(tip.position.clone().applyMatrix4(toCameraBasis));
    const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(cameraBasis);
    const size = bounds.getSize(new THREE.Vector3());
    halfHeight = Math.max(size.x / aspect, size.y, extent * (fitted.length ? 0.001 : 0.5)) * 0.54;
    const cameraDistance = worktable ? 0.85 + size.z / 2 : size.z / 2 + Math.max(halfHeight * 3, extent);
    if (!worktable) { camera.near = cameraDistance * 0.00001; camera.far = cameraDistance + Math.max(size.z, extent, halfHeight) * 8; }
    camera.zoom = 1;
    updateFrustum();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, cameraDistance);
    controls.update();
    userCamera = false;
    framed = true;
    invalidate();
  }
  function invalidate() {
    if (frame || !host.clientWidth || !host.clientHeight) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!framed && positioned) resetView();
      if (positioned) {
        if (!worktable) tip.scale.setScalar(7 * halfHeight / (Math.max(host.clientHeight, 1) * camera.zoom));
        renderer.render(scene, camera);
        canvas.dataset.ready = "true";
      }
    });
  }
  function resize() {
    if (!host.clientWidth || !host.clientHeight) return;
    const nextAspect = host.clientWidth / host.clientHeight;
    if (Math.abs(nextAspect - aspect) > 0.01 && !userCamera) framed = false;
    aspect = nextAspect;
    updateFrustum();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    invalidate();
  }
  function keyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowLeft": controls.rotateLeft(0.13); break;
      case "ArrowRight": controls.rotateLeft(-0.13); break;
      case "ArrowUp": controls.rotateUp(0.13); break;
      case "ArrowDown": controls.rotateUp(-0.13); break;
      case "+":
      case "=": controls.dollyIn(0.84); break;
      case "-": controls.dollyOut(0.84); break;
      case "Home": resetView(); break;
      default: return;
    }
    event.preventDefault();
    if (event.key !== "Home") userCamera = true;
  }
  const markCamera = () => { userCamera = true; };
  canvas.addEventListener("keydown", keyDown);
  controls.addEventListener("start", markCamera);
  controls.addEventListener("change", invalidate);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  return {
    resetView, resize,
    setPose(sample: SceneSample) {
      pieces.forEach((piece, index) => {
        piece.position.fromArray(sample.geomPoses, index * 7);
        piece.quaternion.fromArray(sample.geomPoses, index * 7 + 3);
      });
      tip.position.fromArray(sample.pointM);
      positioned = true;
      invalidate();
    },
    setTrail(trail: SceneSample[]) {
      const points = new Float32Array(trail.length * 3);
      const box = new THREE.Box3(), matrix = new THREE.Matrix4(), projected = new THREE.Matrix4();
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
      motionBounds.makeEmpty();
      trail.forEach(({ pointM, geomPoses }, index) => {
        points.set(pointM, index * 3);
        fitted.forEach(({piece, index: slot}) => {
          position.fromArray(geomPoses, slot * 7);
          rotation.fromArray(geomPoses, slot * 7 + 3);
          matrix.compose(position, rotation, scale);
          projected.multiplyMatrices(toCameraBasis, matrix);
          motionBounds.union(box.copy(piece.geometry.boundingBox!).applyMatrix4(projected));
        });
        motionBounds.expandByPoint(position.fromArray(pointM).applyMatrix4(toCameraBasis));
      });
      path.geometry.dispose();
      path.geometry = new THREE.BufferGeometry();
      path.geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
      path.geometry.computeBoundingBox();
      if (!userCamera) framed = false;
      invalidate();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("start", markCamera);
      controls.removeEventListener("change", invalidate);
      controls.dispose();
      canvas.removeEventListener("keydown", keyDown);
      for (const buffer of buffers) buffer.dispose();
      for (const material of materials.values()) material.dispose();
      grid?.dispose(); axes.dispose();
      floor?.geometry.dispose(); floor?.material.dispose();
      path.geometry.dispose(); path.material.dispose();
      tip.geometry.dispose(); tip.material.dispose();
      key.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

const coordinates = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
function coordinate(metres: number, unit: "m" | "mm") {
  if (unit === "m") return String(Number(metres.toPrecision(6)));
  const value = metres * 1000;
  return coordinates.format(Math.abs(value) < 0.005 ? 0 : value);
}
function Projection({ trail, sample, side, unit, pointName, minimumSpan }: {
  trail: SceneSample[]; sample: SceneSample; side: boolean; unit: "m" | "mm"; pointName: string; minimumSpan: number;
}) {
  const axis = side ? 2 : 1, title = side ? "XZ 侧视" : "XY 俯视";
  const chart = useMemo(() => {
    const points = trail.map(({ pointM }) => [pointM[0], pointM[axis]]);
    const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
    const xmin = points.length ? Math.min(...xs) : 0, xmax = points.length ? Math.max(...xs) : 0;
    const ymin = points.length ? Math.min(...ys) : 0, ymax = points.length ? Math.max(...ys) : 0;
    const scale = Math.min(225 / Math.max(minimumSpan, xmax - xmin), 110 / Math.max(minimumSpan, ymax - ymin));
    const x = (value: number) => 166 + (value - (xmin + xmax) / 2) * scale;
    const y = (value: number) => 78 - (value - (ymin + ymax) / 2) * scale;
    return { x, y, path: points.map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(2)},${y(b).toFixed(2)}`).join(" "),
      x0: (xmin + xmax) / 2 - 125 / scale, x1: (xmin + xmax) / 2 + 125 / scale,
      y0: (ymin + ymax) / 2 - 65 / scale, y1: (ymin + ymax) / 2 + 65 / scale };
  }, [axis, trail, minimumSpan]);
  return <figure className="min-w-0">
    <figcaption className="text-xs text-muted-foreground">{title} · {unit}</figcaption>
    <svg viewBox="0 0 300 163" role="img" aria-label={`${pointName}轨迹 ${title}投影`} className="mt-1 block w-full">
      <rect x="41" y="13" width="250" height="130" fill="#101916" stroke="#42564d" />
      <path d="M41 78H291 M166 13V143" fill="none" stroke="#2b3b33" strokeDasharray="3 4" />
      <path d={chart.path} fill="none" stroke={trailColor} strokeWidth="2" />
      <circle cx={chart.x(sample.pointM[0])} cy={chart.y(sample.pointM[axis])} r="4" fill={tipColor} />
      <g fill="#9cafa4" fontSize="10">
        <text x="36" y="20" textAnchor="end">{coordinate(chart.y1, unit)}</text>
        <text x="36" y="142" textAnchor="end">{coordinate(chart.y0, unit)}</text>
        <text x="41" y="158">{coordinate(chart.x0, unit)}</text>
        <text x="291" y="158" textAnchor="end">{coordinate(chart.x1, unit)}</text>
      </g>
    </svg>
  </figure>;
}

export default function PhysicsScene({ geometry, sample, trail, title, pointName, coordinateLabel, unit = "m", worktable = false, focus }: Props) {
  const view = useRef<ReturnType<typeof createView> | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const mount = useCallback((parent: HTMLDivElement | null) => {
    if (!parent) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setUnavailable(true);
      return;
    }
    const current = createView(parent, renderer, geometry, title, worktable);
    view.current = current;
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); };
    const restored = () => { setUnavailable(false); current.resize(); };
    const canvas = renderer.domElement;
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    setUnavailable(false);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      view.current = null;
      current.dispose();
    };
  }, [geometry, title, worktable]);
  useEffect(() => { view.current?.setTrail(trail); }, [geometry, trail]);
  useEffect(() => { view.current?.setPose(sample); }, [geometry, sample]);
  useEffect(() => { if (focus) view.current?.resetView(); }, [geometry, focus]);

  return <figure className="min-w-0 overflow-hidden rounded-md border bg-background">
    <div className={unavailable ? "hidden" : "relative"}>
      <div ref={mount} className="h-[320px] w-full sm:h-[385px] lg:h-[420px]" />
      <Button size="sm" variant="outline" className="absolute right-3 top-3 bg-background/90" onClick={() => view.current?.resetView()}><RotateCcw />复位视角</Button>
      <span className="pointer-events-none absolute bottom-2 left-3 rounded bg-background/75 px-2 py-1 text-[10px] text-muted-foreground">{worktable ? "Z 向上 · 地面每格 50 mm" : "世界坐标 · Z 向上"}</span>
    </div>
    {unavailable && <div className="p-4">
      <p className="mb-3 text-sm">WebGL 不可用，显示{pointName}轨迹的世界坐标投影。</p>
      <div className="grid gap-3 sm:grid-cols-2">{[false, true].map((side) =>
        <Projection key={String(side)} trail={trail.length ? trail : [sample]} sample={sample} side={side} unit={unit} pointName={pointName}
          minimumSpan={worktable ? 0.02 : Math.max(1e-9, geometry.extentM * 0.03)} />)}</div>
    </div>}
    <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-2"><i className="h-0.5 w-4" style={{ backgroundColor: trailColor }} />{pointName}轨迹 <i className="ml-1 h-2 w-2 rounded-full" style={{ backgroundColor: tipColor }} />当前{pointName}</span>
      <output aria-label={coordinateLabel} aria-live="off" className="mono text-foreground/85">
        X {coordinate(sample.pointM[0], unit)} · Y {coordinate(sample.pointM[1], unit)} · Z {coordinate(sample.pointM[2], unit)} {unit}
      </output>
    </figcaption>
  </figure>;
}
