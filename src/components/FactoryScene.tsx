import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Box, Map as MapIcon, RotateCcw } from "lucide-react";
import type { FactoryLayout } from "@contracts/factory";
import type { FactoryRunResult } from "@/lib/factory-runtime";
import { equipmentPhases, type PlantFrame, type PlantPoint } from "@/lib/factory-playback";
import { Button } from "./ui/button";
import { factoryMeshes } from "./factory-equipment";

type Props = {
  layout: FactoryLayout;
  result: FactoryRunResult;
  frame: PlantFrame;
  selectedId: string;
  onSelect: (id: string) => void;
};
const lampColors = {
  idle: 0x7b9594,
  reserved: 0xe9b866,
  processing: 0x65e3ad,
  empty: 0x85aed1,
  pickup: 0xf2be66,
  carrying: 0x5fd5dd,
  drop: 0xf2be66,
};
const lampCss = (phase: keyof typeof lampColors) => "#" + lampColors[phase].toString(16).padStart(6, "0");
const roleNames = { handle: "上下料", machine: "数控机床", conveyor: "输送带", mobile: "移动机器人" };

function mapLayout(layout: FactoryLayout, result: FactoryRunResult) {
  const resources = new Map(result.resources.map(r => [r.id, r]));
  const xs = result.resources.map(r => r.positionM[0]),
    ys = result.resources.map(r => r.positionM[1]);
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(...ys),
    ymax = Math.max(...ys);
  const scale = 10 / (Math.max(xmax - xmin, ymax - ymin) || 10);
  const xy = ([x, y]: PlantPoint): PlantPoint => [
    (x - xmin) * scale - ((xmax - xmin) * scale) / 2,
    (y - ymin) * scale - ((ymax - ymin) * scale) / 2,
  ];
  let separation = 2.1;
  const points = result.resources.map(r => xy(r.positionM));
  points.forEach(([x, y], i) => {
    for (const [a, b] of points.slice(0, i)) {
      const d = Math.hypot(x - a, y - b);
      if (d > 0.01) separation = Math.min(separation, d);
    }
  });
  const unit = Math.max(0.13, Math.min(1.03, separation * 0.54));
  const routes = new Map<string, { a: PlantPoint; b: PlantPoint; belt: boolean }>();
  const belts = new Map<string, { a: PlantPoint; b: PlantPoint }>();
  for (const line of layout.lines) {
    line.stages.forEach((stage, i) => {
      if (!i) return;
      for (const from of line.stages[i - 1].stations)
        for (const to of stage.stations) {
          const a = resources.get(from)?.positionM,
            b = resources.get(to)?.positionM;
          if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
          const carriers = stage.carriers.filter(id => resources.get(id)?.role === "conveyor");
          for (const id of carriers) belts.set(id, { a, b });
          const key = [from, to].sort().join("\0");
          routes.set(key, { a, b, belt: !!carriers.length || !!routes.get(key)?.belt });
        }
    });
  }
  return {
    xy,
    unit,
    routes: [...routes.values()],
    belts,
    halfX: Math.max(0.8, ((xmax - xmin) * scale) / 2) + 1.45 * unit,
    halfY: Math.max(0.65, ((ymax - ymin) * scale) / 2) + 1.55 * unit,
  };
}
type SceneMap = ReturnType<typeof mapLayout>;

function createScene(
  host: HTMLDivElement,
  renderer: THREE.WebGLRenderer,
  result: FactoryRunResult,
  map: SceneMap,
  onSelect: (id: string) => void
) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172422);
  renderer.setPixelRatio(Math.min(1.7, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "block h-full w-full focus-visible:outline-offset-[-3px]";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "工厂三维布局");
  canvas.setAttribute("aria-description", "点选设备，拖动旋转，滚轮或双指缩放。Home 键复位。");
  canvas.tabIndex = 0;
  host.appendChild(canvas);
  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.03, 150);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minZoom = 0.42;
  controls.maxZoom = 7;
  const shapes = factoryMeshes();
  const { unit, xy, halfX, halfY } = map;
  scene.add(new THREE.HemisphereLight(0xf2f8ee, 0x647e77, 1.62));
  const key = new THREE.DirectionalLight(0xffefd8, 2.15);
  key.position.set(-6, 11, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 0.1, far: 38 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.normalBias = 0.012;
  key.shadow.bias = -0.00025;
  const rim = new THREE.DirectionalLight(0xafdcf0, 0.96);
  rim.position.set(4, 5, -9);
  scene.add(key, rim);
  shapes.box(scene, 0x314541, [2 * halfX, 0.12, 2 * halfY], [0, -0.1, 0]);
  shapes.box(scene, 0x2b3c38, [2 * halfX, 0.032, 2 * halfY], [0, -0.025, 0]);
  const linePoints: number[] = [];
  for (let x = Math.ceil(-halfX); x <= halfX; x++) linePoints.push(x, 0.003, -halfY, x, 0.003, halfY);
  for (let z = Math.ceil(-halfY); z <= halfY; z++) linePoints.push(-halfX, 0.003, z, halfX, 0.003, z);
  const gridGeometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(linePoints, 3));
  const gridMaterial = new THREE.LineBasicMaterial({ color: 0x43564d, transparent: true, opacity: 0.62 });
  scene.add(new THREE.LineSegments(gridGeometry, gridMaterial));
  const dashMaterial = new THREE.LineDashedMaterial({
    color: 0x83aa94,
    dashSize: 0.18,
    gapSize: 0.12,
    opacity: 0.74,
    transparent: true,
  });
  const routes: THREE.BufferGeometry[] = [];
  map.routes.forEach(route => {
    const [x, y] = xy(route.a),
      [u, v] = xy(route.b);
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0.021, -y), new THREE.Vector3(u, 0.021, -v)]);
    routes.push(geometry);
    const path = new THREE.Line(geometry, dashMaterial);
    path.computeLineDistances();
    scene.add(path);
  });
  const ringGeo = new THREE.RingGeometry(1.02, 1.065, 60),
    ringMat = new THREE.MeshBasicMaterial({ color: 0x69e5b2, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.scale.setScalar(unit);
  scene.add(ring);
  const labels: HTMLButtonElement[] = [];
  const symbols = result.resources.map(resource => {
    const belt = map.belts.get(resource.id);
    const [bx, by] = belt ? xy(belt.a) : [0, 0],
      [tx, ty] = belt ? xy(belt.b) : [0, 0];
    const model = shapes.equipment(resource.role, belt ? Math.hypot(tx - bx, ty - by) / unit - 0.6 : undefined);
    const [x, y] = xy(resource.positionM);
    // Fixed machines face their transfer point. The vehicle can occupy the dock while the machine remains visible.
    const dockOffset = resource.role === "machine" ? 0.91 : resource.role === "handle" ? 0.75 : 0;
    model.body.position.set(x, 0.022, -y - dockOffset * unit);
    model.body.scale.setScalar(unit);
    model.body.userData.resourceId = resource.id;
    if (belt) model.body.rotation.y = Math.atan2(ty - by, tx - bx);
    scene.add(model.body);
    if (dockOffset) {
      for (const side of [-1, 1])
        shapes.box(scene, 0x9b9e79, [0.045 * unit, 0.012, 0.42 * unit], [x + side * 0.48 * unit, 0.018, -y]);
    }
    const label = document.createElement("button");
    label.type = "button";
    const dot = document.createElement("i");
    dot.className = "mr-1 inline-block size-1.5 rounded-full align-middle";
    dot.setAttribute("aria-hidden", "true");
    label.append(dot, document.createTextNode(resource.name));
    label.title = resource.name;
    label.setAttribute("aria-label", "查看设备 " + resource.name);
    label.className =
      "absolute left-0 top-0 max-w-[8rem] truncate rounded border border-[#6d8278]/50 bg-[#14221f]/90 px-1.5 py-0.5 text-[10px] leading-tight text-[#d4e2d9] hover:border-primary focus-visible:z-10";
    label.style.transformOrigin = "0 0";
    label.onclick = () => onSelect(resource.id);
    host.appendChild(label);
    labels.push(label);
    return { ...model, resource, label, dot, dockOffset };
  });
  const markers = result.jobs.map(job => {
    const group = new THREE.Group();
    const tile = shapes.box(group, 0xf6a86c, [0.23, 0.1, 0.19], [0, 0.05, 0]);
    shapes.box(group, 0xe9d8a2, [0.055, 0.012, 0.19], [0.033, 0.107, 0]);
    group.scale.setScalar(unit);
    group.userData.jobId = job.id;
    scene.add(group);
    return { group, tile };
  });
  let frameId = 0,
    selected = "",
    aspect = 1,
    zoomed = false;
  const anchor = new THREE.Vector3();
  function placeLabels() {
    const w = host.clientWidth,
      h = host.clientHeight;
    const occupied: { x: number; y: number; half: number }[] = [];
    const ordered = [...symbols].sort((a, b) => Number(b.resource.id === selected) - Number(a.resource.id === selected));
    for (const { body, height, label, resource } of ordered) {
      anchor.set(body.position.x, body.position.y + unit * height, body.position.z).project(camera);
      const x = ((anchor.x + 1) * w) / 2,
        y = ((1 - anchor.y) * h) / 2;
      const half = Math.min(65, 9 + resource.name.length * 5),
        active = resource.id === selected;
      const visible =
        x > half &&
        x < w - half &&
        y > 18 &&
        y < h &&
        (active || !occupied.some(p => Math.abs(p.x - x) < half + p.half + 2 && Math.abs(p.y - y) < 18));
      label.style.visibility = visible ? "visible" : "hidden";
      if (visible) {
        occupied.push({ x, y, half });
        label.style.transform = `translate(${x}px,${y}px) translate(-50%, -100%)`;
        label.style.borderColor = active ? "#63dab0" : "";
        label.setAttribute("aria-pressed", String(active));
      }
    }
  }
  function render() {
    if (frameId || !host.clientWidth || !host.clientHeight) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      renderer.render(scene, camera);
      placeLabels();
      canvas.dataset.ready = "true";
    });
  }
  function reset() {
    const direction = new THREE.Vector3(0.46, 0.75, 1).normalize(),
      right = new THREE.Vector3().crossVectors(camera.up, direction).normalize(),
      up = new THREE.Vector3().crossVectors(direction, right);
    const area = new THREE.Box3();
    for (const x of [-halfX, halfX])
      for (const z of [-halfY, halfY])
        for (const y of [-0.1, unit * 1.65]) {
          const point = new THREE.Vector3(x, y, z);
          area.expandByPoint(new THREE.Vector3(point.dot(right), point.dot(up), 0));
        }
    const size = area.getSize(new THREE.Vector3()),
      half = Math.max(size.y, size.x / aspect) * 0.54;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.target.set(0, unit * 0.67, 0);
    camera.position.copy(controls.target).addScaledVector(direction, 22);
    controls.update();
    zoomed = false;
    render();
  }
  function resize() {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    aspect = w / h;
    renderer.setSize(w, h, false);
    if (!zoomed) reset();
    else {
      camera.left = -camera.top * aspect;
      camera.right = camera.top * aspect;
      camera.updateProjectionMatrix();
      render();
    }
  }
  function paint(next: PlantFrame, id: string) {
    selected = id;
    for (const { resource, body, beacon, label, dot } of symbols) {
      const pose = next.equipment.get(resource.id)!;
      if (resource.role === "mobile") {
        const [x, y] = xy(pose.point);
        body.position.set(x, 0.022, -y);
        body.rotation.y = pose.heading;
      }
      beacon.material = shapes.material(lampColors[pose.phase]);
      dot.style.backgroundColor = lampCss(pose.phase);
      label.title = resource.name + " · " + equipmentPhases[pose.phase];
      if (resource.id === id) ring.position.set(body.position.x, 0.03, body.position.z);
    }
    ring.visible = next.equipment.has(id);
    const piles = new Map<string, number>();
    next.parts.forEach((part, i) => {
      const { group, tile } = markers[i];
      group.visible = !!part.point;
      if (!part.point) return;
      const [x, y] = xy(part.point),
        key = part.point.join(",");
      const index = piles.get(key) ?? 0;
      piles.set(key, index + 1);
      const loaded = part.phase === "carrying" || part.phase === "pickup" || part.phase === "drop";
      const station = symbols.find(s => s.resource.id === part.operation?.stationId);
      const lift = loaded ? 0.65 : part.phase === "processing" ? (station?.height ?? 1) * 0.98 : 0.13;
      const zOffset =
        part.phase === "processing" ? -(station?.dockOffset ?? 0) : loaded ? 0 : 0.62 + (Math.floor(index / 4) % 3) * 0.19;
      group.position.set(
        x + unit * (loaded || part.phase === "processing" ? 0 : -0.48 + (index % 4) * 0.2),
        unit * (lift + Math.floor(index / 12) * 0.085) + 0.022,
        -y + unit * zOffset
      );
      tile.material = shapes.material(part.phase === "completed" ? 0x73c9ad : 0xf6a86c);
    });
    render();
  }
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2(),
    meshes = symbols.map(s => s.body);
  let down: [number, number] | undefined;
  const pointerDown = (e: PointerEvent) => {
    down = [e.clientX, e.clientY];
  };
  const pointerUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) {
      down = undefined;
      return;
    }
    down = undefined;
    const rect = canvas.getBoundingClientRect();
    pointer.set((2 * (e.clientX - rect.left)) / rect.width - 1, 1 - (2 * (e.clientY - rect.top)) / rect.height);
    raycaster.setFromCamera(pointer, camera);
    let hit: THREE.Object3D | null = raycaster.intersectObjects(meshes, true)[0]?.object ?? null;
    while (hit && !hit.userData.resourceId) hit = hit.parent;
    if (hit) onSelect(hit.userData.resourceId);
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === "Home") {
      e.preventDefault();
      reset();
    }
  };
  const mark = () => {
    zoomed = true;
  };
  controls.addEventListener("start", mark);
  controls.addEventListener("change", render);
  canvas.addEventListener("keydown", keyDown);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  return {
    paint,
    reset,
    dispose() {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.removeEventListener("start", mark);
      controls.dispose();
      canvas.removeEventListener("keydown", keyDown);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      for (const label of labels) label.remove();
      for (const g of routes) g.dispose();
      dashMaterial.dispose();
      gridGeometry.dispose();
      gridMaterial.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      shapes.dispose();
      key.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

function Plan({ result, frame, selectedId, onSelect, map }: Omit<Props, "layout"> & { map: SceneMap }) {
  const pattern = useId().replace(/:/g, "");
  const [[width, height], setViewport] = useState([640, 350]);
  const measure = useCallback((svg: SVGSVGElement | null) => {
    if (!svg) return;
    const resize = () => {
      const box = svg.getBoundingClientRect();
      if (box.width && box.height) setViewport([box.width, box.height]);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    resize();
    return () => observer.disconnect();
  }, []);
  const scale = Math.min((width - 22) / (2 * map.halfX), (height - 44) / (2 * map.halfY));
  const p = (point: PlantPoint) => {
    const [x, y] = map.xy(point);
    return [width / 2 + x * scale, height / 2 - y * scale];
  };
  const compact = width < 510;
  const stations = result.resources.map(r => {
    const pose = frame.equipment.get(r.id)!;
    const [x, dockY] = p(pose.point);
    const y = dockY - (r.role === "machine" ? 0.91 : r.role === "handle" ? 0.75 : 0) * scale * map.unit;
    const size = (r.role === "machine" ? 20 : r.role === "mobile" ? 12 : 15) * (compact ? 0.64 : 1);
    return { r, pose, x, y, dockY, size };
  });
  const labels = new Map<string, { x: number; y: number; text: string }>();
  const occupied = stations.map(s => ({ x: s.x, y: s.y, dx: s.size * 0.8, dy: s.size * 0.65 }));
  const order = [...stations].sort((a, b) => Number(b.r.id === selectedId) - Number(a.r.id === selectedId));
  const font = compact ? 10 : 12;
  for (const { r, x, y, size } of order) {
    const text = r.name.length > 12 ? r.name.slice(0, 11) + "…" : r.name;
    const dx = Math.min(
      width / 2 - 2,
      [...text].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 0.32 : 0.51) * font, 2)
    );
    const lx = Math.max(dx + 2, Math.min(width - dx - 2, x));
    for (const distance of [1, -1, 2, -2, 3, -3]) {
      const ly = y + Math.sign(distance) * (size * 0.65 + 7 + (Math.abs(distance) - 1) * (font + 2));
      if (
        ly < font / 2 ||
        ly + font / 2 > height ||
        occupied.some(b => Math.abs(lx - b.x) < dx + b.dx && Math.abs(ly - b.y) < font * 0.5 + b.dy + 1)
      )
        continue;
      labels.set(r.id, { x: lx, y: ly, text });
      occupied.push({ x: lx, y: ly, dx, dy: font * 0.5 });
      break;
    }
  }
  return (
    <svg
      ref={measure}
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label="工厂俯视布局"
      className="block h-full w-full bg-[#172422]"
    >
      <defs>
        <pattern id={pattern} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="#304339" strokeWidth=".8" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${pattern})`} />
      {map.routes.map((r, i) => {
        const [x, y] = p(r.a),
          [u, v] = p(r.b);
        return (
          <line
            key={i}
            x1={x}
            y1={y}
            x2={u}
            y2={v}
            stroke={r.belt ? "#6b9693" : "#769181"}
            strokeWidth={r.belt ? 5 : 1.8}
            strokeDasharray={r.belt ? undefined : "5 4"}
          />
        );
      })}
      {stations.map(({ r, pose, x, y, dockY, size }) => {
        const label = labels.get(r.id);
        return (
          <g
            key={r.id}
            role="button"
            tabIndex={0}
            aria-label={"查看设备 " + r.name}
            aria-pressed={r.id === selectedId}
            onClick={() => onSelect(r.id)}
            onKeyDown={e => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSelect(r.id);
              }
            }}
            className="cursor-pointer"
          >
            <title>
              {r.name} · {roleNames[r.role]} · {equipmentPhases[pose.phase]}
            </title>
            <rect x={x - Math.max(size, 14)} y={y - 14} width={Math.max(size, 14) * 2} height="28" fill="transparent" />
            {y !== dockY && <path d={`M${x} ${y} V${dockY}`} stroke="#9b9e79" strokeWidth="2" />}
            {r.id === selectedId && <circle cx={x} cy={y} r={size + 6} fill="none" stroke="#62dfb0" strokeWidth="2" />}
            <rect
              x={x - size}
              y={y - size * 0.65}
              width={size * 2}
              height={size * 1.3}
              rx={r.role === "handle" ? 10 : 3}
              stroke="#acbeb1"
              fill={
                r.role === "machine" ? "#426e72" : r.role === "mobile" ? "#ae8a49" : r.role === "handle" ? "#ac7349" : "#526b69"
              }
            />
            {r.role === "conveyor" ? (
              [-8, -4, 0, 4, 8].map(d => <path key={d} d={`M${x + d} ${y - 7}v14`} stroke="#b3c4bd" />)
            ) : (
              <rect x={x - size * 0.58} y={y - size * 0.32} width={size * 1.16} height={size * 0.6} rx="2" fill="#273f41" />
            )}
            <circle cx={x + size - 1} cy={y - size * 0.65} r="3.8" fill={lampCss(pose.phase)} />
            {label && (
              <text
                x={label.x}
                y={label.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#dfebe4"
                fontSize={font}
                stroke="#172422"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {label.text}
              </text>
            )}
          </g>
        );
      })}
      {frame.parts
        .filter(s => s.point && s.phase !== "completed")
        .map(s => {
          const [x, y] = p(s.point!);
          return <circle key={s.id} cx={x} cy={y} r="3.3" fill="#ffa770" stroke="#23332b" pointerEvents="none" />;
        })}
    </svg>
  );
}

export default function FactoryScene({ layout, result, frame, selectedId, onSelect }: Props) {
  const map = useMemo(() => mapLayout(layout, result), [layout, result]);
  const [mode, setMode] = useState<"3d" | "plan">("3d"),
    [failed, setFailed] = useState(false);
  const view = useRef<ReturnType<typeof createScene> | null>(null);
  const plan = mode === "plan" || failed;
  const mount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      } catch {
        setFailed(true);
        return;
      }
      const current = createScene(node, renderer, result, map, onSelect);
      view.current = current;
      const lost = (event: Event) => {
        event.preventDefault();
        setFailed(true);
      };
      renderer.domElement.addEventListener("webglcontextlost", lost);
      return () => {
        renderer.domElement.removeEventListener("webglcontextlost", lost);
        view.current = null;
        current.dispose();
      };
    },
    [map, result, onSelect]
  );
  useEffect(() => {
    view.current?.paint(frame, selectedId);
  }, [frame, selectedId, plan, map]);
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border border-[#435449] bg-[#172422]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#3d4e44] px-3 py-2">
        <figcaption className="text-sm font-medium">厂区布局</figcaption>
        <div className="flex items-center gap-1" aria-label="厂区视图">
          <Button
            size="sm"
            variant={!plan ? "secondary" : "ghost"}
            aria-pressed={!plan}
            onClick={() => {
              setFailed(false);
              setMode("3d");
            }}
          >
            <Box />
            三维
          </Button>
          <Button size="sm" variant={plan ? "secondary" : "ghost"} aria-pressed={plan} onClick={() => setMode("plan")}>
            <MapIcon />
            俯视
          </Button>
          {!plan && (
            <Button size="sm" variant="ghost" title="复位视角" aria-label="复位视角" onClick={() => view.current?.reset()}>
              <RotateCcw />
            </Button>
          )}
        </div>
      </div>
      <div className="relative h-[275px] w-full sm:h-[360px] lg:h-[420px]">
        {plan ? (
          <Plan {...{ result, frame, selectedId, onSelect, map }} />
        ) : (
          <div ref={mount} className="relative h-full w-full overflow-hidden" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#3d4e44] bg-background/45 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-sm bg-[#f6a86c]" />
          工件
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="w-4 border-t border-dashed border-[#83aa94]" />
          物流路径
        </span>
        <span>设备坐标指向工位交接点</span>
        {failed && mode === "3d" && <span>当前浏览器使用俯视图</span>}
      </div>
    </figure>
  );
}
