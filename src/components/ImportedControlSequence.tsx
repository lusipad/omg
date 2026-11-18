import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { IMPORTED_PHYSICS_LIMITS, type ImportedControlStage, type ImportedModelInfo, type ImportedSample } from "@contracts/imported-physics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type StageDraft = { time: string; values: string[]; label: string };
const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const format = (value: number) => String(Number(value.toPrecision(6)));

export function ImportedControlEditor({ actuators, values, stages, duration, onValues, onStages }: {
  actuators: ImportedModelInfo["actuators"]; values: string[]; stages: StageDraft[]; duration: string;
  onValues: (values: string[]) => void; onStages: (stages: StageDraft[]) => void;
}) {
  const [selected, setSelected] = useState(-1);
  const stage = stages[selected];
  const displayed = stage?.values ?? values;
  function update(patch: Partial<StageDraft>) {
    onStages(stages.map((item, i) => i === selected ? { ...item, ...patch } : item));
  }
  function add() {
    let at = stage ? selected + 1 : 0;
    // If the last target already occupies the end time, insert before it.
    if (stage && at === stages.length && Number(stage.time) >= Number(duration)) at = selected;
    const previous = stages[at - 1];
    const start = Number(previous?.time ?? 0), end = Number(stages[at]?.time ?? duration);
    const time = Number.isFinite(end) && end > start ? String(Number(((start + end) / 2).toPrecision(12))) : "";
    onStages([...stages.slice(0, at), { time, label: "", values: [...(previous?.values ?? values)] }, ...stages.slice(at)]);
    setSelected(at);
  }
  return <div className="min-w-0 space-y-3 border-t pt-3">
    {stages.length > 0 && <>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-sm font-medium">多阶段动作 · {stages.length} 段</span>
        <button type="button" className="text-xs text-primary hover:underline" aria-label="改用当前值恒定控制" title="保留当前编辑栏的数值并移除动作阶段" onClick={() => {
          onValues([...displayed]); onStages([]); setSelected(-1);
        }}>改为恒定控制</button>
      </div>
      <label className="block"><span className="field-label">编辑控制阶段</span>
        <select aria-label="编辑控制阶段" className={selectStyle} value={stage ? selected : -1} onChange={(event) => setSelected(Number(event.target.value))}>
          <option value={-1}>0 s · 初始控制</option>
          {stages.map((item, i) => <option key={i} value={i}>{i + 1}. {item.label || "动作阶段"} · {item.time || "…"} s</option>)}
        </select>
      </label>
      <p className="text-xs leading-5 text-muted-foreground">从 0 s 的控制值平滑过渡到各阶段目标，到达末段后保持。</p>
      {stage && <div className="grid gap-2">
        <label><span className="field-label">阶段名称</span>
          <Input aria-label="阶段名称" placeholder={`阶段 ${selected + 1}`} maxLength={IMPORTED_PHYSICS_LIMITS.maxStageLabel}
            value={stage.label} onChange={(event) => update({ label: event.target.value })} />
        </label>
        <label><span className="field-label">到达时间（s）</span>
          <Input aria-label="阶段到达时间（s）" type="number" step="any" className="mono" value={stage.time} placeholder="从 0 秒起算"
            onChange={(event) => update({ time: event.target.value })} />
        </label>
      </div>}
    </>}
    {actuators.length > 0 && <div className="thin-scrollbar max-h-72 space-y-3 overflow-y-auto">
      {actuators.map((item, i) => <label key={i} className="block">
        <span className="field-label"><span className="break-all">{item.name}</span><span className="shrink-0 text-muted-foreground">{item.unit}</span></span>
        <Input aria-label={`执行器 ${item.name}`} className="mono" type="number" step="any" min={item.range?.[0]} max={item.range?.[1]} value={displayed[i] ?? ""}
          onChange={(event) => {
            const next = displayed.map((value, j) => j === i ? event.target.value : value);
            if (stage) update({ values: next }); else onValues(next);
          }} />
        {item.range && <span className="mt-1 block text-[11px] text-muted-foreground">范围 {format(item.range[0])} 至 {format(item.range[1])}</span>}
      </label>)}
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={stages.length >= IMPORTED_PHYSICS_LIMITS.maxStages}
        title={stage && selected === stages.length - 1 && Number(stage.time) >= Number(duration) ? "末段已到运行结束时刻，新阶段将插在其前。" : "在所选控制之后插入阶段"} onClick={add}><Plus />添加动作阶段</Button>
      {stage && <Button type="button" size="sm" variant="ghost" onClick={() => {
        onStages(stages.filter((_, i) => i !== selected)); setSelected(Math.min(selected, stages.length - 2));
      }}><X />移除本阶段</Button>}
    </div>
  </div>;
}

export function ReferenceReadout({ sample, first, name }: { sample: ImportedSample; first: ImportedSample; name?: string }) {
  if (!sample.referenceM || !first.referenceM) return null;
  const z = sample.referenceM[2];
  return <div className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span className="break-all">参考点 {name}</span>
    <span>参考 ΔZ <output aria-label="参考点相对起点 ΔZ" className="mono text-foreground">{format((z - first.referenceM[2]) * 1000)} mm</output></span>
    <span>观测点 Z − 参考点 Z <output aria-label="观测点与参考点 Z 差" className="mono text-foreground">{format((sample.pointM[2] - z) * 1000)} mm</output></span>
  </div>;
}

export function SequencePlayback({ stages, samples, sample, pointName, referenceName, onSeek }: {
  stages: ImportedControlStage[]; samples: ImportedSample[]; sample: ImportedSample; pointName: string; referenceName?: string; onSeek: (index: number) => void;
}) {
  const next = stages.findIndex((stage) => sample.timeS <= stage.timeS + 1e-9);
  const active = next === -1 ? stages.length - 1 : next;
  const current = stages[active];
  const startZ = samples[0].pointM[2];
  const referenceStart = samples[0].referenceM?.[2];
  const maxLiftMm = useMemo(() => (Math.max(...samples.map((frame) => frame.pointM[2])) - startZ) * 1000, [samples, startZ]);
  const readings = useMemo(() => {
    let nearest = 0;
    const rows = [{ label: "起点", time: 0, index: 0 }];
    stages.forEach((stage, i) => {
      while (nearest + 1 < samples.length && Math.abs(samples[nearest + 1].timeS - stage.timeS) < Math.abs(samples[nearest].timeS - stage.timeS)) nearest++;
      rows.push({ label: stage.label ?? `阶段 ${i + 1}`, time: stage.timeS, index: nearest });
    });
    const last = samples.length - 1;
    if (nearest !== last) rows.push({ label: "运行结束", time: samples[last].timeS, index: last });
    return rows;
  }, [stages, samples]);
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
    <output aria-label="当前动作阶段" className="break-words font-medium">
      {next === -1 ? "末段保持" : `阶段 ${active + 1} / ${stages.length}`} · {current.label || `${format(current.timeS)} s 路标`}
    </output>
    <select aria-label="跳至动作阶段" className="h-8 max-w-full rounded border bg-background px-2 text-xs" value="" onChange={(event) => {
      onSeek(readings[Number(event.target.value)].index);
    }}>
      <option value="">跳至阶段最近采样</option>
      {readings.map((row, i) => <option key={i} value={i}>{format(row.time)} s · {row.label}</option>)}
    </select>
    <div className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 text-muted-foreground">
      <span className="break-all">{pointName}</span>
      <span>相对起点 ΔZ <output aria-label="相对起点 ΔZ" className="mono text-foreground">{format((sample.pointM[2] - startZ) * 1000)} mm</output></span>
      <span>全程最大抬升 <output aria-label="全程最大抬升" className="mono text-foreground">{format(maxLiftMm)} mm</output></span>
    </div>
    <ReferenceReadout sample={sample} first={samples[0]} name={referenceName} />
    <details className="w-full text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">阶段观测记录</summary>
      <p className="mt-2">各阶段取最近的实际采样，ΔZ 以 0 s 为基准。{referenceStart !== undefined && "Z 差为观测点高度减去参考点高度，两行之差给出这段时间的相对垂向位移。"}</p>
      <div className="thin-scrollbar mt-2 overflow-x-auto"><table aria-label="阶段观测记录" className="data-table min-w-[430px]">
        <thead><tr>{["阶段", "采样（s）", "X（m）", "Y（m）", "Z（m）", "ΔZ（mm）", ...(referenceStart === undefined ? [] : ["参考 ΔZ（mm）", "Z 差（mm）"])].map((label) => <th key={label}><span className="normal-case">{label}</span></th>)}</tr></thead>
        <tbody>{readings.map((row, i) => {
          const value = samples[row.index];
          return <tr key={i}><td>{row.label}</td><td className="mono">{format(value.timeS)}</td>
            {value.pointM.map((metres, axis) => <td className="mono" key={axis}>{format(metres)}</td>)}
            <td className="mono">{format((value.pointM[2] - startZ) * 1000)}</td>
            {referenceStart !== undefined && <><td className="mono">{value.referenceM ? format((value.referenceM[2] - referenceStart) * 1000) : "—"}</td>
              <td className="mono">{value.referenceM ? format((value.pointM[2] - value.referenceM[2]) * 1000) : "—"}</td></>}</tr>;
        })}</tbody>
      </table></div>
    </details>
  </div>;
}
