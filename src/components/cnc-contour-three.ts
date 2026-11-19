import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM, type MiloStockState } from "@contracts/milo-stock";
import type { CncContourSample } from "@/lib/cnc-contour-runtime";
import { commandColor, feedbackColor, traceBounds, type ContourFocus } from "@/lib/cnc-contour-display";
import { createMiloStockMesh } from "./milo-stock-geometry";

function trace(samples: readonly CncContourSample[], field: "commandMm" | "actualMm") {
  const vertices = new Float32Array(samples.length * 3);
  samples.forEach((sample, index) => vertices.set(sample[field], index * 3));
  const geometry = new LineGeometry().setPositions(vertices);
  const command = field === "commandMm";
  const material = new LineMaterial({ color: command ? commandColor : feedbackColor, dashed: command, dashSize: 1.2, gapSize: .85,
    depthTest: false, depthWrite: false });
  material.linewidth = command ? 1.65 : 2.6;
  const line = new Line2(geometry, material);
  if (command) line.computeLineDistances();
  line.renderOrder = command ? 6 : 5;
  return line;
}

function flatCutter() {
  const tool = new THREE.Group(), radius = MILO_TOOL_DIAMETER_MM / 2;
  const shaft = new THREE.MeshStandardMaterial({ color: 0xced7d5, metalness: .62, roughness: .32 });
  const cutting = new THREE.MeshStandardMaterial({ color: 0xcc9c57, metalness: .55, roughness: .36 });
  function cylinder(r: number, length: number, startZ: number, material: THREE.Material) {
    const geometry = new THREE.CylinderGeometry(r, r, length, 32).rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = startZ + length / 2;
    tool.add(mesh);
  }
  cylinder(radius, 6.5, 0, cutting);
  cylinder(radius * .88, 9.5, 6.5, shaft);
  for (let i = 0; i < 3; i++) {
    const points = Array.from({ length: 21 }, (_, j) => {
      const f = j / 20, angle = i * 2 * Math.PI / 3 + f * 1.9;
      return new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), .35 + 6.0 * f);
    });
    const groove = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, .17, 5, false), shaft);
    tool.add(groove);
  }
  return tool;
}

export function createContourScene(host: HTMLDivElement, samples: readonly CncContourSample[], failed: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0; canvas.className = "block h-full w-full touch-none";
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "工件坐标系三维指令与反馈刀尖轨迹");
  host.append(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14221f);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; controls.minZoom = .35; controls.maxZoom = 28;
  const { widthMm: width, heightMm: height, thicknessMm: thickness } = MILO_STOCK;
  const stock = createMiloStockMesh();
  const command = trace(samples, "commandMm"), actual = trace(samples, "actualMm");
  const cutter = flatCutter();
  const feedback = new THREE.Mesh(new THREE.SphereGeometry(.65, 14, 10), new THREE.MeshBasicMaterial({ color: feedbackColor, depthTest: false }));
  const desired = new THREE.Mesh(new THREE.RingGeometry(.82, 1.13, 24), new THREE.MeshBasicMaterial({ color: commandColor, depthTest: false, side: THREE.DoubleSide }));
  feedback.renderOrder = 8; desired.renderOrder = 9;
  const gapVertices = new THREE.BufferAttribute(new Float32Array(6), 3);
  const gap = new THREE.Line(new THREE.BufferGeometry().setAttribute("position", gapVertices), new THREE.LineBasicMaterial({ color: 0xffead3, depthTest: false }));
  gap.frustumCulled = false; gap.renderOrder = 7;
  const grid = new THREE.GridHelper(140, 28, 0x3b554b, 0x283c34);
  grid.rotation.x = Math.PI / 2; grid.position.set(width / 2, height / 2, -thickness - .12);
  const axes = new THREE.AxesHelper(7); axes.position.set(0, 0, .05);
  scene.add(stock.mesh, command, actual, cutter, feedback, desired, gap, grid, axes, new THREE.HemisphereLight(0xe2fff2, 0x677871, 2.0));
  for (const [x, y, z, intensity] of [[-50, -70, 115, 2.45], [120, 100, 65, 1.15]]) {
    const lamp = new THREE.DirectionalLight(0xfff3dc, intensity); lamp.position.set(x, y, z); scene.add(lamp);
  }
  const direction = new THREE.Vector3(.58, -1.2, 1.05).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize(), up = new THREE.Vector3().crossVectors(direction, right);
  const centre = new THREE.Vector3(), size = new THREE.Vector3();
  let span = 1;
  let disposed = false, raf = 0;
  function render() {
    if (disposed) return;
    desired.quaternion.copy(camera.quaternion);
    renderer.render(scene, camera);
  }
  function schedule() {
    if (!disposed && !raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }
  function reset() {
    controls.target.copy(centre); camera.position.copy(centre).addScaledVector(direction, span * 3);
    camera.zoom = 1; camera.far = span * 18; camera.lookAt(centre); camera.updateProjectionMatrix(); controls.update(); schedule();
  }
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const aspect = w / h;
    const extent = (v: THREE.Vector3) => Math.abs(v.x) * size.x + Math.abs(v.y) * size.y + Math.abs(v.z) * size.z;
    const half = .53 * Math.max(extent(up), extent(right) / aspect);
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix(); renderer.setSize(w, h, false); schedule();
  };
  controls.addEventListener("change", schedule);
  const observer = new ResizeObserver(resize); observer.observe(host);
  function lost(event: Event) { event.preventDefault(); failed(); }
  function keyDown(event: KeyboardEvent) { if (event.key === "Home") { event.preventDefault(); reset(); } }
  canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("keydown", keyDown);
  function focus(mode: ContourFocus) {
    const b = traceBounds(samples, mode);
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    box.getCenter(centre); box.getSize(size); span = Math.max(size.x, size.y, size.z);
    reset(); resize();
  }
  return {
    reset, focus,
    update(index: number, frame: MiloStockState, all: boolean, showCommand: boolean, showFeedback: boolean) {
      const s = samples[index];
      stock.update(frame); cutter.position.fromArray(s.actualMm); feedback.position.copy(cutter.position); desired.position.fromArray(s.commandMm);
      command.visible = desired.visible = showCommand; actual.visible = feedback.visible = showFeedback; gap.visible = showCommand && showFeedback;
      command.geometry.instanceCount = actual.geometry.instanceCount = all ? samples.length - 1 : index;
      gapVertices.setXYZ(0, ...s.commandMm); gapVertices.setXYZ(1, ...s.actualMm); gapVertices.needsUpdate = true;
      schedule();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect(); controls.dispose();
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("keydown", keyDown);
      const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          geometry.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
        }
      });
      for (const g of geometry) g.dispose(); for (const m of materials) m.dispose();
      renderer.dispose(); canvas.remove();
    },
  };
}
