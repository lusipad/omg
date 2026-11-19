import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, Pause, Play, Plus, RotateCcw, SkipBack, Trash2 } from "lucide-react";
import { SO101_JOINTS, parseSo101Motion, type So101Sample, type So101Waypoint } from "@contracts/so101";
import { loadSo101Physics } from "@/lib/so101-physics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import So101Scene from "./So101Scene";
import So101Trace from "./So101Trace";

type Frame = { id: number; time: string; angles: string[] };
type Physics = Awaited<ReturnType<typeof loadSo101Physics>>;
const noTrail: So101Sample[] = [];
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
const display = (value: number) => numberFormat.format(Math.abs(value) < 0.005 ? 0 : value);

function frameInputs(motion: So101Waypoint[]): Frame[] {
  return motion.map((frame, id) => ({ id, time: String(frame.timeS), angles: frame.anglesDeg.map(String) }));
}

function parsedFrames(rows: Frame[]) {
  for (const [index, row] of rows.entries()) {
    if (!row.time.trim()) throw new Error(`请填写第 ${index + 1} 帧的到达时间。`);
    const empty = row.angles.findIndex((angle) => !angle.trim());
    if (empty !== -1) throw new Error(`请填写第 ${index + 1} 帧的${SO101_JOINTS[empty].label}角度。`);
  }
  return parseSo101Motion(rows.map((row) => ({ timeS: Number(row.time), anglesDeg: row.angles.map(Number) })));
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : "动作处理失败，请检查关键帧后重试。";
}

export default function So101MotionBench({ waypoints, onChange }: {
  waypoints: So101Waypoint[]; onChange: (next: So101Waypoint[]) => void;
}) {
  const [rows, setRows] = useState(() => frameInputs(waypoints));
  const nextId = useRef(rows.length);
  const [physics, setPhysics] = useState<Physics | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [samples, setSamples] = useState<So101Sample[]>(noTrail);
  const [index, setIndex] = useState(0);
  const [joint, setJoint] = useState(0);
  const [playback, setPlayback] = useState<{ from: number } | null>(null);
  const sample = samples[index] ?? physics?.initial;
  const last = samples.length - 1;
  const lastTime = Number(rows.at(-1)?.time ?? 0);

  useEffect(() => {
    let active = true;
    loadSo101Physics().then((runtime) => {
      if (active) setPhysics(runtime);
    }).catch((cause) => { if (active) setLoadError(errorText(cause)); });
    return () => { active = false; };
  }, [retry]);

  useEffect(() => {
    if (!playback || !samples.length) return;
    let current = playback.from;
    const origin = performance.now(), initialTime = samples[current].timeS;
    let request = 0;
    function tick(now: number) {
      const targetTime = initialTime + (now - origin) / 1000;
      while (current < samples.length - 1 && samples[current + 1].timeS <= targetTime) current++;
      setIndex(current);
      if (current === samples.length - 1) setPlayback(null);
      else request = requestAnimationFrame(tick);
    }
    const onHidden = () => { if (document.hidden) setPlayback(null); };
    document.addEventListener("visibilitychange", onHidden);
    request = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(request); document.removeEventListener("visibilitychange", onHidden); };
  }, [samples, playback]);

  function edit(next: Frame[]) {
    setRows(next);
    setPlayback(null);
    setSamples(noTrail);
    setIndex(0);
    setRunError("");
    try {
      onChange(parsedFrames(next));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function changeValue(rowId: number, axis: number, value: string) {
    edit(rows.map((row) => {
      if (row.id !== rowId) return row;
      return axis === -1 ? { ...row, time: value } : { ...row, angles: row.angles.map((angle, i) => i === axis ? value : angle) };
    }));
  }

  function run() {
    if (!physics) return;
    try {
      const motion = parsedFrames(rows);
      const next = physics.run(motion);
      if (!next.length) throw new Error("物理引擎未返回采样，请重新运行动作。");
      setSamples(next);
      setIndex(0);
      setPlayback({ from: 0 });
      setRunError("");
    } catch (cause) {
      setPlayback(null); setSamples(noTrail); setIndex(0); setRunError(errorText(cause));
    }
  }

  function play(from: number) {
    setIndex(from);
    setPlayback({ from });
  }

  return <section className="min-w-0 space-y-4" aria-label="SO-101 动作工作台">
    <div className="surface min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold">动作控制</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">从新版校准零位静止起步。五个臂关节和夹爪开合均以度表示，到达时间自 0 s 起算。</p>
        </div>
        <Button onClick={run} disabled={!physics || Boolean(error)}><Play />运行动作</Button>
      </div>
      <details className="border-t px-4 py-3 sm:px-5">
        <summary className="cursor-pointer text-sm font-medium">编辑动作关键帧（{rows.length} 帧）</summary>
        <div className="mt-3 space-y-2">
          <div aria-hidden="true" className="hidden grid-cols-[2.1rem_repeat(7,minmax(0,1fr))_2.3rem] gap-2 text-[11px] text-muted-foreground lg:grid">
            <span>帧</span><span>到达（s）</span>{SO101_JOINTS.map((item) => <span key={item.id}>{item.label}（°）</span>)}
          </div>
          {rows.map((row, i) => <fieldset key={row.id} className="grid min-w-0 grid-cols-2 items-center gap-2 rounded-md border p-3 sm:grid-cols-4 lg:grid-cols-[2.1rem_repeat(7,minmax(0,1fr))_2.3rem] lg:border-0 lg:p-0">
            <legend className="sr-only">关键帧 {i + 1}</legend>
            <div className="col-span-full text-xs font-medium lg:col-span-1"><span className="lg:hidden">关键帧 </span>{i + 1}</div>
            <label className="min-w-0"><span className="field-label lg:hidden">到达（s）</span>
              <Input aria-label={`关键帧 ${i + 1} 到达时间`} type="number" min="0" max="20" step="any" className="mono px-2" value={row.time} onChange={(event) => changeValue(row.id, -1, event.target.value)} />
            </label>
            {SO101_JOINTS.map((item, axis) => <label key={item.id} className="min-w-0"><span className="field-label lg:hidden">{item.label}（°）</span>
              <Input aria-label={`关键帧 ${i + 1} ${item.label}`} title={`${item.minDeg}° 至 ${item.maxDeg}°`} type="number" min={item.minDeg} max={item.maxDeg} step="any"
                className="mono px-2" value={row.angles[axis]} onChange={(event) => changeValue(row.id, axis, event.target.value)} />
            </label>)}
            <Button size="icon" variant="ghost" aria-label={`删除关键帧 ${i + 1}`} disabled={rows.length === 1} onClick={() => edit(rows.filter((item) => item.id !== row.id))}><Trash2 /></Button>
          </fieldset>)}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={rows.length >= 20 || lastTime >= 20 || !Number.isFinite(lastTime)} onClick={() => {
              const previous = rows[rows.length - 1];
              edit([...rows, { id: nextId.current++, time: String(Math.min(20, Math.round((lastTime + 1) * 100) / 100)), angles: [...previous.angles] }]);
            }}><Plus />新增关键帧</Button>
            <span className="text-xs text-muted-foreground">最多 20 帧，末帧在 20 s 内。</span>
          </div>
        </div>
      </details>
      {(error || runError) && <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">{error || runError}</p>}
    </div>

    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="surface min-w-0 space-y-3 p-4 sm:p-5">
        <h3 className="text-base font-semibold">机械臂与末端轨迹</h3>
        {physics && sample ? <So101Scene geometry={physics.geometry} sample={sample} trail={samples} />
          : <div className="engineering-grid grid min-h-56 place-content-center gap-3 rounded-md border p-5 text-center">
            {loadError ? <>
              <p role="alert" className="break-words text-sm text-destructive">{loadError}</p>
              <Button size="sm" variant="outline" className="mx-auto" onClick={() => { setLoadError(""); setRetry((value) => value + 1); }}><RotateCcw />重试加载物理模型</Button>
            </> : <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载 MuJoCo 物理引擎和机械臂模型…</p>}
          </div>}
        {samples.length > 0 && sample && <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => playback ? setPlayback(null) : play(index === last ? 0 : index)}>
              {playback ? <><Pause />暂停回放</> : <><Play />继续播放</>}
            </Button>
            <Button size="sm" variant="outline" onClick={() => play(0)}><SkipBack />从头回放</Button>
            <span className="mono ml-auto text-xs">{display(sample.timeS)} / {display(samples[last].timeS)} s</span>
          </div>
          <input aria-label="回放时间" aria-valuetext={`${display(sample.timeS)} 秒`} type="range" min={0} max={last} step={1} value={index}
            className="block h-5 w-full accent-primary" onChange={(event) => { setPlayback(null); setIndex(Number(event.target.value)); }} />
        </div>}
      </div>
      <div className="surface min-w-0 space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-semibold"><Activity className="size-4 text-primary" />关节响应</h3>
          <select aria-label="观察关节" value={joint} onChange={(event) => setJoint(Number(event.target.value))} className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm">
            {SO101_JOINTS.map((axis, i) => <option key={axis.id} value={i}>{axis.label}</option>)}
          </select>
        </div>
        {samples.length > 0 && sample ? <>
          <So101Trace samples={samples} joint={joint} sample={sample} />
          <output aria-label="关节采样读数" className="mono flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs">
            <span>指令 {display(sample.targetDeg[joint])}°</span>
            <span>实际 {display(sample.positionDeg[joint])}°</span>
            <span>速度 {display(sample.velocityDegS[joint])} °/s</span>
          </output>
        </> : <p className="engineering-grid grid min-h-40 place-content-center rounded-md border p-4 text-center text-sm text-muted-foreground">运行动作后可查看关节指令、实际位置和角速度。</p>}
      </div>
    </div>
  </section>;
}
