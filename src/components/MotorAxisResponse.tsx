import { useId, useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { MotorAxisResult } from "@/lib/modelica-motor-runtime";
import { formatAxisValue as number, nearestSample } from "@/lib/axis-response";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import AxisTrace from "./AxisTrace";

type Props = { result: MotorAxisResult; name: string; targetMm: number; leadMmPerRev: number; motorName: string };

export default function MotorAxisResponse({ result, name, targetMm, leadMmPerRev, motorName }: Props) {
  const { samples } = result, last = samples.length - 1;
  const [index, setIndex] = useState(() => nearestSample(samples, 100));
  const [motor, viewMotor] = useState(false), slider = useId();
  const cursor = samples[index], end = samples[last];
  const data = useMemo(() => samples.map(s => ({ timeMs: s.timeMs, position: s.positionMm, velocity: s.velocityMmS, angle: s.angleDeg, speed: s.speedRpm })), [samples]);
  function exportCsv() {
    const header = "time_ms,target_mm,position_mm,velocity_mm_s,angle_deg,speed_rpm,current_A,motor_torque_Nm";
    const rows = samples.map(s => [s.timeMs, targetMm, s.positionMm, s.velocityMmS, s.angleDeg, s.speedRpm, s.currentA, s.motorTorqueNm].join(","));
    downloadBlob("\uFEFF" + [header, ...rows].join("\r\n") + "\r\n", `${name}-${motorName}-${targetMm}mm.csv`, "text/csv;charset=utf-8");
  }
  return <section aria-label="装机位置阶跃响应" className="surface min-w-0 space-y-3 p-3 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="break-words font-semibold">{name}位置阶跃响应</h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">{motorName} · 指令 {number(targetMm)} mm · {number(end.timeMs)} ms
          <span className={result.settled ? "ml-2 text-primary" : "ml-2 text-amber-300"}>{result.settled ? "已到位" : "观察时间内未到位"}</span>
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={exportCsv}><Download />导出响应 CSV</Button>
    </header>
    <div className="flex flex-wrap gap-1" role="group" aria-label="曲线观测对象">
      <Button type="button" variant={!motor ? "secondary" : "ghost"} size="sm" aria-pressed={!motor} onClick={()=>viewMotor(false)}>工作台</Button>
      <Button type="button" variant={motor ? "secondary" : "ghost"} size="sm" aria-pressed={motor} onClick={()=>viewMotor(true)}>电机轴</Button>
    </div>
    <div className="grid min-w-0 gap-3 xl:grid-cols-2">
      <AxisTrace data={data} metric={motor ? "angle" : "position"} cursor={data[index]} target={motor ? targetMm / leadMmPerRev * 360 : targetMm} />
      <AxisTrace data={data} metric={motor ? "speed" : "velocity"} cursor={data[index]} target={0} />
    </div>
    <p className="text-center text-[11px] text-muted-foreground">时间（ms）</p>
    <div className="surface-inset flex min-w-0 flex-wrap items-center gap-2 p-3">
      <label htmlFor={slider} className="text-xs">采样时间</label>
      <input id={slider} type="range" min={0} max={end.timeMs} step="any" value={cursor.timeMs} aria-valuetext={number(cursor.timeMs) + " 毫秒"}
        className="order-last h-5 w-full min-w-0 accent-primary sm:order-none sm:flex-1"
        onChange={e=>setIndex(nearestSample(samples, e.currentTarget.valueAsNumber))}
        onKeyDown={e=>{
          if (!["ArrowLeft","ArrowRight","ArrowDown","ArrowUp"].includes(e.key)) return;
          e.preventDefault();setIndex(Math.max(0,Math.min(last,index + (e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1))));
        }} />
      <output htmlFor={slider} aria-label="当前采样时刻" className="mono ml-auto text-xs">{number(cursor.timeMs)} ms</output>
    </div>
    <dl className="grid min-w-0 grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      {([
        ["电机转角", cursor.angleDeg, "°"], ["电机转速", cursor.speedRpm, "rpm"],
        ["q 轴电流", cursor.currentA, "A"], ["电磁转矩", cursor.motorTorqueNm, "N·m"],
      ] as const).map(([label,value,unit])=><div key={label} className="min-w-0 border-l pl-2">
        <dt className="text-muted-foreground">{label}</dt><dd className="mono break-all" aria-label={label + "采样值"}>{number(value)} {unit}</dd>
      </div>)}
    </dl>
  </section>;
}
