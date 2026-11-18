import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, RotateCcw } from "lucide-react";
import type { ModelBundle } from "@contracts/import-catalog";
import { IMPORTED_PHYSICS_LIMITS, type ImportedModelInfo, type ImportedPhysics, type ImportedRunSettings, type ImportedSample } from "@contracts/imported-physics";
import { loadImportedPhysics } from "@/lib/imported-physics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ImportedStateTrace from "./ImportedStateTrace";
import PhysicsScene from "./PhysicsScene";

type RunProps = { initialSettings?: ImportedRunSettings; onRun?: (settings: ImportedRunSettings) => void };
type Props = RunProps & { bundle: ModelBundle; onReady?: (ready: boolean) => void };
type LoadingResult = { bundle: ModelBundle; attempt: number; signal: AbortSignal; engine?: ImportedPhysics; error?: string };
const emptySamples: ImportedSample[] = [];
const numberText = (value: number) => String(Number(value.toPrecision(6)));
const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const jointLabels = { hinge: "转动", slide: "移动", ball: "球形", free: "自由" };

function StateList({ label, channels, values }: {
  label: "位置" | "速度"; channels: { name: string; unit: string }[]; values: number[];
}) {
  return <div className="min-w-0">
    <h4 className="mb-1.5 text-xs font-medium">{label}分量</h4>
    <dl className="surface-inset thin-scrollbar max-h-56 divide-y overflow-y-auto">
      {channels.map((channel, i) => <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
        <dt className="min-w-0 break-all text-muted-foreground">{channel.name}</dt>
        <dd className="mono shrink-0"><output aria-label={`${label} ${channel.name}`}>{numberText(values[i])}</output> {channel.unit === "1" ? "无量纲" : channel.unit}</dd>
      </div>)}
    </dl>
  </div>;
}

function checkSettings(settings: ImportedRunSettings, info: ImportedModelInfo, maxDuration: number) {
  if (!settings || !Number.isFinite(settings.durationS) || settings.durationS <= 0 || settings.durationS > maxDuration) {
    return `运行时长须大于零且不超过 ${numberText(maxDuration)} s。`;
  }
  if (!Array.isArray(settings.controls) || settings.controls.length !== info.actuators.length) return "控制值数量与模型执行器不符。";
  for (const [i, { name, range, unit }] of info.actuators.entries()) {
    const value = settings.controls[i];
    if (!Number.isFinite(value)) return `请填写执行器“${name}”的有限数值。`;
    if (range && (value < range[0] || value > range[1])) return `执行器“${name}”的控制范围为 ${numberText(range[0])} 至 ${numberText(range[1])} ${unit}。`;
  }
  return info.points.some((point) => point.id === settings.pointId) ? "" : "模型中没有该观察点。";
}

function RuntimePanel({ engine, reload, initialSettings, onRun }: RunProps & { engine: ImportedPhysics; reload: () => void }) {
  const { info } = engine;
  const maxDuration = Math.min(IMPORTED_PHYSICS_LIMITS.maxDurationS, info.timestepS * IMPORTED_PHYSICS_LIMITS.maxSteps);
  const defaultDuration = Math.min(maxDuration, Math.max(1, info.timestepS));
  const [restored] = useState(() => {
    const issue = initialSettings === undefined ? "" : checkSettings(initialSettings, info, maxDuration);
    return { settings: issue ? undefined : initialSettings, error: issue ? `已保存的运行工况无法恢复。${issue} 已采用模型初值。` : "" };
  });
  const [duration, setDuration] = useState(String(restored.settings?.durationS ?? defaultDuration));
  const [controls, setControls] = useState(() => (restored.settings?.controls ?? info.actuators.map((item) => item.initial)).map(String));
  const [pointId, setPointId] = useState(restored.settings?.pointId ?? info.points[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(restored.error);
  const [samples, setSamples] = useState(emptySamples);
  const [index, setIndex] = useState(0);
  const [playFrom, setPlayFrom] = useState<number | null>(null);
  const point = info.points.find((item) => item.id === pointId);
  const sample = samples[index] ?? (point ? { ...info.initial, pointM: point.initialM } : info.initial);
  const alive = useRef(true);
  const recordRun = useRef(onRun);
  useEffect(() => { recordRun.current = onRun; }, [onRun]);
  const reloadOnReset = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (playFrom === null || !samples.length) return;
    let current = playFrom, frame = 0;
    const started = performance.now(), initial = samples[current].timeS;
    function advance(now: number) {
      const time = initial + (now - started) / 1000;
      while (current < samples.length - 1 && samples[current + 1].timeS <= time) current++;
      setIndex(current);
      if (current === samples.length - 1) setPlayFrom(null);
      else frame = requestAnimationFrame(advance);
    }
    const pause = () => { if (document.hidden) setPlayFrom(null); };
    document.addEventListener("visibilitychange", pause);
    frame = requestAnimationFrame(advance);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", pause); };
  }, [playFrom, samples]);

  function clearRun() {
    setSamples(emptySamples); setPlayFrom(null); setIndex(0); setError("");
  }
  function reset() {
    if (busy || reloadOnReset.current) { reload(); return; }
    clearRun();
    setDuration(String(defaultDuration));
    setControls(info.actuators.map((item) => String(item.initial)));
  }
  async function run() {
    if (!point || busy) return;
    clearRun();
    const settings = { durationS: Number(duration), controls: controls.map((raw) => raw.trim() ? Number(raw) : NaN), pointId: point.id };
    const issue = checkSettings(settings, info, maxDuration);
    if (issue) { setError(issue); return; }
    setBusy(true);
    try {
      const next = await engine.run(settings);
      if (!alive.current) return;
      if (!next.length) throw new Error("物理引擎没有返回采样。");
      reloadOnReset.current = false;
      setSamples(next);
      setIndex(next.length - 1);
      try {
        await recordRun.current?.(settings);
      } catch (cause) {
        if (alive.current) setError(`仿真已完成，保存工况失败。${cause instanceof Error ? cause.message : ""}`);
      }
    } catch (cause) {
      if (alive.current) {
        reloadOnReset.current = true;
        setError(`${cause instanceof Error ? cause.message : "MuJoCo 运行失败。"} 可点“复位”重新加载模型。`);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return <section className="space-y-4" aria-label="导入模型仿真">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-base font-semibold">模型仿真</h3>
      <span className="text-xs text-muted-foreground">MuJoCo 已编译 · 步长 {numberText(info.timestepS)} s</span>
    </div>
    {info.warnings.length > 0 && <ul className="space-y-1 rounded-md border border-amber-400/30 p-3 text-xs text-amber-200">{info.warnings.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
      <form className="surface min-w-0 space-y-3 p-4" noValidate onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <h4 className="text-sm font-semibold">运行设置</h4>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <label className="block"><span className="field-label">运行时长（s）</span>
            <Input aria-label="运行时长（s）" className="mono" type="number" step="any" min={0} max={maxDuration} value={duration}
              onChange={(event) => { clearRun(); setDuration(event.target.value); }} />
          </label>
          <label className="block"><span className="field-label">观察点</span>
            <select className={selectStyle} aria-label="观察点" value={pointId} onChange={(event) => { clearRun(); setPointId(event.target.value); }}>
              {info.points.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind === "site" ? "标记点" : "刚体"}</option>)}
            </select>
          </label>
          {info.actuators.length > 0 ? <div className="thin-scrollbar max-h-72 space-y-3 overflow-y-auto border-t pt-3">
            {info.actuators.map((item, i) => <label key={i} className="block">
              <span className="field-label"><span className="break-all">{item.name}</span><span className="shrink-0 text-muted-foreground">{item.unit}</span></span>
              <Input aria-label={`执行器 ${item.name}`} className="mono" type="number" step="any" min={item.range?.[0]} max={item.range?.[1]} value={controls[i]}
                onChange={(event) => { clearRun(); setControls(controls.map((value, j) => j === i ? event.target.value : value)); }} />
              {item.range && <span className="mt-1 block text-[11px] text-muted-foreground">范围 {numberText(item.range[0])} 至 {numberText(item.range[1])}</span>}
            </label>)}
          </div> : <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">
            {info.joints.length ? "模型没有执行器，使用重力、接触和关节约束运行。" : "模型为固定几何，运行可核对各时刻的世界坐标。"}
          </p>}
        </fieldset>
        <p className="text-xs text-muted-foreground">重力 {info.gravity.map(numberText).join("，")} m/s²</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={busy || !point}>{busy ? <Loader2 className="animate-spin" /> : <Play />}{busy ? "正在计算" : "运行仿真"}</Button>
          <Button size="sm" type="button" variant="outline" onClick={reset}><RotateCcw />复位</Button>
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </form>
      <div className="min-w-0 space-y-3">
        <PhysicsScene geometry={info.geometry} sample={sample} trail={samples} title="导入模型三维场景" pointName="观察点" coordinateLabel="观察点世界坐标" focus={pointId} />
        {samples.length > 0 && <div className="surface space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="outline" onClick={() => {
              if (playFrom !== null) { setPlayFrom(null); return; }
              const start = index === samples.length - 1 ? 0 : index;
              setIndex(start); setPlayFrom(start);
            }}>{playFrom !== null ? <><Pause />暂停</> : <><Play />播放</>}</Button>
            <output className="mono text-xs" aria-label="仿真时间">{numberText(sample.timeS)} / {numberText(samples[samples.length - 1].timeS)} s</output>
          </div>
          <input className="block h-4 w-full accent-primary" type="range" aria-label="仿真采样点" aria-valuetext={`${numberText(sample.timeS)} s`}
            min={0} max={samples.length - 1} step={1} value={index} onChange={(event) => { setPlayFrom(null); setIndex(event.currentTarget.valueAsNumber); }} />
        </div>}
      </div>
    </div>
    {info.joints.length > 0 && <div className="surface min-w-0 space-y-3 p-4">
      <h4 className="text-sm font-semibold">关节状态</h4>
      {samples.length > 0 && <ImportedStateTrace info={info} samples={samples} sample={sample} />}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">关节类型与范围（{info.joints.length}）</summary>
        <ul className="mt-2 space-y-1">{info.joints.map((joint, i) => <li key={i} className="break-all">
          {joint.name} · {jointLabels[joint.kind]}{joint.range && ` · ${joint.range.map(numberText).join(" 至 ")} ${joint.kind === "slide" ? "m" : "rad"}`}
        </li>)}</ul>
      </details>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <StateList label="位置" channels={info.positions} values={sample.qpos} />
        <StateList label="速度" channels={info.velocities} values={sample.qvel} />
      </div>
    </div>}
  </section>;
}

export default function ImportedPhysicsWorkbench({ bundle, onReady, initialSettings, onRun }: Props) {
  const [{ attempt, resetBundle }, setRequest] = useState({ attempt: 0, resetBundle: null as ModelBundle | null });
  const [load, setLoad] = useState<LoadingResult | null>(null);
  const ready = useRef(onReady);
  useEffect(() => { ready.current = onReady; }, [onReady]);
  useEffect(() => {
    const controller = new AbortController();
    let runtime: ImportedPhysics | undefined;
    ready.current?.(false);
    loadImportedPhysics(bundle, controller.signal).then((engine) => {
      if (controller.signal.aborted) { engine.dispose(); return; }
      runtime = engine;
      setLoad({ bundle, attempt, signal: controller.signal, engine });
      ready.current?.(true);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoad({ bundle, attempt, signal: controller.signal, error: cause instanceof Error ? cause.message : "编译器未能读取该模型。" });
      ready.current?.(false);
    });
    return () => { controller.abort(); runtime?.dispose(); };
  }, [bundle, attempt]);
  const result = load?.bundle === bundle && load.attempt === attempt && !load.signal.aborted ? load : undefined;
  const retry = (defaults: ModelBundle | null) => setRequest((previous) => ({ attempt: previous.attempt + 1, resetBundle: defaults }));
  if (result?.engine) return <RuntimePanel engine={result.engine} reload={() => retry(bundle)}
    initialSettings={resetBundle === bundle ? undefined : initialSettings} onRun={onRun} />;
  if (result?.error) return <div className="surface space-y-3 p-4">
    <p role="alert" className="break-words text-sm text-destructive">模型编译失败。{result.error}</p>
    <Button size="sm" variant="outline" onClick={() => retry(null)}><RotateCcw />重新加载</Button>
  </div>;
  return <p role="status" className="surface flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在编译模型和资源…</p>;
}
