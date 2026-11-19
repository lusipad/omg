import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, SkipBack } from "lucide-react";
import { createFeedbackStockPlayback, MILO_STOCK, MILO_TOOL_DIAMETER_MM } from "@contracts/milo-stock";
import { contourTraceCsv, type CncContourResult } from "@/lib/cnc-contour-runtime";
import { commandColor, contourStartIndex, contourTimeIndex, feedbackColor, fixedReading } from "@/lib/cnc-contour-display";
import { downloadBlob } from "@/lib/download";
import CncContourOverlay from "./CncContourOverlay";
import CncContourTraces from "./CncContourTraces";
import { Button } from "./ui/button";

const axisNames = ["X", "Y", "Z"];
const signed = (n: number) => (n >= .0005 ? "+" : "") + fixedReading(n);

export default function CncContourResults({ result }: { result: CncContourResult }) {
  const { samples, plan, endS } = result;
  const [index, setIndex] = useState(() => contourStartIndex(result)), [playing, setPlaying] = useState(false), [rate, setRate] = useState(1);
  const sample = samples[index], currentS = useRef(sample.timeS);
  const stock = useMemo(() => createFeedbackStockPlayback(samples), [samples]);
  const frame = useMemo(() => stock.seek(sample.timeS), [stock, sample]);
  const seek = useCallback((time: number) => {
    setPlaying(false);
    const target = contourTimeIndex(samples, time);
    currentS.current = samples[target].timeS; setIndex(target);
  }, [samples]);
  useEffect(() => {
    if (!playing) return;
    const start = performance.now(), origin = currentS.current;
    let handle = 0, lastPaint = -Infinity;
    function animate(now: number) {
      const time = Math.min(endS, origin + (now - start) * rate / 1000);
      if (now - lastPaint >= 35 || time >= endS) {
        lastPaint = now;
        const i = contourTimeIndex(samples, time); currentS.current = samples[i].timeS; setIndex(i);
      }
      if (time >= endS) setPlaying(false);
      else handle = requestAnimationFrame(animate);
    }
    handle = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(handle);
  }, [playing, rate, samples, endS]);
  const segment = plan.plan.segments.find(s => s.line === sample.line);
  const arc = segment?.arc, radial = arc ? Math.hypot(sample.actualMm[0] - arc.centerMm[0], sample.actualMm[1] - arc.centerMm[1]) - arc.radiusMm : undefined;
  const lines = useMemo(() => result.program.split(/\r\n|\r|\n/), [result.program]);
  return <section className="surface min-w-0 space-y-3 p-3 sm:p-4" aria-label="三轴加工反馈结果">
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 space-y-1"><h3 className="text-base font-semibold">三轴加工反馈</h3>
        <p className="break-words text-xs text-muted-foreground">{result.machineName} · {result.motor.model}（修订 {result.motor.revision}） · 程序 {result.programEndS.toFixed(3)} s · 终点保持 {(endS - result.programEndS).toFixed(2)} s</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => downloadBlob("\uFEFF" + contourTraceCsv(result), result.machineName + "-三轴轨迹.csv", "text/csv;charset=utf-8")}>
        <Download size={15} />导出三轴轨迹 CSV</Button>
    </header>
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-background/35 p-2.5">
      <Button type="button" size="sm" variant="secondary" onClick={() => {
        if (!playing && index === samples.length - 1) { currentS.current = 0; setIndex(0); }
        setPlaying(p => !p);
      }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停加工回放" : "播放加工回放"}</Button>
      <Button type="button" size="sm" variant="ghost" title="回到起点" aria-label="回到起点" onClick={() => seek(0)}><SkipBack size={15} /></Button>
      <select aria-label="加工回放倍率" className="h-8 rounded border bg-background px-1.5 text-xs" value={rate} onChange={e => setRate(Number(e.target.value))}>
        {[.5, 1, 2, 4].map(r => <option key={r} value={r}>{r}×</option>)}
      </select>
      <output aria-label="轮廓当前时刻" className="whitespace-nowrap font-mono text-xs tabular-nums">{sample.timeS.toFixed(3)} / {endS.toFixed(3)} s</output>
      <input aria-label="轮廓回放时间" aria-valuetext={sample.timeS.toFixed(3) + " 秒"} className="min-w-[min(100%,8rem)] flex-1 accent-primary" type="range" min="0" max={endS} step="any"
        value={sample.timeS} onChange={e => seek(e.target.valueAsNumber)} onKeyDown={e => {
          const next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? index - 1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? index + 1 : undefined;
          if (next !== undefined) { e.preventDefault(); seek(samples[Math.max(0, Math.min(samples.length - 1, next))].timeS); }
        }} />
    </div>
    <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1.8fr)_minmax(16.5rem,1fr)]">
      <CncContourOverlay {...{ samples, index, frame }} />
      <aside className="min-w-0 space-y-3 rounded-md border p-3 text-xs">
        <div className="space-y-1.5">
          <label className="flex flex-wrap items-center justify-between gap-1 font-semibold">当前程序块
            <select aria-label="定位程序块" className="h-7 rounded border bg-background px-1 font-normal" value={sample.line ?? ""} onChange={e => {
              const chosen = plan.plan.segments.find(s => s.line === Number(e.target.value));
              seek(chosen ? (chosen.startS + chosen.endS) / 2 : endS);
            }}>
              {plan.plan.segments.map(s => <option key={s.line} value={s.line}>第 {s.line} 行 · {s.mode}</option>)}<option value="">程序结束保持</option>
            </select>
          </label>
          <code className="block break-all rounded bg-background/65 px-2 py-1.5 font-mono text-xs">{sample.line ? lines[sample.line - 1] : "保持终点指令"}</code>
        </div>
        <table aria-label="当前三轴位置与同刻误差" className="w-full table-fixed border-collapse text-right tabular-nums">
          <caption className="pb-1.5 text-left font-semibold">工件坐标 <span className="font-normal text-muted-foreground">mm</span></caption>
          <thead className="border-b text-muted-foreground"><tr><th className="w-[13%] py-1 text-left font-normal">轴</th>
            <th style={{ color: commandColor }} className="font-normal">指令</th><th style={{ color: feedbackColor }} className="font-normal">仿真反馈</th><th className="font-normal">反馈−指令</th></tr></thead>
          <tbody>{axisNames.map((axis, i) => <tr key={axis} className="border-b last:border-0">
            <th className="py-1.5 text-left font-semibold">{axis}</th>
            <td aria-label={axis + " 轴指令位置"}>{fixedReading(sample.commandMm[i])}</td><td aria-label={axis + " 轴反馈位置"}>{fixedReading(sample.actualMm[i])}</td>
            <td>{signed(sample.followingErrorMm[i])}</td></tr>)}</tbody>
        </table>
        <div className="space-y-1.5 border-t pt-2"><dl className="space-y-1.5 tabular-nums">
          <div className="flex flex-wrap items-baseline justify-between gap-1"><dt className="font-semibold">当前刀尖跟随误差</dt>
            <dd aria-label="当前刀尖跟随误差" className="text-sm font-semibold">{sample.errorMm.toFixed(4)} mm</dd></div>
          <div className="flex flex-wrap items-baseline justify-between gap-1"><dt>全程最大跟随误差</dt>
            <dd><button type="button" aria-label="定位最大误差" title="定位最大误差" className="underline decoration-dotted underline-offset-2" onClick={() => seek(result.maxErrorTimeS)}>{result.maxErrorMm.toFixed(4)} mm @ {result.maxErrorTimeS.toFixed(3)} s</button></dd></div>
          <div className="flex justify-between gap-1"><dt>全程均方根（RMS）</dt><dd>{result.rmsErrorMm.toFixed(4)} mm</dd></div>
        </dl>
        <p className="text-[11px] leading-relaxed text-muted-foreground">跟随误差取同刻两刀尖的三维距离。全程指标按采样统计，含快移和终点保持，RMS 按时间加权。</p></div>
        {radial !== undefined && <div className="flex flex-wrap justify-between gap-1 border-t pt-2"><span>本段 XY 径向偏差</span><span className="tabular-nums">{signed(radial)} mm</span></div>}
        <dl className="space-y-1.5 border-t pt-2 tabular-nums">
          <div className="flex justify-between gap-1"><dt>反馈去料体积</dt><dd aria-label="反馈去料体积">{frame.removedVolumeMm3.toFixed(1)} mm³</dd></div>
          <div className="flex justify-between gap-1"><dt>反馈最大切深</dt><dd aria-label="反馈最大切深">{frame.maxDepthMm.toFixed(3)} mm</dd></div>
        </dl>
      </aside>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">毛坯 {MILO_STOCK.widthMm} × {MILO_STOCK.heightMm} × {MILO_STOCK.thicknessMm} mm，顶面 Z0。Ø{MILO_TOOL_DIAMETER_MM} mm 平底刀按反馈采样间的直线扫掠 {MILO_STOCK.cellSizeMm} mm 网格，料内快移计入去料。</p>
    <CncContourTraces result={result} index={index} seek={seek} />
  </section>;
}
