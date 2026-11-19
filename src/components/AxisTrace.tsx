import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { metrics, formatAxisValue as number, type Metric, type AxisSample } from "@/lib/axis-response";

export default function AxisTrace({ data, metric, cursor, target }: { data: AxisSample[]; metric: Metric; cursor: AxisSample; target: number }) {
  const value = cursor[metric];
  if (value === undefined) return null;
  const position = metric === "position" || metric === "angle", { label, aria, unit, color } = metrics[metric];
  const flatZero = data.every(point => point[metric] === 0) && (!position || target === 0);
  return <figure className="min-w-0" aria-label={`${aria}曲线`}>
    <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium"><i className="h-0.5 w-4" style={{ backgroundColor: color }} />{label}（{unit}）</span>
      {position && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><i className="w-4 border-t border-dashed border-amber-300" />目标 {number(target)} {unit}</span>}
      <output aria-label={`${aria}读数`} className="mono ml-auto">{number(value)} {unit}</output>
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
          <ReferenceDot x={cursor.timeMs} y={value} r={3.5} fill={color} stroke="#17211c" isFront />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </figure>;
}
