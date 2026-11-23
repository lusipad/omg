import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Layers, Pause, Play, RotateCcw, Save, Sliders, Sparkles } from "lucide-react";
import {
  solveArticulatedAssembly,
  type ArticulatedSolveResult,
} from "@contracts/articulated-kinematics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { createPrimitivePartGroup, disposeGroupResources } from "./primitive-part-mesh";

export interface ArticulatedAssemblyViewportProps {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  externalCommands?: Record<string, number>;
  externalStatusLabel?: string;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  onApplyCommands?: (commands: Record<string, number>) => void;
  compact?: boolean;
  hideHeader?: boolean;
}

const formatNum = (v: number) => Number(v.toFixed(2)).toString();
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

export default function ArticulatedAssemblyViewport({
  workspace,
  assembly,
  externalCommands,
  externalStatusLabel,
  selectedNodeId: controlledSelectedId,
  onSelectNode,
  onApplyCommands,
  compact = false,
  hideHeader = false,
}: ArticulatedAssemblyViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneCtxRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    renderer: THREE.WebGLRenderer;
    partsGroup: THREE.Group;
    nodeObjects: Map<string, THREE.Group>;
    leaderLinesObj: THREE.LineSegments;
    tcpMarker: THREE.Mesh;
    labelsOverlay: HTMLDivElement;
    labelEls: Map<string, HTMLButtonElement>;
    paint: () => void;
    fitCamera: () => void;
  } | null>(null);

  const [internalSelected, setInternalSelected] = useState<string>("");
  const selectedId = controlledSelectedId ?? internalSelected;
  const selectNode = useCallback(
    (id: string) => {
      if (onSelectNode) onSelectNode(id);
      else setInternalSelected(id);
    },
    [onSelectNode],
  );

  const assemblyStamp = useMemo(
    () => `${assembly.id}:${assembly.nodes.map((n) => `${n.id}=${n.packageKey}`).join(",")}`,
    [assembly],
  );
  const [motionState, setMotionState] = useState<{
    stamp: string;
    commands: Record<string, number>;
    autoDemo: boolean;
  }>(() => ({ stamp: assemblyStamp, commands: { ...assembly.commands }, autoDemo: false }));

  const [explodePct, setExplodePct] = useState(0);
  const [subtreeOnly, setSubtreeOnly] = useState(false);
  const [showLeaders, setShowLeaders] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [meshRevision, setMeshRevision] = useState(0);

  const localCommands = useMemo(
    () => (motionState.stamp === assemblyStamp ? motionState.commands : assembly.commands),
    [motionState, assemblyStamp, assembly.commands],
  );
  const autoDemo = motionState.stamp === assemblyStamp ? motionState.autoDemo : false;

  const setLocalCommands = useCallback(
    (updater: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => {
      setMotionState((prev) => {
        const baseCmds = prev.stamp === assemblyStamp ? prev.commands : assembly.commands;
        const baseDemo = prev.stamp === assemblyStamp ? prev.autoDemo : false;
        const nextCmds = typeof updater === "function" ? updater(baseCmds) : updater;
        return { stamp: assemblyStamp, commands: nextCmds, autoDemo: baseDemo };
      });
    },
    [assemblyStamp, assembly.commands],
  );

  const setAutoDemo = useCallback(
    (updater: boolean | ((prev: boolean) => boolean)) => {
      setMotionState((prev) => {
        const baseCmds = prev.stamp === assemblyStamp ? prev.commands : assembly.commands;
        const baseDemo = prev.stamp === assemblyStamp ? prev.autoDemo : false;
        const nextDemo = typeof updater === "function" ? updater(baseDemo) : updater;
        return { stamp: assemblyStamp, commands: baseCmds, autoDemo: nextDemo };
      });
    },
    [assemblyStamp, assembly.commands],
  );

  const activeCommands = externalCommands ?? localCommands;
  const explodeSubtreeRoot = subtreeOnly && selectedId ? selectedId : undefined;

  const solved: ArticulatedSolveResult = useMemo(
    () =>
      solveArticulatedAssembly(workspace, assembly, {
        commandOverrides: activeCommands,
        explodeFactor: explodePct / 100,
        explodeSubtreeRoot,
      }),
    [workspace, assembly, activeCommands, explodePct, explodeSubtreeRoot],
  );

  const solvedRef = useRef(solved);
  const showLeadersRef = useRef(showLeaders);
  const showLabelsRef = useRef(showLabels);
  const explodePctRef = useRef(explodePct);
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    solvedRef.current = solved;
    showLeadersRef.current = showLeaders;
    showLabelsRef.current = showLabels;
    explodePctRef.current = explodePct;
    selectedIdRef.current = selectedId;
  }, [solved, showLeaders, showLabels, explodePct, selectedId]);

  // Auto multi-axis animation (smooth circular pocket + cutter spin, works even while exploded)
  useEffect(() => {
    if (!autoDemo || externalCommands) return;
    let raf = 0;
    const t0 = performance.now();
    const controls = solvedRef.current.activeControls;
    const step = (now: number) => {
      const sec = (now - t0) / 1000;
      const next: Record<string, number> = {};
      controls.forEach((ctrl, idx) => {
        const [min, max] = ctrl.joint.range;
        if (ctrl.joint.type === "slide") {
          const mid = (min + max) / 2;
          const amp = (max - min) * 0.36;
          const phase = idx === 0 ? sec * 1.4 : idx === 1 ? sec * 1.4 + Math.PI / 2 : sec * 0.9;
          next[ctrl.path] = mid + amp * Math.sin(phase);
        } else {
          const span = max - min;
          const raw = (sec * 360) % Math.max(360, Math.min(span, 7200));
          next[ctrl.path] = min <= 0 && max >= 360 ? raw : min + ((sec * 180) % Math.max(1, span));
        }
      });
      setLocalCommands(next);
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [autoDemo, externalCommands, setLocalCommands]);

  const applyPosesAndPaint = useCallback(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;
    const current = solvedRef.current;

    for (const node of current.nodes) {
      const group = ctx.nodeObjects.get(node.path);
      if (!group) continue;
      group.matrixAutoUpdate = false;
      group.matrix.copy(node.explodedMatrix);
      group.matrixWorldNeedsUpdate = true;
    }

    const obs = current.explodedObservationPointMm;
    ctx.tcpMarker.position.set(obs[0], obs[1], obs[2]);

    // Dashed explosion leader lines
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
    const leaderGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    ctx.leaderLinesObj.geometry = leaderGeo;
    ctx.leaderLinesObj.computeLineDistances();
    ctx.leaderLinesObj.visible = linePts.length > 0;

    ctx.paint();
  }, []);

  // Initialize Three.js WebGL context once per mount
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const container = host;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      container.innerHTML =
        '<div class="grid h-full place-items-center p-4 text-center text-xs text-muted-foreground">当前浏览器或无头环境暂不支持 WebGL 三维渲染，仍可查看右侧运动学参数与安装坐标。</div>';
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111a18);

    const camera = new THREE.PerspectiveCamera(38, 1.5, 2, 18_000);
    camera.up.set(0, 0, 1);
    camera.position.set(520, -640, 420);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const canvas = renderer.domElement;
    canvas.className = "block h-full w-full touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${assembly.name} 可动机械与爆炸三维视图`);

    const labelsOverlay = document.createElement("div");
    labelsOverlay.className = "pointer-events-none absolute inset-0 overflow-hidden";

    container.innerHTML = "";
    container.append(canvas, labelsOverlay);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.target.set(0, 0, 120);
    controls.minDistance = 80;
    controls.maxDistance = 6000;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xf2fffb, 0x3b4d46, 1.55));
    const keyLight = new THREE.DirectionalLight(0xfffcf2, 1.9);
    keyLight.position.set(420, -480, 760);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xbbe8dc, 0.9);
    fillLight.position.set(-480, 420, 320);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(1600, 32, 0x365247, 0x1e302a);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -18;
    scene.add(grid);

    const partsGroup = new THREE.Group();
    scene.add(partsGroup);

    const leaderMat = new THREE.LineDashedMaterial({
      color: 0x6ce5c2,
      dashSize: 10,
      gapSize: 6,
      transparent: true,
      opacity: 0.85,
    });
    const leaderLinesObj = new THREE.LineSegments(new THREE.BufferGeometry(), leaderMat);
    scene.add(leaderLinesObj);

    const tcpMarker = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff8f68 }),
    );
    scene.add(tcpMarker);

    const nodeObjects = new Map<string, THREE.Group>();
    const labelEls = new Map<string, HTMLButtonElement>();
    const projected = new THREE.Vector3();

    function paint() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      renderer.render(scene, camera);

      const showAny = showLabelsRef.current && (explodePctRef.current >= 4 || Boolean(selectedIdRef.current));
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
        const bw = btn.offsetWidth || 84;
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
      ctxPartsBoxUpdate();
      const box = new THREE.Box3().setFromObject(partsGroup);
      if (box.isEmpty()) {
        for (const node of solvedRef.current.nodes) {
          box.expandByPoint(new THREE.Vector3(node.explodedPosMm[0], node.explodedPosMm[1], node.explodedPosMm[2]));
        }
      }
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.length() * 0.5, 110);
      const vFovRad = (camera.fov * Math.PI) / 180;
      const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * Math.max(camera.aspect, 0.75));
      const minFov = Math.min(vFovRad, hFovRad);
      const dist = Math.max((radius / Math.sin(minFov / 2)) * 1.12, Math.max(size.x, size.y, size.z) * 1.45);
      const dir = new THREE.Vector3(0.68, -0.78, 0.52).normalize();
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.near = Math.max(1, dist * 0.01);
      camera.far = Math.max(18_000, dist * 12);
      camera.updateProjectionMatrix();
      controls.update();
      paint();
    }

    function ctxPartsBoxUpdate() {
      scene.updateMatrixWorld(true);
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

    const picker = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPt: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      if (e.isPrimary && e.button === 0) downPt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downPt || Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 6) {
        downPt = null;
        return;
      }
      downPt = null;
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      picker.setFromCamera(pointer, camera);
      const hits = picker.intersectObjects([...nodeObjects.values()], true);
      let hitObj: THREE.Object3D | null = hits[0]?.object ?? null;
      while (hitObj && !hitObj.userData.nodePath) hitObj = hitObj.parent;
      if (hitObj?.userData.nodePath) selectNode(String(hitObj.userData.nodePath));
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    sceneCtxRef.current = {
      scene,
      camera,
      controls,
      renderer,
      partsGroup,
      nodeObjects,
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
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      disposeGroupResources(partsGroup);
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
  }, [assembly.name, selectNode]);

  // Rebuild meshes when topology, package revisions, or selected highlight change
  const structureKey = useMemo(
    () =>
      `${solved.nodes.map((n) => `${n.path}:${n.packageKey}`).join("|")}::sel=${selectedId}::${meshRevision}`,
    [solved.nodes, selectedId, meshRevision],
  );
  const packagesMap = useMemo(
    () => new Map(workspace.packages.map((p) => [packageKey(p), p])),
    [workspace.packages],
  );

  const fittedStampRef = useRef<string>("");

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
      const isSel = selectedId === node.path;
      const partGroup = createPrimitivePartGroup(pkg, {
        selected: isSel,
        onAsyncLoaded: () => setMeshRevision((r) => r + 1),
      });
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
      pill.onclick = () => selectNode(node.path);
      ctx.labelsOverlay.append(pill);
      ctx.labelEls.set(node.path, pill);
    }

    applyPosesAndPaint();
    if (fittedStampRef.current !== assemblyStamp) {
      fittedStampRef.current = assemblyStamp;
      ctx.fitCamera();
    }
  }, [structureKey, assemblyStamp, packagesMap, selectedId, selectNode, applyPosesAndPaint]);

  // Fast 60 FPS pose + explode updates with zero geometry rebuild
  useEffect(() => {
    applyPosesAndPaint();
  }, [solved, showLeaders, showLabels, explodePct, selectedId, applyPosesAndPaint]);

  const selectedSolved = solved.nodes.find((n) => n.path === selectedId) ?? solved.nodes[0];

  return (
    <section className={hideHeader ? "min-w-0 space-y-2.5" : "surface space-y-3 p-3 sm:p-4"} aria-label="可动与三维爆炸交互视口">
      {!hideHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Layers className="size-4 text-primary" />
              <span>{assembly.name} · 三维可动装配与层级爆炸视图</span>
            </h3>
            <p className="text-[11px] text-muted-foreground">
              共 {solved.nodes.length} 个实体部件 · {solved.activeControls.length} 个主动关节 · {solved.coupledControls.length} 个随动耦合副 · 支持实时机械运动与层级拆解
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!externalCommands && solved.activeControls.length > 0 && (
              <Button
                size="sm"
                variant={autoDemo ? "default" : "outline"}
                onClick={() => setAutoDemo((v) => !v)}
              >
                {autoDemo ? <Pause /> : <Play />}
                {autoDemo ? "暂停联动演示" : "多轴联动演示"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => sceneCtxRef.current?.fitCamera()}>
              <RotateCcw />
              视角居中
            </Button>
            {!externalCommands && onApplyCommands && solved.activeControls.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => onApplyCommands(localCommands)}>
                <Save />
                写入装配指令
              </Button>
            )}
          </div>
        </div>
      )}

      {externalStatusLabel && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
          <div>
            <Sparkles className="mr-1.5 inline size-3.5" />
            {externalStatusLabel}
          </div>
          {hideHeader && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-primary" onClick={() => sceneCtxRef.current?.fitCamera()}>
              <RotateCcw className="size-3" />
              视角居中
            </Button>
          )}
        </div>
      )}

      {/* Exploded View Control Strip */}
      <div className="surface-inset flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-xs">
        <label className="flex min-w-44 flex-1 items-center gap-2">
          <span className="shrink-0 font-medium">三维爆炸展开</span>
          <input
            type="range"
            aria-label="三维爆炸展开比例"
            min={0}
            max={100}
            step={1}
            value={explodePct}
            className="h-4 flex-1 accent-primary"
            onChange={(e) => setExplodePct(Number(e.currentTarget.value))}
          />
          <span className="mono w-10 text-right">{explodePct}%</span>
        </label>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" className="h-7 px-2 text-xs" variant={explodePct === 0 ? "secondary" : "ghost"} onClick={() => setExplodePct(0)}>
            收拢
          </Button>
          <Button size="sm" className="h-7 px-2 text-xs" variant={explodePct === 45 ? "secondary" : "ghost"} onClick={() => setExplodePct(45)}>
            半爆 45%
          </Button>
          <Button size="sm" className="h-7 px-2 text-xs" variant={explodePct === 100 ? "secondary" : "ghost"} onClick={() => setExplodePct(100)}>
            全爆 100%
          </Button>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showLeaders}
            onChange={(e) => setShowLeaders(e.currentTarget.checked)}
          />
          <span>拆装引导线</span>
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setShowLabels(e.currentTarget.checked)}
          />
          <span>爆炸零件铭牌</span>
        </label>
        {selectedId && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-primary">
            <input
              type="checkbox"
              checked={subtreeOnly}
              onChange={(e) => setSubtreeOnly(e.currentTarget.checked)}
            />
            <span>仅炸开所选分支（{selectedSolved?.label ?? selectedId}）</span>
          </label>
        )}
      </div>

      <div className={`grid gap-3 ${compact ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(15rem,1fr)]" : "lg:grid-cols-[minmax(0,1.8fr)_minmax(17rem,1fr)]"}`}>
        {/* 3D Canvas Host */}
        <div
          ref={hostRef}
          className={`relative w-full overflow-hidden rounded-md border bg-[#111a18] ${compact ? "h-80 sm:h-96" : "h-96 sm:h-[30rem]"}`}
        />

        {/* Real-time Joint Controls / Closed-Loop Readout & Part Info */}
        <div className="surface-inset flex min-w-0 flex-col justify-between gap-3 p-3 text-xs">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between border-b pb-2">
              <span className="flex items-center gap-1.5 font-medium">
                <Sliders className="size-3.5 text-primary" />
                {externalCommands ? "闭环轨迹实时联动读数" : "实时关节手轮控制"}
              </span>
              {!externalCommands && solved.activeControls.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => {
                    setAutoDemo(false);
                    const zeros: Record<string, number> = {};
                    for (const ctrl of solved.activeControls) {
                      zeros[ctrl.path] = clamp(0, ctrl.joint.range[0], ctrl.joint.range[1]);
                    }
                    setLocalCommands(zeros);
                  }}
                >
                  全部回零
                </button>
              )}
            </div>

            {solved.activeControls.length === 0 ? (
              <p className="text-muted-foreground">当前装配的部件全部为刚性固连（可通过下方编辑将任一部件改为移动副 slide 或转动副 hinge）。</p>
            ) : externalCommands ? (
              <div className="space-y-2">
                {solved.activeControls.map((ctrl) => {
                  const unit = ctrl.joint.type === "slide" ? "mm" : "°";
                  const [min, max] = ctrl.joint.range;
                  const pct = clamp(((ctrl.value - min) / Math.max(1e-6, max - min)) * 100, 0, 100);
                  return (
                    <div key={ctrl.path} className="space-y-1.5 rounded border bg-background/60 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium" title={ctrl.path}>{ctrl.label}</span>
                        <span className="mono shrink-0 font-semibold text-primary">
                          {formatNum(ctrl.value)} {unit}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {solved.activeControls.map((ctrl) => {
                  const unit = ctrl.joint.type === "slide" ? "mm" : "°";
                  return (
                    <label key={ctrl.path} className="block space-y-1 rounded border bg-background/60 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium" title={ctrl.path}>
                          {ctrl.label}
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            ({ctrl.joint.type === "slide" ? "移动" : "转动"})
                          </span>
                        </span>
                        <span className="mono shrink-0 text-primary">
                          {formatNum(ctrl.value)} {unit}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label={`关节 ${ctrl.label}`}
                        min={ctrl.joint.range[0]}
                        max={ctrl.joint.range[1]}
                        step={ctrl.joint.type === "slide" ? 0.5 : 1}
                        value={ctrl.value}
                        className="h-4 w-full accent-primary"
                        onChange={(e) => {
                          setAutoDemo(false);
                          const v = Number(e.currentTarget.value);
                          setLocalCommands((prev) => ({ ...prev, [ctrl.path]: v }));
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            )}

            {solved.coupledControls.length > 0 && (
              <div className="space-y-1 border-t pt-2">
                <p className="text-[11px] font-medium text-muted-foreground">联动传动副（自动随动）：</p>
                {solved.coupledControls.map((c) => (
                  <div key={c.path} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-muted-foreground">
                      {c.label}（{c.coupledSummary}）
                    </span>
                    <span className="mono shrink-0 text-foreground">{formatNum(c.value)}°</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t pt-2 text-[11px]">
            <div>
              <span className="text-muted-foreground">输出观察点（未爆炸 / 真实末端）：</span>
              <p className="mono font-medium text-foreground">
                X {formatNum(solved.observationPointMm[0])} · Y {formatNum(solved.observationPointMm[1])} · Z{" "}
                {formatNum(solved.observationPointMm[2])} mm
              </p>
            </div>
            {selectedSolved && (
              <div className="rounded border bg-background/70 p-2">
                <p className="font-medium text-foreground">
                  选中零件：{selectedSolved.label}（{selectedSolved.id}）
                </p>
                <p className="text-muted-foreground">
                  层级深度：L{selectedSolved.depth} · 当前爆炸偏移：[{selectedSolved.explodeDeltaMm.map(formatNum).join(", ")}] mm
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
