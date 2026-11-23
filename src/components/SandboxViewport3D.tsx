import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  frameToMatrixMm,
  solveArticulatedAssembly,
  type ArticulatedSolveResult,
} from "@contracts/articulated-kinematics";
import {
  classifyNodeFunctionalLayer,
  type FunctionalLayerId,
} from "@contracts/machine-evolution";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { MILO_STOCK, type MiloStockState } from "@contracts/milo-stock";
import { primitiveBoundingBoxMm } from "@contracts/primitive-parts";
import {
  matingInputAndExplode,
  SANDBOX_BLOCKS,
  SANDBOX_MOUNT_LABELS,
  type WorldTargetStatus,
} from "@contracts/sandbox-challenges";
import { buildPrimitivePartPackage, packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { createMiloStockMesh } from "./milo-stock-geometry";
import { createPrimitivePartGroup, disposeGroupResources } from "./primitive-part-mesh";

export interface SandboxViewport3DProps {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  mode: "build" | "test" | "explode";
  armedBlockId: string | null;
  selectedNodeId: string;
  preferredParentId?: string;
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
  // Enhanced showroom & trial simulation overlays
  stockState?: MiloStockState | null;
  xrayMode?: boolean;
  activeLayerId?: FunctionalLayerId | null;
  physicsHighlight?: {
    readonly overloadedNodeIds: readonly string[];
    readonly columnDeflectionUm: number;
    readonly cuttingForceN: number;
    readonly thrustForceN: number;
    readonly hasSpindle?: boolean;
  };
  idealTrailMm?: readonly (readonly [number, number, number])[];
  actualTrailMm?: readonly (readonly [number, number, number])[];
  trailInWorkpieceFrame?: boolean;
  showTipMarker?: boolean;
}

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

export default function SandboxViewport3D({
  workspace,
  assembly,
  mode,
  armedBlockId,
  selectedNodeId,
  preferredParentId,
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
  stockState,
  xrayMode = false,
  activeLayerId = null,
  physicsHighlight,
  idealTrailMm,
  actualTrailMm,
  trailInWorkpieceFrame = false,
  showTipMarker = false,
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
    stockAnchorGroup: THREE.Group;
    stockMeshCtrl: ReturnType<typeof createMiloStockMesh>;
    trailsGroup: THREE.Group;
    xrayGroup: THREE.Group;
    nodeObjects: Map<string, THREE.Group>;
    snapMeshes: Array<{
      mesh: THREE.Mesh;
      parentNodeId: string;
      mountId: string;
      parentLabel: string;
      mountMatrixWorld: THREE.Matrix4;
      isPreferred: boolean;
    }>;
    leaderLinesObj: THREE.LineSegments;
    tcpMarker: THREE.Mesh;
    labelsOverlay: HTMLDivElement;
    targetsOverlay: HTMLDivElement;
    tipBadgeEl: HTMLDivElement;
    xrayBadgeEl: HTMLDivElement;
    labelEls: Map<string, HTMLButtonElement>;
    targetBadgeEls: Map<string, HTMLDivElement>;
    lastAutoFitKey: string;
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
  const preferredParentRef = useRef(preferredParentId ?? "");
  const showLeadersRef = useRef(showLeaders);
  const showLabelsRef = useRef(showLabels);
  const explodePctRef = useRef(effectiveExplodePct);
  const worldTargetsRef = useRef(worldTargets);
  const stockStateRef = useRef(stockState);
  const xrayModeRef = useRef(xrayMode);
  const physicsRef = useRef(physicsHighlight);
  const trailInWorkpieceRef = useRef(trailInWorkpieceFrame);
  const showTipMarkerRef = useRef(showTipMarker);
  const onSelectRef = useRef(onSelectNode);
  const onSnapRef = useRef(onSnapBlock);
  const onHoverRef = useRef(onHoverSnapChange);

  useEffect(() => {
    solvedRef.current = solved;
    modeRef.current = mode;
    armedBlockRef.current = armedBlockId;
    selectedIdRef.current = selectedNodeId;
    preferredParentRef.current = preferredParentId ?? "";
    showLeadersRef.current = showLeaders;
    showLabelsRef.current = showLabels;
    explodePctRef.current = effectiveExplodePct;
    worldTargetsRef.current = worldTargets;
    stockStateRef.current = stockState;
    xrayModeRef.current = xrayMode;
    physicsRef.current = physicsHighlight;
    trailInWorkpieceRef.current = trailInWorkpieceFrame;
    showTipMarkerRef.current = showTipMarker;
    onSelectRef.current = onSelectNode;
    onSnapRef.current = onSnapBlock;
    onHoverRef.current = onHoverSnapChange;
  }, [
    solved,
    mode,
    armedBlockId,
    selectedNodeId,
    preferredParentId,
    showLeaders,
    showLabels,
    effectiveExplodePct,
    worldTargets,
    stockState,
    xrayMode,
    physicsHighlight,
    trailInWorkpieceFrame,
    showTipMarker,
    onSelectNode,
    onSnapBlock,
    onHoverSnapChange,
  ]);

  const applyPosesAndPaint = useCallback(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;
    const current = solvedRef.current;

    let wpNode: (typeof current.nodes)[number] | undefined;
    for (const node of current.nodes) {
      const grp = ctx.nodeObjects.get(node.path);
      if (!grp) continue;
      grp.visible = true;
      grp.matrixAutoUpdate = false;
      grp.matrix.copy(node.explodedMatrix);
      grp.matrixWorldNeedsUpdate = true;

      const isWp =
        node.pkg?.primitive?.finish === "workpiece_alloy" ||
        node.id.toLowerCase().includes("workpiece") ||
        node.label.includes("毛坯");
      if (isWp) wpNode = node;
    }

    // Real 3D milled voxel aluminum stock aligned flush onto the workpiece node
    const curStock = stockStateRef.current;
    if (curStock && wpNode) {
      const wpGrp = ctx.nodeObjects.get(wpNode.path);
      if (wpGrp) wpGrp.visible = false;
      const wpDims = wpNode.pkg?.primitive ? primitiveBoundingBoxMm(wpNode.pkg.primitive) : ([110, 90, 26] as const);
      ctx.stockAnchorGroup.visible = true;
      ctx.stockAnchorGroup.matrixAutoUpdate = false;
      ctx.stockAnchorGroup.matrix.copy(wpNode.explodedMatrix);
      ctx.stockAnchorGroup.matrixWorldNeedsUpdate = true;
      ctx.stockMeshCtrl.mesh.scale.set(
        wpDims[0] / MILO_STOCK.widthMm,
        wpDims[1] / MILO_STOCK.heightMm,
        wpDims[2] / MILO_STOCK.thicknessMm,
      );
      ctx.stockMeshCtrl.mesh.position.set(-wpDims[0] / 2, -wpDims[1] / 2, wpDims[2] / 2);
      ctx.stockMeshCtrl.update(curStock);
    } else {
      ctx.stockAnchorGroup.visible = false;
    }

    // Align planned/actual trajectory ribbon to moving workpiece top if machining
    ctx.trailsGroup.matrixAutoUpdate = false;
    if (trailInWorkpieceRef.current && wpNode) {
      const wpDims = wpNode.pkg?.primitive ? primitiveBoundingBoxMm(wpNode.pkg.primitive) : ([110, 90, 26] as const);
      ctx.trailsGroup.matrix
        .copy(wpNode.explodedMatrix)
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, wpDims[2] / 2));
    } else {
      ctx.trailsGroup.matrix.identity();
    }
    ctx.trailsGroup.matrixWorldNeedsUpdate = true;

    const obs = current.explodedObservationPointMm;
    ctx.tcpMarker.position.set(obs[0], obs[1], obs[2]);
    ctx.tcpMarker.visible =
      current.nodes.length > 0 &&
      (showTipMarkerRef.current || worldTargetsRef.current.length > 0 || modeRef.current === "test");

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

    // Live 3D X-Ray force vectors (motor thrust -> ball screw -> tool cutting reaction)
    disposeGroupResources(ctx.xrayGroup);
    ctx.xrayGroup.clear();
    if (xrayModeRef.current && current.nodes.length > 0) {
      const ph = physicsRef.current;
      const cutN = ph?.cuttingForceN ?? 28;
      const cutLen = clamp(32 + cutN * 0.45, 36, 115);
      const cutColor = (ph?.columnDeflectionUm ?? 0) > 48 ? 0xef4444 : 0xf59e0b;
      const cutArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0.75, -0.45, 0.48).normalize(),
        new THREE.Vector3(obs[0], obs[1], obs[2]),
        cutLen,
        cutColor,
        16,
        9,
      );
      ctx.xrayGroup.add(cutArrow);

      for (const node of current.nodes) {
        const spec = node.pkg?.primitive;
        if (!spec) continue;
        if (spec.shape === "servo_motor_body" && "axis" in spec) {
          const dir =
            spec.axis === "x"
              ? new THREE.Vector3(1, 0, 0)
              : spec.axis === "y"
                ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(0, 0, 1);
          const isOver = ph?.overloadedNodeIds.includes(node.id) ?? false;
          const mArrow = new THREE.ArrowHelper(
            dir,
            new THREE.Vector3(node.explodedPosMm[0], node.explodedPosMm[1], node.explodedPosMm[2]),
            52,
            isOver ? 0xef4444 : 0x38bdf8,
            13,
            7.5,
          );
          ctx.xrayGroup.add(mArrow);
        }
      }
    }

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
        '<div class="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">当前浏览器或无头环境暂不支持 WebGL 3D 渲染，可通过左侧控制面板操作积木与物理仿真。</div>';
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
    canvas.setAttribute("aria-label", "三维积木拼装与物理透视视口");

    const labelsOverlay = document.createElement("div");
    labelsOverlay.className = "pointer-events-none absolute inset-0 overflow-hidden";

    const targetsOverlay = document.createElement("div");
    targetsOverlay.className = "pointer-events-none absolute inset-0 overflow-hidden";

    const tipBadgeEl = document.createElement("div");
    tipBadgeEl.className =
      "pointer-events-none absolute hidden whitespace-nowrap rounded-full border border-orange-400/60 bg-[#1a1310]/90 px-2 py-0.5 text-[10px] font-medium text-orange-200 shadow";

    const xrayBadgeEl = document.createElement("div");
    xrayBadgeEl.className =
      "pointer-events-none absolute hidden whitespace-nowrap rounded-full border border-red-400/70 bg-[#2a0c0c]/95 px-2.5 py-0.5 text-[10px] font-semibold text-red-200 shadow-lg";

    container.innerHTML = "";
    container.append(canvas, labelsOverlay, targetsOverlay, tipBadgeEl, xrayBadgeEl);

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
    const stockAnchorGroup = new THREE.Group();
    const stockMeshCtrl = createMiloStockMesh();
    stockAnchorGroup.add(stockMeshCtrl.mesh);
    stockAnchorGroup.visible = false;
    const trailsGroup = new THREE.Group();
    const xrayGroup = new THREE.Group();
    ghostGroup.visible = false;
    scene.add(partsGroup, stockAnchorGroup, trailsGroup, xrayGroup, snapGroup, targetsGroup, ghostGroup);

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
    const targetBadgeEls = new Map<string, HTMLDivElement>();
    const snapMeshes: Array<{
      mesh: THREE.Mesh;
      parentNodeId: string;
      mountId: string;
      parentLabel: string;
      mountMatrixWorld: THREE.Matrix4;
      isPreferred: boolean;
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

      if (!tcpMarker.visible) {
        tipBadgeEl.style.display = "none";
      } else {
        projected.copy(tcpMarker.position).project(camera);
        if (projected.z > 1 || projected.z < -1) {
          tipBadgeEl.style.display = "none";
        } else {
          const hasSpindle = solvedRef.current.nodes.some(
            (n) => n.id.includes("spindle") || n.label.includes("主轴"),
          );
          tipBadgeEl.textContent = hasSpindle ? "● 刀尖点" : "● 当前末端点";
          tipBadgeEl.style.display = "block";
          const tx = clamp(((projected.x + 1) * w) / 2 + 10, 6, Math.max(6, w - 96));
          const ty = clamp(((1 - projected.y) * h) / 2 + 6, 6, Math.max(6, h - 26));
          tipBadgeEl.style.left = `${tx}px`;
          tipBadgeEl.style.top = `${ty}px`;
        }
      }

      const ph = physicsRef.current;
      const overloadId = ph?.overloadedNodeIds[0];
      const overNode = overloadId
        ? solvedRef.current.nodes.find((n) => n.id === overloadId || n.path === overloadId)
        : undefined;
      if (overNode) {
        projected.set(overNode.explodedPosMm[0], overNode.explodedPosMm[1], overNode.explodedPosMm[2] + 28).project(camera);
        if (projected.z <= 1 && projected.z >= -1) {
          xrayBadgeEl.textContent = `⚠️ 电机扭矩过载 (${overNode.label})`;
          xrayBadgeEl.style.display = "block";
          xrayBadgeEl.style.left = `${clamp(((projected.x + 1) * w) / 2 - 70, 6, Math.max(6, w - 180))}px`;
          xrayBadgeEl.style.top = `${clamp(((1 - projected.y) * h) / 2 - 22, 6, Math.max(6, h - 28))}px`;
        } else {
          xrayBadgeEl.style.display = "none";
        }
      } else if (xrayModeRef.current && ph?.hasSpindle && ph.columnDeflectionUm > 48) {
        const obsPt = solvedRef.current.explodedObservationPointMm;
        projected.set(obsPt[0], obsPt[1], obsPt[2] + 34).project(camera);
        if (projected.z <= 1 && projected.z >= -1) {
          xrayBadgeEl.textContent = `⚠️ 悬臂让刀 ${ph.columnDeflectionUm} μm`;
          xrayBadgeEl.style.display = "block";
          xrayBadgeEl.style.left = `${clamp(((projected.x + 1) * w) / 2 - 60, 6, Math.max(6, w - 160))}px`;
          xrayBadgeEl.style.top = `${clamp(((1 - projected.y) * h) / 2 - 24, 6, Math.max(6, h - 28))}px`;
        } else {
          xrayBadgeEl.style.display = "none";
        }
      } else {
        xrayBadgeEl.style.display = "none";
      }

      for (const t of worldTargetsRef.current) {
        const badge = targetBadgeEls.get(t.id);
        if (!badge) continue;
        projected.set(t.worldPosMm[0], t.worldPosMm[1], t.worldPosMm[2] + t.radiusMm + 8).project(camera);
        if (projected.z > 1 || projected.z < -1) {
          badge.style.display = "none";
          continue;
        }
        badge.style.display = "block";
        const bw = badge.offsetWidth || 104;
        const bh = badge.offsetHeight || 20;
        const bx = clamp(((projected.x + 1) * w) / 2 - bw / 2, 6, Math.max(6, w - bw - 6));
        const by = clamp(((1 - projected.y) * h) / 2 - bh, 6, Math.max(6, h - bh - 6));
        badge.style.left = `${bx}px`;
        badge.style.top = `${by}px`;
      }
    }

    function fitCamera() {
      partsGroup.updateMatrixWorld(true);
      const box = new THREE.Box3();
      if (partsGroup.children.length > 0) {
        try {
          box.setFromObject(partsGroup);
        } catch {
          box.makeEmpty();
        }
      }
      if (box.isEmpty()) {
        for (const node of solvedRef.current.nodes) {
          box.expandByPoint(new THREE.Vector3(node.explodedPosMm[0], node.explodedPosMm[1], node.explodedPosMm[2]));
        }
      }
      for (const t of worldTargetsRef.current) {
        const [x, y, z] = t.worldPosMm;
        const r = t.radiusMm;
        box.expandByPoint(new THREE.Vector3(x - r, y - r, z - r));
        box.expandByPoint(new THREE.Vector3(x + r, y + r, z + r));
      }
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 220);
      controls.target.copy(center);
      camera.position.set(center.x + span * 0.95, center.y - span * 1.35, center.z + span * 0.85);
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

    let resizeRaf = 0;
    const scheduleResize = () => {
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        resize();
      });
    };

    const observer = new ResizeObserver(scheduleResize);
    observer.observe(container);
    controls.addEventListener("change", paint);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPt: { x: number; y: number } | null = null;
    let hoveredSnap: (typeof snapMeshes)[number] | null = null;
    let lastPartHover = "";

    const toNdc = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const styleSnapResting = (snap: (typeof snapMeshes)[number]) => {
      const mat = snap.mesh.material as THREE.MeshStandardMaterial;
      if (snap.isPreferred) {
        mat.color.setHex(0x38bdf8);
        mat.emissive.setHex(0x0284c7);
        snap.mesh.scale.setScalar(1.22);
      } else {
        mat.color.setHex(0x2dd4bf);
        mat.emissive.setHex(0x0d9488);
        snap.mesh.scale.setScalar(1);
      }
    };

    const resetSnapHover = () => {
      if (hoveredSnap) {
        styleSnapResting(hoveredSnap);
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
        if (hoveredSnap || ghostGroup.visible) resetSnapHover();
        if (!armedBlockRef.current) {
          toNdc(e);
          raycaster.setFromCamera(pointer, camera);
          const partHits = raycaster.intersectObjects([...nodeObjects.values()], true);
          let obj: THREE.Object3D | null = partHits[0]?.object ?? null;
          while (obj && !obj.userData.nodePath) obj = obj.parent;
          const hoveredPath = obj?.userData.nodePath ? String(obj.userData.nodePath) : "";
          if (hoveredPath !== lastPartHover) {
            lastPartHover = hoveredPath;
            const node = hoveredPath ? solvedRef.current.nodes.find((n) => n.path === hoveredPath) : undefined;
            onHoverRef.current?.(node ? `部件「${node.label}」· 点击选中编辑尺寸或拆装` : "");
          }
        }
        return;
      }
      lastPartHover = "";
      toNdc(e);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(snapMeshes.map((s) => s.mesh), false);
      const hitMesh = hits[0]?.object as THREE.Mesh | undefined;
      const matched = hitMesh ? snapMeshes.find((s) => s.mesh === hitMesh) ?? null : null;

      if (matched === hoveredSnap) return;
      if (hoveredSnap) styleSnapResting(hoveredSnap);
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
      matched.mesh.scale.setScalar(1.42);

      const armedDef = SANDBOX_BLOCKS.find((b) => b.id === armedBlockRef.current);
      if (armedDef) {
        const bounds = primitiveBoundingBoxMm(armedDef.spec);
        const offset = matingInputAndExplode(matched.mountId, bounds).inputPosMm;
        const invInput = frameToMatrixMm({ positionMm: offset, quatWxyz: [1, 0, 0, 0] }).invert();
        const previewMatrix = matched.mountMatrixWorld.clone().multiply(invInput);
        ghostGroup.matrixAutoUpdate = false;
        ghostGroup.matrix.copy(previewMatrix);
        ghostGroup.matrixWorldNeedsUpdate = true;
        ghostGroup.visible = true;
      }
      const mountCaption = SANDBOX_MOUNT_LABELS[matched.mountId] ?? matched.mountId;
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
      stockAnchorGroup,
      stockMeshCtrl,
      trailsGroup,
      xrayGroup,
      nodeObjects,
      snapMeshes,
      leaderLinesObj,
      tcpMarker,
      labelsOverlay,
      targetsOverlay,
      tipBadgeEl,
      xrayBadgeEl,
      labelEls,
      targetBadgeEls,
      lastAutoFitKey: "",
      paint,
      fitCamera,
    };

    resize();

    return () => {
      sceneCtxRef.current = null;
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
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
      disposeGroupResources(trailsGroup);
      disposeGroupResources(xrayGroup);
      stockMeshCtrl.dispose();
      leaderLinesObj.geometry.dispose();
      leaderMat.dispose();
      tcpMarker.geometry.dispose();
      (tcpMarker.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      labelsOverlay.innerHTML = "";
      targetsOverlay.innerHTML = "";
      tipBadgeEl.remove();
      xrayBadgeEl.remove();
      canvas.remove();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, []);

  // Rebuild meshes when topology / selection / X-ray / layer isolation / overload state changes
  const packagesMap = useMemo(
    () => new Map(workspace.packages.map((p) => [packageKey(p), p])),
    [workspace.packages],
  );
  const overloadedKey = physicsHighlight?.overloadedNodeIds.join(",") ?? "";
  const structureSig = useMemo(
    () =>
      `${assembly.id}::${solved.nodes.map((n) => `${n.path}:${n.packageKey}`).join("|")}::sel=${selectedNodeId}::xray=${xrayMode ? 1 : 0}::layer=${activeLayerId ?? ""}::over=${overloadedKey}`,
    [assembly.id, solved.nodes, selectedNodeId, xrayMode, activeLayerId, overloadedKey],
  );

  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.partsGroup);
    ctx.partsGroup.clear();
    ctx.nodeObjects.clear();
    ctx.labelsOverlay.innerHTML = "";
    ctx.labelEls.clear();

    const overloadedSet = new Set(overloadedKey ? overloadedKey.split(",") : []);

    for (const node of solvedRef.current.nodes) {
      const pkg = node.pkg ?? packagesMap.get(node.packageKey);
      const isSel = selectedNodeId === node.path;
      const layer = classifyNodeFunctionalLayer(pkg);
      const isOverloaded = overloadedSet.has(node.path) || overloadedSet.has(node.id);
      const isDimmedByLayer = Boolean(activeLayerId && activeLayerId !== layer && !isSel);
      const makeXrayGhost = Boolean(isDimmedByLayer || (xrayMode && layer === "skeleton" && !isSel && !isOverloaded));

      const partGroup = createPrimitivePartGroup(pkg, { selected: isSel });
      if (makeXrayGhost || isOverloaded || (xrayMode && !isSel && (layer === "transmission" || layer === "actuator"))) {
        partGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
            if (makeXrayGhost) {
              child.material.transparent = true;
              child.material.opacity = isDimmedByLayer ? 0.14 : 0.22;
              child.material.depthWrite = false;
              child.castShadow = false;
            }
            if (isOverloaded) {
              child.material.emissive.setHex(0xdc2626);
              child.material.emissiveIntensity = 0.88;
            } else if (!makeXrayGhost && xrayMode && (layer === "transmission" || layer === "actuator")) {
              child.material.emissive.setHex(layer === "transmission" ? 0x0284c7 : 0x059669);
              child.material.emissiveIntensity = 0.36;
            }
          }
        });
      }

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

    if (ctx.lastAutoFitKey !== assembly.id) {
      ctx.lastAutoFitKey = assembly.id;
      ctx.fitCamera();
    }
  }, [structureSig, assembly.id, packagesMap, selectedNodeId, xrayMode, activeLayerId, overloadedKey, applyPosesAndPaint]);

  // Rebuild planned vs actual 3D trajectory ribbons
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.trailsGroup);
    ctx.trailsGroup.clear();

    if (idealTrailMm && idealTrailMm.length >= 2) {
      const pts = idealTrailMm.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(
        geo,
        new THREE.LineDashedMaterial({
          color: 0x38bdf8,
          dashSize: 3.5,
          gapSize: 2.2,
          transparent: true,
          opacity: 0.72,
          depthTest: false,
        }),
      );
      line.computeLineDistances();
      line.renderOrder = 2;
      ctx.trailsGroup.add(line);
    }

    if (actualTrailMm && actualTrailMm.length >= 2) {
      const pts = actualTrailMm.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const hasWarn = Boolean(overloadedKey) || (physicsHighlight?.columnDeflectionUm ?? 0) > 48;
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: hasWarn ? 0xf97316 : 0x34d399,
          transparent: true,
          opacity: 0.94,
          depthTest: false,
        }),
      );
      line.renderOrder = 3;
      ctx.trailsGroup.add(line);
    }

    ctx.paint();
  }, [idealTrailMm, actualTrailMm, overloadedKey, physicsHighlight?.columnDeflectionUm]);

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

  // Rebuild interactive snap spheres when build mode + armedBlockId + preferredParentId + nodes update
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
      const isPreferred = Boolean(preferredParentId && node.id === preferredParentId);
      for (const out of pkg.mechanics.outputs) {
        if (out.id === "center" && pkg.mechanics.outputs.length > 1) continue;
        if (out.id === "pos_z" || out.id === "neg_z") continue; // already covered by top/bottom
        if (occupied.has(`${node.id}::${out.id}`)) continue;

        const mountWorld = node.explodedMatrix.clone().multiply(frameToMatrixMm(out));
        const pos = new THREE.Vector3().setFromMatrixPosition(mountWorld);
        const snapMat = new THREE.MeshStandardMaterial({
          color: isPreferred ? 0x38bdf8 : 0x2dd4bf,
          emissive: isPreferred ? 0x0284c7 : 0x0d9488,
          emissiveIntensity: isPreferred ? 0.95 : 0.75,
          transparent: true,
          opacity: 0.92,
        });
        const orb = new THREE.Mesh(sphereGeo.clone(), snapMat);
        orb.position.copy(pos);
        if (isPreferred) orb.scale.setScalar(1.22);
        ctx.snapGroup.add(orb);

        const ringMat = new THREE.MeshBasicMaterial({
          color: isPreferred ? 0x7dd3fc : 0x5eead4,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: isPreferred ? 0.65 : 0.45,
        });
        const ring = new THREE.Mesh(haloGeo.clone(), ringMat);
        orb.add(ring);

        ctx.snapMeshes.push({
          mesh: orb,
          parentNodeId: node.id,
          mountId: out.id,
          parentLabel: node.label,
          mountMatrixWorld: mountWorld,
          isPreferred,
        });
      }
    }

    sphereGeo.dispose();
    haloGeo.dispose();
    ctx.paint();
  }, [mode, armedBlockId, preferredParentId, solved, assembly.nodes, packagesMap]);

  // Rebuild challenge target spheres and overlaid target labels
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    disposeGroupResources(ctx.targetsGroup);
    ctx.targetsGroup.clear();
    ctx.targetsOverlay.innerHTML = "";
    ctx.targetBadgeEls.clear();

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

      const badge = document.createElement("div");
      badge.textContent = `${t.hit ? "✅" : "🎯"} ${t.label}`;
      badge.className = `pointer-events-none absolute whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-md ${
        t.hit
          ? "border-emerald-400/60 bg-emerald-950/90 text-emerald-200"
          : "border-amber-400/60 bg-[#1d1609]/90 text-amber-200"
      }`;
      ctx.targetsOverlay.append(badge);
      ctx.targetBadgeEls.set(t.id, badge);
    }

    ctx.paint();
  }, [worldTargets, mode]);

  // Trigger camera fit on challenge switch or explicit button click
  useEffect(() => {
    if (fitRequestToken === 0) return;
    sceneCtxRef.current?.fitCamera();
  }, [fitRequestToken]);

  // Update 60fps pose + stock cutting mesh + X-Ray arrows + leader lines
  useEffect(() => {
    applyPosesAndPaint();
  }, [
    solved,
    stockState,
    xrayMode,
    physicsHighlight,
    trailInWorkpieceFrame,
    showTipMarker,
    showLeaders,
    showLabels,
    effectiveExplodePct,
    selectedNodeId,
    applyPosesAndPaint,
  ]);

  return (
    <div className="relative h-full min-h-[16rem] w-full overflow-hidden rounded-lg border bg-[#0f1716]">
      <div ref={hostRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-2 left-2.5 z-10 rounded-full border border-white/10 bg-[#0b1312]/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
        左键旋转 · 右键平移 · 滚轮缩放 · 点击零件选中
      </div>
    </div>
  );
}
