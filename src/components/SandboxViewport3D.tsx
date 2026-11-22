import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  frameToMatrixMm,
  solveArticulatedAssembly,
  type ArticulatedSolveResult,
} from "@contracts/articulated-kinematics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { primitiveBoundingBoxMm } from "@contracts/primitive-parts";
import { SANDBOX_BLOCKS, type WorldTargetStatus } from "@contracts/sandbox-challenges";
import { buildPrimitivePartPackage, packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { createPrimitivePartGroup, disposeGroupResources } from "./primitive-part-mesh";

export interface SandboxViewport3DProps {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  mode: "build" | "test" | "explode";
  armedBlockId: string | null;
  selectedNodeId: string;
  commands: Record<string, number>;
  explodePct: number;
  subtreeOnly: boolean;
  showLeaders: boolean;
  showLabels: boolean;
  worldTargets: readonly WorldTargetStatus[];
  fitRequestToken: number;
  onSelectNode: (nodeId: string) => void;
  onSnapBlock: (parentNodeId: string, parentMountId: string) => void;
  onHoverSnapChange?: (label: string) => void;
}

const MOUNT_LABELS: Record<string, string> = {
  top: "顶面 (top)",
  bottom: "底面 (bottom)",
  pos_x: "右侧面 (+X)",
  neg_x: "左侧面 (-X)",
  pos_y: "后面 (+Y)",
  neg_y: "前面 (-Y)",
  carriage_top: "滑块承载面",
  carriage_front: "滑块正面",
  column_seat: "立柱安装位",
  z_rail_mount: "立柱Z轨位",
  spindle_clamp: "主轴安装环",
  arm_mount: "臂连接面",
  shaft_tip: "电机出轴端",
  tool_tip: "刀尖端",
  center: "中心点",
};

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

function snapInputOffsetMm(mountId: string, bounds: readonly [number, number, number]): [number, number, number] {
  const [dx, dy, dz] = bounds;
  switch (mountId) {
    case "bottom":
    case "neg_z":
    case "spindle_clamp":
    case "tool_tip":
      return [0, 0, dz / 2];
    case "pos_x":
    case "bearing_mount":
      return [-dx / 2, 0, 0];
    case "neg_x":
    case "motor_mount":
      return [dx / 2, 0, 0];
    case "pos_y":
    case "rear_plate_mount":
      return [0, -dy / 2, 0];
    case "neg_y":
    case "carriage_front":
    case "z_rail_mount":
      return [0, dy / 2, 0];
    case "center":
      return [0, 0, 0];
    default:
      return [0, 0, -dz / 2];
  }
}

export default function SandboxViewport3D({
  workspace,
  assembly,
  mode,
  armedBlockId,
  selectedNodeId,
  commands,
  explodePct,
  subtreeOnly,
  showLeaders,
  showLabels,
  worldTargets,
  fitRequestToken,
  onSelectNode,
  onSnapBlock,
  onHoverSnapChange,
}: SandboxViewport3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneCtxRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    renderer: THREE.WebGLRenderer;
    partsGroup: THREE.Group;
    snapGroup: THREE.Group;
    targetsGroup: THREE.Group;
    ghostGroup: THREE.Group;
    nodeObjects: Map<string, THREE.Group>;
    snapMeshes: Array<{ mesh: THREE.Mesh; parentNodeId: string; mountId: string; parentLabel: string; mountMatrixWorld: THREE.Matrix4 }>;
    leaderLinesObj: THREE.LineSegments;
    tcpMarker: THREE.Mesh;
    labelsOverlay: HTMLDivElement;
    labelEls: Map<string, HTMLButtonElement>;
    paint: () => void;
    fitCamera: () => void;
  } | null>(null);

  const effectiveExplodePct = mode === "explode" ? explodePct : 0;
  const explodeSubtreeRoot = mode === "explode" && subtreeOnly && selectedNodeId ? selectedNodeId : undefined;

  const solved: ArticulatedSolveResult = useMemo(
    () =>
      solveArticulatedAssembly(workspace, assembly, {
        commandOverrides: commands,
        explodeFactor: effectiveExplodePct / 100,
        explodeSubtreeRoot,
      }),
    [workspace, assembly, commands, effectiveExplodePct, explodeSubtreeRoot],
  );

  const solvedRef = useRef(solved);
  const modeRef = useRef(mode);
  const armedBlockRef = useRef(armedBlockId);
  const selectedIdRef = useRef(selectedNodeId);
  const showLeadersRef = useRef(showLeaders);
  const showLabelsRef = useRef(showLabels);
  const explodePctRef = useRef(effectiveExplodePct);
  const onSelectRef = useRef(onSelectNode);
  const onSnapRef = useRef(onSnapBlock);
  const onHoverRef = useRef(onHoverSnapChange);

  useEffect(() => {
    solvedRef.current = solved;
    modeRef.current = mode;
    armedBlockRef.current = armedBlockId;
    selectedIdRef.current = selectedNodeId;
    showLeadersRef.current = showLeaders;
    showLabelsRef.current = showLabels;
    explodePctRef.current = effectiveExplodePct;
    onSelectRef.current = onSelectNode;
    onSnapRef.current = onSnapBlock;
    onHoverRef.current = onHoverSnapChange;
  }, [
    solved,
    mode,
    armedBlockId,
    selectedNodeId,
    showLeaders,
    showLabels,
    effectiveExplodePct,
    onSelectNode,
    onSnapBlock,
    onHoverSnapChange,
  ]);

  const applyPosesAndPaint = useCallback(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;
    const current = solvedRef.current;

    for (const node of current.nodes) {
      const grp = ctx.nodeObjects.get(node.path);
      if (!grp) continue;
      grp.matrixAutoUpdate = false;
      grp.matrix.copy(node.explodedMatrix);
      grp.matrixWorldNeedsUpdate = true;
    }

    const obs = current.explodedObservationPointMm;
    ctx.tcpMarker.position.set(obs[0], obs[1], obs[2]);
    ctx.tcpMarker.visible = current.nodes.length > 0;

    // Leader lines during explosion
    const linePts: THREE.Vector3[] = [];
    if (showLeadersRef.current && current.leaderLines.length > 0) {
      for (const seg of current.leaderLines) {
        linePts.push(
          new THREE.Vector3(seg.fromMm[0], seg.fromMm[1], seg.fromMm[2]),
          new THREE.Vector3(seg.toMm[0], seg.toMm[1], seg.toMm[2]),
        );
      }
    }
    ctx.leaderLinesObj.geometry.dispose();
    ctx.leaderLinesObj.geometry = new THREE.BufferGeometry().setFromPoints(linePts);
    ctx.leaderLinesObj.computeLineDistances();
    ctx.leaderLinesObj.visible = linePts.length > 0;

    ctx.paint();
  }, []);

  // Init WebGL Three.js scene
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const container = host;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      container.innerHTML =
        '<div class="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">当前浏览器或无头环境暂不支持 WebGL 3D 渲染，可通过左侧控制面板操作积木与挑战进度。</div>';
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1716);

    const camera = new THREE.PerspectiveCamera(40, 1.5, 2, 20_000);
    camera.up.set(0, 0, 1);
    camera.position.set(460, -560, 390);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const canvas = renderer.domElement;
    canvas.className = "block h-full w-full touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "三维积木拼装与挑战视口");

    const labelsOverlay = document.createElement("div");
    labelsOverlay.className = "pointer-events-none absolute inset-0 overflow-hidden";

    container.innerHTML = "";
    container.append(canvas, labelsOverlay);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.target.set(0, 0, 75);
    controls.minDistance = 80;
    controls.maxDistance = 6500;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xf3fffc, 0x3a4e46, 1.65));
    const sun = new THREE.DirectionalLight(0xfffdf2, 1.9);
    sun.position.set(450, -520, 780);
    sun.castShadow = true;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbbe8dc, 0.9);
    fill.position.set(-480, 460, 320);
    scene.add(fill);

    const grid = new THREE.GridHelper(1400, 28, 0x355348, 0x1a2b25);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -18;
    scene.add(grid);

    const partsGroup = new THREE.Group();
    const snapGroup = new THREE.Group();
    const targetsGroup = new THREE.Group();
    const ghostGroup = new THREE.Group();
    ghostGroup.visible = false;
    scene.add(partsGroup, snapGroup, targetsGroup, ghostGroup);

    const leaderMat = new THREE.LineDashedMaterial({
      color: 0x5eead4,
      dashSize: 10,
      gapSize: 6,
      transparent: true,
      opacity: 0.9,
    });
    const leaderLinesObj = new THREE.LineSegments(new THREE.BufferGeometry(), leaderMat);
    scene.add(leaderLinesObj);

    const tcpMarker = new THREE.Mesh(
      new THREE.SphereGeometry(6.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff7b54 }),
    );
    scene.add(tcpMarker);

    const nodeObjects = new Map<string, THREE.Group>();
    const labelEls = new Map<string, HTMLButtonElement>();
    const snapMeshes: Array<{
      mesh: THREE.Mesh;
      parentNodeId: string;
      mountId: string;
      parentLabel: string;
      mountMatrixWorld: THREE.Matrix4;
    }> = [];

    const projected = new THREE.Vector3();

    function paint() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      renderer.render(scene, camera);

      const showAny =
        showLabelsRef.current && (explodePctRef.current >= 4 || Boolean(selectedIdRef.current));
      const usedBoxes: Array<{ x: number; y: number; bw: number; bh: number }> = [];
      for (const node of solvedRef.current.nodes) {
        const btn = labelEls.get(node.path);
        if (!btn) continue;
        const isSel = selectedIdRef.current === node.path;
        if (!showAny || (!isSel && explodePctRef.current < 4)) {
          btn.style.display = "none";
          continue;
        }
        projected.set(node.explodedPosMm[0], node.explodedPosMm[1], node.explodedPosMm[2]).project(camera);
        if (projected.z > 1 || projected.z < -1) {
          btn.style.display = "none";
          continue;
        }
        btn.style.display = "block";
        const ax = ((projected.x + 1) * w) / 2;
        const ay = ((1 - projected.y) * h) / 2;
        const bw = btn.offsetWidth || 88;
        const bh = btn.offsetHeight || 20;
        const x = clamp(ax - bw / 2, 4, Math.max(4, w - bw - 4));
        let y = clamp(ay - bh / 2, 4, Math.max(4, h - bh - 4));
        let fits = true;
        for (const step of [0, -1, 1, -2, 2, -3, 3]) {
          const candY = clamp(ay + step * (bh + 3), 4, Math.max(4, h - bh - 4));
          const overlaps = usedBoxes.some(
            (b) => x < b.x + b.bw + 3 && b.x < x + bw + 3 && candY < b.y + b.bh + 3 && b.y < candY + bh + 3,
          );
          if (!overlaps) {
            y = candY;
            fits = true;
            break;
          }
          fits = false;
        }
        if (!fits && !isSel) {
          btn.style.display = "none";
          continue;
        }
        usedBoxes.push({ x, y, bw, bh });
        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;
      }
    }

    function fitCamera() {
      const box = new THREE.Box3();
      for (const node of solvedRef.current.nodes) {
        box.expandByPoint(new THREE.Vector3(node.explodedPosMm[0], node.explodedPosMm[1], node.explodedPosMm[2]));
      }
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 260);
      controls.target.copy(center);
      camera.position.set(center.x + span * 1.15, center.y - span * 1.35, center.z + span * 0.9);
      camera.updateProjectionMatrix();
      controls.update();
      paint();
    }

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      paint();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    controls.addEventListener("change", paint);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPt: { x: number; y: number } | null = null;
    let hoveredSnap: (typeof snapMeshes)[number] | null = null;

    const toNdc = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const resetSnapHover = () => {
      if (hoveredSnap) {
        const mat = hoveredSnap.mesh.material as THREE.MeshStandardMaterial;
        mat.color.setHex(0x2dd4bf);
        mat.emissive.setHex(0x0d9488);
        hoveredSnap.mesh.scale.setScalar(1);
        hoveredSnap = null;
      }
      if (ghostGroup.visible) {
        ghostGroup.visible = false;
        paint();
      }
      onHoverRef.current?.("");
    };

    const onPointerMove = (e: PointerEvent) => {
      if (modeRef.current !== "build" || !armedBlockRef.current || snapMeshes.length === 0) {
        resetSnapHover();
        return;
      }
      toNdc(e);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(snapMeshes.map((s) => s.mesh), false);
      const hitMesh = hits[0]?.object as THREE.Mesh | undefined;
      const matched = hitMesh ? snapMeshes.find((s) => s.mesh === hitMesh) ?? null : null;

      if (matched === hoveredSnap) return;
      if (hoveredSnap) {
        const prevMat = hoveredSnap.mesh.material as THREE.MeshStandardMaterial;
        prevMat.color.setHex(0x2dd4bf);
        prevMat.emissive.setHex(0x0d9488);
        hoveredSnap.mesh.scale.setScalar(1);
      }
      hoveredSnap = matched;
      if (!matched) {
        ghostGroup.visible = false;
        onHoverRef.current?.("");
        paint();
        return;
      }

      const mat = matched.mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xfacc15);
      mat.emissive.setHex(0xca8a04);
      matched.mesh.scale.setScalar(1.38);

      const armedDef = SANDBOX_BLOCKS.find((b) => b.id === armedBlockRef.current);
      if (armedDef) {
        const bounds = primitiveBoundingBoxMm(armedDef.spec);
        const offset = snapInputOffsetMm(matched.mountId, bounds);
        const invInput = frameToMatrixMm({ positionMm: offset, quatWxyz: [1, 0, 0, 0] }).invert();
        const previewMatrix = matched.mountMatrixWorld.clone().multiply(invInput);
        ghostGroup.matrixAutoUpdate = false;
        ghostGroup.matrix.copy(previewMatrix);
        ghostGroup.matrixWorldNeedsUpdate = true;
        ghostGroup.visible = true;
      }
      const mountCaption = MOUNT_LABELS[matched.mountId] ?? matched.mountId;
      onHoverRef.current?.(`点击吸附到「${matched.parentLabel}」的 ${mountCaption}`);
      paint();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.isPrimary && e.button === 0) downPt = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!downPt || Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 6) {
        downPt = null;
        return;
      }
      downPt = null;
      toNdc(e);
      raycaster.setFromCamera(pointer, camera);

      if (modeRef.current === "build" && armedBlockRef.current && snapMeshes.length > 0) {
        const snapHits = raycaster.intersectObjects(snapMeshes.map((s) => s.mesh), false);
        const hitMesh = snapHits[0]?.object as THREE.Mesh | undefined;
        const matched = hitMesh ? snapMeshes.find((s) => s.mesh === hitMesh) : undefined;
        if (matched) {
          onSnapRef.current(matched.parentNodeId, matched.mountId);
          return;
        }
      }

      const partHits = raycaster.intersectObjects([...nodeObjects.values()], true);
      let obj: THREE.Object3D | null = partHits[0]?.object ?? null;
      while (obj && !obj.userData.nodePath) obj = obj.parent;
      if (obj?.userData.nodePath) {
        onSelectRef.current(String(obj.userData.nodePath));
      }
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    sceneCtxRef.current = {
      scene,
      camera,
      controls,
      renderer,
      partsGroup,
      snapGroup,
      targetsGroup,
      ghostGroup,
      nodeObjects,
      snapMeshes,
      leaderLinesObj,
      tcpMarker,
      labelsOverlay,
      labelEls,
      paint,
      fitCamera,
    };

    resize();

    return () => {
      sceneCtxRef.current = null;
      observer.disconnect();
      controls.removeEventListener("change", paint);
      controls.dispose();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      disposeGroupResources(partsGroup);
      disposeGroupResources(snapGroup);
      disposeGroupResources(targetsGroup);
      disposeGroupResources(ghostGroup);
      leaderLinesObj.geometry.dispose();
      leaderMat.dispose();
      tcpMarker.geometry.dispose();
      (tcpMarker.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      labelsOverlay.innerHTML = "";
      canvas.remove();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, []);

  // Rebuild meshes when topology / selected highlight / package specs change
  const packagesMap = useMemo(
    () => new Map(workspace.packages.map((p) => [packageKey(p), p])),
    [workspace.packages],
  );
  const structureSig = useMemo(
    () => `${assembly.id}::${solved.nodes.map((n) => `${n.path}:${n.packageKey}`).join("|")}::sel=${selectedNodeId}`,
    [assembly.id, solved.nodes, selectedNodeId],
  );

  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.partsGroup);
    ctx.partsGroup.clear();
    ctx.nodeObjects.clear();
    ctx.labelsOverlay.innerHTML = "";
    ctx.labelEls.clear();

    for (const node of solvedRef.current.nodes) {
      const pkg = node.pkg ?? packagesMap.get(node.packageKey);
      const isSel = selectedNodeId === node.path;
      const partGroup = createPrimitivePartGroup(pkg, { selected: isSel });
      partGroup.userData.nodePath = node.path;
      partGroup.traverse((child) => {
        child.userData.nodePath = node.path;
      });
      ctx.partsGroup.add(partGroup);
      ctx.nodeObjects.set(node.path, partGroup);

      const pill = document.createElement("button");
      pill.type = "button";
      pill.textContent = node.label;
      pill.className = `pointer-events-auto absolute max-w-36 truncate rounded border px-1.5 py-0.5 text-[10px] font-medium shadow-sm transition-colors ${
        isSel
          ? "border-primary bg-primary text-primary-foreground"
          : "border-[#4b6a5d] bg-[#12201b]/90 text-[#e6f3ea] hover:border-primary"
      }`;
      pill.onclick = () => onSelectRef.current(node.path);
      ctx.labelsOverlay.append(pill);
      ctx.labelEls.set(node.path, pill);
    }

    applyPosesAndPaint();
  }, [structureSig, packagesMap, selectedNodeId, applyPosesAndPaint]);

  // Rebuild ghost hologram when armedBlockId changes
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;
    disposeGroupResources(ctx.ghostGroup);
    ctx.ghostGroup.clear();
    ctx.ghostGroup.visible = false;
    if (!armedBlockId) return;

    const def = SANDBOX_BLOCKS.find((b) => b.id === armedBlockId);
    if (!def) return;
    const tempPkg = buildPrimitivePartPackage({
      model: def.name,
      primitive: def.spec,
    });
    const ghost = createPrimitivePartGroup(tempPkg);
    const hologramMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    ghost.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material?.dispose();
        child.material = hologramMat;
        child.castShadow = false;
      }
    });
    ctx.ghostGroup.add(ghost);
  }, [armedBlockId]);

  // Rebuild interactive snap spheres when build mode + armedBlockId + nodes update
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.snapGroup);
    ctx.snapGroup.clear();
    ctx.snapMeshes.length = 0;

    if (mode !== "build" || !armedBlockId) {
      ctx.paint();
      return;
    }

    const occupied = new Set(
      assembly.nodes
        .filter((n) => n.parent)
        .map((n) => `${n.parent!.node}::${n.parent!.mount}`),
    );
    const sphereGeo = new THREE.SphereGeometry(9, 18, 14);
    const haloGeo = new THREE.RingGeometry(11, 14, 24);

    for (const node of solved.nodes) {
      const pkg = node.pkg ?? packagesMap.get(node.packageKey);
      if (pkg?.mechanics?.kind !== "part") continue;
      for (const out of pkg.mechanics.outputs) {
        if (out.id === "center" && pkg.mechanics.outputs.length > 1) continue;
        if (out.id === "pos_z" || out.id === "neg_z") continue; // already covered by top/bottom
        if (occupied.has(`${node.id}::${out.id}`)) continue;

        const mountWorld = node.explodedMatrix.clone().multiply(frameToMatrixMm(out));
        const pos = new THREE.Vector3().setFromMatrixPosition(mountWorld);
        const snapMat = new THREE.MeshStandardMaterial({
          color: 0x2dd4bf,
          emissive: 0x0d9488,
          emissiveIntensity: 0.75,
          transparent: true,
          opacity: 0.9,
        });
        const orb = new THREE.Mesh(sphereGeo.clone(), snapMat);
        orb.position.copy(pos);
        ctx.snapGroup.add(orb);

        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x5eead4,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.45,
        });
        const ring = new THREE.Mesh(haloGeo.clone(), ringMat);
        orb.add(ring);

        ctx.snapMeshes.push({
          mesh: orb,
          parentNodeId: node.id,
          mountId: out.id,
          parentLabel: node.label,
          mountMatrixWorld: mountWorld,
        });
      }
    }

    sphereGeo.dispose();
    haloGeo.dispose();
    ctx.paint();
  }, [mode, armedBlockId, solved, assembly.nodes, packagesMap]);

  // Rebuild challenge target spheres
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.targetsGroup);
    ctx.targetsGroup.clear();

    for (const t of worldTargets) {
      const group = new THREE.Group();
      group.position.set(t.worldPosMm[0], t.worldPosMm[1], t.worldPosMm[2]);

      const color = t.hit ? 0x10b981 : 0xf59e0b;
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(t.radiusMm, 22, 16),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: mode === "test" ? (t.hit ? 0.25 : 0.34) : 0.14,
          depthWrite: false,
        }),
      );
      const wire = new THREE.Mesh(
        new THREE.SphereGeometry(t.radiusMm, 12, 8),
        new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: mode === "test" ? 0.65 : 0.25,
        }),
      );
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(5, 12, 10),
        new THREE.MeshBasicMaterial({ color }),
      );
      group.add(shell, wire, core);
      ctx.targetsGroup.add(group);
    }

    ctx.paint();
  }, [worldTargets, mode]);

  // Trigger camera fit on challenge switch or explicit button click
  useEffect(() => {
    if (fitRequestToken === 0) return;
    sceneCtxRef.current?.fitCamera();
  }, [fitRequestToken]);

  // Update 60fps pose + leader lines
  useEffect(() => {
    applyPosesAndPaint();
  }, [solved, showLeaders, showLabels, effectiveExplodePct, selectedNodeId, applyPosesAndPaint]);

  return (
    <div
      ref={hostRef}
      className="relative h-full min-h-[28rem] w-full overflow-hidden rounded-lg border bg-[#0f1716]"
    />
  );
}
