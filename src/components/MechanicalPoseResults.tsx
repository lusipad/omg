import { useEffect, useId, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { ResolvedMechanicalAssembly } from "@contracts/mechanical-assembly";
import { compileMechanicalModel, mechanicalJointName, MECHANICAL_OUTPUT_SITE } from "@contracts/mechanical-model";
import type { ImportedSample } from "@contracts/imported-physics";
import { loadImportedPhysics } from "@/lib/imported-physics";
import { Button } from "@/components/ui/button";
import PhysicsScene from "./PhysicsScene";

type Props = { resolved: ResolvedMechanicalAssembly };
const format = (v: number) => String(Number(v.toFixed(4)));

async function solvePoses(resolved: ResolvedMechanicalAssembly, signal: AbortSignal) {
  const engine = await loadImportedPhysics(compileMechanicalModel(resolved), signal);
  try {
    const { info } = engine;
    const output = info.points.findIndex(p => p.kind === "site" && p.name === MECHANICAL_OUTPUT_SITE);
    if (output < 0) throw new Error("编译后的装配缺少所选的末端接口。");
    const frames: Pick<ImportedSample, "pointM" | "geomPoses" | "qpos">[] = [];
    for (const name of info.keyframes) {
      signal.throwIfAborted();
      const pose = await engine.previewKeyframe(name);
      frames.push({ pointM: pose.pointsM[output], geomPoses: pose.initial.geomPoses, qpos: pose.initial.qpos });
    }
    const last = frames[frames.length - 1];
    if (frames[0].qpos.every((v, i) => v === last.qpos[i])) frames.splice(0, frames.length - 1);
    const coordinates = new Map(info.positions.map((p, i) => [p.name, i]));
    const joints = resolved.nodes.flatMap(({ path, part }, i) => {
      const joint = part.joint;
      if (joint.type === "fixed") return [];
      const index = coordinates.get(mechanicalJointName(i));
      if (index === undefined) throw new Error(`编译后找不到“${path}”的关节输入。`);
      return [{ path, index, scale: joint.type === "hinge" ? 180 / Math.PI : 1000, unit: joint.unit }];
    });
    return { frames, joints, geometry: info.geometry, output: resolved.output };
  } finally { engine.dispose(); }
}

type Poses = Awaited<ReturnType<typeof solvePoses>>;
function PoseReadout({ poses }: { poses: Poses }) {
  const { frames, joints, geometry, output } = poses, last = frames.length - 1;
  const [index, setIndex] = useState(last), [playing, setPlaying] = useState(false);
  const [jointPath, setJointPath] = useState(joints[0]?.path);
  const slider = useId(), joint = joints.find(j => j.path === jointPath), sample = frames[index], goal = frames[last];
  const percent = last ? index * 100 / last : 100;
  function seek(next: number) { setPlaying(false); setIndex(Math.min(last, Math.max(0, next))); }
  useEffect(() => {
    if (!playing || index >= last) return;
    const timer = window.setTimeout(() => {
      setIndex(index + 1);
      if (index + 1 === last) setPlaying(false);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [playing, index, last]);
  return <>
    <div className="surface-inset flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <Button size="sm" variant="outline" disabled={!last} onClick={() => {
        if (!playing && index === last) setIndex(0);
        setPlaying(!playing);
      }}>{playing ? <Pause /> : <Play />}{playing ? "暂停" : "回放姿态"}</Button>
      <label htmlFor={slider} className="text-xs">位姿进度</label>
      <input id={slider} type="range" min={0} max={100} step="any" value={percent} disabled={!last}
        aria-valuetext={`${format(percent)}%`} className="order-last h-5 w-full min-w-0 accent-primary sm:order-none sm:flex-1"
        onChange={e => seek(Math.round(e.currentTarget.valueAsNumber * last / 100))}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault(); seek(index + (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1));
        }} />
      <output htmlFor={slider} aria-label="当前位姿帧" className="mono ml-auto text-xs">{index + 1} / {frames.length} 帧 · {format(percent)}%</output>
    </div>
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)]">
      <PhysicsScene geometry={geometry} sample={sample} trail={frames} title="机械装配三维运动学示意" pointName="末端" coordinateLabel="当前末端世界坐标" unit="mm" />
      <div className="surface-inset min-w-0 space-y-4 p-4">
        <div><h4 className="text-sm font-medium">目标末端世界坐标</h4>
          <output aria-label="目标末端世界坐标" className="mono mt-1 block break-words text-sm">X {format(goal.pointM[0] * 1000)} · Y {format(goal.pointM[1] * 1000)} · Z {format(goal.pointM[2] * 1000)} mm</output>
          <p className="mt-1 break-all text-xs text-muted-foreground">输出接口 {output.path} / {output.mount}</p>
        </div>
        {joint ? <div className="border-t pt-3">
          <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">观测关节
            <select value={joint.path} onChange={event => setJointPath(event.target.value)} className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-xs">
              {joints.map(j => <option key={j.path} value={j.path}>{j.path} · {j.unit === "deg" ? "转动" : "移动"}</option>)}
            </select>
          </label>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">{([
            ["起点", frames[0]], ["当前", sample], ["目标", goal],
          ] as const).map(([label, pose]) => {
            const value = pose.qpos[joint.index] * joint.scale;
            return <div key={label}><dt className="text-muted-foreground">{label}</dt>
              <dd className="mono mt-1 break-words"><output aria-label={`关节${label}读数`}>{format(value)} {joint.unit === "deg" ? "°" : "mm"}</output></dd></div>;
          })}</dl>
        </div> : <p className="border-t pt-3 text-xs">所有部件均为固定连接。</p>}
        <div className="border-t pt-3 text-xs leading-5 text-muted-foreground">
          <p>连杆按安装点绘制，符号尺寸用于辨认接口与关节。回放进度表示从合法起点到目标输入的插值比例。</p>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {[["接口", "#5bdeb0"], ["转动关节", "#faa853"], ["移动关节", "#63b8fa"]].map(([label, color]) =>
              <span key={label} className="inline-flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>)}
          </p>
        </div>
      </div>
    </div>
  </>;
}

export default function MechanicalPoseResults({ resolved }: Props) {
  const [outcome, setOutcome] = useState<(Props & ({ poses: Poses } | { error: string })) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    solvePoses(resolved, controller.signal).then(poses => {
      if (!controller.signal.aborted) setOutcome({ resolved, poses });
    }).catch(cause => {
      if (!controller.signal.aborted) setOutcome({ resolved, error: cause instanceof Error ? cause.message : "无法计算装配位姿。" });
    });
    return () => controller.abort();
  }, [resolved]);
  const shown = outcome?.resolved === resolved ? outcome : null;
  return <section aria-label="机械装配位姿结果" className="surface min-w-0 space-y-4 p-4 sm:p-5">
    <header className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-lg font-semibold">装配位姿</h3><span className="text-xs text-muted-foreground">MuJoCo 正运动学</span></header>
    {!shown ? <p role="status" className="text-sm text-muted-foreground">正在编译装配并计算关节位姿…</p> : "error" in shown
      ? <p role="alert" className="break-words text-sm text-destructive">{shown.error}</p> : <PoseReadout poses={shown.poses} />}
  </section>;
}
