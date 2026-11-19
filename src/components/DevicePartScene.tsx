import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RotateCcw } from "lucide-react";
import type { CompositionShape, DevicePart } from "@contracts/device-composition";
import type { DevicePackage } from "@contracts/twin-device";
import { Button } from "./ui/button";
import { makePartMesh } from "./device-part-geometry";

type Slot = { id: string; label: string; quantity: number; total?: string; shape?: CompositionShape; missing: boolean };
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));
function mountScene(host: HTMLDivElement, renderer: THREE.WebGLRenderer, slots: Slot[], choose: (id: string) => void) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-4, 4, 3, -3, .03, 180);
  scene.background = new THREE.Color(0x172421);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "本层三维分解图");
  canvas.setAttribute("aria-description", "点选模型或槽位标签进入子件。拖动或使用方向键旋转，滚轮与双指缩放，Home 复位。");
  canvas.className = "block h-full w-full touch-none rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
  host.append(canvas);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false; controls.minZoom = .55; controls.maxZoom = 3; controls.maxPolarAngle = Math.PI * .47;
  const look = new THREE.Vector3(0, .45, 0);
  function reset() { controls.target.copy(look); camera.position.set(3.9, 5, 7); camera.zoom = 1; camera.lookAt(look); camera.updateProjectionMatrix(); controls.update(); }
  reset();
  scene.add(new THREE.HemisphereLight(0xedffff, 0x637669, 1.7));
  for (const [x, y, z, power] of [[-3, 6, 4, 2.0], [4, 3, -4, 2.1]]) {
    const light = new THREE.DirectionalLight(0xe9f6e8, power); light.position.set(x, y, z); scene.add(light);
  }
  const grid = new THREE.GridHelper(48, 48, 0x3d5349, 0x263b32); grid.position.y = -.105; scene.add(grid);
  const templates = new Map<string, THREE.Group>();
  const objects = slots.map(slot => {
    const kind = slot.shape ?? "";
    if (!templates.has(kind)) templates.set(kind, makePartMesh(slot.shape));
    const object = templates.get(kind)!.clone();
    object.userData.slot = slot.id;
    scene.add(object);
    const label = document.createElement("button");
    label.type = "button";
    label.textContent = slot.label + " ×" + slot.quantity + (slot.total ? " · 共" + slot.total : "");
    label.title = `${slot.label}（${slot.id}）${slot.missing ? " · 缺少修订" : !slot.shape ? " · 外形待补" : ""}`;
    label.setAttribute("aria-label", `三维中查看 ${slot.label}（${slot.id}）`);
    label.setAttribute("aria-description", `每套 ${slot.quantity} 件${slot.total ? "，此路径累计 " + slot.total + " 件" : ""}`);
    label.className = "absolute z-[1] max-w-40 truncate rounded border border-[#537263] bg-[#16251f]/95 px-1.5 py-0.5 text-[11px] font-medium text-[#e7f2e9] hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
    label.onclick = () => choose(slot.id); host.append(label);
    return { object, label };
  });
  const rays = new Float32Array(slots.length * 6);
  const leaders = new THREE.BufferGeometry(); leaders.setAttribute("position", new THREE.BufferAttribute(rays, 3));
  const guides = new THREE.LineSegments(leaders, new THREE.LineBasicMaterial({ color: 0x587969 })); scene.add(guides);
  let width = 0, height = 0, cols = 1, rows = 1, spread = 65;
  function place() {
    const spacing = 1.15 + 2.05 * spread / 100;
    objects.forEach(({ object }, i) => {
      const row = Math.floor(i / cols), n = Math.min(cols, slots.length - row * cols);
      const x = i % cols - (n - 1) / 2, z = row - (rows - 1) / 2;
      object.position.set(x * spacing, 0, z * spacing);
      rays.set([x * .55, -.07, z * .55, object.position.x, -.07, object.position.z], i * 6);
    });
    leaders.attributes.position.needsUpdate = true; leaders.computeBoundingSphere();
  }
  const projected = new THREE.Vector3();
  function paint() {
    if (!width || !height) return;
    renderer.render(scene, camera);
    const used: { x: number; y: number; w: number; h: number }[] = [];
    for (const { object, label } of objects) {
      projected.copy(object.position).project(camera);
      const anchorX = (projected.x + 1) * width / 2, anchorY = (1 - projected.y) * height / 2 + 4;
      const w = label.offsetWidth, h = label.offsetHeight, x = clamp(anchorX - w / 2, 2, width - w - 2);
      let y = clamp(anchorY, 2, height - h - 2);
      for (const delta of [0, 1, -1, 2, -2, 3, -3]) {
        const candidate = clamp(anchorY + delta * (h + 3), 2, height - h - 2);
        if (!used.some(b => x < b.x + b.w + 2 && b.x < x + w + 2 && candidate < b.y + b.h + 2 && b.y < candidate + h + 2)) { y = candidate; break; }
      }
      used.push({ x, y, w, h }); label.style.left = `${x}px`; label.style.top = `${y}px`;
    }
  }
  function resize() {
    width = host.clientWidth; height = host.clientHeight;
    if (!width || !height) return;
    cols = Math.min(slots.length, width < 430 ? 2 : width < 700 ? 3 : 4); rows = Math.ceil(slots.length / cols);
    place();
    // Frame the fully separated layout once per viewport. Moving the slider leaves that scale fixed.
    const halfX = 1.6 * (cols - 1) + 1, halfZ = 1.6 * (rows - 1) + 1;
    const view = new THREE.OrthographicCamera(); view.position.set(3.9, 5, 7); view.lookAt(look); view.updateMatrixWorld();
    let extentX = 0, extentY = 0;
    for (const x of [-halfX, halfX]) for (const y of [0, 1.65]) for (const z of [-halfZ, halfZ]) {
      projected.set(x, y, z).applyMatrix4(view.matrixWorldInverse);
      extentX = Math.max(extentX, Math.abs(projected.x)); extentY = Math.max(extentY, Math.abs(projected.y));
    }
    const aspect = width / height, halfH = 1.10 * Math.max(extentY, extentX / aspect, 1.5);
    camera.top = halfH; camera.bottom = -halfH; camera.left = -halfH * aspect; camera.right = -camera.left;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    objects.forEach(({ label }) => { label.style.maxWidth = Math.min(144, width / Math.min(cols, 4) - 6) + "px"; });
    paint();
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  const picker = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let pressed: { x: number; y: number; id: number } | null = null;
  function down(e: PointerEvent) { pressed = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; }
  function up(e: PointerEvent) {
    const start = pressed; pressed = null;
    if (!start || start.id !== e.pointerId || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return;
    const rect = canvas.getBoundingClientRect(); pointer.set(2 * (e.clientX - rect.left) / rect.width - 1, 1 - 2 * (e.clientY - rect.top) / rect.height);
    picker.setFromCamera(pointer, camera); picker.params.Line.threshold = .08;
    const hit = picker.intersectObjects(objects.map(o => o.object), true)[0];
    let picked: THREE.Object3D | null = hit?.object ?? null;
    while (picked && !picked.userData.slot) picked = picked.parent;
    if (picked) choose(String(picked.userData.slot));
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === "Home") { e.preventDefault(); reset(); paint(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const orbit = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") orbit.theta += (e.key === "ArrowLeft" ? -1 : 1) * Math.PI / 18;
    else orbit.phi = clamp(orbit.phi + (e.key === "ArrowUp" ? -.12 : .12), .12, controls.maxPolarAngle);
    camera.position.setFromSpherical(orbit).add(controls.target); controls.update(); paint();
  }
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointerup", up); canvas.addEventListener("keydown", keydown);
  controls.addEventListener("change", paint); resize();
  return {
    setSpread(value: number) { spread = value; place(); paint(); },
    reset() { reset(); paint(); },
    dispose() {
      observer.disconnect(); controls.removeEventListener("change", paint); controls.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("keydown", keydown);
      const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(obj => {
        if (!(obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments)) return;
        geometry.add(obj.geometry);
        for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) materials.add(mat);
      });
      geometry.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
      objects.forEach(({ label }) => label.remove()); canvas.remove(); renderer.dispose(); renderer.forceContextLoss();
    },
  };
}

export default function DevicePartScene({ parts, installed, parentQuantity, onChoose, onFallback }: {
  parts: readonly DevicePart[]; installed: ReadonlyMap<string, DevicePackage>; parentQuantity: bigint; onChoose: (id: string) => void; onFallback: () => void;
}) {
  const host = useRef<HTMLDivElement>(null), scene = useRef<ReturnType<typeof mountScene> | null>(null);
  const [spread, setSpread] = useState(65);
  const slots = useMemo(() => parts.map(part => {
    const pkg = installed.get(part.packageKey);
    return { id: part.id, label: part.label, quantity: part.quantity, total: parentQuantity === 1n ? undefined : String(parentQuantity * BigInt(part.quantity)),
      shape: pkg?.composition?.shape, missing: !pkg };
  }), [parts, installed, parentQuantity]);
  const callbacks = useRef({ onChoose, onFallback });
  useEffect(() => { callbacks.current = { onChoose, onFallback }; }, [onChoose, onFallback]);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" }); }
    catch { callbacks.current.onFallback(); return; }
    const view = mountScene(parent, renderer, slots, id => callbacks.current.onChoose(id));
    scene.current = view;
    const lost = (e: Event) => { e.preventDefault(); callbacks.current.onFallback(); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => { renderer.domElement.removeEventListener("webglcontextlost", lost); scene.current = null; view.dispose(); };
  }, [slots]);
  useEffect(() => { scene.current?.setSpread(spread); }, [spread, slots]);
  return <div className="min-w-0">
    <div ref={host} aria-label="三维槽位示意" className="relative h-64 min-w-0 overflow-hidden bg-[#172421] sm:h-72" />
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t px-2 py-1.5 text-xs">
      <label className="flex min-w-[min(100%,10rem)] flex-1 items-center gap-2"><span className="shrink-0">分离程度</span>
        <input className="h-5 min-w-0 flex-1 accent-primary" type="range" min={0} max={100} step={1} value={spread} onChange={e => setSpread(e.currentTarget.valueAsNumber)} />
        <output className="mono w-9 text-right text-muted-foreground">{spread}%</output>
      </label>
      <Button size="sm" variant="ghost" type="button" onClick={() => scene.current?.reset()}><RotateCcw />复位视角</Button>
    </div>
    <p className="px-3 pb-2 text-[11px] text-muted-foreground">点选部件或槽位标签继续拆解。每个槽位显示一件代表件，线框表示外形待补。</p>
  </div>;
}
