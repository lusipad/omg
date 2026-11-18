import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { So101Sample } from "@contracts/so101";

const timeFormat = (value: number) => String(Number(value.toFixed(2)));
const valueFormat = (value: number) => String(Number(value.toPrecision(3)));

function Series({ data, sample, position }: {
  data: { time: number; target: number; position: number; velocity: number }[];
  sample: So101Sample;
  position: boolean;
}) {
  const title = position ? "关节角位置（°）" : "关节角速度（°/s）";
  const color = position ? "#61deb0" : "#83c8ff";
  return <figure className="min-w-0" aria-label={title + "随时间变化曲线"}>
    <figcaption className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
      {title}<span className="inline-flex items-center gap-1.5 font-normal text-muted-foreground"><span aria-hidden="true" className="h-0.5 w-4" style={{ backgroundColor: color }} />实际</span>
      {position && <span className="inline-flex items-center gap-1.5 font-normal text-muted-foreground"><span aria-hidden="true" className="w-4 border-t-2 border-dashed border-amber-300" />指令</span>}
    </figcaption>
    <div className="h-32 min-w-0 sm:h-36">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ left: 0, top: 6, right: 12, bottom: 0 }}>
          <CartesianGrid stroke="#29332f" strokeDasharray="3 4" />
          <XAxis type="number" dataKey="time" domain={[0, data[data.length - 1].time]} height={23} stroke="#91a098" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={timeFormat} />
          <YAxis width={45} domain={["auto", "auto"]} tickCount={4} stroke="#91a098" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={valueFormat} />
          {position && <Line dataKey="target" type="linear" isAnimationActive={false} stroke="#e7bc72" strokeDasharray="5 3" strokeWidth={1.6} dot={false} />}
          <Line dataKey={position ? "position" : "velocity"} type="linear" isAnimationActive={false} stroke={color} strokeWidth={2} dot={false} />
          <ReferenceLine x={sample.timeS} stroke="#b1bdb6" strokeDasharray="2 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </figure>;
}

export default function So101Trace({ samples, joint, sample }: { samples: So101Sample[]; joint: number; sample: So101Sample }) {
  const data = useMemo(() => samples.map((point) => ({
    time: point.timeS, target: point.targetDeg[joint], position: point.positionDeg[joint], velocity: point.velocityDegS[joint],
  })), [samples, joint]);
  return <div className="space-y-2">
    <Series data={data} sample={sample} position />
    <Series data={data} sample={sample} position={false} />
    <p className="text-center text-[11px] text-muted-foreground">时间（s）</p>
  </div>;
}

