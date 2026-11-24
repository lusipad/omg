import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Blocks,
  Code,
  Compass,
  Download,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import type { ImportedModelInfo, ImportedRunSettings, ImportedSample } from "@contracts/imported-physics";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import {
  ARENA_PRESETS,
  compileAssemblyToMujoco,
  inferDefaultArenaAndMobility,
  type ArenaPresetId,
} from "@contracts/mujoco-compiler";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadBlob } from "@/lib/download";
import { loadImportedPhysics, type ImportedPhysics } from "@/lib/imported-physics";
import PhysicsModelCard from "./PhysicsModelCard";
import PhysicsScene from "./PhysicsScene";

export interface MujocoSandboxArenaProps {
  currentWorkspace: TwinWorkspace;
  currentAssembly: MechanicalAssembly;
  onBackToBuild: () => void;
  onOpenTemplates: () => void;
  onChangeBaseMobility?: (mobility: "fixed" | "free") => void;
}

interface LoadedSimState {
  readonly key: string;
  readonly info: ImportedModelInfo;
  readonly samples: ImportedSample[];
  readonly runUsed: ImportedRunSettings;
}

function fmtDisplacement(mm: number): string {
  const sign = mm >= 0 ? "+" : "-";
  const abs = Math.abs(mm);
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(2)} m`;
  return `${sign}${abs.toFixed(1)} mm`;
}

export default function MujocoSandboxArena({
  currentWorkspace,
  currentAssembly,
  onBackToBuild,
  onOpenTemplates,
  onChangeBaseMobility,
}: MujocoSandboxArenaProps) {
  const [arenaOverride, setArenaOverride] = useState<ArenaPresetId | null>(null);
  const [mobilityOverride, setMobilityOverride] = useState<"fixed" | "free" | null>(null);
  const [manualCtrls, setManualCtrls] = useState<number[] | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [simState, setSimState] = useState<LoadedSimState | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [focusToken, setFocusToken] = useState(1);
  const [xmlOpen, setXmlOpen] = useState(false);

  const engineRef = useRef<ImportedPhysics | null>(null);

  const isEmpty = currentAssembly.nodes.length === 0;

  const inferredDefaults = useMemo(
    () =>
      isEmpty
        ? { arena: "lab_floor" as ArenaPresetId, baseMobility: "fixed" as const }
        : inferDefaultArenaAndMobility(currentWorkspace, currentAssembly),
    [isEmpty, currentWorkspace, currentAssembly],
  );

  const effectiveArena = arenaOverride ?? inferredDefaults.arena;
  const effectiveMobility = mobilityOverride ?? inferredDefaults.baseMobility;

  const displayAssembly = useMemo(
    () =>
      currentAssembly.baseMobility === effectiveMobility
        ? currentAssembly
        : { ...currentAssembly, baseMobility: effectiveMobility },
    [currentAssembly, effectiveMobility],
  );

  const compilation = useMemo(() => {
    if (isEmpty) {
      return { ok: false as const, empty: true as const, key: "empty", error: "" };
    }
    try {
      const result = compileAssemblyToMujoco(currentWorkspace, currentAssembly, {
        arena: effectiveArena,
        baseMobility: effectiveMobility,
      });
      return {
        ok: true as const,
        empty: false as const,
        key: `${effectiveArena}:${effectiveMobility}:${currentAssembly.id}:${currentAssembly.nodes.length}:${result.xml.length}:${result.stats.equalityCount}`,
        result,
      };
    } catch (cause) {
      return {
        ok: false as const,
        empty: false as const,
        key: `err:${currentAssembly.id}`,
        error: cause instanceof Error ? cause.message : "装配尚未闭环，无法编译为 MuJoCo 物理模型。",
      };
    }
  }, [isEmpty, currentWorkspace, currentAssembly, effectiveArena, effectiveMobility]);

  // Spawn Worker and execute initial MuJoCo integration whenever compiled model changes
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();

    queueMicrotask(async () => {
      if (!alive) return;
      if (compilation.empty) {
        engineRef.current?.dispose();
        engineRef.current = null;
        setSimState(null);
        setErrorMsg("");
        setStatus("ready");
        return;
      }
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

  function handleExportXml() {
    if (!compilation.ok) return;
    downloadBlob(
      compilation.result.xml,
      `${currentAssembly.id}-${effectiveArena}.xml`,
      "application/xml;charset=utf-8",
    );
  }

  function handleChangeMobility(next: "fixed" | "free") {
    setMobilityOverride(next);
    onChangeBaseMobility?.(next);
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
    const deltaZMm = (last.pointM[2] - first.pointM[2]) * 1000;
    const peakZMm = Math.max(...simState.samples.map((s) => (s.pointM[2] - first.pointM[2]) * 1000));

    let payloadLiftMm: number | null = null;
    let payloadSlideMm: number | null = null;
    if (first.referenceM && last.referenceM) {
      payloadLiftMm = (last.referenceM[2] - first.referenceM[2]) * 1000;
      payloadSlideMm = (last.referenceM[0] - first.referenceM[0]) * 1000;
    }

    return {
      durationS: last.timeS,
      deltaXMm,
      deltaZMm,
      peakZMm,
      payloadLiftMm,
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

  if (isEmpty) {
    return (
      <div className="surface flex flex-1 items-center justify-center p-6">
        <div className="max-w-md space-y-3 rounded-lg border border-dashed border-primary/40 bg-background/60 p-6 text-center">
          <h2 className="text-base font-semibold text-foreground">当前画布还没有零件（0 件）</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            放置至少 1 个零件，或者从起点样机库直接载入成品原型，即可编译为 MJCF 并运行真实 MuJoCo 刚体动力学仿真。
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            <Button size="sm" className="h-8 text-xs" onClick={onBackToBuild}>
              <Blocks className="size-3.5" /> ← 去拼装设计放零件
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onOpenTemplates}>
              <Compass className="size-3.5" /> 浏览成品样机 →
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden max-md:grid-rows-[44dvh_auto_minmax(0,1fr)] md:grid-cols-[16.5rem_minmax(0,1fr)_16.5rem] xl:grid-cols-[18.5rem_minmax(0,1fr)_18.5rem]">
      {/* Left Pane: Testbed Environment & Motor Sliders */}
      <aside
        aria-label="试车控制台"
        className="surface flex min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs max-md:row-start-2 md:col-start-1 md:row-start-1"
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={onBackToBuild}>
              <ArrowLeft className="size-3.5" /> 返回拼装
            </Button>
            <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={onOpenTemplates}>
              <Compass className="size-3.5" /> 换其他样机
            </Button>
          </div>

          <div className="rounded-md border bg-background/50 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold text-foreground">{currentAssembly.name}</span>
              <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {currentAssembly.nodes.length}件
              </span>
            </div>
          </div>
        </div>

        {/* Physical World & Root Mobility */}
        <div className="space-y-2.5 border-t pt-3">
          <div className="space-y-1">
            <label htmlFor="arena-select" className="font-semibold text-foreground">
              试炼物理场地（g = -9.81 m/s²）
            </label>
            <select
              id="arena-select"
              aria-label="选择试炼物理场地"
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              value={effectiveArena}
              onChange={(e) => setArenaOverride(e.target.value as ArenaPresetId)}
            >
              {ARENA_PRESETS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <span className="font-semibold text-foreground">底座约束</span>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="sm"
                variant={effectiveMobility === "fixed" ? "default" : "outline"}
                className="h-8 text-xs"
                onClick={() => handleChangeMobility("fixed")}
              >
                🔩 固定基座
              </Button>
              <Button
                size="sm"
                variant={effectiveMobility === "free" ? "default" : "outline"}
                className="h-8 text-xs"
                onClick={() => handleChangeMobility("free")}
              >
                🛞 6-DOF 自由
              </Button>
            </div>
          </div>
        </div>

        {/* Motor & Actuator Sliders */}
        {compilation.ok && compilation.result.actuatorMeta.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground">
                电机与执行器 ({compilation.result.actuatorMeta.length})
              </span>
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={() => {
                  setManualCtrls(null);
                  void runWithSettings(compilation.result.recommendedRun);
                }}
              >
                恢复默认剧本
              </button>
            </div>

            {compilation.result.recommendedRun.sequence && manualCtrls === null && (
              <p className="text-[11px] text-emerald-300">
                正运行 {compilation.result.recommendedRun.sequence.length} 阶段推荐剧本 · 拖动滑块接管控制
              </p>
            )}

            <div className="space-y-2">
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
                  <label key={act.name} className="block space-y-1 rounded-md border bg-background/60 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{act.label}</span>
                      <span className="mono shrink-0 text-[11px] text-primary">{displayVal}</span>
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
              className="h-8 w-full text-xs"
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
              <Play /> 按当前滑块重算轨迹
            </Button>
          </div>
        )}
      </aside>

      {/* Center Pane: Live MuJoCo WASM 3D Playback */}
      <main className="surface relative flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2.5 max-md:row-start-1 md:col-start-2 md:row-start-1">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold text-foreground">{currentAssembly.name} · MuJoCo 实时求解</h2>
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
              <RotateCcw /> 重跑
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
              title={`${currentAssembly.name} MuJoCo 刚体接触动力学视图`}
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

      {/* Right Pane: Hero Telemetry, Physics Equations & MJCF Inspect */}
      <aside
        aria-label="实测表现与物理原理"
        className="surface flex min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs max-md:row-start-3 md:col-start-3 md:row-start-1"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 font-semibold text-foreground">
              <Activity className="size-3.5 text-primary" />
              仿真运动实测
            </h2>
            {telemetry && (
              <span className="mono text-[11px] text-muted-foreground">{telemetry.durationS.toFixed(2)}s</span>
            )}
          </div>

          {!compilation.ok ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              {compilation.error}
            </p>
          ) : (
            <div className="space-y-2">
              {telemetry ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <div className="text-[11px] text-muted-foreground">净高度变化 ΔZ</div>
                      <div className="mono mt-0.5 text-sm font-bold text-sky-300">
                        {fmtDisplacement(telemetry.deltaZMm)}
                      </div>
                    </div>
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <div className="text-[11px] text-muted-foreground">水平位移 ΔX</div>
                      <div className="mono mt-0.5 text-sm font-bold text-emerald-300">
                        {fmtDisplacement(telemetry.deltaXMm)}
                      </div>
                    </div>
                  </div>

                  {telemetry.payloadLiftMm !== null && (
                    <div
                      className={`rounded-md border px-2.5 py-1.5 text-xs ${
                        telemetry.payloadLiftMm > 35
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                      }`}
                    >
                      {effectiveArena === "grasp_pedestal"
                        ? telemetry.payloadLiftMm > 35
                          ? `物块静摩擦夹持抬起 ${fmtDisplacement(telemetry.payloadLiftMm)}`
                          : `物块尚未稳定抬离（${fmtDisplacement(telemetry.payloadLiftMm)}）`
                        : `物块水平推距 ${fmtDisplacement(telemetry.payloadSlideMm ?? 0)}`}
                    </div>
                  )}

                  {effectiveArena === "flat_ramp" && effectiveMobility === "free" && (
                    <div
                      className={`rounded-md border px-2.5 py-1.5 text-xs ${
                        telemetry.deltaXMm > 350 && telemetry.deltaZMm > 30
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : "border-border bg-background/60 text-muted-foreground"
                      }`}
                    >
                      {telemetry.deltaXMm > 350 && telemetry.deltaZMm > 30
                        ? "电驱四轮沿 10° 坡面摩擦爬升"
                        : "可通过左侧开启轮毂电机驱动观察爬坡。"}
                    </div>
                  )}

                  {effectiveArena === "launch_complex" && effectiveMobility === "free" && (
                    <div
                      className={`rounded-md border px-2.5 py-1.5 text-xs ${
                        telemetry.peakZMm > 350
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : "border-border bg-background/60 text-muted-foreground"
                      }`}
                    >
                      {Math.abs(telemetry.peakZMm - telemetry.deltaZMm) > 100
                        ? `峰值爬升 +${(telemetry.peakZMm / 1000).toFixed(2)} m · `
                        : ""}
                      {telemetry.peakZMm > 350 ? "电机推力克服重力离台升空" : "推力尚不足以克服自重"}
                    </div>
                  )}

                  {effectiveMobility === "fixed" &&
                    compilation.result.actuatorMeta.filter((a) => a.mode === "velocity").length >= 2 && (
                      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200">
                        {compilation.result.actuatorMeta.length} 组回转副按设定角速度同步运行
                      </div>
                    )}
                </>
              ) : (
                <p className="rounded-md border bg-background/50 p-2.5 text-xs text-muted-foreground">
                  等待仿真积分输出实时位移数据…
                </p>
              )}

              {compilation.result.motorCouplings.length > 0 && (
                <div className="space-y-1.5">
                  {compilation.result.motorCouplings.map((mc) => (
                    <div
                      key={`${mc.kind}_${mc.effectorPath}`}
                      className={`rounded-md border px-2.5 py-1.5 text-xs ${
                        mc.active
                          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                      }`}
                    >
                      {mc.active ? (
                        <span>
                          ⚡ {mc.motorLabel} → {mc.effectorLabel}（{mc.kind === "pump_speed" ? "F ∝ ω_pump" : "F ∝ ω²"} · 上限 {mc.maxForceN} N）
                        </span>
                      ) : (
                        <span>⚠️ {mc.effectorLabel} 当前 0 N：{mc.reason}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <p className="mono text-[11px] text-muted-foreground">
                编译规模：{compilation.result.stats.bodyCount} 刚体 · {compilation.result.stats.jointCount} 副 ·{" "}
                {compilation.result.stats.totalMassKg.toFixed(2)} kg
                {compilation.result.stats.equalityCount > 0 ? ` · ${compilation.result.stats.equalityCount} 闭环` : ""}
                {compilation.result.stats.tendonCount > 0 ? ` · ${compilation.result.stats.tendonCount} 弹簧` : ""}
              </p>

              {simState && simState.info.warnings.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
                  {simState.info.warnings.join(" ")}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t pt-3">
          <PhysicsModelCard
            workspace={currentWorkspace}
            assembly={displayAssembly}
            compact
            hideSystemSummary
          />
        </div>

        <div className="mt-auto grid grid-cols-2 gap-1.5 border-t pt-2.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={!compilation.ok}
            onClick={() => setXmlOpen(true)}
          >
            <Code /> 查看 MJCF
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={!compilation.ok}
            onClick={handleExportXml}
          >
            <Download /> 导出 .xml
          </Button>
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
