import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Blocks,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FolderOpen,
  Hammer,
  Layers,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { solveArticulatedAssembly } from "@contracts/articulated-kinematics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { upsertMechanicalAssembly } from "@contracts/mechanical-assembly";
import { primitiveBoundingBoxMm, type AxisDir } from "@contracts/primitive-parts";
import {
  buildAssemblyTreeRows,
  computeChallengeGuide,
  convertSandboxToSystemTwin,
  createChallengeSolution,
  createChallengeStarter,
  deleteSandboxMachineFromWorkspace,
  evaluateChallengeProgress,
  extractSandboxBomSummary,
  findBestSnapTarget,
  listSavedSandboxMachines,
  loadSandboxMachineFromWorkspace,
  REAL_VENDOR_BOM_PRESETS,
  removeSandboxNode,
  SANDBOX_BLOCKS,
  SANDBOX_CHALLENGES,
  sandboxBomToCsv,
  saveSandboxMachineToWorkspace,
  snapBlockOntoAssembly,
  updateSandboxNode,
  type SandboxBlockCategory,
  type SandboxChallengeDef,
} from "@contracts/sandbox-challenges";
import { type StudioRoute } from "@contracts/studio-navigation";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { downloadBlob } from "@/lib/download";
import { SandboxBlockIcon } from "./SandboxBlockIcon";
import SandboxViewport3D from "./SandboxViewport3D";
import { VisionIntakePanel } from "./VisionIntakePanel";

export interface SandboxBuilderStudioProps {
  workspace: TwinWorkspace;
  initialChallengeId?: string;
  onSaveWorkspace: (next: TwinWorkspace) => void;
  onNavigate: (route: StudioRoute, message?: string) => void;
}

type StudioMode = "build" | "test" | "explode";
type PaletteFilter = "all" | SandboxBlockCategory;

interface SandboxSessionState {
  challengeId: SandboxChallengeDef["id"];
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  commands: Record<string, number>;
  visitedIds: Set<string>;
  completedIds: Set<string>;
  dirty: boolean;
  history: Array<{ workspace: TwinWorkspace; assembly: MechanicalAssembly }>;
}

const COMPLETED_STORAGE_KEY = "gouyuan.sandbox.completed.v1";
const CHALLENGE_IDS = new Set<string>(SANDBOX_CHALLENGES.map((c) => c.id));
const FILTER_TABS: ReadonlyArray<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "frame", label: "骨架" },
  { id: "motion", label: "关节" },
  { id: "actuator", label: "动力" },
  { id: "sensor", label: "传感" },
];

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const formatNum = (v: number) => Number(v.toFixed(1)).toString();

function readCompletedChallengeIds(): string[] {
  try {
    const raw = window.localStorage.getItem(COMPLETED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCompletedChallengeIds(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / private mode
  }
}

function resolveInitialChallenge(id?: string): SandboxChallengeDef["id"] {
  return id && CHALLENGE_IDS.has(id) ? (id as SandboxChallengeDef["id"]) : "level-1-axis";
}

function getPrimaryLengthMm(pkgSpec?: ReturnType<typeof primitiveBoundingBoxMm>, specShape?: string, rawSpec?: Record<string, unknown>): number | undefined {
  if (!rawSpec || !specShape) return pkgSpec?.[0];
  if (typeof rawSpec.lengthMm === "number") return rawSpec.lengthMm;
  if (typeof rawSpec.railLengthMm === "number") return rawSpec.railLengthMm;
  if (typeof rawSpec.widthMm === "number") return rawSpec.widthMm;
  if (typeof rawSpec.bodyLengthMm === "number") return rawSpec.bodyLengthMm;
  return pkgSpec?.[0];
}

function makeInitialState(id: SandboxChallengeDef["id"], completedIds: Set<string>): SandboxSessionState {
  const starter = createChallengeStarter(id);
  return {
    challengeId: id,
    workspace: starter.workspace,
    assembly: starter.assembly,
    commands: { ...starter.assembly.commands },
    visitedIds: new Set<string>(),
    completedIds,
    dirty: false,
    history: [],
  };
}

export default function SandboxBuilderStudio({
  workspace,
  initialChallengeId,
  onSaveWorkspace,
  onNavigate,
}: SandboxBuilderStudioProps) {
  const [state, setState] = useState<SandboxSessionState>(() =>
    makeInitialState(resolveInitialChallenge(initialChallengeId), new Set(readCompletedChallengeIds())),
  );
  const [mode, setMode] = useState<StudioMode>("build");
  const [paletteFilter, setPaletteFilter] = useState<PaletteFilter>("all");
  const [armedBlockId, setArmedBlockId] = useState<string | null>(null);
  const [preferredParentId, setPreferredParentId] = useState<string>("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [hoverHint, setHoverHint] = useState("");
  const [explodePct, setExplodePct] = useState(45);
  const [subtreeOnly, setSubtreeOnly] = useState(false);
  const [showLeaders, setShowLeaders] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [autoSweeping, setAutoSweeping] = useState(false);
  const [fitToken, setFitToken] = useState(1);
  const [outlinerOpen, setOutlinerOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<"left" | "right">("left");
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [projectTab, setProjectTab] = useState<"challenges" | "saved">("challenges");
  const [saveNameDraft, setSaveNameDraft] = useState("");
  const [saveFeedback, setSaveFeedback] = useState("");
  const [bomOpen, setBomOpen] = useState(false);
  const [bomTab, setBomTab] = useState<"bom" | "photo">("bom");
  const [error, setError] = useState("");
  const [customWidthInput, setCustomWidthInput] = useState("");

  const challenge = useMemo(
    () => SANDBOX_CHALLENGES.find((c) => c.id === state.challengeId) ?? SANDBOX_CHALLENGES[0]!,
    [state.challengeId],
  );

  const solved = useMemo(
    () =>
      solveArticulatedAssembly(state.workspace, state.assembly, {
        commandOverrides: state.commands,
        explodeFactor: mode === "explode" ? explodePct / 100 : 0,
        explodeSubtreeRoot: mode === "explode" && subtreeOnly && selectedNodeId ? selectedNodeId : undefined,
      }),
    [state.workspace, state.assembly, state.commands, mode, explodePct, subtreeOnly, selectedNodeId],
  );

  const progress = useMemo(
    () => evaluateChallengeProgress(challenge, state.workspace, state.assembly, solved, state.visitedIds),
    [challenge, state.workspace, state.assembly, solved, state.visitedIds],
  );

  const guide = useMemo(
    () => computeChallengeGuide(challenge, state.workspace, state.assembly, solved, progress),
    [challenge, state.workspace, state.assembly, solved, progress],
  );

  const treeRows = useMemo(
    () => buildAssemblyTreeRows(state.workspace, state.assembly, solved),
    [state.workspace, state.assembly, solved],
  );

  const bomRows = useMemo(
    () => extractSandboxBomSummary(state.workspace, state.assembly),
    [state.workspace, state.assembly],
  );

  const savedMachines = useMemo(() => listSavedSandboxMachines(workspace), [workspace]);

  const filteredBlocks = useMemo(
    () => (paletteFilter === "all" ? SANDBOX_BLOCKS : SANDBOX_BLOCKS.filter((b) => b.category === paletteFilter)),
    [paletteFilter],
  );

  const stateRef = useRef(state);
  const challengeRef = useRef(challenge);
  useEffect(() => {
    stateRef.current = state;
    challengeRef.current = challenge;
  }, [state, challenge]);

  // Persist completed challenge badges cleanly outside render
  useEffect(() => {
    writeCompletedChallengeIds(state.completedIds);
  }, [state.completedIds]);

  // Auto clear save confirmation banner
  useEffect(() => {
    if (!saveFeedback) return;
    const timer = window.setTimeout(() => setSaveFeedback(""), 2200);
    return () => window.clearTimeout(timer);
  }, [saveFeedback]);

  // Escape cancels armed block placement / preferred parent
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setArmedBlockId(null);
        setPreferredParentId("");
        setHoverHint("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const applyCommandsAndScore = useCallback((nextCmds: Record<string, number>) => {
    setState((prev) => {
      const ch = SANDBOX_CHALLENGES.find((c) => c.id === prev.challengeId) ?? SANDBOX_CHALLENGES[0]!;
      const preview = solveArticulatedAssembly(prev.workspace, prev.assembly, { commandOverrides: nextCmds });
      const check = evaluateChallengeProgress(ch, prev.workspace, prev.assembly, preview, prev.visitedIds);
      const nextVisited = new Set(prev.visitedIds);
      for (const hitId of check.newlyHitIds) nextVisited.add(hitId);
      let nextCompleted = prev.completedIds;
      if (check.completed && !prev.completedIds.has(prev.challengeId)) {
        nextCompleted = new Set(prev.completedIds);
        nextCompleted.add(prev.challengeId);
      }
      return { ...prev, commands: nextCmds, visitedIds: nextVisited, completedIds: nextCompleted };
    });
  }, []);

  // Auto demo sweep across challenge waypoints or sinusoidal joint scan
  useEffect(() => {
    if (!autoSweeping || mode !== "test") return;
    let raf = 0;
    const t0 = performance.now();
    const controlsSnapshot = solveArticulatedAssembly(stateRef.current.workspace, stateRef.current.assembly).activeControls;
    const sweep = challengeRef.current.demoSweep;

    const tick = (now: number) => {
      const elapsedSec = (now - t0) / 1000;
      const next: Record<string, number> = {};

      if (sweep && sweep.length > 0 && controlsSnapshot.every((c) => sweep.some((wp) => Object.hasOwn(wp, c.path)))) {
        const segDur = 1.4;
        const totalDur = sweep.length * segDur;
        const loopT = elapsedSec % totalDur;
        const idx = Math.floor(loopT / segDur);
        const frac = (loopT - idx * segDur) / segDur;
        const fromWp = idx === 0 ? stateRef.current.assembly.commands : sweep[idx - 1]!;
        const toWp = sweep[idx]!;
        for (const c of controlsSnapshot) {
          const a = fromWp[c.path] ?? 0;
          const b = toWp[c.path] ?? a;
          next[c.path] = a + (b - a) * Math.min(1, frac * 1.15);
        }
      } else {
        controlsSnapshot.forEach((ctrl, i) => {
          const [min, max] = ctrl.joint.range;
          if (ctrl.joint.type === "slide") {
            const mid = (min + max) / 2;
            const amp = (max - min) * 0.42;
            next[ctrl.path] = mid + amp * Math.sin(elapsedSec * 1.35 + i * 1.1);
          } else {
            const span = Math.min(360, max - min);
            next[ctrl.path] = clamp(Math.sin(elapsedSec * 1.1 + i * 0.9) * (span * 0.45), min, max);
          }
        });
      }

      applyCommandsAndScore(next);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [autoSweeping, mode, applyCommandsAndScore]);

  function switchChallenge(nextId: SandboxChallengeDef["id"]) {
    setAutoSweeping(false);
    setArmedBlockId(null);
    setPreferredParentId("");
    setSelectedNodeId("");
    setHoverHint("");
    setError("");
    setMode("build");
    setState((prev) => makeInitialState(nextId, prev.completedIds));
    setProjectManagerOpen(false);
    setFitToken((n) => n + 1);
  }

  function loadReferenceSolution(targetChallengeId?: SandboxChallengeDef["id"]) {
    const cid = targetChallengeId ?? state.challengeId;
    setAutoSweeping(false);
    setArmedBlockId(null);
    setPreferredParentId("");
    setError("");
    const ch = SANDBOX_CHALLENGES.find((c) => c.id === cid) ?? challenge;
    const sol = createChallengeSolution(cid);
    const preview = solveArticulatedAssembly(sol.workspace, sol.assembly);
    const check = evaluateChallengeProgress(ch, sol.workspace, sol.assembly, preview, new Set());
    setState((prev) => ({
      ...prev,
      challengeId: cid,
      workspace: sol.workspace,
      assembly: sol.assembly,
      commands: { ...sol.assembly.commands },
      visitedIds: new Set(check.newlyHitIds),
      dirty: true,
      history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
    }));
    setSelectedNodeId("");
    setProjectManagerOpen(false);
    setFitToken((n) => n + 1);
  }

  function undoLast() {
    setAutoSweeping(false);
    setError("");
    setState((prev) => {
      const last = prev.history.at(-1);
      if (!last) return prev;
      return {
        ...prev,
        workspace: last.workspace,
        assembly: last.assembly,
        commands: { ...last.assembly.commands },
        dirty: true,
        history: prev.history.slice(0, -1),
      };
    });
    setSelectedNodeId("");
    setPreferredParentId("");
  }

  const handleSnapBlock = useCallback(
    (parentNodeId: string, parentMountId: string) => {
      if (!armedBlockId) return;
      setError("");
      try {
        const cur = stateRef.current;
        const res = snapBlockOntoAssembly(cur.workspace, cur.assembly, armedBlockId, parentNodeId, parentMountId);
        const preview = solveArticulatedAssembly(res.workspace, res.assembly);
        const check = evaluateChallengeProgress(challengeRef.current, res.workspace, res.assembly, preview, cur.visitedIds);
        const nextVisited = new Set([...cur.visitedIds, ...check.newlyHitIds]);
        setState((prev) => {
          let nextCompleted = prev.completedIds;
          if (check.completed && !prev.completedIds.has(prev.challengeId)) {
            nextCompleted = new Set(prev.completedIds);
            nextCompleted.add(prev.challengeId);
          }
          return {
            ...prev,
            workspace: res.workspace,
            assembly: res.assembly,
            commands: { ...res.assembly.commands },
            visitedIds: nextVisited,
            completedIds: nextCompleted,
            dirty: true,
            history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
          };
        });
        setSelectedNodeId(res.addedNodeId);
        setCustomWidthInput("");
        setArmedBlockId(null);
        setPreferredParentId("");
        setHoverHint("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "吸附连接失败，请尝试其他接口。");
      }
    },
    [armedBlockId],
  );

  function quickSnapBlock(blockId: string, overrideParentId?: string) {
    setError("");
    const cur = stateRef.current;
    const hintParent = overrideParentId ?? (preferredParentId || undefined);
    const best = findBestSnapTarget(cur.workspace, cur.assembly, blockId, hintParent);
    if (!best) {
      setError("当前机器暂无合适空闲安装位，请在右侧「装配结构树」点 + 指定挂载零件，或拆除不需要的零件。");
      return;
    }
    try {
      const res = snapBlockOntoAssembly(cur.workspace, cur.assembly, blockId, best.parentNodeId, best.parentMountId);
      const preview = solveArticulatedAssembly(res.workspace, res.assembly);
      const check = evaluateChallengeProgress(challengeRef.current, res.workspace, res.assembly, preview, cur.visitedIds);
      const nextVisited = new Set([...cur.visitedIds, ...check.newlyHitIds]);
      setState((prev) => {
        let nextCompleted = prev.completedIds;
        if (check.completed && !prev.completedIds.has(prev.challengeId)) {
          nextCompleted = new Set(prev.completedIds);
          nextCompleted.add(prev.challengeId);
        }
        return {
          ...prev,
          workspace: res.workspace,
          assembly: res.assembly,
          commands: { ...res.assembly.commands },
          visitedIds: nextVisited,
          completedIds: nextCompleted,
          dirty: true,
          history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
        };
      });
      const blk = SANDBOX_BLOCKS.find((b) => b.id === blockId);
      setSelectedNodeId(res.addedNodeId);
      setCustomWidthInput("");
      setArmedBlockId(null);
      setPreferredParentId("");
      setMode("build");
      setHoverHint(`已自动将「${blk?.name ?? blockId}」装到「${best.parentLabel}」的 ${best.mountLabel}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "快捷安装失败，请尝试点 3D 发光球手动吸附。");
    }
  }

  function mutateNode(nodeId: string, patch: Parameters<typeof updateSandboxNode>[3]) {
    setError("");
    try {
      const res = updateSandboxNode(state.workspace, state.assembly, nodeId, patch);
      setState((prev) => ({
        ...prev,
        workspace: res.workspace,
        assembly: res.assembly,
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新积木属性失败。");
    }
  }

  function deleteNodeById(nodeId: string) {
    setError("");
    try {
      const nextAsm = removeSandboxNode(state.workspace, state.assembly, nodeId);
      setState((prev) => ({
        ...prev,
        assembly: nextAsm,
        commands: { ...nextAsm.commands },
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
      if (selectedNodeId === nodeId) setSelectedNodeId("");
      if (preferredParentId === nodeId) setPreferredParentId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法拆除该积木。");
    }
  }

  function handleSaveCurrentMachine(options?: { asNewCopy?: boolean; customName?: string }) {
    setError("");
    try {
      const res = saveSandboxMachineToWorkspace(workspace, state.workspace, state.assembly, options);
      onSaveWorkspace(res.workspace);
      setState((prev) => ({
        ...prev,
        assembly: res.savedAssembly,
        dirty: false,
      }));
      setSaveFeedback(options?.asNewCopy ? `已另存为「${res.savedAssembly.name}」` : `已保存「${res.savedAssembly.name}」`);
      setSaveNameDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存到本地机器库失败。");
    }
  }

  function handleLoadSavedMachine(assemblyId: string) {
    setError("");
    try {
      const loaded = loadSandboxMachineFromWorkspace(workspace, assemblyId);
      setAutoSweeping(false);
      setArmedBlockId(null);
      setPreferredParentId("");
      setSelectedNodeId("");
      setMode("build");
      setState((prev) => ({
        ...prev,
        challengeId: "free-sandbox",
        workspace: loaded.workspace,
        assembly: loaded.assembly,
        commands: { ...loaded.assembly.commands },
        visitedIds: new Set<string>(),
        dirty: false,
        history: [],
      }));
      setProjectManagerOpen(false);
      setFitToken((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "载入机器失败。");
    }
  }

  function handleDeleteSavedMachine(assemblyId: string) {
    setError("");
    try {
      const nextHost = deleteSandboxMachineFromWorkspace(workspace, assemblyId);
      onSaveWorkspace(nextHost);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除机器失败。");
    }
  }

  function launchClosedLoopTwin() {
    try {
      const { workspace: convertedWs, system } = convertSandboxToSystemTwin(state.workspace, state.assembly);
      const merged = upsertMechanicalAssembly(convertedWs, state.assembly);
      const finalWs: TwinWorkspace = {
        ...workspace,
        ...merged,
        packages: [
          ...workspace.packages.filter((p) => !merged.packages.some((mp) => packageKey(mp) === packageKey(p))),
          ...merged.packages,
        ],
        systems: [
          ...(workspace.systems ?? []).filter((s) => s.id !== system.id),
          system,
        ],
      };
      onSaveWorkspace(finalWs);
      setBomOpen(false);
      onNavigate({ view: "workbench", target: `system:${system.id}` }, `已由当前拼装生成闭环系统「${system.name}」。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转换为闭环验证工程失败。");
    }
  }

  const selectedSolved = solved.nodes.find((n) => n.path === selectedNodeId);
  const selectedRawNode = state.assembly.nodes.find((n) => n.id === selectedNodeId);
  const selectedPkg = selectedRawNode ? state.workspace.packages.find((p) => packageKey(p) === selectedRawNode.packageKey) : undefined;
  const selectedPart = selectedPkg?.mechanics?.kind === "part" ? selectedPkg.mechanics : undefined;
  const selectedCurrentPrimaryLen = useMemo(() => {
    if (!selectedPkg?.primitive) return undefined;
    const bbox = primitiveBoundingBoxMm(selectedPkg.primitive);
    return getPrimaryLengthMm(bbox, selectedPkg.primitive.shape, selectedPkg.primitive as unknown as Record<string, unknown>);
  }, [selectedPkg]);

  const nextChallenge = useMemo(() => {
    const idx = SANDBOX_CHALLENGES.findIndex((c) => c.id === state.challengeId);
    return idx >= 0 && idx + 1 < SANDBOX_CHALLENGES.length ? SANDBOX_CHALLENGES[idx + 1] : null;
  }, [state.challengeId]);

  const isUserSavedMachine = !state.assembly.id.startsWith("sandbox-");
  const currentProjectBadge = isUserSavedMachine ? "我的机器" : challenge.badge;

  const armedBlockDef = armedBlockId ? SANDBOX_BLOCKS.find((b) => b.id === armedBlockId) : undefined;
  const preferredParentNode = preferredParentId ? state.assembly.nodes.find((n) => n.id === preferredParentId) : undefined;

  const viewportBannerText = armedBlockDef
    ? preferredParentNode
      ? `已拿起「${armedBlockDef.name}」— 请点击「${preferredParentNode.label ?? preferredParentNode.id}」身上的蓝色发光球吸附`
      : `已拿起「${armedBlockDef.name}」— 点 3D 青色发光球吸附，或直接点右侧自动吸合`
    : hoverHint ||
      (mode === "test" && challenge.targets.length > 0
        ? progress.completed
          ? `🎉 挑战通关！全部 ${challenge.targets.length} 个空间目标已点亮`
          : `拖动左侧滑块（或点自动演练），让橙色末端触达全部目标球 (${progress.hitCount}/${challenge.targets.length})`
        : guide.activeStep?.title ?? challenge.story);

  const leftPaneVisible = mobileTab === "left";
  const rightPaneVisible = mobileTab === "right";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* Compact Single-Row Top Bar */}
      <header className="surface flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
            <Blocks className="size-4 text-primary" />
            <span>构元积木工坊</span>
          </h1>
          <Button
            size="sm"
            variant="outline"
            className="h-7 max-w-[15rem] gap-1.5 px-2 text-xs"
            onClick={() => {
              setSaveNameDraft(state.assembly.name);
              setProjectManagerOpen(true);
            }}
          >
            <FolderOpen className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">
              {currentProjectBadge} · {state.assembly.name}
            </span>
            {state.completedIds.has(challenge.id) && (
              <span className="shrink-0 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">已通</span>
            )}
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </Button>
        </div>

        {/* Centered 3-Mode Pill */}
        <div role="tablist" aria-label="工坊模式切换" className="flex items-center gap-1 rounded-md border bg-background/70 p-0.5">
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "build"}
            variant={mode === "build" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setAutoSweeping(false);
              setMode("build");
            }}
          >
            <Hammer />
            拼装积木
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "test"}
            variant={mode === "test" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedBlockId(null);
              setMode("test");
            }}
          >
            <Play />
            试动与挑战
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "explode"}
            variant={mode === "explode" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setAutoSweeping(false);
              setArmedBlockId(null);
              setMode("explode");
            }}
          >
            <Layers />
            爆炸视图
          </Button>
        </div>

        {/* Right Controls: Save, BOM, Pro Mode */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={saveFeedback ? "default" : "outline"}
            className="relative h-7 px-2.5 text-xs"
            onClick={() => handleSaveCurrentMachine()}
          >
            {saveFeedback ? <Check /> : <Save />}
            {saveFeedback || "保存"}
            {state.dirty && !saveFeedback && (
              <span aria-hidden="true" className="ml-0.5 size-1.5 rounded-full bg-amber-400" />
            )}
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setBomOpen(true)}>
            <Package />
            现实 BOM ({state.assembly.nodes.length}件)
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs">
                <Wrench />
                专业工程模式
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>底层 Modelica 与工业工程面板</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onNavigate({ view: "resources" })}>
                <Camera /> ① 拍照识别与设备资料库
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={launchClosedLoopTwin}>
                <Sparkles /> 将当前积木转入闭环仿真工作台
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNavigate({ view: "workbench" })}>
                <Wrench /> ② 进入高级装配与录波工作台
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNavigate({ view: "examples" })}>
                <Blocks /> ③ 浏览全部 16 个参考工程模板
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Locked 100dvh Responsive 3-Pane Workspace (single Viewport instance) */}
      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden max-lg:grid-rows-[44dvh_auto_minmax(0,1fr)] ${
          outlinerOpen ? "lg:grid-cols-[17.5rem_minmax(0,1fr)_17.5rem]" : "lg:grid-cols-[17.5rem_minmax(0,1fr)]"
        }`}
      >
        {/* Mobile/Tablet Pane Switcher (<1024px only) */}
        <div className="flex shrink-0 gap-1.5 lg:hidden" role="tablist" aria-label="移动端面板切换">
          <Button
            size="sm"
            role="tab"
            aria-selected={leftPaneVisible}
            variant={leftPaneVisible ? "default" : "outline"}
            className="h-8 flex-1 text-xs"
            onClick={() => setMobileTab("left")}
          >
            🧱 积木与引导
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={rightPaneVisible}
            variant={rightPaneVisible ? "default" : "outline"}
            className="h-8 flex-1 text-xs"
            onClick={() => setMobileTab("right")}
          >
            🗂️ 结构树与管理 ({state.assembly.nodes.length})
          </Button>
        </div>

        {/* Left Pane: Dynamic Step Checklist + Mode Content */}
        <aside
          aria-label="拼装引导与积木库"
          className={`surface min-h-0 flex-col gap-2 overflow-hidden p-2.5 text-xs max-lg:row-start-3 lg:col-start-1 lg:row-start-1 ${
            leftPaneVisible ? "flex" : "hidden lg:flex"
          }`}
        >
          {/* Live Guided Checklist Card */}
          <div className="shrink-0 space-y-1.5 rounded-md border bg-background/60 p-2">
            <div className="flex items-center justify-between gap-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {challenge.badge}
                </span>
                <h2 className="truncate font-semibold text-foreground">{challenge.title}</h2>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {state.history.length > 0 && (
                  <button
                    type="button"
                    onClick={undoLast}
                    className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <Undo2 className="size-3" /> 撤销
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => switchChallenge(state.challengeId)}
                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="size-3" /> 重置
                </button>
              </div>
            </div>

            <div className="space-y-1">
              {guide.steps.map((step, idx) => {
                const isActive = guide.activeStep?.id === step.id;
                return (
                  <div
                    key={step.id}
                    className={`rounded px-1.5 py-1 text-[11px] transition-colors ${
                      step.done
                        ? "text-emerald-400/90"
                        : isActive
                          ? "border border-primary/40 bg-primary/10 text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="shrink-0 font-mono text-[10px] leading-4">
                        {step.done ? "✅" : isActive ? "🔵" : `${idx + 1}.`}
                      </span>
                      <span className={`min-w-0 flex-1 ${step.done ? "line-through opacity-80" : "font-medium"}`}>
                        {step.title}
                      </span>
                    </div>
                    {isActive && (
                      <div className="mt-1 space-y-1.5 pl-4">
                        <p className="text-[10px] leading-relaxed text-muted-foreground">{step.detail}</p>
                        <div className="flex flex-wrap gap-1">
                          {step.recommendedBlockId && (
                            <>
                              <Button
                                size="sm"
                                variant={armedBlockId === step.recommendedBlockId ? "default" : "outline"}
                                className="h-6 px-2 text-[10px]"
                                onClick={() => {
                                  setMode("build");
                                  setArmedBlockId(
                                    armedBlockId === step.recommendedBlockId ? null : step.recommendedBlockId!,
                                  );
                                }}
                              >
                                {armedBlockId === step.recommendedBlockId ? "已拿起·点3D蓝球" : "拿起去吸"}
                              </Button>
                              <Button
                                size="sm"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => quickSnapBlock(step.recommendedBlockId!)}
                              >
                                <Zap className="size-3" />
                                一步装上
                              </Button>
                            </>
                          )}
                          {step.recommendedMode === "test" && (
                            <Button
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => {
                                setArmedBlockId(null);
                                setMode("test");
                              }}
                            >
                              <Play className="size-3" />
                              去试动通关 →
                            </Button>
                          )}
                          {step.recommendedMode === "explode" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => {
                                setArmedBlockId(null);
                                setMode("explode");
                              }}
                            >
                              <Layers className="size-3" />
                              打开爆炸视图
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {state.challengeId !== "free-sandbox" && (
              <Button size="sm" variant="secondary" className="h-7 w-full text-[11px]" onClick={() => loadReferenceSolution()}>
                <Sparkles className="size-3.5" /> 加载完整参考成品（直接体验）
              </Button>
            )}
          </div>

          {mode === "build" && (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
              {/* Compact Category Pills */}
              <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label="积木分类筛选">
                {FILTER_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={paletteFilter === tab.id}
                    onClick={() => setPaletteFilter(tab.id)}
                    className={`flex-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
                      paletteFilter === tab.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-background/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <p className="shrink-0 text-[10px] text-muted-foreground">
                {preferredParentNode
                  ? `当前挂载目标：「${preferredParentNode.label ?? preferredParentNode.id}」· 点下面积木直接吸上`
                  : "单击拿起积木（3D亮蓝球） · 双击直接自动装上"}
              </p>

              {/* 2-Column Visual Tile Grid */}
              <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-1.5 overflow-y-auto pr-0.5">
                {filteredBlocks.map((blk) => {
                  const active = armedBlockId === blk.id;
                  const isRecommended = guide.activeStep?.recommendedBlockId === blk.id;
                  return (
                    <button
                      key={blk.id}
                      type="button"
                      title={blk.subtitle}
                      onClick={() => {
                        if (preferredParentId) {
                          quickSnapBlock(blk.id, preferredParentId);
                        } else {
                          setArmedBlockId(active ? null : blk.id);
                        }
                      }}
                      onDoubleClick={() => quickSnapBlock(blk.id)}
                      className={`group relative flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-all ${
                        active
                          ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                          : isRecommended
                            ? "border-amber-400/70 bg-amber-500/10 text-foreground ring-1 ring-amber-400/40"
                            : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                      }`}
                    >
                      {isRecommended && !active && (
                        <span className="absolute right-1 top-1 rounded bg-amber-400/20 px-1 text-[9px] font-semibold text-amber-300">
                          推荐
                        </span>
                      )}
                      {blk.defaultJoint.type !== "fixed" && (
                        <span className="absolute left-1 top-1 rounded bg-muted px-1 text-[9px] text-primary">
                          {blk.defaultJoint.type === "slide" ? "滑" : "转"}
                        </span>
                      )}
                      <SandboxBlockIcon
                        shape={blk.spec.shape}
                        finish={blk.spec.finish}
                        blockId={blk.id}
                        className="mt-1 size-8 transition-transform group-hover:scale-105"
                      />
                      <span className="line-clamp-2 text-[11px] font-medium leading-tight">{blk.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {mode === "test" && (
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
              {challenge.targets.length > 0 && (
                <div className="space-y-1.5 rounded-md border bg-background/60 p-2">
                  <p className="font-semibold text-foreground">
                    过关进度（{progress.hitCount}/{challenge.targets.length}）
                  </p>
                  {progress.structuralChecks.map((chk) => (
                    <div key={chk.label} className="flex items-center gap-1.5 text-[11px]">
                      <CheckCircle2
                        className={`size-3.5 shrink-0 ${chk.passed ? "text-emerald-500" : "text-muted-foreground/40"}`}
                      />
                      <span className={chk.passed ? "text-foreground" : "text-muted-foreground"}>{chk.label}</span>
                    </div>
                  ))}
                  {progress.worldTargets.map((t) => (
                    <div key={t.id} className="flex items-center gap-1.5 text-[11px]">
                      <CheckCircle2 className={`size-3.5 shrink-0 ${t.hit ? "text-emerald-500" : "text-amber-400"}`} />
                      <span className={t.hit ? "text-emerald-400 line-through" : "text-foreground"}>{t.label}</span>
                    </div>
                  ))}
                  {progress.completed && (
                    <div className="space-y-2 rounded border border-emerald-500/40 bg-emerald-500/10 p-2">
                      <p className="font-medium text-emerald-300">挑战成功！已验证空间可达性</p>
                      <div className="flex flex-wrap gap-1.5">
                        {nextChallenge && (
                          <Button size="sm" className="h-7 text-xs" onClick={() => switchChallenge(nextChallenge.id)}>
                            {nextChallenge.badge} <ArrowRight />
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBomOpen(true)}>
                          生成 BOM & 物理闭环
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-1.5">
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  variant={autoSweeping ? "default" : "outline"}
                  disabled={solved.activeControls.length === 0}
                  onClick={() => setAutoSweeping((v) => !v)}
                >
                  {autoSweeping ? <Pause /> : <Play />}
                  {autoSweeping ? "暂停演示" : "自动演练轨迹"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setAutoSweeping(false);
                    const zeros: Record<string, number> = {};
                    for (const c of solved.activeControls) zeros[c.path] = clamp(0, c.joint.range[0], c.joint.range[1]);
                    applyCommandsAndScore(zeros);
                  }}
                >
                  回零
                </Button>
              </div>

              {solved.activeControls.length === 0 ? (
                <p className="rounded border bg-background/50 p-2.5 text-muted-foreground">
                  当前拼装全部为刚性连接。切回「拼装积木」加上直线滑台/旋转关节，或在右栏把零件设为可动关节。
                </p>
              ) : (
                <div className="space-y-2">
                  {solved.activeControls.map((ctrl) => {
                    const unit = ctrl.joint.type === "slide" ? "mm" : "°";
                    return (
                      <label key={ctrl.path} className="block space-y-1 rounded border bg-background/60 p-2">
                        <div className="flex items-center justify-between">
                          <span className="truncate font-medium">{ctrl.label}</span>
                          <span className="mono text-primary">
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
                            setAutoSweeping(false);
                            applyCommandsAndScore({ ...state.commands, [ctrl.path]: Number(e.currentTarget.value) });
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              )}

              {solved.coupledControls.length > 0 && (
                <div className="space-y-1 border-t pt-2">
                  <p className="font-medium text-muted-foreground">丝杠联动旋转（自动跟随）：</p>
                  {solved.coupledControls.map((c) => (
                    <div key={c.path} className="flex justify-between text-[11px]">
                      <span className="truncate text-muted-foreground">{c.label}</span>
                      <span className="mono">{formatNum(c.value)}°</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === "explode" && (
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
              <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
                <label className="block space-y-1.5">
                  <div className="flex items-center justify-between font-medium">
                    <span>整机拆解展开</span>
                    <span className="mono text-primary">{explodePct}%</span>
                  </div>
                  <input
                    type="range"
                    aria-label="爆炸视图展开比例"
                    min={0}
                    max={100}
                    step={1}
                    value={explodePct}
                    className="h-4 w-full accent-primary"
                    onChange={(e) => setExplodePct(Number(e.currentTarget.value))}
                  />
                </label>
                <div className="grid grid-cols-3 gap-1">
                  <Button size="sm" variant={explodePct === 0 ? "secondary" : "ghost"} onClick={() => setExplodePct(0)}>
                    收拢
                  </Button>
                  <Button size="sm" variant={explodePct === 45 ? "secondary" : "ghost"} onClick={() => setExplodePct(45)}>
                    45%
                  </Button>
                  <Button size="sm" variant={explodePct === 100 ? "secondary" : "ghost"} onClick={() => setExplodePct(100)}>
                    100%
                  </Button>
                </div>
                <label className="flex items-center gap-2 pt-1">
                  <input type="checkbox" checked={showLeaders} onChange={(e) => setShowLeaders(e.target.checked)} />
                  <span>显示拆装引导虚线</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                  <span>显示零件浮动铭牌</span>
                </label>
                {selectedNodeId && (
                  <label className="flex items-center gap-2 text-primary">
                    <input type="checkbox" checked={subtreeOnly} onChange={(e) => setSubtreeOnly(e.target.checked)} />
                    <span>仅炸开「{selectedSolved?.label ?? selectedNodeId}」分支</span>
                  </label>
                )}
              </div>

              {solved.activeControls.length > 0 && (
                <div className="space-y-2 border-t pt-2">
                  <p className="font-medium text-muted-foreground">边爆炸边试动关节：</p>
                  {solved.activeControls.map((ctrl) => (
                    <label key={ctrl.path} className="block space-y-1 rounded border bg-background/60 p-2">
                      <div className="flex justify-between">
                        <span className="truncate">{ctrl.label}</span>
                        <span className="mono">{formatNum(ctrl.value)}</span>
                      </div>
                      <input
                        type="range"
                        min={ctrl.joint.range[0]}
                        max={ctrl.joint.range[1]}
                        step={ctrl.joint.type === "slide" ? 0.5 : 1}
                        value={ctrl.value}
                        className="h-4 w-full accent-primary"
                        onChange={(e) => applyCommandsAndScore({ ...state.commands, [ctrl.path]: Number(e.currentTarget.value) })}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="shrink-0 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </aside>

        {/* Center 3D Viewport */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-lg:row-start-1 lg:col-start-2 lg:row-start-1">
          <div className="pointer-events-none absolute inset-x-2.5 top-2.5 z-10 flex items-start justify-between gap-2">
            <div className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-1.5 rounded-full border border-primary/30 bg-[#101c1a]/90 px-3 py-1 text-xs text-foreground shadow-md backdrop-blur">
              <span>{viewportBannerText}</span>
              {armedBlockId && (
                <>
                  <Button size="sm" className="h-5 px-2 text-[10px]" onClick={() => quickSnapBlock(armedBlockId)}>
                    <Zap className="size-3" />
                    自动吸到推荐位
                  </Button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setArmedBlockId(null);
                      setPreferredParentId("");
                      setHoverHint("");
                    }}
                  >
                    取消
                  </button>
                </>
              )}
            </div>

            <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="secondary" className="h-7 px-2 text-xs shadow-md" onClick={() => setFitToken((n) => n + 1)}>
                <RotateCcw />
                居中视角
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="hidden h-7 px-2 text-xs shadow-md lg:inline-flex"
                aria-label={outlinerOpen ? "收起右侧装配结构树" : "展开右侧装配结构树"}
                onClick={() => setOutlinerOpen((v) => !v)}
              >
                {outlinerOpen ? <PanelRightClose /> : <PanelRightOpen />}
                <span className="hidden xl:inline">{outlinerOpen ? "收起结构树" : "结构树"}</span>
              </Button>
            </div>
          </div>

          <SandboxViewport3D
            workspace={state.workspace}
            assembly={state.assembly}
            mode={mode}
            armedBlockId={armedBlockId}
            selectedNodeId={selectedNodeId}
            preferredParentId={preferredParentId}
            commands={state.commands}
            explodePct={explodePct}
            subtreeOnly={subtreeOnly}
            showLeaders={showLeaders}
            showLabels={showLabels}
            worldTargets={progress.worldTargets}
            fitRequestToken={fitToken}
            onSelectNode={(id) => {
              setSelectedNodeId(id);
              setCustomWidthInput("");
            }}
            onSnapBlock={handleSnapBlock}
            onHoverSnapChange={setHoverHint}
          />
        </main>

        {/* Right Pane: Persistent Assembly Outliner Tree & Selected Part Inspector */}
        <aside
          aria-label="装配结构树与零件管理"
          className={`surface min-h-0 flex-col overflow-hidden p-2.5 text-xs max-lg:row-start-3 lg:col-start-3 lg:row-start-1 ${
            rightPaneVisible ? "flex" : outlinerOpen ? "hidden lg:flex" : "hidden"
          }`}
        >
          {/* Section A: Hierarchy Outliner Tree */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-1 border-b pb-1.5">
              <h2 className="font-semibold text-foreground">装配结构树 ({state.assembly.nodes.length}件)</h2>
              <span className="text-[10px] text-muted-foreground">点 + 挂载 · 点行选中</span>
            </div>

            {preferredParentNode && (
              <div className="mt-1.5 flex shrink-0 items-center justify-between gap-1 rounded border border-sky-400/50 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">
                <span className="truncate">正挂载到「{preferredParentNode.label ?? preferredParentNode.id}」</span>
                <button
                  type="button"
                  className="shrink-0 underline hover:text-white"
                  onClick={() => setPreferredParentId("")}
                >
                  清除
                </button>
              </div>
            )}

            <div className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
              {treeRows.map((row) => {
                const isSel = selectedNodeId === row.id;
                const isAttachTarget = preferredParentId === row.id;
                return (
                  <div
                    key={row.id}
                    className={`flex items-center gap-1 rounded border px-1.5 py-1 transition-colors ${
                      isSel
                        ? "border-primary bg-primary/15 text-foreground"
                        : isAttachTarget
                          ? "border-sky-400/60 bg-sky-500/10 text-foreground"
                          : "border-transparent bg-background/40 hover:border-border hover:bg-accent/40"
                    }`}
                    style={{ paddingLeft: `${6 + Math.min(row.depth, 5) * 10}px` }}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      onClick={() => {
                        setSelectedNodeId(row.id);
                        setCustomWidthInput("");
                      }}
                    >
                      <SandboxBlockIcon shape={row.shape} finish={row.finish} className="size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="truncate font-medium">{row.label}</span>
                          {row.isOutputTip && (
                            <span className="shrink-0 rounded bg-orange-500/20 px-1 text-[9px] text-orange-300">末端</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                          <span>{row.jointSummary}</span>
                          {!row.isRoot && <span>· {row.mountLabel}</span>}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      aria-label={`在 ${row.label} 下挂载新积木`}
                      title="在此零件上挂载新积木"
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-primary/20 hover:text-primary"
                      onClick={() => {
                        setPreferredParentId(row.id);
                        setSelectedNodeId(row.id);
                        setMode("build");
                        setMobileTab("left");
                      }}
                    >
                      <Plus className="size-3.5" />
                    </button>
                    {!row.isRoot && (
                      <button
                        type="button"
                        aria-label={`拆除 ${row.label}`}
                        title="拆除该积木及其子零件"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                        onClick={() => deleteNodeById(row.id)}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section B: Contextual Selected Node Inspector or Management Quick-Card */}
          <div className="mt-2 max-h-[52%] shrink-0 space-y-2 overflow-y-auto border-t pt-2">
            {selectedSolved && selectedRawNode ? (
              <>
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-semibold text-primary">编辑 · {selectedSolved.label}</span>
                  <button
                    type="button"
                    aria-label="取消选中零件"
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setSelectedNodeId("")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>

                <label className="block space-y-1">
                  <span className="field-label">零件名称</span>
                  <Input
                    className="h-7 text-xs"
                    defaultValue={selectedSolved.label}
                    key={`name-${selectedRawNode.id}-${selectedRawNode.packageKey}`}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next && next !== selectedSolved.label) mutateNode(selectedRawNode.id, { label: next });
                    }}
                  />
                </label>

                {selectedPkg?.primitive && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="field-label">主长度 / 宽 (mm)</span>
                      {selectedCurrentPrimaryLen !== undefined && (
                        <span className="mono text-[10px] text-muted-foreground">当前 {formatNum(selectedCurrentPrimaryLen)} mm</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-1.5 text-[10px]"
                        disabled={(selectedCurrentPrimaryLen ?? 40) <= 30}
                        onClick={() => {
                          if (selectedCurrentPrimaryLen) {
                            mutateNode(selectedRawNode.id, { primaryLengthMm: Math.max(15, selectedCurrentPrimaryLen - 20) });
                          }
                        }}
                      >
                        -20
                      </Button>
                      <Input
                        type="number"
                        className="h-7 min-w-0 flex-1 text-xs"
                        placeholder={selectedCurrentPrimaryLen ? String(selectedCurrentPrimaryLen) : "输入毫米"}
                        value={customWidthInput}
                        onChange={(e) => setCustomWidthInput(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[10px]"
                        onClick={() => {
                          const v = Number(customWidthInput);
                          if (v > 0) mutateNode(selectedRawNode.id, { primaryLengthMm: v });
                        }}
                      >
                        改
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-1.5 text-[10px]"
                        onClick={() => {
                          if (selectedCurrentPrimaryLen) {
                            mutateNode(selectedRawNode.id, { primaryLengthMm: selectedCurrentPrimaryLen + 20 });
                          }
                        }}
                      >
                        +20
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-[11px]"
                    onClick={() => mutateNode(selectedRawNode.id, { rotateZ90: true })}
                  >
                    绕 Z 转 90°
                  </Button>
                  {selectedPkg?.primitive && "axis" in selectedPkg.primitive && (
                    <select
                      aria-label="切换延伸轴"
                      className="h-7 rounded border bg-background px-1.5 text-[11px]"
                      value={selectedPkg.primitive.axis}
                      onChange={(e) => mutateNode(selectedRawNode.id, { axis: e.target.value as AxisDir })}
                    >
                      <option value="x">沿 X</option>
                      <option value="y">沿 Y</option>
                      <option value="z">沿 Z</option>
                    </select>
                  )}
                </div>

                {selectedPart && (
                  <label className="block space-y-1">
                    <span className="field-label">运动连接方式</span>
                    <select
                      aria-label="运动连接方式"
                      className="h-7 w-full rounded border bg-background px-1.5 text-[11px]"
                      value={selectedPart.joint.type}
                      onChange={(e) =>
                        mutateNode(selectedRawNode.id, { jointType: e.target.value as "fixed" | "slide" | "hinge" })
                      }
                    >
                      <option value="fixed">fixed（刚性固定）</option>
                      <option value="slide">slide（直线滑动 ±120mm）</option>
                      <option value="hinge">hinge（旋转角度 ±180°）</option>
                    </select>
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="field-label">替换为真实品牌型号</span>
                  <select
                    aria-label="换用真实品牌型号"
                    className="h-7 w-full rounded border bg-background px-1.5 text-[11px]"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) mutateNode(selectedRawNode.id, { vendorPresetId: e.target.value });
                    }}
                  >
                    <option value="">
                      {selectedPkg?.manufacturer} · {selectedPkg?.model}
                    </option>
                    {REAL_VENDOR_BOM_PRESETS.map((v) => (
                      <option key={v.id} value={v.id}>
                        换为 {v.label}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedRawNode.parent !== null && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 w-full text-[11px]"
                    onClick={() => deleteNodeById(selectedRawNode.id)}
                  >
                    <Trash2 />
                    拆除该积木及下级子件
                  </Button>
                )}
              </>
            ) : (
              <div className="space-y-2 rounded border bg-background/50 p-2 text-[11px] text-muted-foreground">
                <p className="leading-relaxed">
                  点击上方结构树或 3D 视口中的任意零件，即可调整尺寸、旋转方向、设成可动关节，或换用松下/汇川真实型号。
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 flex-1 text-[11px]" onClick={() => handleSaveCurrentMachine()}>
                    <Save /> 保存当前作品
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 flex-1 text-[11px]"
                    onClick={() => {
                      setProjectTab("saved");
                      setSaveNameDraft(state.assembly.name);
                      setProjectManagerOpen(true);
                    }}
                  >
                    <FolderOpen /> 我的机器库 ({savedMachines.length})
                  </Button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Challenge & Saved Machines Manager Dialog */}
      <Dialog open={projectManagerOpen} onOpenChange={setProjectManagerOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>关卡挑战与我的机器作品库</DialogTitle>
            <DialogDescription>
              在这里切换闯关关卡、加载标准可动机器成品，或将你创造的新机器保存、复制与管理到本机工程库。
            </DialogDescription>
          </DialogHeader>

          <div role="tablist" className="flex gap-1 border-b pb-2">
            <Button
              size="sm"
              variant={projectTab === "challenges" ? "secondary" : "ghost"}
              onClick={() => setProjectTab("challenges")}
            >
              🏆 渐进闯关 ({state.completedIds.size}/4 已通关)
            </Button>
            <Button
              size="sm"
              variant={projectTab === "saved" ? "secondary" : "ghost"}
              onClick={() => setProjectTab("saved")}
            >
              <FolderOpen /> 我的机器库 ({savedMachines.length} 件)
            </Button>
          </div>

          {projectTab === "challenges" ? (
            <div className="grid gap-2 text-xs">
              {SANDBOX_CHALLENGES.map((c) => {
                const isCurrent = c.id === state.challengeId && !isUserSavedMachine;
                const isDone = state.completedIds.has(c.id);
                return (
                  <div
                    key={c.id}
                    className={`rounded-md border p-3 ${isCurrent ? "border-primary bg-primary/10" : "bg-background/60"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {c.badge}
                        </span>
                        <span className="font-semibold text-foreground">{c.title}</span>
                        {isDone && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                            ✅ 已通关
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant={isCurrent ? "default" : "outline"} onClick={() => switchChallenge(c.id)}>
                          {isCurrent ? "重置本关" : "开始拼装"}
                        </Button>
                        {c.id !== "free-sandbox" && (
                          <Button size="sm" variant="secondary" onClick={() => loadReferenceSolution(c.id)}>
                            看完整参考成品
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{c.story}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="space-y-2 rounded-md border bg-background/60 p-3">
                <p className="font-medium text-foreground">保存当前工坊中的机器设计</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 min-w-44 flex-1 text-xs"
                    aria-label="保存的机器名称"
                    placeholder="给你的机器取个名字（如：四轴桁架机械手）"
                    value={saveNameDraft}
                    onChange={(e) => setSaveNameDraft(e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSaveCurrentMachine({ customName: saveNameDraft })}
                  >
                    <Save /> 保存当前
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleSaveCurrentMachine({ asNewCopy: true, customName: saveNameDraft })}
                  >
                    另存为新作品
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => switchChallenge("free-sandbox")}>
                    + 新建空白构型
                  </Button>
                </div>
              </div>

              {savedMachines.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground">
                  还没有保存过的机器作品。拼出构型后点击上方「保存当前」即可长期留存在浏览器本地工程中，并同步用于 BOM 采购和 Modelica 仿真。
                </div>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {savedMachines.map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">{m.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {m.nodes.length} 个积木零件 · {Object.keys(m.commands).length} 个可控关节
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="default" onClick={() => handleLoadSavedMachine(m.id)}>
                          打开编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`删除机器 ${m.name}`}
                          onClick={() => handleDeleteSavedMachine(m.id)}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* On-Demand Hardware BOM + Photo Intake + Closed-Loop Dialog */}
      <Dialog open={bomOpen} onOpenChange={setBomOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>当前拼装清单（BOM）与现实设备落地</DialogTitle>
            <DialogDescription>
              先从数学基本件创造构型，随时在此一步替换为汇川/松下/台达/PMI/THK 真实型号，或直接转入 Modelica 闭环动态校验。
            </DialogDescription>
          </DialogHeader>

          <div role="tablist" className="flex gap-1 border-b pb-2">
            <Button size="sm" variant={bomTab === "bom" ? "secondary" : "ghost"} onClick={() => setBomTab("bom")}>
              <Package /> BOM 清单与闭环转发 ({bomRows.length} 类)
            </Button>
            <Button size="sm" variant={bomTab === "photo" ? "secondary" : "ghost"} onClick={() => setBomTab("photo")}>
              <Camera /> 拍照识别实物铭牌入库
            </Button>
          </div>

          {bomTab === "bom" ? (
            <div className="space-y-3 text-xs">
              <div className="max-h-72 overflow-y-auto rounded border">
                <table className="w-full text-left">
                  <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground">
                    <tr>
                      <th className="p-2">品牌 / 型号</th>
                      <th className="p-2">积木类别</th>
                      <th className="p-2">包络尺寸</th>
                      <th className="p-2 text-right">用量</th>
                      <th className="p-2">状态 / 换真实件</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {bomRows.map((row) => (
                      <tr key={row.packageKey}>
                        <td className="p-2">
                          <div className="font-medium">{row.model}</div>
                          <div className="text-[10px] text-muted-foreground">{row.manufacturer}</div>
                        </td>
                        <td className="p-2 text-muted-foreground">{row.shapeLabel}</td>
                        <td className="mono p-2 text-[11px]">{row.dimensionsText}</td>
                        <td className="mono p-2 text-right">×{row.quantity}</td>
                        <td className="p-2">
                          {row.suggestedPresetCategory ? (
                            <select
                              aria-label={`替换 ${row.model} 为真实厂商件`}
                              className="h-7 max-w-44 rounded border bg-background px-1.5 text-[11px]"
                              value=""
                              onChange={(e) => {
                                const presetId = e.target.value;
                                const firstNodeId = row.nodeIds[0];
                                if (presetId && firstNodeId) {
                                  const res = updateSandboxNode(state.workspace, state.assembly, firstNodeId, {
                                    vendorPresetId: presetId,
                                  });
                                  setState((prev) => ({
                                    ...prev,
                                    workspace: res.workspace,
                                    assembly: res.assembly,
                                    dirty: true,
                                  }));
                                }
                              }}
                            >
                              <option value="">{row.hasRealBehavior ? "已带物理模型 · 可换" : "选真实型号…"}</option>
                              {REAL_VENDOR_BOM_PRESETS.filter((p) => p.category === row.suggestedPresetCategory).map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={row.hasRealBehavior ? "text-emerald-400" : "text-muted-foreground"}>
                              {row.hasRealBehavior ? "带质量/行为绑定" : "标准结构件"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadBlob(sandboxBomToCsv(bomRows), `${state.assembly.name}-bom.csv`, "text/csv;charset=utf-8")}
                >
                  <Download />
                  导出采购 BOM CSV
                </Button>
                <Button size="sm" onClick={launchClosedLoopTwin}>
                  <Sparkles />
                  一键送入 Modelica 闭环深度校验 →
                </Button>
              </div>
            </div>
          ) : (
            <VisionIntakePanel
              workspace={workspace}
              onApply={(nextWs, opts) => {
                onSaveWorkspace(nextWs);
                if (opts?.openTarget) {
                  setBomOpen(false);
                  onNavigate({ view: "workbench", target: opts.openTarget });
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
