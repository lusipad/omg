import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { sampleMiloMotion, type MiloMotionPlan, type MiloMotionSample } from "@contracts/milo-motion";
import { createMiloStockPlayback } from "@contracts/milo-stock";
import { Button } from "@/components/ui/button";
import MiloScene from "./MiloScene";
import { makeMiloSpatialPath, miloAxes, miloAxisColors, miloLayerEnds, miloNumber, miloTraceSamples, tickStep } from "./milo-plot";

type Series = "positionMm" | "velocityMmS";
const strokes = [undefined, "7 3", "2 3"];
const modes = { G0: "快移", G1: "进给", G2: "顺时针圆弧", G3: "逆时针圆弧" };

function traceGeometry(plan: MiloMotionPlan, series: Series, samples: MiloMotionSample[]) {
  let low = 0, high = 0;
  for (const row of samples) {
    for (const value of row[series]) { low = Math.min(low, value); high = Math.max(high, value); }
  }
  const step = low === high ? 0.5 : tickStep((high - low) / 4);
  const start = low === high ? -2 : Math.floor(low / step), end = low === high ? 2 : Math.ceil(high / step);
  const ticks = Array.from({length:end - start + 1}, (_, n) => (n + start) * step);
  const bottom = (start - 0.12) * step, top = (end + 0.12) * step;
  const x = (time: number) => plan.durationS ? time / plan.durationS * 1000 : 0;
  const y = (value: number) => (top - value) / (top - bottom) * 100;
  const phaseSamples = new Map(samples.map((row) => [row.timeS, row]));
  const arcSamples = new Map<number, MiloMotionSample[]>();
  for (const row of samples) {
    if (row.line === null || (row.mode !== "G2" && row.mode !== "G3")) continue;
    const list = arcSamples.get(row.line);
    if (list) list.push(row); else arcSamples.set(row.line, [row]);
  }
  const positionAt = (t: number) => (phaseSamples.get(t) ?? sampleMiloMotion(plan, t)).positionMm;
  const paths = miloAxes.map((_, i) => {
    if (series === "velocityMmS" || !plan.segments.length) {
      return samples.map((row, n) => `${n ? "L" : "M"}${x(row.timeS).toFixed(3)},${y(row[series][i]).toFixed(3)}`).join(" ");
    }
    const path = [`M0,${y(plan.segments[0].startMm[i]).toFixed(3)}`];
    for (const segment of plan.segments) {
      if (segment.arc && i < 2) {
        for (const row of arcSamples.get(segment.line) ?? []) path.push(`L${x(row.timeS).toFixed(3)},${y(row.positionMm[i]).toFixed(3)}`);
        continue;
      }
      const rise = segment.startS + segment.rampS;
      const fall = segment.cruiseS > 0 ? segment.endS - segment.rampS : rise;
      // 等加速度段的位置是时间的二次函数，静止端的水平切线确定控制点。
      path.push(`Q${x(segment.startS + segment.rampS / 2).toFixed(3)},${y(segment.startMm[i]).toFixed(3)} ${x(rise).toFixed(3)},${y(positionAt(rise)[i]).toFixed(3)}`);
      if (segment.cruiseS > 0) path.push(`L${x(fall).toFixed(3)},${y(positionAt(fall)[i]).toFixed(3)}`);
      path.push(`Q${x(fall + (segment.endS - fall) / 2).toFixed(3)},${y(segment.endMm[i]).toFixed(3)} ${x(segment.endS).toFixed(3)},${y(segment.endMm[i]).toFixed(3)}`);
    }
    return path.join(" ");
  });
  const interval = tickStep(plan.durationS / 4);
  const times = Array.from({length:Math.floor(plan.durationS / interval + 1e-10) + 1}, (_, i) => i * interval);
  return { ticks, times, paths, x, y };
}

function AxisTrace({plan, sample, samples, series}: {plan:MiloMotionPlan; sample:MiloMotionSample; samples:MiloMotionSample[]; series:Series}) {
  const plot = useMemo(() => traceGeometry(plan, series, samples), [plan, series, samples]);
  const position = series === "positionMm";
  const title = position ? "三轴位置随时间变化曲线" : "三轴速度随时间变化曲线";
  const x = plot.x(sample.timeS);
  return <figure className="min-w-0" aria-label={title}>
    <figcaption className="mb-2 text-xs font-medium">{position ? "工件坐标位置（mm）" : "工件系轴速度（mm/s）"}</figcaption>
    <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-2 pr-2">
      <div className="relative h-28" aria-hidden="true">
        {plot.ticks.map((value) => <span key={value} className="mono absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground" style={{top:`${plot.y(value)}%`}}>{miloNumber(value)}</span>)}
      </div>
      <div className="relative h-28 min-w-0">
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={title} className="block h-full w-full overflow-visible">
          {plot.ticks.map((value) => <line key={value} x1="0" x2="1000" y1={plot.y(value)} y2={plot.y(value)} stroke={value === 0 ? "#475b50" : "#293a31"} strokeDasharray={value === 0 ? undefined : "3 4"} vectorEffect="non-scaling-stroke" />)}
          {plot.times.map((time) => <line key={time} x1={plot.x(time)} x2={plot.x(time)} y1="0" y2="100" stroke="#293a31" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
          {plot.paths.map((path, i) => <path key={i} data-axis={miloAxes[i]} d={path} fill="none" stroke={miloAxisColors[i]} strokeWidth="1.8" strokeDasharray={strokes[i]} vectorEffect="non-scaling-stroke" />)}
          <line x1={x} x2={x} y1="0" y2="100" stroke="#b0beb6" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </svg>
        {miloAxes.map((axis, i) => <i key={axis} aria-hidden="true" className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{left:`${x / 10}%`, top:`${plot.y(sample[series][i])}%`, background:miloAxisColors[i]}} />)}
      </div>
      <div /><div className="relative mt-1 h-4" aria-hidden="true">{plot.times.map((time) => {
        const offset = plot.x(time) / 10;
        return <span key={time} className="mono absolute text-[10px] text-muted-foreground" style={{left:`${offset}%`, transform:`translateX(${offset === 0 ? 0 : offset >= 99 ? -100 : -50}%)`}}>{miloNumber(time)}</span>;
      })}</div>
    </div>
  </figure>;
}

export default function MiloMotionBench({plan}: {plan:MiloMotionPlan}) {
  const duration = plan.durationS;
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [play, setPlay] = useState<{from:number} | null>(() =>
    duration > 0 && !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? {from:0} : null);
  const sample = useMemo(() => sampleMiloMotion(plan, time), [plan, time]);
  const path = useMemo(() => makeMiloSpatialPath(plan), [plan]);
  const trace = useMemo(() => miloTraceSamples(plan), [plan]);
  const layers = useMemo(() => miloLayerEnds(plan), [plan]);
  const cutting = useMemo(() => createMiloStockPlayback(plan), [plan]);
  const frame = useMemo(() => cutting.seek(sample.timeS), [cutting, sample.timeS]);
  useEffect(() => {
    if (!play) return;
    let frame = 0;
    const origin = performance.now(), from = play.from;
    function tick(now: number) {
      const next = Math.min(duration, from + Math.max(0, now - origin) * rate / 1000);
      setTime(next);
      if (next >= duration) setPlay(null); else frame = requestAnimationFrame(tick);
    }
    const hidden = () => { if (document.hidden) setPlay(null); };
    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", hidden);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", hidden); };
  }, [duration, play, rate]);

  function start(from: number) { setTime(from); setPlay({from}); }
  function seek(seconds: number) {
    setPlay(null);
    // 浏览器可能用舍入后的十进制值表示滑条末端。
    setTime(duration - seconds <= 32 * Number.EPSILON * duration ? duration : seconds);
  }
  return <section aria-label="Milo 加工回放" className="min-w-0 space-y-4">
    <div className="surface min-w-0 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">加工回放</h3>
          <p className="mt-1 text-xs text-muted-foreground">刀尖路径 <output aria-label="刀尖路径长度" className="mono">{miloNumber(plan.totalLengthMm)}</output> mm</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={!duration} onClick={() => { if (play) setPlay(null); else start(time >= duration ? 0 : time); }}>
            {play ? <><Pause />暂停</> : <><Play />播放</>}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!duration} onClick={() => start(0)}><RotateCcw />从头播放</Button>
          <select aria-label="回放速度" className="h-8 rounded border bg-background px-2 text-xs" value={rate} onChange={(event) => {
            setRate(Number(event.target.value)); if (play) setPlay({from:time});
          }}>{[0.5,1,2,4,8].map((value) => <option key={value} value={value}>{value}×</option>)}</select>
        </div>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span>{sample.line === null ? <>无位移程序行 <output aria-label="当前程序行">—</output></> : <>第 <output aria-label="当前程序行" className="mono">{sample.line}</output> 行</>}
          {sample.mode && <span className="ml-2 text-muted-foreground">{sample.mode} {modes[sample.mode]}</span>}</span>
        <span className="mono"><output aria-label="当前回放时间">{miloNumber(time)}</output> / <output aria-label="程序总时长">{miloNumber(duration)}</output> s</span>
      </div>
      <input aria-label="加工回放时间" aria-valuetext={`${miloNumber(time)} 秒`} className="block h-4 w-full accent-primary"
        type="range" min="0" max={duration || 1} step="any" disabled={!duration} value={time}
        onChange={(event) => seek(event.currentTarget.valueAsNumber)} />
      {layers.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <span className="mr-1 text-xs text-muted-foreground">跳至水平进给层末</span>
        <Button type="button" size="sm" variant={time === 0 ? "secondary" : "outline"} aria-pressed={time === 0} onClick={() => seek(0)}>毛坯</Button>
        {layers.length <= 6 ? layers.map((layer) =>
          <Button key={layer.z} type="button" size="sm" variant={time === layer.time ? "secondary" : "outline"} aria-label={`Z ${layer.z} mm 层末`}
            aria-pressed={time === layer.time} onClick={() => seek(layer.time)}>Z {miloNumber(layer.z)} mm</Button>) :
          <select aria-label="选择水平进给层末" className="h-8 rounded border bg-background px-2 text-xs" value="" onChange={(event) => seek(Number(event.target.value))}>
            <option value="">选择深度</option>{layers.map((layer) => <option key={layer.z} value={layer.time}>Z {miloNumber(layer.z)} mm</option>)}
          </select>}
      </div>}
    </div>
    <MiloScene path={path} sample={sample} frame={frame} />
    <section className="surface min-w-0 p-4 sm:p-5" aria-label="三轴规划轨迹">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">三轴规划轨迹</h3>
        <div className="flex gap-4">{miloAxes.map((axis,i) => <span key={axis} className="mono inline-flex items-center gap-1.5 text-xs">
          <i className="w-4 border-t-2" style={{borderColor:miloAxisColors[i],borderStyle:["solid", "dashed", "dotted"][i]}} />{axis}
        </span>)}</div>
      </header>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <AxisTrace plan={plan} sample={sample} samples={trace} series="positionMm" />
        <AxisTrace plan={plan} sample={sample} samples={trace} series="velocityMmS" />
      </div>
      <p className="mt-1 text-center text-[11px] text-muted-foreground">时间（s）</p>
      <table aria-label="实时三轴读数" className="mt-4 w-full table-fixed border-t text-right text-xs">
        <thead><tr><th scope="col" className="w-[35%] py-2 text-left font-medium">当前读数</th>{miloAxes.map((axis,i) =>
          <th scope="col" key={axis} className="mono font-medium" style={{color:miloAxisColors[i]}}>{axis}</th>)}</tr></thead>
        <tbody>{(["positionMm", "velocityMmS"] as const).map((series) => <tr key={series} className="border-t">
          <th scope="row" className="py-2 text-left font-normal text-muted-foreground">{series === "positionMm" ? "工件位置（mm）" : "轴速度（mm/s）"}</th>
          {miloAxes.map((axis,i) => <td key={axis} className="mono"><output aria-label={`${axis} 轴${series === "positionMm" ? "位置" : "速度"}`}>{miloNumber(sample[series][i])}</output></td>)}
        </tr>)}</tbody>
      </table>
      <details className="border-t pt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">机床坐标与理论微步计数</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">{miloAxes.map((axis,i) => <div key={axis} className="surface-inset p-2">
          <span className="mono mr-2" style={{color:miloAxisColors[i]}}>{axis}</span>
          <output aria-label={`${axis} 轴机床坐标`} className="mono">{miloNumber(sample.machineMm[i])}</output> mm · <output aria-label={`${axis} 轴理论微步计数`} className="mono">{sample.stepCounts[i]}</output> 微步
        </div>)}</div>
      </details>
    </section>
  </section>;
}
