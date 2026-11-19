import { useEffect, useId, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { LinearAssembly, LinearAssemblyResult } from "@contracts/linear-assembly";
import type { ImportedGeometry } from "@contracts/imported-physics";
import { Button } from "@/components/ui/button";
import PhysicsScene, { type SceneSample } from "./PhysicsScene";

type Props = { assembly: LinearAssembly; result: LinearAssemblyResult };
type Samples = LinearAssemblyResult["samples"];
type AxisSample = { timeMs: number; position: number; velocity: number };
const number = (value: number) => String(Number(value.toPrecision(6)));

function nearestSample(samples: Samples, timeMs: number) {
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].timeMs < timeMs) low = mid + 1;
    else high = mid;
  }
  return low > 0 && timeMs - samples[low - 1].timeMs < samples[low].timeMs - timeMs ? low - 1 : low;
}

function sceneFor(samples: Samples) {
  const min = [...samples[0].tipMm], max = [...min];
  const trail = samples.map(({ tipMm }): SceneSample => {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], tipMm[i]);
      max[i] = Math.max(max[i], tipMm[i]);
    }
    return { pointM: [tipMm[0] / 1000, tipMm[1] / 1000, tipMm[2] / 1000], geomPoses: [] };
  });
  const center = (i: number) => (min[i] + max[i]) / 2000;
  const geometry: ImportedGeometry = {
    meshes: [], geoms: [], centerM: [center(0), center(1), center(2)],
    extentM: Math.max(...max.map((value, i) => value - min[i])) / 1000 || 0.001,
  };
  return { geometry, trail };
}

function AxisTrace({ data, metric, cursor, target }: { data: AxisSample[]; metric: "position" | "velocity"; cursor: AxisSample; target: number }) {
  const position = metric === "position", label = position ? "位置" : "速度";
  const unit = position ? "mm" : "mm/s", color = position ? "#62dfb0" : "#80c0f5";
  const flatZero = data.every(point => point[metric] === 0) && (!position || target === 0);
  return <figure className="min-w-0" aria-label={`轴${label}曲线`}>
    <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium"><i className="h-0.5 w-4" style={{ backgroundColor: color }} />{label}（{unit}）</span>
      {position && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><i className="w-4 border-t border-dashed border-amber-300" />目标 {number(target)} mm</span>}
      <output aria-label={`轴${label}读数`} className="mono ml-auto">{number(cursor[metric])} {unit}</output>
    </figcaption>
    <div className="h-36 min-w-0 sm:h-40">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ left: 0, right: 18, top: 7, bottom: 0 }}>
          <CartesianGrid stroke="#293a31" strokeDasharray="3 4" />
          <XAxis type="number" dataKey="timeMs" domain={[data[0].timeMs, Math.max(data[0].timeMs + 1, data[data.length - 1].timeMs)]}
            height={23} tickCount={5} tickFormatter={number} stroke="#91a098" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis type="number" width={52} domain={flatZero ? [-1, 1] : ["auto", "auto"]} tickCount={5}
            tickFormatter={number} stroke="#91a098" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <ReferenceLine y={0} ifOverflow="extendDomain" stroke="#485b51" />
          {position && <ReferenceLine y={target} ifOverflow="extendDomain" stroke="#e7bc72" strokeDasharray="5 4" />}
          <Line type="linear" dataKey={metric} stroke={color} strokeWidth={2} dot={data.length === 1} isAnimationActive={false} />
          <ReferenceLine x={cursor.timeMs} stroke="#abbab1" strokeDasharray="3 3" />
          <ReferenceDot x={cursor.timeMs} y={cursor[metric]} r={3.5} fill={color} stroke="#17211c" isFront />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </figure>;
}

function MotionReadout({ assembly, result }: Props) {
  const { samples } = result, lastIndex = samples.length - 1, end = samples[lastIndex];
  const [index, setIndex] = useState(lastIndex);
  const [fromMs, setFromMs] = useState<number | null>(null);
  const [axisId, setAxisId] = useState(assembly.axes[0].id);
  const axisIndex = Math.max(0, assembly.axes.findIndex(axis => axis.id === axisId));
  const axis = assembly.axes[axisIndex], sample = samples[index], slider = useId();
  const { geometry, trail } = useMemo(() => sceneFor(samples), [samples]);
  const data = useMemo(() => samples.map(point => ({
    timeMs: point.timeMs, position: point.positionMm[axisIndex], velocity: point.velocityMmS[axisIndex],
  })), [samples, axisIndex]);
  useEffect(() => {
    if (fromMs === null) return;
    const origin = performance.now() - fromMs;
    let frame = 0;
    function tick(now: number) {
      const timeMs = now - origin;
      setIndex(nearestSample(samples, timeMs));
      if (timeMs >= end.timeMs) setFromMs(null);
      else frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fromMs, samples, end.timeMs]);
  function seek(next: number) { setFromMs(null); setIndex(next); }

  return <section className="surface min-w-0 space-y-4 p-4 sm:p-5" aria-label="直线装配运动结果">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-lg font-semibold">运动结果</h3>
      <p className="text-xs text-muted-foreground">仿真终点 {number(end.timeMs)} ms <span className={result.settled ? "ml-1 text-primary" : "ml-1 text-amber-300"}>
        {result.settled ? "全部轴已到位" : "观察时间内未全部到位"}</span></p>
    </header>
    <div className="surface-inset flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <Button size="sm" variant="outline" disabled={lastIndex === 0} onClick={() => {
        if (fromMs !== null) setFromMs(null);
        else { const start = index === lastIndex ? 0 : index; setIndex(start); setFromMs(samples[start].timeMs); }
      }}>{fromMs === null ? <Play /> : <Pause />}{fromMs === null ? "回放" : "暂停"}</Button>
      <label htmlFor={slider} className="text-xs">采样时间</label>
      <input id={slider} type="range" className="order-last h-5 w-full min-w-0 accent-primary sm:order-none sm:flex-1"
        min={samples[0].timeMs} max={end.timeMs} step="any" value={sample.timeMs} disabled={lastIndex === 0} aria-valuetext={`${number(sample.timeMs)} 毫秒`}
        onChange={event => seek(nearestSample(samples, event.currentTarget.valueAsNumber))}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          seek(Math.max(0, Math.min(lastIndex, index + (event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1))));
        }} />
      <output aria-label="当前采样时刻" htmlFor={slider} className="mono ml-auto text-xs">{number(sample.timeMs)} ms</output>
    </div>
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      <div className="min-w-0">
        <h4 className="mb-2 text-sm font-medium">末端轨迹</h4>
        <PhysicsScene geometry={geometry} sample={trail[index]} trail={trail} unit="mm" title="直线装配末端三维轨迹" pointName="末端" coordinateLabel="装配末端世界坐标" />
        <p className="mt-2 text-xs text-muted-foreground">终点 <output aria-label="末端终点坐标" className="mono">X {number(end.tipMm[0])} · Y {number(end.tipMm[1])} · Z {number(end.tipMm[2])} mm</output></p>
      </div>
      <div className="min-w-0 space-y-3">
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">观测轴
          <select className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm font-normal" value={axis.id} onChange={event => setAxisId(event.target.value)}>
            {assembly.axes.map(item => <option key={item.id} value={item.id}>{item.id} · {item.module}</option>)}
          </select>
        </label>
        <AxisTrace data={data} metric="position" cursor={data[index]} target={axis.targetMm} />
        <AxisTrace data={data} metric="velocity" cursor={data[index]} target={axis.targetMm} />
        <p className="text-center text-[11px] text-muted-foreground">时间（ms）</p>
      </div>
    </div>
  </section>;
}

export default function LinearAssemblyResults({ assembly, result }: Props) {
  const [run, setRun] = useState({ samples: result.samples, generation: 0 });
  if (run.samples !== result.samples) setRun({ samples: result.samples, generation: run.generation + 1 });
  if (!result.samples.length || !assembly.axes.length) return <p role="status">暂无轴运动采样。</p>;
  return <MotionReadout key={run.generation} assembly={assembly} result={result} />;
}
