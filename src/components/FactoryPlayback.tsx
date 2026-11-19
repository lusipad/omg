import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Pause, Play, SlidersHorizontal } from "lucide-react";
import type { FactoryLayout } from "@contracts/factory";
import { factoryTimelineCsv, type FactoryOperation, type FactoryRunResult } from "@/lib/factory-runtime";
import { equipmentPhases, factoryFrame, indexFactoryRun, partPhases, type FactoryTimeline } from "@/lib/factory-playback";
import { downloadBlob } from "@/lib/download";
import FactoryScene from "./FactoryScene";
import { Button } from "./ui/button";

type Props = { layout: FactoryLayout; result: FactoryRunResult; onEditResource?: (id: string) => void };
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
const seconds = (t: number) => number.format(t) + " s";
const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm";
const titles = { handle: "上下料工位", machine: "数控机床", conveyor: "输送带", mobile: "移动机器人" };

function ResourceTimeline({
  timeline,
  time,
  selected,
  onSelect,
  onSeek,
}: {
  timeline: FactoryTimeline;
  time: number;
  selected: string;
  onSelect: (id: string) => void;
  onSeek: (t: number) => void;
}) {
  const total = timeline.result.makespanS;
  const percent = (v: number) => (total ? (100 * v) / total : 0) + "%";
  function band(start: number, end: number, color: string, key: string) {
    if (end <= start) return null;
    return (
      <span
        key={key}
        className="absolute inset-y-1 rounded-[1px]"
        style={{ left: percent(start), width: percent(end - start), backgroundColor: color }}
      />
    );
  }
  return (
    <details className="min-w-0 rounded-md border bg-background/35 px-3 py-2.5" open>
      <summary className="cursor-pointer text-sm font-medium">设备占用时间线</summary>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2 w-3 bg-[#6baa91]" />
          加工或搬运
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2 w-3 bg-[#b4975e]" />
          预占等料
        </span>
      </div>
      <div className="mt-2 space-y-1" aria-label="各设备的作业区间">
        {timeline.result.resources.map(resource => {
          const intervals = timeline.byResource.get(resource.id)!;
          return (
            <div key={resource.id} className="grid grid-cols-[minmax(5rem,.27fr)_1fr] items-center gap-2">
              <button
                type="button"
                aria-pressed={resource.id === selected}
                onClick={() => onSelect(resource.id)}
                title={resource.name}
                className={`truncate text-left text-xs ${resource.id === selected ? "text-primary" : "text-muted-foreground"}`}
              >
                {resource.name}
              </button>
              <button
                type="button"
                aria-label={resource.name + "作业时间线"}
                className="relative block h-5 min-w-0 overflow-hidden rounded-sm bg-[#293831]"
                onClick={e => {
                  onSelect(resource.id);
                  if (e.detail) {
                    const b = e.currentTarget.getBoundingClientRect();
                    onSeek(Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * total);
                  }
                }}
              >
                {intervals.map(op =>
                  op.carrierId === resource.id
                    ? band(op.dispatchS, op.serviceStartS, "#6baa91", op.jobId + ":" + op.stageId)
                    : [
                        band(op.dispatchS, op.serviceStartS, "#b4975e", op.jobId + ":" + op.stageId + ":reserve"),
                        band(op.serviceStartS, op.finishS, "#6baa91", op.jobId + ":" + op.stageId + ":work"),
                      ]
                )}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 w-px bg-[#e4eee8]"
                  style={{ left: `clamp(0px, ${percent(time)}, calc(100% - 1px))` }}
                />
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-1 grid grid-cols-[minmax(5rem,.27fr)_1fr] gap-2 text-[10px] text-muted-foreground">
        <span />
        <div className="flex justify-between">
          <span>0 s</span>
          <span>{seconds(total)}</span>
        </div>
      </div>
    </details>
  );
}

function Playback({ layout, result, onEditResource }: Props) {
  const timeline = useMemo(() => indexFactoryRun(result), [result]),
    slider = useId();
  const sliderEnd = useMemo(() => {
    // Range controls can round a fractional maximum differently from JavaScript. Detect their final thumb position.
    const input = document.createElement("input");
    input.type = "range";
    input.step = "any";
    input.max = String(result.makespanS);
    input.value = input.max;
    return input.valueAsNumber;
  }, [result.makespanS]);
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4);
  const timeRef = useRef(0);
  const [selectedId, select] = useState(result.resources[0].id),
    [jobId, setJob] = useState(result.jobs[0].id);
  const frame = useMemo(() => factoryFrame(timeline, time), [time, timeline]);
  const resource = result.resources.find(item => item.id === selectedId) ?? result.resources[0];
  const pose = frame.equipment.get(resource.id)!;
  const part = frame.parts.find(item => item.id === jobId) ?? frame.parts[0];
  const stageName = (op: FactoryOperation) =>
    layout.lines.find(l => l.id === op.lineId)?.stages.find(s => s.id === op.stageId)?.name ?? op.stageId;
  const lineName = (id: string) => layout.lines.find(l => l.id === id)?.name ?? id;
  const deviceName = (id?: string) => result.resources.find(r => r.id === id)?.name ?? "";
  const scheduled = timeline.byResource.get(resource.id)!;
  const next = scheduled.find(op => op.dispatchS > time);
  const lines = layout.lines.filter(line =>
    line.stages.some(s => s.stations.includes(resource.id) || s.carriers.includes(resource.id))
  );
  const utilization = result.makespanS ? resource.busyS / result.makespanS : 0;
  function seek(t: number) {
    const clamped = Math.max(0, Math.min(result.makespanS, t));
    setPlaying(false);
    setTime(clamped);
    timeRef.current = clamped;
  }
  function stepEvent(forward: boolean) {
    const times = timeline.events;
    if (forward) {
      seek(times.find(s => s > time) ?? result.makespanS);
      return;
    }
    for (let i = times.length - 1; i >= 0; i--)
      if (times[i] < time) {
        seek(times[i]);
        return;
      }
    seek(0);
  }
  useEffect(() => {
    if (!playing) return;
    let raf = 0,
      lastPaint = -Infinity;
    const origin = performance.now(),
      start = timeRef.current;
    function tick(now: number) {
      const current = Math.min(result.makespanS, start + ((now - origin) / 1000) * speed);
      if (current >= result.makespanS || now - lastPaint >= 65) {
        lastPaint = now;
        timeRef.current = current;
        setTime(current);
      }
      if (current >= result.makespanS) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, result.makespanS, speed]);

  return (
    <section aria-label="工厂运行回放" className="surface min-w-0 space-y-4 p-3 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">工厂运行回放</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadBlob("\uFEFF" + factoryTimelineCsv(result), layout.name + "-工序时间线.csv", "text/csv;charset=utf-8")
          }
        >
          <Download />
          导出时间线 CSV
        </Button>
      </header>
      <dl className="grid grid-cols-2 gap-y-3 rounded-md border bg-background/40 px-3 py-3 sm:grid-cols-4 sm:gap-y-0">
        {[
          ["已完工", `${frame.completed} / ${result.jobs.length}`],
          ["在制工件", frame.wip],
          ["等待工件", frame.waiting],
          ["整批用时", seconds(result.makespanS)],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 sm:border-l sm:px-3 sm:first:border-0 sm:first:pl-0">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd aria-label={String(label)} className="mono mt-0.5 text-base font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,2.15fr)_minmax(15rem,1fr)]">
        <div className="min-w-0 space-y-2">
          <FactoryScene {...{ layout, result, frame, selectedId: resource.id, onSelect: select }} />
          <div className="surface-inset flex flex-wrap items-center gap-2 px-3 py-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={playing ? "暂停工厂回放" : "播放工厂回放"}
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (time >= result.makespanS) {
                    timeRef.current = 0;
                    setTime(0);
                  }
                  setPlaying(true);
                }
              }}
            >
              {playing ? <Pause /> : <Play />}
              {playing ? "暂停" : "回放"}
            </Button>
            <select
              aria-label="回放速度"
              className="h-8 rounded border bg-background px-1 text-xs"
              value={speed}
              onChange={e => setSpeed(Number(e.target.value))}
            >
              {[1, 4, 10].map(n => (
                <option key={n} value={n}>
                  {n}×
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              aria-label="上一事件"
              title="上一事件"
              disabled={time === 0}
              onClick={() => stepEvent(false)}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="下一事件"
              title="下一事件"
              disabled={time === result.makespanS}
              onClick={() => stepEvent(true)}
            >
              <ChevronRight />
            </Button>
            <output aria-label="工厂当前时刻" htmlFor={slider} className="mono ml-auto text-sm">
              {seconds(time)}
            </output>
            <input
              id={slider}
              type="range"
              aria-label="工厂仿真时间"
              min={0}
              max={result.makespanS}
              step="any"
              value={time}
              aria-valuetext={seconds(time)}
              onChange={e => {
                const t = e.currentTarget.valueAsNumber;
                seek(t >= sliderEnd ? result.makespanS : t);
              }}
              onKeyDown={e => {
                if (e.key === "Home" || e.key === "End") {
                  e.preventDefault();
                  seek(e.key === "Home" ? 0 : result.makespanS);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  stepEvent(e.key === "ArrowRight");
                }
              }}
              className="block h-5 w-full accent-primary"
            />
          </div>
        </div>
        <aside aria-label="工厂设备状态" className="min-w-0 space-y-4 rounded-md border bg-background/45 p-3.5">
          <div className="space-y-1.5">
            <label className="block">
              <span className="field-label">观察设备</span>
              <select className={selectClass} value={resource.id} onChange={e => select(e.target.value)}>
                {result.resources.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {titles[r.role]}
                  </option>
                ))}
              </select>
            </label>
            <p className="break-words text-[11px] text-muted-foreground">
              {resource.modelRef.id} · {resource.modelRef.version}
            </p>
          </div>
          <div className="space-y-1">
            <p
              aria-label="设备当前状态"
              className={pose.phase === "idle" ? "text-sm font-medium text-muted-foreground" : "text-sm font-semibold text-primary"}
            >
              {equipmentPhases[pose.phase]}
            </p>
            {pose.operation ? (
              <p className="break-words text-xs leading-5">
                {lineName(pose.operation.lineId)} · {stageName(pose.operation)} · {pose.operation.jobId}
              </p>
            ) : (
              <p className="break-words text-xs text-muted-foreground">
                {next ? `下次任务 ${seconds(next.dispatchS)} · ${next.jobId}` : scheduled.length ? "本批任务已完成" : "本批无任务"}
              </p>
            )}
            <output aria-label="设备当前位置" className="mono block text-[11px] text-muted-foreground">
              X {number.format(pose.point[0])} · Y {number.format(pose.point[1])} m
            </output>
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <div className="flex justify-between text-xs">
              <span>整批利用率</span>
              <output aria-label="设备整批利用率" className="mono">
                {number.format(utilization * 100)}%
              </output>
            </div>
            <div className="h-1 rounded bg-muted">
              <div className="h-full rounded bg-primary" style={{ width: Math.min(100, utilization * 100) + "%" }} />
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              作业 {seconds(resource.busyS)}
              {resource.reservedS > 0 && ` · 预占等料 ${seconds(resource.reservedS)}`}
            </p>
            {!!lines.length && (
              <p className="break-words text-[11px] text-muted-foreground">{lines.map(l => l.name).join(" · ")}</p>
            )}
          </div>
          {onEditResource && (
            <Button size="sm" variant="outline" onClick={() => onEditResource(resource.id)}>
              <SlidersHorizontal />
              编辑此设备
            </Button>
          )}
          <div className="space-y-1.5 border-t pt-3">
            <label className="block">
              <span className="field-label">跟踪工件</span>
              <select className={selectClass} value={part.id} onChange={e => setJob(e.target.value)}>
                {result.jobs.map(j => (
                  <option key={j.id} value={j.id}>
                    {lineName(j.lineId)} · {j.id}
                  </option>
                ))}
              </select>
            </label>
            <p aria-label="工件当前状态" className="break-words text-xs font-medium">
              {partPhases[part.phase]}
              {part.operation && ` · ${stageName(part.operation)}`}
            </p>
            {part.operation && (
              <p className="break-words text-xs text-muted-foreground">
                {part.phase === "waiting"
                  ? `等候转入 ${deviceName(part.operation.stationId)}`
                  : part.phase === "carrying" || part.phase === "pickup" || part.phase === "drop"
                    ? `${deviceName(part.operation.carrierId)} · ${deviceName(part.operation.fromStationId)} → ${deviceName(part.operation.stationId)}`
                    : deviceName(part.operation.stationId)}
              </p>
            )}
            {part.point && (
              <output aria-label="工件当前位置" className="mono block text-[11px] text-muted-foreground">
                X {number.format(part.point[0])} · Y {number.format(part.point[1])} m
              </output>
            )}
          </div>
        </aside>
      </div>
      <ResourceTimeline timeline={timeline} time={time} selected={resource.id} onSelect={select} onSeek={seek} />
      {frame.waiting > 0 && (
        <details className="rounded-md border bg-background/35 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">等待工件 · {frame.waiting}</summary>
          <ul className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
            {frame.parts
              .filter(p => p.phase === "waiting")
              .map(p => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="text-left text-muted-foreground hover:text-primary"
                    onClick={() => {
                      setJob(p.id);
                      select(p.operation!.stationId);
                    }}
                  >
                    {p.id} · {stageName(p.operation!)} · 等候转入 {deviceName(p.operation!.stationId)}
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default function FactoryPlayback(props: Props) {
  const [run, setRun] = useState({ result: props.result, revision: 0 });
  if (run.result !== props.result) setRun({ result: props.result, revision: run.revision + 1 });
  return <Playback key={run.revision} {...props} />;
}
