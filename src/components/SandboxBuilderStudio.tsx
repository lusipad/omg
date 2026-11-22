import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Blocks,
  Camera,
  CheckCircle2,
  Download,
  Hammer,
  Layers,
  Package,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { solveArticulatedAssembly } from "@contracts/articulated-kinematics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { upsertMechanicalAssembly } from "@contracts/mechanical-assembly";
import type { AxisDir } from "@contracts/primitive-parts";
import {
  convertSandboxToSystemTwin,
  createChallengeSolution,
  createChallengeStarter,
  evaluateChallengeProgress,
  extractSandboxBomSummary,
  REAL_VENDOR_BOM_PRESETS,
  removeSandboxNode,
  SANDBOX_BLOCKS,
  SANDBOX_CATEGORY_LABELS,
  SANDBOX_CHALLENGES,
  sandboxBomToCsv,
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
import SandboxViewport3D from "./SandboxViewport3D";
import { VisionIntakePanel } from "./VisionIntakePanel";

export interface SandboxBuilderStudioProps {
  workspace: TwinWorkspace;
  initialChallengeId?: string;
  onSaveWorkspace: (next: TwinWorkspace) => void;
  onNavigate: (route: StudioRoute, message?: string) => void;
}

type StudioMode = "build" | "test" | "explode";

interface SandboxSessionState {
  challengeId: SandboxChallengeDef["id"];
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  commands: Record<string, number>;
  visitedIds: Set<string>;
  history: Array<{ workspace: TwinWorkspace; assembly: MechanicalAssembly }>;
}

const CHALLENGE_IDS = new Set<string>(SANDBOX_CHALLENGES.map((c) => c.id));
const CATEGORIES: readonly SandboxBlockCategory[] = ["frame", "motion", "actuator", "sensor"];
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const formatNum = (v: number) => Number(v.toFixed(1)).toString();

function resolveInitialChallenge(id?: string): SandboxChallengeDef["id"] {
  return id && CHALLENGE_IDS.has(id) ? (id as SandboxChallengeDef["id"]) : "level-1-axis";
}

function makeInitialState(id: SandboxChallengeDef["id"]): SandboxSessionState {
  const starter = createChallengeStarter(id);
  return {
    challengeId: id,
    workspace: starter.workspace,
    assembly: starter.assembly,
    commands: { ...starter.assembly.commands },
    visitedIds: new Set<string>(),
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
    makeInitialState(resolveInitialChallenge(initialChallengeId)),
  );
  const [mode, setMode] = useState<StudioMode>("build");
  const [armedBlockId, setArmedBlockId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [hoverHint, setHoverHint] = useState("");
  const [explodePct, setExplodePct] = useState(45);
  const [subtreeOnly, setSubtreeOnly] = useState(false);
  const [showLeaders, setShowLeaders] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [autoSweeping, setAutoSweeping] = useState(false);
  const [fitToken, setFitToken] = useState(1);
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

  const bomRows = useMemo(
    () => extractSandboxBomSummary(state.workspace, state.assembly),
    [state.workspace, state.assembly],
  );

  const stateRef = useRef(state);
  const challengeRef = useRef(challenge);
  useEffect(() => {
    stateRef.current = state;
    challengeRef.current = challenge;
  }, [state, challenge]);

  // Escape cancels armed block placement
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setArmedBlockId(null);
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
      return { ...prev, commands: nextCmds, visitedIds: nextVisited };
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
    setSelectedNodeId("");
    setHoverHint("");
    setError("");
    setMode("build");
    setState(makeInitialState(nextId));
    setFitToken((n) => n + 1);
  }

  function loadReferenceSolution() {
    setAutoSweeping(false);
    setArmedBlockId(null);
    setError("");
    const sol = createChallengeSolution(state.challengeId);
    const preview = solveArticulatedAssembly(sol.workspace, sol.assembly);
    const check = evaluateChallengeProgress(challenge, sol.workspace, sol.assembly, preview, new Set());
    setState((prev) => ({
      ...prev,
      workspace: sol.workspace,
      assembly: sol.assembly,
      commands: { ...sol.assembly.commands },
      visitedIds: new Set(check.newlyHitIds),
      history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
    }));
    setSelectedNodeId("");
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
        history: prev.history.slice(0, -1),
      };
    });
    setSelectedNodeId("");
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
        setState((prev) => ({
          ...prev,
          workspace: res.workspace,
          assembly: res.assembly,
          commands: { ...res.assembly.commands },
          visitedIds: nextVisited,
          history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
        }));
        setSelectedNodeId(res.addedNodeId);
        setArmedBlockId(null);
        setHoverHint("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "吸附连接失败，请尝试其他接口。");
      }
    },
    [armedBlockId],
  );

  function mutateSelectedNode(patch: Parameters<typeof updateSandboxNode>[3]) {
    if (!selectedNodeId) return;
    setError("");
    try {
      const res = updateSandboxNode(state.workspace, state.assembly, selectedNodeId, patch);
      setState((prev) => ({
        ...prev,
        workspace: res.workspace,
        assembly: res.assembly,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新积木属性失败。");
    }
  }

  function deleteSelectedNode() {
    if (!selectedNodeId) return;
    setError("");
    try {
      const nextAsm = removeSandboxNode(state.workspace, state.assembly, selectedNodeId);
      setState((prev) => ({
        ...prev,
        assembly: nextAsm,
        commands: { ...nextAsm.commands },
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
      setSelectedNodeId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法拆除该积木。");
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

  const nextChallenge = useMemo(() => {
    const idx = SANDBOX_CHALLENGES.findIndex((c) => c.id === state.challengeId);
    return idx >= 0 && idx + 1 < SANDBOX_CHALLENGES.length ? SANDBOX_CHALLENGES[idx + 1] : null;
  }, [state.challengeId]);

  const currentHintBanner =
    hoverHint
    || (mode === "build" && armedBlockId
      ? `已拿起「${SANDBOX_BLOCKS.find((b) => b.id === armedBlockId)?.name ?? ""}」— 请在 3D 视口点击青色发光球直接吸附（按 Esc 取消）`
      : mode === "test" && challenge.targets.length > 0
        ? progress.completed
          ? `🎉 挑战通过！全部 ${challenge.targets.length} 个空间目标已触达，可前往下一关或打开 BOM/闭环验证。`
          : `拖动左侧关节滑块（或点「自动演练」），使红点末端依次触达黄色发光目标（${progress.hitCount}/${challenge.targets.length}）`
        : challenge.hints[0]);

  return (
    <div className="flex min-h-[calc(100dvh-2rem)] flex-col gap-3">
      {/* Minimalist Top Bar */}
      <header className="surface flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <Blocks className="size-5 text-primary" />
            <span>构元积木工坊</span>
          </div>
          <select
            aria-label="选择关卡或自由创造沙盒"
            className="h-8 rounded-md border bg-background px-2 text-xs font-medium text-foreground"
            value={state.challengeId}
            onChange={(e) => switchChallenge(e.target.value as SandboxChallengeDef["id"])}
          >
            {SANDBOX_CHALLENGES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.badge} · {c.title}
              </option>
            ))}
          </select>
        </div>

        {/* Centered 3-Mode Pill */}
        <div role="tablist" aria-label="工坊模式切换" className="flex items-center gap-1 rounded-md border bg-background/70 p-1">
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "build"}
            variant={mode === "build" ? "default" : "ghost"}
            onClick={() => { setAutoSweeping(false); setMode("build"); }}
          >
            <Hammer />
            拼装积木
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "test"}
            variant={mode === "test" ? "default" : "ghost"}
            onClick={() => { setArmedBlockId(null); setMode("test"); }}
          >
            <Play />
            试动与挑战
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mode === "explode"}
            variant={mode === "explode" ? "default" : "ghost"}
            onClick={() => { setAutoSweeping(false); setArmedBlockId(null); setMode("explode"); }}
          >
            <Layers />
            爆炸视图
          </Button>
        </div>

        {/* Right Controls: BOM Drawer & Pro Engineer Mode */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setBomOpen(true)}>
            <Package />
            现实 BOM ({state.assembly.nodes.length}件)
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
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

      {/* Main 3-Pane Workspace */}
      <div className="grid flex-1 gap-3 lg:grid-cols-[18rem_minmax(0,1fr)_auto]">
        {/* Left Context Panel */}
        <aside className="surface flex min-w-0 flex-col gap-3 p-3 text-xs">
          {/* Mission Strip */}
          <div className="rounded-md border bg-background/60 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-1">
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {challenge.badge}
              </span>
              <div className="flex items-center gap-1">
                {state.history.length > 0 && (
                  <button type="button" onClick={undoLast} className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                    <Undo2 className="size-3" /> 撤销
                  </button>
                )}
                <button type="button" onClick={() => switchChallenge(state.challengeId)} className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <RotateCcw className="size-3" /> 重置
                </button>
              </div>
            </div>
            <p className="font-semibold text-foreground">{challenge.title}</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{challenge.story}</p>
            {state.challengeId !== "free-sandbox" && (
              <Button size="sm" variant="secondary" className="w-full" onClick={loadReferenceSolution}>
                <Sparkles /> 查看参考拼法（完整可动示例）
              </Button>
            )}
          </div>

          {mode === "build" && (
            <div className="flex-1 space-y-3 overflow-y-auto pr-0.5">
              {CATEGORIES.map((cat) => (
                <div key={cat} className="space-y-1.5">
                  <p className="font-medium text-muted-foreground">{SANDBOX_CATEGORY_LABELS[cat]}</p>
                  <div className="grid gap-1.5">
                    {SANDBOX_BLOCKS.filter((b) => b.category === cat).map((blk) => {
                      const active = armedBlockId === blk.id;
                      return (
                        <button
                          key={blk.id}
                          type="button"
                          onClick={() => setArmedBlockId(active ? null : blk.id)}
                          className={`rounded-md border p-2 text-left transition-colors ${
                            active
                              ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                              : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1 font-medium">
                            <span>{blk.name}</span>
                            {blk.defaultJoint.type !== "fixed" && (
                              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-primary">
                                {blk.defaultJoint.type === "slide" ? "滑动" : "旋转"}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">{blk.subtitle}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {mode === "test" && (
            <div className="flex-1 space-y-3 overflow-y-auto pr-0.5">
              {challenge.targets.length > 0 && (
                <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
                  <p className="font-semibold text-foreground">
                    过关进度（{progress.hitCount}/{challenge.targets.length}）
                  </p>
                  {progress.structuralChecks.map((chk) => (
                    <div key={chk.label} className="flex items-center gap-1.5 text-[11px]">
                      <CheckCircle2 className={`size-3.5 shrink-0 ${chk.passed ? "text-emerald-500" : "text-muted-foreground/40"}`} />
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
                      <p className="font-medium text-emerald-300">挑战成功！已验证运动可达性</p>
                      <div className="flex flex-wrap gap-1.5">
                        {nextChallenge && (
                          <Button size="sm" onClick={() => switchChallenge(nextChallenge.id)}>
                            {nextChallenge.badge} <ArrowRight />
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setBomOpen(true)}>
                          生成 BOM & 物理闭环
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={autoSweeping ? "default" : "outline"}
                  disabled={solved.activeControls.length === 0}
                  onClick={() => setAutoSweeping((v) => !v)}
                >
                  {autoSweeping ? <Pause /> : <Play />}
                  {autoSweeping ? "暂停演示" : "自动演练过关轨迹"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
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
                  当前拼装全部为刚性连接。切回「拼装积木」加上直线滑台/旋转关节，或选中积木在右侧将其设为可动关节。
                </p>
              ) : (
                <div className="space-y-2">
                  {solved.activeControls.map((ctrl) => {
                    const unit = ctrl.joint.type === "slide" ? "mm" : "°";
                    return (
                      <label key={ctrl.path} className="block space-y-1 rounded border bg-background/60 p-2">
                        <div className="flex items-center justify-between">
                          <span className="truncate font-medium">{ctrl.label}</span>
                          <span className="mono text-primary">{formatNum(ctrl.value)} {unit}</span>
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
            <div className="flex-1 space-y-3 overflow-y-auto pr-0.5">
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
                  <Button size="sm" variant={explodePct === 0 ? "secondary" : "ghost"} onClick={() => setExplodePct(0)}>收拢</Button>
                  <Button size="sm" variant={explodePct === 45 ? "secondary" : "ghost"} onClick={() => setExplodePct(45)}>45%</Button>
                  <Button size="sm" variant={explodePct === 100 ? "secondary" : "ghost"} onClick={() => setExplodePct(100)}>100%</Button>
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

          {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>}
        </aside>

        {/* Center 3D World Canvas */}
        <main className="relative flex min-h-[34rem] min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-2">
            <div className="pointer-events-auto max-w-2xl rounded-full border border-primary/30 bg-[#101c1a]/90 px-3.5 py-1.5 text-xs text-foreground shadow-md backdrop-blur">
              {currentHintBanner}
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="pointer-events-auto shadow-md"
              onClick={() => setFitToken((n) => n + 1)}
            >
              <RotateCcw />
              居中视角
            </Button>
          </div>

          <SandboxViewport3D
            workspace={state.workspace}
            assembly={state.assembly}
            mode={mode}
            armedBlockId={armedBlockId}
            selectedNodeId={selectedNodeId}
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

        {/* Right Contextual Part Inspector (only appears when a part is selected!) */}
        {selectedSolved && selectedRawNode && (
          <aside className="surface w-full shrink-0 space-y-3 p-3 text-xs lg:w-64" aria-label="选中积木属性">
            <div className="flex items-center justify-between border-b pb-2">
              <span className="truncate font-semibold">{selectedSolved.label}</span>
              <button
                type="button"
                aria-label="关闭零件面板"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedNodeId("")}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="field-label">零件名称</span>
                <Input
                  className="h-8 text-xs"
                  defaultValue={selectedSolved.label}
                  key={`name-${selectedRawNode.id}-${selectedRawNode.packageKey}`}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== selectedSolved.label) mutateSelectedNode({ label: next });
                  }}
                />
              </label>

              {selectedPkg?.primitive && (
                <div className="flex items-end gap-1.5">
                  <label className="flex-1 space-y-1">
                    <span className="field-label">主长度 / 宽 (mm)</span>
                    <Input
                      type="number"
                      className="h-8 text-xs"
                      placeholder="输入毫米"
                      value={customWidthInput}
                      onChange={(e) => setCustomWidthInput(e.target.value)}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const v = Number(customWidthInput);
                      if (v > 0) mutateSelectedNode({ primaryLengthMm: v });
                    }}
                  >
                    应用
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="flex-1" onClick={() => mutateSelectedNode({ rotateZ90: true })}>
                  绕 Z 旋转 90°
                </Button>
                {selectedPkg?.primitive && "axis" in selectedPkg.primitive && (
                  <select
                    aria-label="切换延伸轴"
                    className="h-8 rounded border bg-background px-2 text-xs"
                    value={selectedPkg.primitive.axis}
                    onChange={(e) => mutateSelectedNode({ axis: e.target.value as AxisDir })}
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
                    className="h-8 w-full rounded border bg-background px-2 text-xs"
                    value={selectedPart.joint.type}
                    onChange={(e) => mutateSelectedNode({ jointType: e.target.value as "fixed" | "slide" | "hinge" })}
                  >
                    <option value="fixed">fixed（刚性固定）</option>
                    <option value="slide">slide（直线滑动 ±120mm）</option>
                    <option value="hinge">hinge（旋转角度 ±180°）</option>
                  </select>
                </label>
              )}

              <label className="block space-y-1 border-t pt-2">
                <span className="field-label">换用真实品牌型号（可选）</span>
                <select
                  aria-label="换用真实品牌型号"
                  className="h-8 w-full rounded border bg-background px-2 text-xs"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) mutateSelectedNode({ vendorPresetId: e.target.value });
                  }}
                >
                  <option value="">{selectedPkg?.manufacturer} · {selectedPkg?.model}</option>
                  {REAL_VENDOR_BOM_PRESETS.map((v) => (
                    <option key={v.id} value={v.id}>
                      换为 {v.label}
                    </option>
                  ))}
                </select>
              </label>

              {selectedRawNode.parent !== null && (
                <Button size="sm" variant="destructive" className="w-full" onClick={deleteSelectedNode}>
                  <Trash2 />
                  拆掉此积木及下级子件
                </Button>
              )}
            </div>
          </aside>
        )}
      </div>

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
                                  const res = updateSandboxNode(state.workspace, state.assembly, firstNodeId, { vendorPresetId: presetId });
                                  setState((prev) => ({ ...prev, workspace: res.workspace, assembly: res.assembly }));
                                }
                              }}
                            >
                              <option value="">{row.hasRealBehavior ? "已带物理模型 · 可换" : "选真实型号…"}</option>
                              {REAL_VENDOR_BOM_PRESETS.filter((p) => p.category === row.suggestedPresetCategory).map((v) => (
                                <option key={v.id} value={v.id}>{v.label}</option>
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
