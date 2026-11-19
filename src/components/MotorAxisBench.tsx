import { useLayoutEffect, useMemo, useState } from "react";
import { Download, PackagePlus, Play, Upload } from "lucide-react";
import { nextStructureRevision } from "@contracts/device-composition-edit";
import { type FactoryLayout, type FactoryResource } from "@contracts/factory";
import { factoryMotorMount, installMotorOnFactoryAxis, resolveMotorAxis, setMotorAxisTarget } from "@contracts/motor-assembly";
import { SERVO_AXIS_MODEL } from "@contracts/servo-axis";
import type { MotorAxisLocation } from "@contracts/studio-navigation";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { installPackage, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportDeviceLibrary } from "@/lib/device-library";
import { downloadFile, downloadJson } from "@/lib/download";
import { runMotorAxis, type MotorAxisResult } from "@/lib/modelica-motor-runtime";
import MotorAssemblyForm from "./MotorAssemblyForm";
import MotorAxisResponse from "./MotorAxisResponse";

type Props = {
  workspace: TwinWorkspace; layout: FactoryLayout; initialResourceId?: string; initialAxisId?: string;
  initialMotorKey?: string; trial?: boolean; onChange: (workspace: TwinWorkspace, layout: FactoryLayout) => void;
  onBusyChange?: (blocked: boolean) => void; onImport?: () => void;
  onFocusChange?: (focus?: MotorAxisLocation) => void;
};
type Port = NonNullable<DevicePackage["axisPorts"]>[number];
type Request = { action: "restore" | "run" | "export"; workspace: TwinWorkspace; layout: FactoryLayout; signature: string; target: number; save?: Props["onChange"] };
type SessionProps = Pick<Props, "workspace" | "layout" | "onChange" | "onBusyChange" | "trial" | "initialMotorKey" | "onImport"> & {
  resource: FactoryResource; port: Port;
};
const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作失败，请核对设备资料后重试。";
const identity = (part: DevicePackage) => part.model + " · 修订 " + part.revision;
const finiteNumber = (value: string) => value.trim() ? Number(value) : NaN;

function AxisSession({ workspace, layout, resource, port, initialMotorKey, onChange, onBusyChange, onImport, trial }: SessionProps) {
  const checkpoint = resource.axisTargetsMm?.[port.id], savedTarget = checkpoint ?? 10;
  const [pendingMotor, setPendingMotor] = useState<string | undefined>(initialMotorKey);
  const [revision, setRevision] = useState<string>();
  const [targetText, setTargetText] = useState<string>();
  const [assemblyDirty, setAssemblyDirty] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [outcome, setOutcome] = useState<{ signature: string; result: MotorAxisResult } | null>(null);
  const mount = useMemo(() => {
    try { return { value: factoryMotorMount(workspace, layout, resource.id, port.id), error: "" }; }
    catch (cause) { return { error: message(cause) }; }
  }, [workspace, layout, resource.id, port.id]);
  const motors = workspace.packages.filter(p => p.motorPhysics?.kind === "motor" && p.motorPhysics.fit === port.fit);
  const installed = mount.value?.motor, installedKey = mount.value?.motorKey;
  const installedMotor = installed?.motorPhysics?.kind === "motor" ? installed : undefined;
  const selectedKey = pendingMotor ?? (installedMotor ? installedKey : undefined) ?? (motors[0] && packageKey(motors[0])) ?? "";
  const proposed = motors.find(p => packageKey(p) === selectedKey);
  const differentMotor = pendingMotor !== undefined && pendingMotor !== installedKey;
  const [building, setBuilding] = useState(() => !motors.length);
  const rootRevision = revision ?? (mount.value ? nextStructureRevision(workspace, resource.packageKey) : "");
  const target = targetText ?? String(savedTarget), targetMm = finiteNumber(target);
  const bound = useMemo(() => {
    if (!installedMotor) return { error: "" };
    if (!Number.isFinite(targetMm)) return { error: "请填写有限的毫米目标。" };
    try { return { value: resolveMotorAxis(workspace, layout, resource.id, port.id, targetMm), error: "" }; }
    catch (cause) { return { error: message(cause) }; }
  }, [installedMotor, layout, port.id, resource.id, targetMm, workspace]);
  const signature = bound.value ? JSON.stringify([resource.packageKey, installedKey, port, bound.value.parameters, bound.value.sources]) : "";
  const [request, setRequest] = useState<Request | null>(() =>
    signature && checkpoint !== undefined && !differentMotor
      ? { action: "restore", workspace, layout, signature, target: targetMm } : null);
  const job = request?.workspace === workspace && request.layout === layout && request.signature === signature && !differentMotor ? request : null;
  if (request && !job) setRequest(null);
  const blocked = !!job || assemblyDirty || differentMotor || (targetText !== undefined && targetMm !== savedTarget);
  useLayoutEffect(() => {
    onBusyChange?.(blocked);
    return () => { if (blocked) onBusyChange?.(false); };
  }, [blocked, onBusyChange]);
  useLayoutEffect(() => {
    if (!job) return;
    const controller = new AbortController();
    async function execute(task: Request) {
      const signal = controller.signal;
      signal.throwIfAborted();
      if (task.action === "export") {
        const { exportMotorAxis } = await import("@/lib/motor-axis-export");
        const file = await exportMotorAxis(task.workspace, task.layout, resource.id, port.id, task.target, signal);
        signal.throwIfAborted();
        downloadFile(file, resource.name + "-" + port.name + "-Modelica.zip");
        setNotice("已导出当前装机参数和原生模型。");
      } else {
        const result = await runMotorAxis(task.workspace, task.layout, resource.id, port.id, task.target, signal);
        signal.throwIfAborted();
        if (!result.samples.length) throw new Error("求解器没有返回采样，请核对轴工况。");
        if (task.save && task.target !== checkpoint) {
          task.save(task.workspace, setMotorAxisTarget(task.layout, resource.id, port.id, task.target));
        }
        setTargetText(undefined);
        setOutcome({ signature: task.signature, result });
      }
      setRequest(null);
    }
    Promise.resolve().then(() => execute(job)).catch(cause => {
      if (!controller.signal.aborted) { setError(message(cause)); setRequest(null); }
    });
    return () => controller.abort();
  }, [job, checkpoint, port.id, port.name, resource.id, resource.name]);

  function clearFeedback() { setError(""); setNotice(""); setRequest(null); }
  function keepMotor(device: DevicePackage) {
    const next = installPackage(workspace, device);
    onChange(next, layout);
    setPendingMotor(packageKey(device));
    setBuilding(false); setAssemblyDirty(false);
    clearFeedback(); setOutcome(null); setRevision(undefined);
    setNotice(`${identity(device)} 已保存到${trial ? "试用设备库" : "设备库"}。`);
  }
  function install() {
    clearFeedback();
    if (!proposed || !mount.value || selectedKey === installedKey) return;
    try {
      const change = installMotorOnFactoryAxis(workspace, layout, resource.id, port.id, selectedKey, rootRevision);
      onChange(change.workspace, change.layout);
      setPendingMotor(undefined); setRevision(undefined); setTargetText(undefined); setOutcome(null);
      setNotice(`${identity(proposed)} 已装到 ${resource.name} 的${port.name}，机床新修订 ${rootRevision}。`);
    } catch (cause) { setError(message(cause)); }
  }
  function issue(action: "run" | "export") {
    clearFeedback();
    if (!bound.value || assemblyDirty || differentMotor) return;
    if (action === "run") setOutcome(null);
    setRequest({ action, workspace, layout, signature, target: targetMm, ...(action === "run" && { save: onChange }) });
  }
  const trace = !differentMotor && !assemblyDirty && outcome?.signature === signature ? outcome.result : null;
  return <>
    <section className="surface min-w-0 space-y-3 p-3 sm:p-5" aria-label="电机选件与安装">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">电机装配</h3>
        <div className="flex flex-wrap items-center gap-1">
          {onImport && <Button type="button" size="sm" variant="ghost" onClick={onImport}>导入设备包</Button>}
          <Button type="button" size="sm" aria-expanded={building} variant="outline"
            onClick={() => { clearFeedback(); setBuilding(!building); setAssemblyDirty(false); }}>
            <PackagePlus />{building ? (assemblyDirty ? "取消本次组装" : "收起选件") : "从零件组装电机"}
          </Button>
        </div>
      </header>
      {building && <div className="border-b pb-3"><MotorAssemblyForm workspace={workspace} preferredFit={port.fit}
        submitLabel="组装并存入设备库" onBuild={keepMotor} onDirtyChange={setAssemblyDirty} /></div>}
      <div className="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(9rem,.5fr)_auto]">
        <label className="min-w-0"><span className="field-label">待装电机</span>
          <select className={selectClass} disabled={!motors.length} value={proposed ? selectedKey : ""} onChange={e => {
            clearFeedback(); setPendingMotor(e.target.value); setRevision(undefined);
          }}>
            {!proposed && <option value="">{motors.length ? "请选择兼容电机" : "请先组装或导入电机"}</option>}
            {motors.map(p => <option key={packageKey(p)} value={packageKey(p)}>{identity(p)} · {p.manufacturer}</option>)}
          </select>
        </label>
        <label className="min-w-0"><span className="field-label">机床新修订</span>
          <Input maxLength={160} value={rootRevision} disabled={!proposed || selectedKey === installedKey} onChange={e => { clearFeedback(); setRevision(e.target.value); }} />
        </label>
        <Button type="button" variant="outline" disabled={!mount.value || !proposed || selectedKey === installedKey || !rootRevision.trim() || !!job || assemblyDirty} onClick={install}>装到当前轴</Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <p className="min-w-0 break-all">当前安装 · {installed ? identity(installed) : installedKey || "待确定"} · {mount.value?.installedPath.join(" / ") ?? [...port.path, port.motorSlot].join(" / ")}</p>
        {proposed && <button type="button" className="inline-flex items-center gap-1 text-primary underline underline-offset-2" onClick={() => {
          try { downloadJson(exportDeviceLibrary(workspace.packages, selectedKey), proposed.model + "-" + proposed.revision + "-电机设备库.json"); }
          catch (cause) { setError(message(cause)); }
        }}><Download size={13} />下载电机和子件</button>}
        {differentMotor && <button type="button" className="text-primary underline underline-offset-2" onClick={() => {
          clearFeedback(); setPendingMotor(undefined); setRevision(undefined);
        }}>取消待装选择</button>}
      </div>
      {mount.error && <p role="alert" className="whitespace-pre-line break-words text-xs text-destructive">{mount.error}</p>}
      {pendingMotor && !proposed && <p role="alert" className="text-xs text-amber-300">所选电机不在当前 {port.fit} 配合清单中，请切换安装位或改选电机。</p>}
      {!mount.error && !installedMotor && <p className="text-xs leading-5 text-muted-foreground">选定电机并装入此轴后，即可输入毫米指令计算响应。</p>}
    </section>
    {installedMotor && <section className="surface min-w-0 space-y-3 p-3 sm:p-5" aria-label="已装轴位置指令">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="min-w-0 grow sm:max-w-64"><span className="field-label">目标位移（mm）</span>
          <Input className="mono" type="number" step="any" value={target} onChange={e => {
            clearFeedback(); setTargetText(e.target.value); setOutcome(null);
          }} />
        </label>
        <Button type="button" disabled={!bound.value || assemblyDirty || differentMotor || !!job} onClick={() => issue("run")}><Play />运行位置指令</Button>
        {trace && <Button type="button" variant="outline" size="sm" disabled={!!job} onClick={() => issue("export")}><Download />导出轴 Modelica ZIP</Button>}
        {targetText !== undefined && targetMm !== savedTarget && <button type="button" className="text-xs text-primary underline" onClick={() => {
          clearFeedback(); setTargetText(undefined); setOutcome(null);
        }}>还原目标</button>}
      </div>
      {differentMotor && <p className="text-xs text-muted-foreground">请先装入所选电机，或取消待装选择以运行当前配置。</p>}
      <details className="min-w-0 border-t pt-2 text-xs leading-5 text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">装机参数与模型假设</summary>
        <p className="mt-2 break-all">{port.modelRef.id} @ {port.modelRef.version} · {port.fit}</p>
        <p>丝杠 {port.leadMmPerRev} mm/转 · 移动质量 {port.tableMassKg} kg · 电压上限 {port.driveVoltageLimitV} V · 电流指令上限 {port.driveCurrentLimitA} A。</p>
        <p>转速指令上限 {port.driveSpeedLimitRpm} rpm · 控制参考惯量 {port.driveReferenceInertiaKgM2} kg·m² · 电流环比例增益 {port.currentGainOhm} Ω。</p>
        <p className="break-words">{port.source}</p>
        {bound.value && <dl aria-label="实装电机物理参数" className="my-2 grid gap-2 border-y py-2 sm:grid-cols-3">
          <div className="min-w-0 break-words"><dt className="font-medium text-foreground">定子 · {identity(bound.value.stator)}</dt>
            <dd>每相电阻 {bound.value.parameters.phaseResistanceOhm} Ω，q 轴电感 {bound.value.parameters.qInductanceH} H。</dd>
            <dd>串联 {bound.value.parameters.windingTurns} 匝，绕组系数 {bound.value.parameters.windingFactor}，峰值电流指令上限 {bound.value.parameters.windingCurrentLimitA} A。</dd>
          </div>
          <div className="min-w-0 break-words"><dt className="font-medium text-foreground">转子 · {identity(bound.value.rotor)}</dt>
            <dd>{bound.value.parameters.polePairs} 对极，每极基波磁通 {bound.value.parameters.rotorFluxWb} Wb。</dd>
            <dd>转动惯量 {bound.value.parameters.rotorInertiaKgM2} kg·m²。</dd>
          </div>
          <div className="min-w-0 break-words"><dt className="font-medium text-foreground">轴承 · {identity(bound.value.bearing)} × {bound.value.parameters.bearingCount}</dt>
            <dd>单只粘滞系数 {bound.value.parameters.bearingViscousNmS} N·m·s/rad。</dd>
          </div>
        </dl>}
        <p>水平刚性丝杠由永磁同步电机驱动，d 轴电流设为零。轴承按粘滞阻力计算，位置和转速反馈采用理想测量。每次阶跃从静止零位起步。</p>
        <p>电机角度误差在 ±{SERVO_AXIS_MODEL.positionToleranceDeg}° 内、转速在 ±{SERVO_AXIS_MODEL.speedToleranceRpm} rpm 内连续保持 {SERVO_AXIS_MODEL.settleHoldMs} ms 即判为到位。每 {SERVO_AXIS_MODEL.samplePeriodMs} ms 采样并保留终点，最长观察 {SERVO_AXIS_MODEL.maxTimeMs / 1000} s。</p>
      </details>
      {bound.error && <p role="alert" className="whitespace-pre-line break-words text-xs text-destructive">{bound.error}</p>}
    </section>}
    {(notice || job) && <p role="status" className="break-words text-xs text-primary">{job ? (job.action === "export" ? "正在准备原生轴工程…" : "正在计算已装电机的轴响应…") : notice}</p>}
    {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
    {trace && installedMotor && <MotorAxisResponse key={signature} result={trace} targetMm={targetMm} name={resource.name + " · " + port.name}
      leadMmPerRev={port.leadMmPerRev} motorName={identity(installedMotor)} />}
  </>;
}

export default function MotorAxisBench({ workspace, layout, initialResourceId, initialAxisId, initialMotorKey, trial, onChange, onBusyChange, onFocusChange, onImport }: Props) {
  const packages = useMemo(() => new Map(workspace.packages.map(p => [packageKey(p), p])), [workspace.packages]);
  const eligible = layout.resources.filter(r => packages.get(r.packageKey)?.axisPorts?.length);
  const [picked, setPicked] = useState(initialResourceId ?? ""), [axisId, setAxisId] = useState(initialAxisId ?? "");
  const resource = eligible.find(r => r.id === picked) ?? eligible[0];
  const root = resource && packages.get(resource.packageKey);
  const port = root?.axisPorts?.find(a => a.id === axisId) ?? root?.axisPorts?.[0];
  const activeResource = resource?.id, activeAxis = port?.id;
  useLayoutEffect(() => {
    onFocusChange?.(activeResource && activeAxis ? { resourceId: activeResource, axisId: activeAxis } : undefined);
    return () => onFocusChange?.(undefined);
  }, [activeResource, activeAxis, onFocusChange]);
  return <section className="min-w-0 space-y-3" aria-label="伺服电机与进给轴试验">
    <div className="surface min-w-0 space-y-2 p-3 sm:p-5">
      <h2 className="text-base font-semibold">轴安装位</h2>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="min-w-0"><span className="field-label">机床实例</span>
          <select className={selectClass} value={resource?.id ?? ""} disabled={!resource} onChange={e => { setPicked(e.target.value); setAxisId(""); }}>
            {!resource && <option value="">没有声明电机安装位的机床</option>}
            {eligible.map(r => <option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}
          </select></label>
        <label className="min-w-0"><span className="field-label">试验轴</span>
          <select className={selectClass} value={port?.id ?? ""} disabled={!port} onChange={e => setAxisId(e.target.value)}>
            {!port && <option value="">待安装</option>}
            {root?.axisPorts?.map(a => <option value={a.id} key={a.id}>{a.name} · {a.id}</option>)}
          </select></label>
      </div>
      {root && port && <p className="min-w-0 break-all text-xs text-muted-foreground">
        {identity(root)} · {port.fit} · 安装槽 {[...port.path, port.motorSlot].join(" / ")}
      </p>}
    </div>
    {resource && port ? <AxisSession key={JSON.stringify([resource.id, port.id, initialMotorKey])} workspace={workspace} layout={layout}
      resource={resource} port={port} initialMotorKey={initialMotorKey} trial={trial} onChange={onChange} onBusyChange={onBusyChange} onImport={onImport} />
      : <div className="surface min-w-0 space-y-2 p-4 text-sm">
        <p>请在设备布局放置带电机安装位的机床修订，再将电机连接到指定轴。</p>
        {onImport && <Button size="sm" variant="outline" onClick={onImport}><Upload />导入机床或部件设备包</Button>}
      </div>}
  </section>;
}
