import { useEffect, useId, useMemo, useState } from "react";
import { Download, Pause, Play } from "lucide-react";
import { metrics, formatAxisValue as number, nearestSample } from "@/lib/axis-response";
import AxisTrace from "./AxisTrace";
import type { LinearAssembly, LinearAssemblyResult } from "@contracts/linear-assembly";
import type { ImportedGeometry } from "@contracts/imported-physics";
import { Button } from "@/components/ui/button";
import { downloadBlob } from "@/lib/download";
import PhysicsScene, { type SceneSample } from "./PhysicsScene";

type Props = { assembly: LinearAssembly; result: LinearAssemblyResult };
type Samples = LinearAssemblyResult["samples"];

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
    torque: point.motorTorqueNm?.[axisIndex], force: point.axialForceN?.[axisIndex],
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

  function exportCsv() {
    const columns = [metrics.position.column, metrics.velocity.column, ...(end.motorTorqueNm ? [metrics.torque.column, metrics.force.column] : [])];
    const header = ["time_ms", ...assembly.axes.flatMap(a => columns.map(name => `${a.id}_${name}`)), "tip_x_mm", "tip_y_mm", "tip_z_mm"];
    const lines = samples.map(point => [point.timeMs, ...assembly.axes.flatMap((_, i) => [
      point.positionMm[i], point.velocityMmS[i], ...(point.motorTorqueNm && point.axialForceN ? [point.motorTorqueNm[i], point.axialForceN[i]] : []),
    ]), ...point.tipMm].join(","));
    downloadBlob("\uFEFF" + [header.join(","), ...lines].join("\r\n") + "\r\n", `${assembly.name}-轴响应.csv`, "text/csv;charset=utf-8");
  }

  return <section className="surface min-w-0 space-y-4 p-4 sm:p-5" aria-label="直线装配运动结果">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-lg font-semibold">运动结果</h3>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2"><p className="text-xs text-muted-foreground">仿真终点 {number(end.timeMs)} ms <span className={result.settled ? "ml-1 text-primary" : "ml-1 text-amber-300"}>
        {result.settled ? "全部轴已到位" : "观察时间内未全部到位"}</span></p>
        <Button size="sm" variant="outline" onClick={exportCsv}><Download />导出响应 CSV</Button>
      </div>
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
      </div>
      {end.motorTorqueNm && end.axialForceN && <div className="grid min-w-0 gap-5 sm:grid-cols-2 lg:col-span-2">
        <AxisTrace data={data} metric="torque" cursor={data[index]} target={axis.targetMm} />
        <AxisTrace data={data} metric="force" cursor={data[index]} target={axis.targetMm} />
      </div>}
    </div>
    <p className="text-center text-[11px] text-muted-foreground">时间（ms）</p>
  </section>;
}

export default function LinearAssemblyResults({ assembly, result }: Props) {
  const [run, setRun] = useState({ samples: result.samples, generation: 0 });
  if (run.samples !== result.samples) setRun({ samples: result.samples, generation: run.generation + 1 });
  if (!result.samples.length || !assembly.axes.length) return <p role="status">暂无轴运动采样。</p>;
  return <MotionReadout key={run.generation} assembly={assembly} result={result} />;
}
