import { useMemo, useState } from "react";
import type { CncContourResult } from "@/lib/cnc-contour-runtime";
import { commandColor, feedbackColor, fixedReading } from "@/lib/cnc-contour-display";

const axes = ["X", "Y", "Z"] as const;
type Axis = 0 | 1 | 2;
type Quantity = "position" | "velocity";
const chartWidth = 500, chartHeight = 94, margin = 5;

function SignalPlot({ result, index, axis, quantity, seek }: {
  result: CncContourResult; index: number; axis: Axis; quantity: Quantity; seek: (seconds: number) => void;
}) {
  const velocity = quantity === "velocity", quantityLabel = velocity ? "速度" : "位置", unit = velocity ? "mm/s" : "mm";
  const commanded = velocity ? "commandVelocityMmS" : "commandMm", actual = velocity ? "actualVelocityMmS" : "actualMm";
  const { samples, endS } = result, sample = samples[index];
  const plot = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const s of samples) {
      min = Math.min(min, s[commanded][axis], s[actual][axis]); max = Math.max(max, s[commanded][axis], s[actual][axis]);
    }
    if (max - min < .001) { const middle = (max + min) / 2; min = middle - .5; max = middle + .5; }
    const y = (value: number) => chartHeight - margin - (value - min) / (max - min) * (chartHeight - margin * 2);
    const x = (seconds: number) => seconds / endS * chartWidth;
    // Keep each display bucket's extrema so a short acceleration peak survives drawing at screen resolution.
    function path(field: typeof commanded | typeof actual) {
      const points: string[] = [], bucket = Math.max(1, Math.ceil(samples.length / chartWidth));
      const add = (i: number) => points.push((points.length ? "L" : "M") + x(samples[i].timeS).toFixed(2) + " " + y(samples[i][field][axis]).toFixed(2));
      for (let first = 0; first < samples.length; first += bucket) {
        const last = Math.min(samples.length - 1, first + bucket - 1);
        let low = first, high = first;
        for (let i = first + 1; i <= last; i++) {
          if (samples[i][field][axis] < samples[low][field][axis]) low = i;
          if (samples[i][field][axis] > samples[high][field][axis]) high = i;
        }
        for (const i of [...new Set([first, Math.min(low, high), Math.max(low, high), last])]) add(i);
      }
      return points.join("");
    }
    return { min, max, y, x, demand: path(commanded), feedback: path(actual) };
  }, [samples, axis, commanded, actual, endS]);
  const x = plot.x(sample.timeS), digits = Math.abs(plot.max - plot.min) >= 10 ? 1 : 2;
  return <figure aria-label={axes[axis] + " 轴" + quantityLabel + "指令与反馈曲线"} className="min-w-0">
    <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs tabular-nums">
      <span className="font-medium">{quantityLabel} <span className="font-normal text-muted-foreground">({unit})</span></span>
      <span style={{ color: commandColor }}>指令 {fixedReading(sample[commanded][axis])}</span>
      <span style={{ color: feedbackColor }}>反馈 {fixedReading(sample[actual][axis])}</span>
    </figcaption>
    <div className="grid grid-cols-[2.55rem_minmax(0,1fr)] text-[10px] text-muted-foreground tabular-nums">
      <div className="flex h-[92px] flex-col items-end justify-between pr-1">
        {[plot.max, (plot.max + plot.min) / 2, plot.min].map((n, i) => <span key={i}>{fixedReading(n, digits)}</span>)}
      </div>
      <svg className="h-[92px] w-full cursor-crosshair rounded-sm bg-background/50" viewBox={"0 0 " + chartWidth + " " + chartHeight}
        preserveAspectRatio="none" aria-hidden="true" onClick={e => {
          const box = e.currentTarget.getBoundingClientRect();
          if (box.width) seek(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * endS);
        }}>
        {[margin, chartHeight / 2, chartHeight - margin].map(v => <line key={v} x1="0" x2={chartWidth} y1={v} y2={v} stroke="#39453f" vectorEffect="non-scaling-stroke" />)}
        <path d={plot.feedback} fill="none" stroke={feedbackColor} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d={plot.demand} fill="none" stroke={commandColor} strokeDasharray="5 3" strokeWidth="1.35" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <line x1={x} x2={x} y1="0" y2={chartHeight} stroke="#e9f4ec" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle cx={x} cy={plot.y(sample[actual][axis])} r="2.8" fill={feedbackColor} stroke="#37352d" vectorEffect="non-scaling-stroke" />
        <circle cx={x} cy={plot.y(sample[commanded][axis])} r="3.8" fill="none" stroke={commandColor} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="col-start-2 flex justify-between pt-0.5"><span>0 s</span><span>{(endS / 2).toFixed(2)} s</span><span>{endS.toFixed(2)} s</span></div>
    </div>
  </figure>;
}

export default function CncContourTraces({ result, index, seek }: {
  result: CncContourResult; index: number; seek: (seconds: number) => void;
}) {
  const [filter, setFilter] = useState("all");
  return <section aria-label="三轴位置和速度曲线" className="min-w-0 rounded-md border">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <h4 className="text-sm font-semibold">各轴位置与速度</h4>
      <select className="h-8 rounded border bg-background px-2 text-xs" aria-label="观测轴曲线" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">全部三轴</option>{axes.map(a => <option key={a} value={a}>{a} 轴</option>)}
      </select>
    </div>
    {([0, 1, 2] as const).filter(i => filter === "all" || filter === axes[i]).map(axis =>
      <section key={axis} aria-label={axes[axis] + " 轴曲线"} className="grid min-w-0 gap-2 border-b px-3 py-3 last:border-0 md:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)] md:gap-4">
        <h5 className="text-sm font-semibold">{axes[axis]} 轴</h5>
        <SignalPlot {...{ result, index, axis, seek }} quantity="position" />
        <SignalPlot {...{ result, index, axis, seek }} quantity="velocity" />
      </section>)}
  </section>;
}
