import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { miloSegmentFractionAtTime, type MiloMotionSample } from "@contracts/milo-motion";
import { MILO_STOCK, type MiloStockState } from "@contracts/milo-stock";
import { createMiloMachine3D } from "./milo-machine-3d";
import { createMiloStockMesh } from "./milo-stock-geometry";
import type { MiloSpatialPath } from "./milo-plot";

export type MiloCameraView = "workpiece" | "machine";

// 用可见表面的支持值拟合透视视锥，两侧约束 r±tan(fov/2)d 也考虑顶点深度。
function homeCamera(focus: MiloCameraView, camera: THREE.PerspectiveCamera, group: THREE.Group,
  stock: THREE.Object3D, marker: THREE.Object3D, path: MiloSpatialPath, sample: MiloMotionSample) {
  const work = focus === "workpiece";
  const backward = (work ? new THREE.Vector3(0.72, -1.15, 0.88) : new THREE.Vector3(0.82, -1.18, 0.71)).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, backward).normalize();
  const up = new THREE.Vector3().crossVectors(backward, right);
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (work ? 0.89 : 0.84), h = v * camera.aspect;
  const directions = [
    right.clone().addScaledVector(backward, h), right.clone().negate().addScaledVector(backward, h),
    up.clone().addScaledVector(backward, v), up.clone().negate().addScaledVector(backward, v), backward, backward.clone().negate(),
  ];
  const max = directions.map(() => -Infinity);
  const point = new THREE.Vector3();
  if (work) {
    for (const x of [0, MILO_STOCK.widthMm]) for (const y of [0, MILO_STOCK.heightMm]) for (const z of [-MILO_STOCK.thicknessMm, 0]) {
      point.set(x, y, z);
      directions.forEach((d, i) => { max[i] = Math.max(max[i], d.dot(point)); });
    }
    const tool = group.getObjectByName("end-mill");
    if (tool) {
      tool.updateWorldMatrix(true, true);
      const toolBox = new THREE.Box3().setFromObject(tool), shank = toolBox.max.z - sample.positionMm[2];
      const cap = directions.map(d => 0.5 * (toolBox.max.x - toolBox.min.x) * Math.hypot(d.x, d.y) + Math.max(0, d.z) * shank);
      for (const [x, y, z] of path.vertices) {
        if (x < 0 || y < 0 || x > MILO_STOCK.widthMm || y > MILO_STOCK.heightMm || z < -MILO_STOCK.thicknessMm) continue;
        point.set(x, y, z);
        directions.forEach((d, i) => { max[i] = Math.max(max[i], d.dot(point) + cap[i]); });
      }
    }
  } else {
    const table = group.getObjectByName("xy-table"), saddle = group.getObjectByName("y-saddle"), head = group.getObjectByName("z-head");
    const stationary = directions.map(() => 0);
    const [sx,sy,sz] = sample.positionMm;
    const padY = directions.map(d => Math.max(d.y * (sy - path.min[1]), d.y * (sy - path.max[1])));
    const padZ = directions.map(d => Math.max(d.z * (path.min[2] - sz), d.z * (path.max[2] - sz)));
    const padXY = directions.map(d => {
      let largest = 0;
      for (const [x, y] of path.vertices) largest = Math.max(largest, d.x * (sx - x) + d.y * (sy - y));
      return largest;
    });
    const instance = new THREE.Matrix4(), world = new THREE.Matrix4();
    group.updateMatrixWorld(true);
    group.traverseVisible((mesh) => {
      if (!(mesh instanceof THREE.Mesh) || mesh === marker) return;
      const geometry = mesh.geometry, position = geometry.getAttribute("position");
      if (!position?.count) return;
      let pad = stationary;
      for (let parent: THREE.Object3D | null = mesh; parent !== null; parent = parent.parent) {
        if (parent === table) { pad = padXY; break; }
        if (parent === saddle) { pad = padY; break; }
        if (parent === head) { pad = padZ; break; }
      }
      function include() {
        for (let i = 0; i < directions.length; i++) max[i] = Math.max(max[i], directions[i].dot(point) + pad[i]);
      }
      if (mesh === stock) {
        for (const x of [0, MILO_STOCK.widthMm]) for (const y of [0, MILO_STOCK.heightMm]) for (const z of [-MILO_STOCK.thicknessMm, 0]) {
          point.set(x,y,z).applyMatrix4(mesh.matrixWorld); include();
        }
        return;
      }
      const count = mesh instanceof THREE.InstancedMesh ? mesh.count : 1;
      for (let i = 0; i < count; i++) {
        world.copy(mesh.matrixWorld);
        if (mesh instanceof THREE.InstancedMesh) { mesh.getMatrixAt(i, instance); world.multiply(instance); }
        for (let vertex = 0; vertex < position.count; vertex++) { point.fromBufferAttribute(position, vertex).applyMatrix4(world); include(); }
      }
    });
  }
  const depth = (max[4] - max[5]) / 2;
  const target = right.multiplyScalar((max[0] - max[1]) / 2).addScaledVector(up, (max[2] - max[3]) / 2).addScaledVector(backward, depth);
  const cameraDepth = Math.max((max[0] + max[1]) / (2*h), (max[2] + max[3]) / (2*v), max[4] + 1);
  return { target, position: target.clone().addScaledVector(backward, cameraDepth - depth) };
}

function createTrace(path: MiloSpatialPath) {
  const group = new THREE.Group();
  const data = new Float32Array(path.vertices.length * 3);
  path.vertices.forEach((point, i) => data.set(point, 3 * i));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data, 3));
  const planned = new THREE.Line(geometry, new THREE.LineDashedMaterial({
    color: 0xa4bbd0, dashSize: 1.2, gapSize: 0.85, transparent: true, opacity: 0.50, depthTest: false, depthWrite: false,
  }));
  planned.computeLineDistances();
  const completedGeometry = new THREE.BufferGeometry().setAttribute("position", geometry.getAttribute("position"));
  completedGeometry.setDrawRange(0, 0);
  const travelledMaterial = new THREE.LineBasicMaterial({ color: 0xffd18d, depthTest: false, depthWrite: false });
  const completed = new THREE.Line(completedGeometry, travelledMaterial);
  const endPositions = new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
  const endGeometry = new THREE.BufferGeometry().setAttribute("position", endPositions);
  const end = new THREE.Line(endGeometry, travelledMaterial);
  end.frustumCulled = false;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff875f, depthTest: false, depthWrite: false }));
  // 刀路作为可关闭的叠加层，未加工到的低层路径也能检查。
  planned.renderOrder = 1; completed.renderOrder = 2; end.renderOrder = 2; marker.renderOrder = 3;
  group.add(planned, completed, end, marker);
  return {
    group, marker,
    update(sample: MiloMotionSample) {
      let last = 0;
      const span = sample.line === null ? undefined : path.spans.get(sample.line);
      if (span) {
        const fraction = miloSegmentFractionAtTime(span.segment, sample.timeS);
        const ahead = span.fractions.findIndex((value) => value > fraction);
        last = span.first + (ahead < 0 ? span.fractions.length - 1 : Math.max(0, ahead - 1));
      }
      completedGeometry.setDrawRange(0, last + 1);
      endPositions.setXYZ(0, ...path.vertices[last]); endPositions.setXYZ(1, ...sample.positionMm);
      endPositions.needsUpdate = true;
      marker.position.fromArray(sample.positionMm);
    },
    dispose() {
      geometry.dispose(); completedGeometry.dispose(); endGeometry.dispose();
      planned.material.dispose(); travelledMaterial.dispose(); marker.geometry.dispose(); marker.material.dispose();
    },
  };
}

export function createMiloThreeView(host: HTMLDivElement, path: MiloSpatialPath, onUnavailable: (message: string) => void) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, powerPreference: "high-performance" });
  if (!gl) throw new Error("浏览器未能建立 WebGL 2 图形上下文。");
  const release: (() => void)[] = [];
  let disposed = false, lost = false, raf = 0;
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    for (const clean of release.reverse()) clean();
    canvas.remove();
  }
  function failed(message: string) {
    if (disposed || lost) return;
    lost = true;
    cancelAnimationFrame(raf);
    canvas.dataset.ready = "false";
    onUnavailable(message);
  }
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
    release.push(() => { renderer.dispose(); if (!gl.isContextLost()) renderer.forceContextLoss(); });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    canvas.className = "block h-full w-full touch-none focus-visible:outline-offset-[-3px]";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Milo 三维加工场景");
    canvas.setAttribute("aria-description", "拖动旋转，滚轮缩放，右键拖动平移。方向键旋转，配合 Shift 平移，加减键缩放，Home 复位。");
    canvas.dataset.ready = "false";
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121c19);
    if (renderer.extensions.has("EXT_color_buffer_float")) {
      const room = new RoomEnvironment(), generator = new THREE.PMREMGenerator(renderer);
      try {
        const reflection = generator.fromScene(room, 0.03, 0.1, 100, { size: 64 });
        scene.environment = reflection.texture;
        scene.environmentRotation.x = Math.PI / 2;
        release.push(() => { scene.environment = null; reflection.dispose(); });
      } finally { room.dispose(); generator.dispose(); }
    }
    const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(100, -110, 85);
    const controls = new OrbitControls(camera, canvas);
    release.push(() => controls.dispose());
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    const machine = createMiloMachine3D();
    release.push(() => machine.dispose());
    const stock = createMiloStockMesh();
    release.push(() => stock.dispose());
    const trace = createTrace(path);
    release.push(() => trace.dispose());
    stock.mesh.castShadow = true; stock.mesh.receiveShadow = true;
    machine.workOrigin.add(stock.mesh, trace.group);
    release.push(() => machine.workOrigin.remove(stock.mesh, trace.group));
    scene.add(machine.group);

    const ambient = new THREE.HemisphereLight(0xf4fbff, 0x7a8b82, 1.32);
    const key = new THREE.DirectionalLight(0xfff3dd, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.00055;
    const fill = new THREE.DirectionalLight(0xc6e7ff, 0.68);
    scene.add(ambient, key, key.target, fill, fill.target);
    release.push(() => key.shadow.dispose());
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1600), new THREE.ShadowMaterial({ color: 0x020604, opacity: 0.38, depthWrite: false }));
    floor.receiveShadow = true;
    const grid = new THREE.GridHelper(1400, 28, 0x4c6357, 0x35483d);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true; grid.material.opacity = 0.37; grid.material.depthWrite = false;
    scene.add(floor, grid);
    release.push(() => { floor.geometry.dispose(); floor.material.dispose(); grid.dispose(); });

    let focus: MiloCameraView = "workpiece", sample: MiloMotionSample | undefined;
    let presetNeeded = true, customCamera = false;
    const saved = new Map<MiloCameraView, { camera: THREE.Vector3; target: THREE.Vector3 }>();
    const markerWorld = new THREE.Vector3();

    function bounds() {
      if (focus === "workpiece" || !sample) {
        return new THREE.Box3(new THREE.Vector3(0, 0, -MILO_STOCK.thicknessMm), new THREE.Vector3(MILO_STOCK.widthMm, MILO_STOCK.heightMm, 2));
      }
      return new THREE.Box3().setFromObject(machine.group);
    }
    function prepareView(reset: boolean) {
      if (!sample) return;
      const box = bounds(), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 1);
      scene.environmentIntensity = focus === "workpiece" ? 0.17 : 0.48;
      floor.visible = grid.visible = focus === "machine";
      floor.position.set(centre.x, centre.y, box.min.z - 1);
      grid.position.copy(floor.position); grid.position.z += 0.18;
      key.target.position.copy(centre); fill.target.position.copy(centre);
      key.position.set(-1.05, -0.85, 1.08).multiplyScalar(span).add(centre);
      fill.position.set(0.8, 0.65, 0.60).multiplyScalar(span).add(centre);
      const radius = span * 0.86;
      Object.assign(key.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: span * 0.1, far: span * 3.7 });
      key.shadow.camera.updateProjectionMatrix();
      key.shadow.normalBias = span * 0.00095;
      renderer.shadowMap.needsUpdate = true;
      controls.minDistance = span * 0.09; controls.maxDistance = span * 6;
      camera.near = span / 1500; camera.far = span * 12;
      camera.updateProjectionMatrix();

      const previous = !reset && saved.get(focus);
      if (previous) {
        camera.position.copy(previous.camera); controls.target.copy(previous.target); customCamera = true;
      } else {
        const home = homeCamera(focus, camera, machine.group, stock.mesh, trace.marker, path, sample);
        controls.target.copy(home.target);
        camera.position.copy(home.position);
        customCamera = false;
      }
      controls.update();
      presetNeeded = false;
    }
    function draw() {
      raf = 0;
      if (disposed || lost || !sample || !host.clientHeight || !host.clientWidth) return;
      if (renderer.getContext().isContextLost()) { failed("WebGL 图形上下文已丢失。"); return; }
      try {
        if (presetNeeded) prepareView(false);
        trace.marker.getWorldPosition(markerWorld);
        const mmPerPixel = 2 * camera.position.distanceTo(markerWorld) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / host.clientHeight;
        trace.marker.scale.setScalar(mmPerPixel * 3);
        renderer.render(scene, camera);
        if (canvas.dataset.ready !== "true") canvas.dataset.ready = "true";
        if (canvas.dataset.cameraView !== focus) canvas.dataset.cameraView = focus;
      } catch { failed("浏览器未能完成本帧的三维渲染。"); }
    }
    function invalidate() {
      if (!raf && !disposed && !lost && sample) raf = requestAnimationFrame(draw);
    }
    function resize() {
      const width = host.clientWidth, height = host.clientHeight;
      if (!width || !height || disposed) return;
      const aspect = width / height;
      if (!customCamera && Math.abs(camera.aspect - aspect) > 0.01) presetNeeded = true;
      camera.aspect = aspect; camera.updateProjectionMatrix();
      renderer.setSize(width, height, false); invalidate();
    }
    function reset() {
      if (!sample || disposed || lost) return;
      saved.delete(focus); prepareView(true); invalidate();
    }
    const interacted = () => { customCamera = true; };
    controls.addEventListener("start", interacted); controls.addEventListener("change", invalidate);
    const observer = new ResizeObserver(resize);
    observer.observe(host); resize();
    release.push(() => { observer.disconnect(); controls.removeEventListener("start", interacted); controls.removeEventListener("change", invalidate); });
    const onLost = (event: Event) => { event.preventDefault(); failed("WebGL 图形上下文已丢失。"); };
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowLeft": if (event.shiftKey) controls.pan(-24, 0); else controls.rotateLeft(0.13); break;
        case "ArrowRight": if (event.shiftKey) controls.pan(24, 0); else controls.rotateLeft(-0.13); break;
        case "ArrowUp": if (event.shiftKey) controls.pan(0, -24); else controls.rotateUp(0.13); break;
        case "ArrowDown": if (event.shiftKey) controls.pan(0, 24); else controls.rotateUp(-0.13); break;
        case "+": case "=": controls.dollyIn(0.84); break;
        case "-": controls.dollyOut(0.84); break;
        case "Home": reset(); break;
        default: return;
      }
      if (event.key !== "Home") customCamera = true;
      event.preventDefault();
    };
    canvas.addEventListener("webglcontextlost", onLost); canvas.addEventListener("keydown", onKey);
    release.push(() => { canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("keydown", onKey); });

    return {
      update(next: MiloMotionSample, frame: MiloStockState) {
        if (lost || disposed) return;
        try {
          sample = next;
          stock.update(frame); machine.setPose(next, focus === "workpiece" ? "stock" : "machine");
          trace.update(next); renderer.shadowMap.needsUpdate = true; invalidate();
        } catch { failed("无法更新当前工件的三维几何。"); }
      },
      setView(next: MiloCameraView) {
        if (focus === next || lost || disposed) return;
        if (customCamera) saved.set(focus, { camera: camera.position.clone(), target: controls.target.clone() });
        focus = next; presetNeeded = true; customCamera = false;
        if (sample) machine.setPose(sample, focus === "workpiece" ? "stock" : "machine");
        invalidate();
      },
      showPath(visible: boolean) { trace.group.visible = visible; canvas.dataset.showPath = String(visible); invalidate(); },
      reset, dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
