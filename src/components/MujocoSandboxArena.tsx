import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Box,
  Code,
  Download,
  ExternalLink,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Wrench,
} from "lucide-react";
import { parseImportCatalog, type ModelRef } from "@contracts/import-catalog";
import type { ImportedModelInfo, ImportedRunSettings, ImportedSample } from "@contracts/imported-physics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import {
  ARENA_PRESETS,
  compileAssemblyToMujoco,
  inferDefaultArenaAndMobility,
  type ArenaPresetId,
} from "@contracts/mujoco-compiler";
import type { StudioRoute } from "@contracts/studio-navigation";
import { parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import {
  loadUniversalArchetype,
  UNIVERSAL_ARCHETYPES,
  type UniversalArchetypeId,
} from "@contracts/universal-archetypes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadBlob } from "@/lib/download";
import { loadImportedPhysics, type ImportedPhysics } from "@/lib/imported-physics";
import { describeModel, putModelBundle } from "@/lib/model-files";
import PhysicsModelCard from "./PhysicsModelCard";
import PhysicsScene from "./PhysicsScene";

export interface MujocoSandboxArenaProps {
  hostWorkspace: TwinWorkspace;
  currentWorkspace: TwinWorkspace;
  currentAssembly: MechanicalAssembly;
  initialSource?: "current" | UniversalArchetypeId;
  onLoadIntoSandbox: (ws: TwinWorkspace, assembly: MechanicalAssembly, notice?: string) => void;
  onSaveHostWorkspace: (next: TwinWorkspace) => void;
  onNavigate: (route: StudioRoute, message?: string) => void;
}

type ArenaSourceChoice = "current" | UniversalArchetypeId;

interface LoadedSimState {
  readonly key: string;
  readonly info: ImportedModelInfo;
  readonly samples: ImportedSample[];
  readonly runUsed: ImportedRunSettings;
}

const fmtMm = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} mm`;

export default function MujocoSandboxArena({
  hostWorkspace,
  currentWorkspace,
  currentAssembly,
  initialSource,
  onLoadIntoSandbox,
  onSaveHostWorkspace,
  onNavigate,
}: MujocoSandboxArenaProps) {
  const [sourceChoice, setSourceChoice] = useState<ArenaSourceChoice>(() =>
    initialSource ?? (currentAssembly.nodes.length >= 2 ? "current" : "reusable-tvc-rocket"),
  );
  const [arenaOverride, setArenaOverride] = useState<ArenaPresetId | null>(null);
  const [mobilityOverride, setMobilityOverride] = useState<"fixed" | "free" | null>(null);
  const [manualCtrls, setManualCtrls] = useState<number[] | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [simState, setSimState] = useState<LoadedSimState | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [focusToken, setFocusToken] = useState(1);
  const [exportingPro, setExportingPro] = useState(false);
  const [xmlOpen, setXmlOpen] = useState(false);

  const engineRef = useRef<ImportedPhysics | null>(null);

  const activeInput = useMemo(() => {
    if (sourceChoice === "current") {
      return { workspace: currentWorkspace, assembly: currentAssembly, isArchetype: false as const };
    }
    const loaded = loadUniversalArchetype(sourceChoice);
    return { ...loaded, isArchetype: true as const };
  }, [sourceChoice, currentWorkspace, currentAssembly]);

  const inferredDefaults = useMemo(
    () => inferDefaultArenaAndMobility(activeInput.workspace, activeInput.assembly),
    [activeInput.workspace, activeInput.assembly],
  );

  const effectiveArena = arenaOverride ?? inferredDefaults.arena;
  const effectiveMobility = mobilityOverride ?? inferredDefaults.baseMobility;

  const compilation = useMemo(() => {
    try {
      const result = compileAssemblyToMujoco(activeInput.workspace, activeInput.assembly, {
        arena: effectiveArena,
        baseMobility: effectiveMobility,
      });
      return {
        ok: true as const,
        key: `${sourceChoice}:${effectiveArena}:${effectiveMobility}:${activeInput.assembly.id}:${activeInput.assembly.nodes.length}:${result.xml.length}:${result.stats.equalityCount}`,
        result,
      };
    } catch (cause) {
      return {
        ok: false as const,
        key: `err:${sourceChoice}`,
        error: cause instanceof Error ? cause.message : "装配尚未闭环，无法编译为 MuJoCo 物理模型。",
      };
    }
  }, [activeInput.workspace, activeInput.assembly, effectiveArena, effectiveMobility, sourceChoice]);

  // Spawn Worker and execute initial MuJoCo integration whenever compiled model changes
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();

    queueMicrotask(async () => {
      if (!alive) return;
      if (!compilation.ok) {
        setStatus("error");
        setErrorMsg(compilation.error);
        setSimState(null);
        return;
      }

      setStatus("loading");
      setErrorMsg("");
      try {
        const engine = await loadImportedPhysics(compilation.result.bundle, ac.signal);
        if (!alive) {
          engine.dispose();
          return;
        }
        engineRef.current?.dispose();
        engineRef.current = engine;
        const runSettings = compilation.result.recommendedRun;
        const samples = await engine.run(runSettings);
        if (!alive) return;
        setSimState({
          key: compilation.key,
          info: engine.info,
          samples,
          runUsed: runSettings,
        });
        setManualCtrls(null);
        setFrameIdx(0);
        setPlaying(true);
        setFocusToken((n) => n + 1);
        setStatus("ready");
      } catch (cause) {
        if (!alive || ac.signal.aborted) return;
        setErrorMsg(cause instanceof Error ? cause.message : "MuJoCo 仿真线程执行失败。");
        setStatus("error");
      }
    });

    return () => {
      alive = false;
      ac.abort();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [compilation]);

  // Playback animation loop synced to MuJoCo trajectory frames
  const totalSamples = simState?.samples.length ?? 0;
  useEffect(() => {
    if (!playing || status !== "ready" || totalSamples < 2) return;
    const id = window.setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % totalSamples);
    }, 32);
    return () => window.clearInterval(id);
  }, [playing, status, totalSamples]);

  async function runWithSettings(nextSettings: ImportedRunSettings) {
    if (!compilation.ok || !engineRef.current) return;
    setStatus("loading");
    setErrorMsg("");
    try {
      const samples = await engineRef.current.run(nextSettings);
      setSimState({
        key: compilation.key,
        info: engineRef.current.info,
        samples,
        runUsed: nextSettings,
      });
      setFrameIdx(0);
      setPlaying(true);
      setStatus("ready");
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : "物理步进求解失败。");
      setStatus("error");
    }
  }

  async function handleSendToProMujoco() {
    if (!compilation.ok || exportingPro) return;
    setExportingPro(true);
    setErrorMsg("");
    try {
      const compiled = compilation.result;
      const baseRef = await describeModel(compiled.bundle);
      const runToSave = simState?.runUsed ?? compiled.recommendedRun;
      const ref: ModelRef = { ...baseRef, run: runToSave };
      await putModelBundle(ref, compiled.bundle);

      const baseWs = parseWorkspace(hostWorkspace);
      const existingCatalog = baseWs.catalog ?? { models: [], materials: [] };
      const nextModels = [
        ...existingCatalog.models.filter((m) => m.id !== ref.id),
        ref,
      ];
      const nextWs: TwinWorkspace = {
        ...baseWs,
        catalog: parseImportCatalog(
          { models: nextModels, materials: existingCatalog.materials },
          baseWs.packages,
        ),
      };
      onSaveHostWorkspace(nextWs);
      onNavigate(
        { view: "workbench", target: `model:${ref.id}` },
        `已将「${activeInput.assembly.name}」实时编译为 MuJoCo 物理模型并载入专业求解工作台。`,
      );
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : "写入 MuJoCo 模型库失败。");
    } finally {
      setExportingPro(false);
    }
  }

  function handleExportXml() {
    if (!compilation.ok) return;
    downloadBlob(
      compilation.result.xml,
      `${activeInput.assembly.id}-${effectiveArena}.xml`,
      "application/xml;charset=utf-8",
    );
  }

  function handleSelectSource(next: ArenaSourceChoice) {
    setSourceChoice(next);
    setArenaOverride(null);
    setMobilityOverride(null);
    setManualCtrls(null);
  }

  const activeSample =
    simState && simState.samples.length > 0
      ? simState.samples[Math.min(frameIdx, simState.samples.length - 1)]!
      : simState?.info.initial;

  const telemetry = useMemo(() => {
    if (!simState || simState.samples.length < 2) return null;
    const first = simState.samples[0]!;
    const last = simState.samples.at(-1)!;
    const deltaXMm = (last.pointM[0] - first.pointM[0]) * 1000;
    const deltaYMm = (last.pointM[1] - first.pointM[1]) * 1000;
    const deltaZMm = (last.pointM[2] - first.pointM[2]) * 1000;
    const peakZMm = Math.max(...simState.samples.map((s) => (s.pointM[2] - first.pointM[2]) * 1000));
    const minZMm = Math.min(...simState.samples.map((s) => (s.pointM[2] - first.pointM[2]) * 1000));

    let payloadLiftMm: number | null = null;
    let payloadPeakLiftMm: number | null = null;
    let payloadSlideMm: number | null = null;
    if (first.referenceM && last.referenceM) {
      payloadLiftMm = (last.referenceM[2] - first.referenceM[2]) * 1000;
      payloadPeakLiftMm = Math.max(...simState.samples.map((s) => (s.referenceM![2] - first.referenceM![2]) * 1000));
      payloadSlideMm = (last.referenceM[0] - first.referenceM[0]) * 1000;
    }

    return {
      durationS: last.timeS,
      sampleCount: simState.samples.length,
      deltaXMm,
      deltaYMm,
      deltaZMm,
      peakZMm,
      minZMm,
      payloadLiftMm,
      payloadPeakLiftMm,
      payloadSlideMm,
    };
  }, [simState]);

  const sliderValues = useMemo(() => {
    if (!compilation.ok) return [];
    if (manualCtrls && manualCtrls.length === compilation.result.actuatorMeta.length) {
      return manualCtrls;
    }
    const seq = compilation.result.recommendedRun.sequence;
    if (seq && seq.length > 0) return [...seq.at(-1)!.controls];
    return [...compilation.result.recommendedRun.controls];
  }, [compilation, manualCtrls]);

  const activeArchetypeMeta =
    sourceChoice !== "current" ? UNIVERSAL_ARCHETYPES.find((a) => a.id === sourceChoice) : undefined;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden max-lg:grid-rows-[46dvh_auto_minmax(0,1fr)] lg:grid-cols-[19rem_minmax(0,1fr)_18.5rem]">
      {/* Left Pane: Subject Selection, Arena & Controls */}
      <aside
        aria-label="多体仿真对象与环境控制"
        className="surface flex min-h-0 flex-col gap-2 overflow-y-auto p-2.5 text-xs max-lg:row-start-3 lg:col-start-1 lg:row-start-1"
      >
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <h2 className="font-semibold text-foreground">仿真装配模型</h2>
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              MuJoCo 刚体求解
            </span>
          </div>

          <button
            type="button"
            onClick={() => handleSelectSource("current")}
            className={`w-full rounded-md border p-2 text-left transition-colors ${
              sourceChoice === "current"
                ? "border-primary bg-primary/15 ring-1 ring-primary"
                : "bg-background/50 hover:border-primary/40"
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate font-semibold text-foreground">
                当前装配 · {currentAssembly.name}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                {currentAssembly.nodes.length}件
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              将当前拼装构型编译为刚体模型并在重力场中求解
            </p>
          </button>

          {(
            [
              {
                category: "flagship" as const,
                heading: "空天载具与建筑结构",
                badgeClass: "bg-amber-500/15 text-amber-300",
              },
              {
                category: "mechanism" as const,
                heading: "移动底盘与典型机构",
                badgeClass: "bg-sky-500/15 text-sky-300",
              },
            ] as const
          ).map((group) => (
            <div key={group.category} className="space-y-1 pt-1">
              <p className="text-[10px] font-semibold text-muted-foreground">{group.heading}</p>
              <div className="space-y-1">
                {UNIVERSAL_ARCHETYPES.filter((a) => a.category === group.category).map((item) => {
                  const selected = sourceChoice === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectSource(item.id)}
                      className={`w-full rounded-md border p-2 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/15 ring-1 ring-primary"
                          : "bg-background/50 hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate font-semibold text-foreground">{item.title}</span>
                        <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${group.badgeClass}`}>
                          {item.badge}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                        {item.subtitle}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {activeInput.isArchetype && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 w-full text-[11px]"
              onClick={() =>
                onLoadIntoSandbox(
                  activeInput.workspace,
                  activeInput.assembly,
                  `已将「${activeInput.assembly.name}」送入自由创造台，可自由增删积木并生成采购 BOM`,
                )
              }
            >
              <Wrench /> 送入自由创造台拆改零件
            </Button>
          )}
        </div>

        {/* Physical World & Root Mobility Settings */}
        <div className="space-y-2 border-t pt-2">
          <div className="space-y-1">
            <label htmlFor="arena-select" className="font-semibold text-foreground">
              试炼物理场地（重力 g = -9.81 m/s²）
            </label>
            <select
              id="arena-select"
              aria-label="选择试炼物理场地"
              className="h-7 w-full rounded border bg-background px-1.5 text-[11px]"
              value={effectiveArena}
              onChange={(e) => setArenaOverride(e.target.value as ArenaPresetId)}
            >
              {ARENA_PRESETS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] leading-snug text-muted-foreground">
              {ARENA_PRESETS.find((a) => a.id === effectiveArena)?.summary}
            </p>
          </div>

          <div className="space-y-1">
            <span className="font-semibold text-foreground">底座刚体安装约束</span>
            <div className="grid grid-cols-2 gap-1">
              <Button
                size="sm"
                variant={effectiveMobility === "fixed" ? "default" : "outline"}
                className="h-7 text-[11px]"
                onClick={() => setMobilityOverride("fixed")}
              >
                🔩 固定螺栓基座
              </Button>
              <Button
                size="sm"
                variant={effectiveMobility === "free" ? "default" : "outline"}
                className="h-7 text-[11px]"
                onClick={() => setMobilityOverride("free")}
              >
                🛞 6-DOF 自由底盘
              </Button>
            </div>
          </div>
        </div>

        {/* Actuator Sliders & Script Re-run */}
        {compilation.ok && compilation.result.actuatorMeta.length > 0 && (
          <div className="space-y-1.5 border-t pt-2">
            <div className="flex items-center justify-between gap-1">
              <span className="font-semibold text-foreground">
                主动执行器控制 ({compilation.result.actuatorMeta.length})
              </span>
              <button
                type="button"
                className="text-[10px] text-primary hover:underline"
                onClick={() => {
                  setManualCtrls(null);
                  void runWithSettings(compilation.result.recommendedRun);
                }}
              >
                恢复推荐动作剧本
              </button>
            </div>

            {compilation.result.recommendedRun.sequence && manualCtrls === null && (
              <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-1.5 text-[10px] text-emerald-200">
                <div className="font-medium">当前正运行多阶段剧本：</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {compilation.result.recommendedRun.sequence.map((st, idx) => (
                    <span key={idx} className="rounded bg-background/50 px-1 py-0.5">
                      {st.timeS}s {st.label ?? `阶段${idx + 1}`}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              {compilation.result.actuatorMeta.map((act, idx) => {
                const val = sliderValues[idx] ?? 0;
                const displayVal =
                  act.unit === "rad"
                    ? `${((val * 180) / Math.PI).toFixed(1)}°`
                    : act.unit === "m"
                      ? `${(val * 1000).toFixed(1)} mm`
                      : act.unit === "N"
                        ? `${val.toFixed(1)} N`
                        : `${val.toFixed(1)} rad/s`;
                return (
                  <label key={act.name} className="block space-y-0.5 rounded border bg-background/60 p-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-[11px] font-medium">{act.label}</span>
                      <span className="mono shrink-0 text-[10px] text-primary">{displayVal}</span>
                    </div>
                    <input
                      type="range"
                      min={act.range[0]}
                      max={act.range[1]}
                      step={(act.range[1] - act.range[0]) / 80}
                      value={val}
                      className="h-4 w-full accent-primary"
                      onChange={(e) => {
                        const num = Number(e.currentTarget.value);
                        setManualCtrls(() => {
                          const next = [...sliderValues];
                          next[idx] = num;
                          return next;
                        });
                      }}
                    />
                  </label>
                );
              })}
            </div>

            <Button
              size="sm"
              className="h-7 w-full text-[11px]"
              disabled={status === "loading"}
              onClick={() =>
                void runWithSettings({
                  durationS: compilation.result.recommendedRun.durationS,
                  controls: sliderValues,
                  pointId: compilation.result.recommendedRun.pointId,
                  ...(compilation.result.recommendedRun.referencePointId
                    ? { referencePointId: compilation.result.recommendedRun.referencePointId }
                    : {}),
                })
              }
            >
              <Play /> 按当前滑块目标值重算物理轨迹
            </Button>
          </div>
        )}
      </aside>

      {/* Center Pane: Live MuJoCo WASM 3D Viewport + Timeline */}
      <main className="surface relative flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2.5 max-lg:row-start-1 lg:col-start-2 lg:row-start-1">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {activeInput.assembly.name}
              {activeArchetypeMeta ? ` · ${activeArchetypeMeta.physicsHighlights}` : ""}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={status !== "ready" || totalSamples < 2}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? <Pause /> : <Play />}
              {playing ? "暂停" : "播放"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!compilation.ok || status === "loading"}
              onClick={() => compilation.ok && void runWithSettings(simState?.runUsed ?? compilation.result.recommendedRun)}
            >
              <RotateCcw /> 重跑积分
            </Button>
          </div>
        </div>

        {status === "error" && errorMsg && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            {errorMsg}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {simState && activeSample ? (
            <PhysicsScene
              key={simState.key}
              geometry={simState.info.geometry}
              sample={activeSample}
              trail={simState.samples}
              title={`${activeInput.assembly.name} MuJoCo 刚体接触动力学视图`}
              pointName={compilation.ok && effectiveMobility === "free" ? "质心追踪" : "末端观测点"}
              coordinateLabel="MuJoCo 世界坐标"
              unit="mm"
              worktable={false}
              focus={String(focusToken)}
            />
          ) : (
            <div className="flex h-[340px] items-center justify-center rounded-md border bg-background/60 text-xs text-muted-foreground">
              {status === "loading" ? "正在 Web Worker 中编译 MJCF 并步进 MuJoCo 刚体动力学…" : "等待可编译装配…"}
            </div>
          )}
        </div>

        {simState && simState.samples.length > 1 && (
          <div className="flex shrink-0 items-center gap-2 rounded-md border bg-background/60 px-2.5 py-1.5 text-xs">
            <span className="mono shrink-0 text-[11px] text-primary">
              {(activeSample?.timeS ?? 0).toFixed(2)}s / {(simState.samples.at(-1)?.timeS ?? 0).toFixed(2)}s
            </span>
            <input
              type="range"
              aria-label="MuJoCo 仿真时间轴"
              min={0}
              max={simState.samples.length - 1}
              value={Math.min(frameIdx, simState.samples.length - 1)}
              className="h-4 min-w-0 flex-1 accent-primary"
              onChange={(e) => {
                setPlaying(false);
                setFrameIdx(Number(e.currentTarget.value));
              }}
            />
          </div>
        )}
      </main>

      {/* Right Pane: Physics Telemetry, Structural Compile Stats & Pro Hand-off */}
      <aside
        aria-label="MuJoCo 动力学遥测与专业台通道"
        className="surface flex min-h-0 flex-col gap-2.5 overflow-y-auto p-2.5 text-xs max-lg:row-start-3 lg:col-start-3 lg:row-start-1"
      >
        <div className="space-y-1.5">
          <h2 className="flex items-center gap-1.5 font-semibold text-foreground">
            <Activity className="size-3.5 text-primary" />
            MJCF 物理编译规模
          </h2>
          {compilation.ok ? (
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <div className="rounded border bg-background/60 p-2">
                <div className="text-[10px] text-muted-foreground">刚体 / 运动自由度</div>
                <div className="mono font-semibold text-foreground">
                  {compilation.result.stats.bodyCount} 体 · {compilation.result.stats.jointCount} 副
                </div>
              </div>
              <div className="rounded border bg-background/60 p-2">
                <div className="text-[10px] text-muted-foreground">总估算质量</div>
                <div className="mono font-semibold text-foreground">
                  {compilation.result.stats.totalMassKg.toFixed(2)} kg
                </div>
              </div>
              <div className="rounded border bg-background/60 p-2">
                <div className="text-[10px] text-muted-foreground">闭环 / 耦合约束</div>
                <div className="mono font-semibold text-sky-300">
                  {compilation.result.stats.equalityCount} 条 equality
                </div>
              </div>
              <div className="rounded border bg-background/60 p-2">
                <div className="text-[10px] text-muted-foreground">空间弹簧阻尼</div>
                <div className="mono font-semibold text-emerald-300">
                  {compilation.result.stats.tendonCount} 组 tendon
                </div>
              </div>
            </div>
          ) : (
            <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {compilation.error}
            </p>
          )}
        </div>

        {/* Measured Contact & Motion Telemetry */}
        <div className="space-y-1.5 border-t pt-2">
          <h2 className="flex items-center gap-1.5 font-semibold text-foreground">
            <Layers className="size-3.5 text-primary" />
            真实刚体积分实测结果
          </h2>
          {telemetry ? (
            <div className="space-y-1.5 text-[11px]">
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded border bg-background/60 p-2">
                  <div className="text-[10px] text-muted-foreground">末端/车体 ΔX</div>
                  <div className="mono font-semibold text-emerald-300">{fmtMm(telemetry.deltaXMm)}</div>
                </div>
                <div className="rounded border bg-background/60 p-2">
                  <div className="text-[10px] text-muted-foreground">净高度变化 ΔZ</div>
                  <div className="mono font-semibold text-sky-300">{fmtMm(telemetry.deltaZMm)}</div>
                </div>
              </div>

              {telemetry.payloadLiftMm !== null && (
                <div
                  className={`space-y-1 rounded border p-2 ${
                    telemetry.payloadLiftMm > 35
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-amber-500/40 bg-amber-500/10"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>被抓 / 被推物块轨迹</span>
                    <span className="mono">{fmtMm(telemetry.payloadLiftMm)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {effectiveArena === "grasp_pedestal"
                      ? telemetry.payloadLiftMm > 35
                        ? "✅ 纯接触静摩擦力牢牢夹紧 80g 自由物块并抬离台面"
                        : "⚠️ 物块尚未稳定抬离台面，可调整夹指对夹行程或摩擦材质"
                      : `物块水平推距 ${fmtMm(telemetry.payloadSlideMm ?? 0)}`}
                  </p>
                </div>
              )}

              {effectiveArena === "flat_ramp" && effectiveMobility === "free" && (
                <div
                  className={`rounded border p-2 text-[10px] ${
                    telemetry.deltaXMm > 350 && telemetry.deltaZMm > 30
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-border bg-background/60 text-muted-foreground"
                  }`}
                >
                  {telemetry.deltaXMm > 350 && telemetry.deltaZMm > 30
                    ? "四轮接触摩擦驱动底盘沿 10° 坡面爬升"
                    : "可在左侧开启转速驱动或切换 6-DOF 自由底盘观察轮地接触牵引。"}
                </div>
              )}

              {effectiveArena === "launch_complex" && effectiveMobility === "free" && (
                <div
                  className={`space-y-1 rounded border p-2 text-[10px] ${
                    telemetry.peakZMm > 350
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-border bg-background/60 text-muted-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-semibold">
                    <span>峰值爬升高度 +{(telemetry.peakZMm / 1000).toFixed(2)} m</span>
                    <span className="mono">水平航程 {(telemetry.deltaXMm / 1000).toFixed(2)} m</span>
                  </div>
                  <p>
                    {telemetry.peakZMm > 350
                      ? `推力大于自重，垂直爬升峰值 +${(telemetry.peakZMm / 1000).toFixed(2)} m`
                      : "可在左侧开启推进推力或调整旋翼总距与矢量摆角，观察重力场爬升轨迹。"}
                  </p>
                </div>
              )}

              {effectiveMobility === "fixed" &&
                compilation.ok &&
                compilation.result.actuatorMeta.filter((a) => a.mode === "velocity").length >= 2 && (
                  <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-[10px] text-emerald-200">
                    {compilation.result.actuatorMeta.length} 组回转副按设定角速度同步运行
                  </div>
                )}

              {simState && simState.info.warnings.length > 0 && (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[10px] text-amber-200">
                  {simState.info.warnings.join(" ")}
                </div>
              )}
            </div>
          ) : (
            <p className="rounded border bg-background/50 p-2 text-[11px] text-muted-foreground">
              等待仿真积分输出实时位移与接触数据…
            </p>
          )}
        </div>

        {/* Underlying Mathematical & Physical Equations */}
        <div className="space-y-1.5 border-t pt-2">
          <PhysicsModelCard
            workspace={activeInput.workspace}
            assembly={activeInput.assembly}
            compact
          />
        </div>

        {/* Pro Workbench Hand-off & MJCF Export */}
        <div className="mt-auto space-y-1.5 border-t pt-2.5">
          <p className="text-[10px] font-semibold text-muted-foreground">导出与专业工作台衔接</p>
          <Button
            size="sm"
            className="h-8 w-full text-xs"
            disabled={!compilation.ok || exportingPro}
            onClick={() => void handleSendToProMujoco()}
          >
            <Sparkles />
            {exportingPro ? "正在推送至专业求解器…" : "送入专业台 MuJoCo 求解器"}
            <ArrowRight />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full text-[11px]"
            disabled={!compilation.ok}
            onClick={() => setXmlOpen(true)}
          >
            <Code /> 查看编译生成的 MJCF 源码
          </Button>
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={!compilation.ok}
              onClick={handleExportXml}
            >
              <Download /> 导出 MJCF (.xml)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => onNavigate({ view: "workbench" })}
            >
              <Box /> 打开工作台 <ExternalLink className="size-3" />
            </Button>
          </div>
        </div>
      </aside>

      <Dialog open={xmlOpen} onOpenChange={setXmlOpen}>
        <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>自动编译生成的 MuJoCo MJCF 物理描述源码</DialogTitle>
            <DialogDescription>
              下方 XML 由前端装配图、质量惯量矩阵、运动副螺旋轴与推力/闭环约束实时编译而成，直接送入 WASM 刚体积分器求解。
            </DialogDescription>
          </DialogHeader>
          <pre className="mono max-h-[60dvh] overflow-auto rounded border bg-background/80 p-3 text-[11px] leading-relaxed text-emerald-200">
            {compilation.ok ? compilation.result.xml : compilation.error}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
