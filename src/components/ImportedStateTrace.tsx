import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { ImportedModelInfo, ImportedSample } from "@contracts/imported-physics";

const tickText = (value: number) => String(Number(value.toPrecision(4)));

export default function ImportedStateTrace({ info, samples, sample }: {
  info: ImportedModelInfo; samples: ImportedSample[]; sample: ImportedSample;
}) {
  const [choice, setChoice] = useState(() => {
    // A free joint has seven position coordinates; show one that actually moved.
    const first = samples[0];
    for (const field of ["qpos", "qvel"] as const) {
      const i = first[field].findIndex((value, index) => samples.some((point) => point[field][index] !== value));
      if (i !== -1) return `${field}:${i}`;
    }
    return "qpos:0";
  });
  const [name, offset] = choice.split(":");
  const field = name === "qvel" ? "qvel" : "qpos";
  const index = Number(offset);
  const channel = (field === "qvel" ? info.velocities : info.positions)[index];
  const data = useMemo(() => samples.map((item) => ({ time: item.timeS, value: item[field][index] })), [samples, field, index]);
  const values = data.map(({value}) => value);
  const min = Math.min(...values), max = Math.max(...values);
  const margin = Math.max(Math.abs(max) * 0.04, 1e-6);
  const unit = channel.unit === "1" ? "无量纲" : channel.unit;
  return <figure aria-label="自由度时域曲线" className="surface-inset min-w-0 p-3">
    <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-medium">自由度时域曲线 · {unit}</span>
      <label className="text-xs">
        <span className="sr-only">曲线状态量</span>
        <select className="h-8 w-full max-w-60 rounded border bg-background px-2 text-xs" value={choice} aria-label="曲线状态量" onChange={(event) => setChoice(event.target.value)}>
          <optgroup label="位置">{info.positions.map((item, i) => <option value={`qpos:${i}`} key={i}>{item.name} · 位置</option>)}</optgroup>
          <optgroup label="速度">{info.velocities.map((item, i) => <option value={`qvel:${i}`} key={i}>{item.name} · 速度</option>)}</optgroup>
        </select>
      </label>
    </figcaption>
    <div className="h-40 min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{top:6, right:12, bottom:0, left:0}}>
          <CartesianGrid stroke="#29332f" strokeDasharray="3 4" />
          <XAxis type="number" dataKey="time" domain={[data[0].time, data[data.length - 1].time]} height={23} stroke="#91a098" tick={{fontSize:10}} tickLine={false} axisLine={false} tickFormatter={tickText} />
          <YAxis width={52} domain={min === max ? [min - margin, max + margin] : ["auto", "auto"]} tickCount={5}
            ticks={min === max ? [min - margin, min, max + margin] : undefined} stroke="#91a098" tick={{fontSize:10}} tickLine={false} axisLine={false} tickFormatter={tickText} />
          <Line dataKey="value" type="linear" isAnimationActive={false} stroke="#61deb0" strokeWidth={2} dot={false} />
          <ReferenceLine x={sample.timeS} stroke="#b1bdb6" strokeDasharray="2 3" />
          <ReferenceDot x={sample.timeS} y={sample[field][index]} r={3} fill="#61deb0" stroke="#17211c" isFront />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <p className="ml-[52px] text-center text-[11px] text-muted-foreground">时间（s）</p>
  </figure>;
}
