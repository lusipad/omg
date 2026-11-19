import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, FileCode2, Play, RotateCcw, Upload } from "lucide-react";
import { CONTOUR_AXES, mountContourMotors, resolveContourAxes, resolveContourMount, setContourProgram } from "@contracts/cnc-contour";
import { previewContourProgram } from "@contracts/contour-plan";
import { nextStructureRevision } from "@contracts/device-composition-edit";
import type { FactoryLayout, FactoryResource } from "@contracts/factory";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM } from "@contracts/milo-stock";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { decodeImportUtf8, GCODE_FILE_EXTENSIONS, IMPORT_TEXT_LIMITS, parseImportText } from "@contracts/workbench-import";
import { useCncProgramImport } from "@/hooks/useCncProgramImport";
import { runCncContour, type CncContourResult } from "@/lib/cnc-contour-runtime";
import { downloadFile } from "@/lib/download";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import CncContourResults from "./CncContourResults";

type Props = {
  workspace: TwinWorkspace; layout: FactoryLayout; initialResourceId?: string; trial?: boolean;
  defaultProgram: string; template?: DevicePackage; onChange: (workspace: TwinWorkspace, layout: FactoryLayout) => void;
  onBusyChange?: (blocked: boolean) => void; onFocusChange?: (resourceId?: string) => void;
  onOpenMotor?: (resourceId: string, axisId: string) => void;
};
type SessionProps = Omit<Props, "initialResourceId" | "onFocusChange"> & { resource: FactoryResource; root?: DevicePackage };
type Job = {
  action: "run" | "export" | "file";
  workspace: TwinWorkspace; layout: FactoryLayout; source: string; template?: DevicePackage;
  runWorkspace: TwinWorkspace; runLayout: FactoryLayout; signature: string; file?: File;
  save?: Props["onChange"];
};
type Axes = ReturnType<typeof resolveContourAxes>;
const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const identity = (p: DevicePackage) => `${p.model} · ${p.manufacturer} · 修订 ${p.revision}`;
const message = (e: unknown) => e instanceof Error ? e.message : "请核对装机与加工程序。";
const fileAccept = [...GCODE_FILE_EXTENSIONS.map(ext => "." + ext), ".txt"].join(",");

function inspect<T>(test: () => T): { value?: T; error?: string } {
  try { return { value: test() }; } catch (cause) { return { error: message(cause) }; }
}

function runSignature(axes: Axes, program: string) {
  return JSON.stringify([axes.resource.name, axes.resource.packageKey, axes.motorKey, axes.contour, axes.axes.map(a => [a.packagePath, a.parameters]), program]);
}

function MachiningSession({ workspace, layout, resource, root, template, defaultProgram, trial, onChange, onBusyChange, onOpenMotor }: SessionProps) {
  const saved = resource.contourRun?.program;
  const [draft, setDraft] = useState<{ from?: string; text: string }>();
  const program = draft && draft.from === saved ? draft.text : saved ?? defaultProgram;
  const dirty = program !== (saved ?? defaultProgram);
  const [choice, setChoice] = useState<string>();
  const [newRevision, setRevision] = useState<string>();
  const install = useMemo(() => inspect(() => resolveContourMount(workspace, layout, resource.id, template)), [workspace, layout, resource.id, template]);
  const full = useMemo(() => inspect(() => resolveContourAxes(workspace, layout, resource.id)), [workspace, layout, resource.id]);
  const mount = install.value, axes = full.value;
  const selected = choice ?? mount?.recommendedMotorKey ?? "";
  const motor = mount?.compatibleMotors.find(p => packageKey(p) === selected);
  const needsInstall = !axes || selected !== axes.motorKey;
  const revision = newRevision ?? (root ? nextStructureRevision(workspace, resource.packageKey) : "");
  const plan = useMemo(() => mount ? inspect(() => previewContourProgram(program, mount.contour)) : {}, [program, mount]);
  const usableProgram = !!plan.value?.segments.length;
  const signature = useMemo(() => axes ? runSignature(axes, program) : "", [axes, program]);
  const [assembling, setAssembling] = useState(needsInstall);
  const [editing, setEditing] = useState(!usableProgram && !!mount);
  const [outcome, setOutcome] = useState<{ signature: string; result: CncContourResult } | null>(null);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState<Job | null>(() => signature && usableProgram && !needsInstall && saved !== undefined
    ? { action: "run", workspace, layout, source: program, template, runWorkspace: workspace, runLayout: layout, signature } : null);
  const job = request?.workspace === workspace && request.layout === layout && request.source === program && request.template === template ? request : null;
  if (request && !job) setRequest(null);
  const activeResult = !needsInstall && outcome?.signature === signature ? outcome.result : undefined;
  const blocked = !!job || dirty || (choice !== undefined && needsInstall) || newRevision !== undefined;
  useLayoutEffect(() => {
    onBusyChange?.(blocked);
    return () => { if (blocked) onBusyChange?.(false); };
  }, [onBusyChange, blocked]);

  useLayoutEffect(() => {
    if (!job) return;
    const controller = new AbortController(), { signal } = controller;
    async function execute(task: Job) {
      signal.throwIfAborted();
      if (task.action === "file") {
        const file = task.file!;
        if (file.size > IMPORT_TEXT_LIMITS.gcodeFileBytes) throw new Error("G 代码文件超过 65,536 个字符的容量。");
        const text = decodeImportUtf8(await file.arrayBuffer());
        signal.throwIfAborted();
        const nc = parseImportText(text, file.name, { hint: "gcode" });
        if (nc.kind !== "gcode") throw new Error("请选择 UTF-8 编码的 G 代码程序。");
        setDraft({ from: saved, text: nc.program }); setEditing(true);
        setNotice(`已载入 ${file.name}，可核对后运行。`);
      } else if (task.action === "export") {
        const { exportCncContour } = await import("@/lib/cnc-contour-export");
        const blob = await exportCncContour(task.runWorkspace, task.runLayout, resource.id, task.source, signal);
        signal.throwIfAborted();
        downloadFile(blob, resource.name + "-三轴加工-Modelica.zip");
        setNotice("已导出当前三轴装机、程序与原生模型。");
      } else {
        const result = await runCncContour(task.runWorkspace, task.runLayout, resource.id, task.source, signal);
        signal.throwIfAborted();
        task.save?.(task.runWorkspace, task.runLayout);
        setDraft(undefined); setChoice(undefined); setRevision(undefined);
        setOutcome({ signature: task.signature, result });
        setAssembling(false); setEditing(false);
      }
      setRequest(null);
    }
    Promise.resolve().then(() => execute(job)).catch(cause => {
      if (!signal.aborted) { setError(message(cause)); setRequest(null); }
    });
    return () => controller.abort();
  }, [job, resource.id, resource.name, saved]);

  function resetFeedback() { setRequest(null); setNotice(""); setError(""); }
  function changeProgram(text: string) {
    resetFeedback(); setOutcome(null); setDraft({ from: saved, text });
  }
  useCncProgramImport(mount ? resource.name : undefined, text => { changeProgram(text); setEditing(true); });
  function start(run: boolean) {
    resetFeedback();
    try {
      if (!mount || !selected) throw new Error("请先选择库中已组装且与三轴兼容的电机修订。");
      const next = needsInstall ? mountContourMotors(workspace, layout, resource.id, selected, revision, template) : { workspace, layout };
      if (!run) {
        onChange(next.workspace, next.layout);
        setChoice(undefined); setRevision(undefined); setOutcome(null);
        setAssembling(false); setNotice(`已将 ${identity(motor!)} 安装到 ${resource.name} 的 X、Y、Z 三个位置。`); return;
      }
      if (!usableProgram) throw new Error(plan.error ?? "程序需要至少一段进给位移。");
      const runLayout = saved === program ? next.layout : setContourProgram(next.layout, resource.id, program);
      const resolved = resolveContourAxes(next.workspace, runLayout, resource.id);
      setOutcome(null);
      setRequest({ action: "run", workspace, layout, source: program, template, runWorkspace: next.workspace, runLayout,
        signature: runSignature(resolved, program), save: (runLayout !== layout || next.workspace !== workspace) ? onChange : undefined });
    } catch (cause) { setError(message(cause)); }
  }
  function saveProgram() {
    resetFeedback();
    try {
      onChange(workspace, setContourProgram(layout, resource.id, program)); setDraft(undefined);
      setNotice(trial ? "已将程序保存到试用工厂。" : "已保存当前程序。");
    } catch (cause) { setError(message(cause)); }
  }
  const busy = !!job;
  const canInstall = !!mount && !!motor && (!needsInstall || !!revision.trim());
  const segments = plan.value?.segments, arcs = segments?.filter(s => s.arc).length;
  const minZ = segments?.length ? segments.reduce((z, s) => Math.min(z, s.startMm[2], s.endMm[2]), Infinity) : undefined;
  return <>
    <section className="surface min-w-0 space-y-3 p-3 sm:p-4" aria-label="三轴装机与加工程序">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all text-sm font-medium">{axes ? `X、Y、Z 各装一台 · ${identity(axes.motor)}` : "三轴电机安装位"}</p>
          {segments?.length ? <p className="mt-1 text-xs text-muted-foreground">{segments.length} 个运动段 · {arcs} 段圆弧 · 指令时长 {plan.value!.durationS.toFixed(2)} s</p> : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={assembling ? "secondary" : "outline"} type="button" aria-expanded={assembling}
            onClick={() => setAssembling(!assembling)}>三轴装机</Button>
          <Button size="sm" variant={editing ? "secondary" : "outline"} type="button" aria-expanded={editing}
            onClick={() => setEditing(!editing)}><FileCode2/>编辑 G 代码</Button>
          <Button size="sm" type="button" disabled={busy || !canInstall || !usableProgram} onClick={() => start(true)}>
            <Play/>{needsInstall ? "装入三轴并运行" : "运行 G 代码"}
          </Button>
          {activeResult && <Button size="sm" type="button" variant="outline" aria-label="导出三轴 Modelica ZIP" disabled={busy} onClick={() => {
            resetFeedback(); setRequest({ action: "export", workspace, layout, source: program, template, runWorkspace: workspace, runLayout: layout, signature });
          }}><Download/><span className="sm:hidden">Modelica ZIP</span><span className="hidden sm:inline">导出三轴 Modelica ZIP</span></Button>}
        </div>
      </div>
      {assembling && <div className="space-y-3 border-t pt-3">
        {mount && <>
          <div className="grid min-w-0 gap-2 sm:grid-cols-3">{mount.mounts.map((m, i) => <div key={m.port.id} className="surface-inset min-w-0 p-2.5">
            <h4 className="text-xs font-semibold">{CONTOUR_AXES[i].toUpperCase()} 轴{m.port.name !== CONTOUR_AXES[i].toUpperCase() + " 轴" && " · " + m.port.name}</h4>
            <p className="mt-1 break-all text-sm">{m.motor ? identity(m.motor) : "缺少被引用的电机"}</p>
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{m.installedPath.join(" / ")}</p>
            <p className="mt-1 text-xs text-muted-foreground">导程 {m.port.leadMmPerRev} mm/rev · 移动质量 {m.port.tableMassKg} kg</p>
          </div>)}</div>
          {mount.requiresUpgrade && <p className="text-xs text-amber-300">本次装机将依据 {template ? identity(template) : "匹配的机床资料"} 补齐三轴安装位。</p>}
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="min-w-[min(100%,13rem)] flex-1"><span className="field-label">三轴共用电机型号与修订</span>
              <select className={selectClass} disabled={!mount.compatibleMotors.length} value={selected} onChange={e => {
                resetFeedback(); setChoice(e.target.value); setRevision(undefined);
              }}>
                <option value="">{mount.compatibleMotors.length ? "请选择要安装的电机" : "尚无兼容的已组装电机"}</option>
                {mount.compatibleMotors.map(p => <option key={packageKey(p)} value={packageKey(p)}>{identity(p)}</option>)}
              </select></label>
            <label className="min-w-0"><span className="field-label">机床新修订</span><Input disabled={!needsInstall || !motor} maxLength={160} value={revision}
              onChange={e => { resetFeedback(); setRevision(e.target.value); }} /></label>
            <Button size="sm" type="button" variant="outline" disabled={busy || !canInstall || !needsInstall} onClick={() => start(false)}>安装到 X、Y、Z</Button>
          </div>
          {!selected && mount.compatibleMotors.length > 1 && <p className="text-xs text-amber-300">X 轴没有可沿用的已建模电机，请从多个兼容修订中指定一个。</p>}
          {!mount.compatibleMotors.length && <p className="text-xs text-muted-foreground">请先在「电机与轴」中用定子、转子和轴承组装电机，或从设备库导入已组装的电机。</p>}
          {onOpenMotor && <Button variant="ghost" size="sm" type="button" onClick={() => onOpenMotor(resource.id, mount.ports[0].id)}>打开 X 轴电机工作台</Button>}
          {(choice !== undefined || newRevision !== undefined) && <button type="button" className="ml-2 text-xs text-primary underline" onClick={() => {
            resetFeedback(); setChoice(undefined); setRevision(undefined);
          }}>取消待装设置</button>}
        </>}
        {install.error && <p role="alert" className="whitespace-pre-line break-all text-sm text-destructive">{install.error}</p>}
        {mount && !mount.requiresUpgrade && mount.mounts.every(m => m.motorKey === mount.mounts[0].motorKey) && full.error &&
          <p role="alert" className="break-words text-sm text-destructive">{full.error}</p>}
      </div>}
      {editing && <div className="min-w-0 space-y-2 border-t pt-3">
        <label className="block min-w-0"><span className="field-label">加工程序（G 代码）</span>
          <Textarea className="mono h-52 min-w-0 resize-y field-sizing-fixed text-xs leading-5" wrap="off" spellCheck={false}
            value={program} onChange={e => changeProgram(e.target.value)} /></label>
        <div className="flex flex-wrap gap-1.5">
          <input ref={fileInput} aria-label="导入 CNC 加工程序文件" className="hidden" type="file" accept={fileAccept} onChange={e => {
            const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
            resetFeedback(); setOutcome(null); setRequest({ action: "file", workspace, layout, source: program, template, runWorkspace: workspace, runLayout: layout, signature, file });
          }} />
          <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}><Upload/>导入 G 代码</Button>
          <Button type="button" size="sm" variant="ghost" disabled={program === defaultProgram} onClick={() => changeProgram(defaultProgram)}><RotateCcw/>恢复圆槽程序</Button>
          {dirty && <><Button type="button" size="sm" variant="outline" disabled={busy || !usableProgram} onClick={saveProgram}>保存程序</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { resetFeedback(); setDraft(undefined); }}>放弃程序改动</Button></>}
        </div>
        {mount && <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p>工件初始刀尖 ({mount.contour.initialWorkMm.join(", ")}) mm，工件原点位于机床 ({mount.contour.workOriginMachineMm.join(", ")}) mm。工件坐标行程 {CONTOUR_AXES.map((axis, i) => `${axis.toUpperCase()} ${mount.contour.minMm[i] - mount.contour.workOriginMachineMm[i]}…${mount.contour.maxMm[i] - mount.contour.workOriginMachineMm[i]}`).join(" / ")} mm。</p>
          <p>毛坯 {MILO_STOCK.widthMm} × {MILO_STOCK.heightMm} × {MILO_STOCK.thicknessMm} mm，顶面 Z0，平底刀 Ø{MILO_TOOL_DIAMETER_MM} mm。{minZ !== undefined && `程序最低 Z ${minZ} mm。`}Z 轴采用理想重力平衡。</p>
        </div>}
      </div>}
      {mount && !usableProgram && <p role="alert" className="break-words text-xs text-destructive">{plan.error ?? "加工程序需要至少一段有效位移。"}</p>}
      {job && <p role="status" className="flex items-center gap-2 text-xs text-primary">{job.action === "run" ? "正在求解三轴反馈与刀尖轨迹…" : job.action === "export" ? "正在导出三轴原生工程…" : "正在读取程序文件…"}
        <button type="button" className="underline" onClick={() => { resetFeedback(); setNotice("已取消。"); }}>取消</button></p>}
      {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="break-words text-xs text-muted-foreground">{notice}</p>}
    </section>
    {activeResult && <CncContourResults key={signature} result={activeResult} />}
  </>;
}

export default function CncContourBench({ initialResourceId, onFocusChange, ...props }: Props) {
  const { workspace, layout, template } = props;
  const [picked, setPicked] = useState(initialResourceId ?? ""), [templateKey, setTemplateKey] = useState<string>();
  const catalog = useMemo(() => new Map(workspace.packages.map(p => [packageKey(p), p])), [workspace.packages]);
  const candidates = useMemo(() => [...workspace.packages, ...(template && !catalog.has(packageKey(template)) ? [template] : [])].filter(p => p.contour), [workspace.packages, template, catalog]);
  const matching = (p?: DevicePackage) => candidates.filter(t => p?.manufacturer === t.manufacturer && p?.model === t.model);
  const machines = layout.resources.filter(r => {
    const p = catalog.get(r.packageKey);
    return !!p?.contour || !!matching(p).length || r.id === initialResourceId;
  });
  const resource = machines.find(r => r.id === picked) ?? machines[0], resourceId = resource?.id;
  const root = resource && catalog.get(resource.packageKey);
  const options = matching(root), supplied = template && options.find(p => packageKey(p) === packageKey(template));
  const selectedTemplate = root?.contour ? undefined : templateKey !== undefined ? options.find(p => packageKey(p) === templateKey) : supplied ?? (options.length === 1 ? options[0] : undefined);
  useLayoutEffect(() => {
    onFocusChange?.(resourceId);
    return () => onFocusChange?.(undefined);
  }, [resourceId, onFocusChange]);
  return <section className="min-w-0 space-y-3" aria-label="数控三轴联动加工">
    <div className="surface flex min-w-0 flex-wrap items-end gap-3 p-3 sm:p-4">
      <label className="min-w-[min(100%,12rem)] flex-1"><span className="field-label">加工机床</span>
        <select className={selectClass} value={resourceId ?? ""} disabled={!machines.length} onChange={e => { setPicked(e.target.value); setTemplateKey(undefined); }}>
          {!machines.length && <option value="">当前工厂没有三轴加工定义</option>}
          {machines.map(r => <option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}
        </select></label>
      {root && <p className="min-w-0 grow break-all pb-1 text-xs text-muted-foreground">{identity(root)}</p>}
      {root && !root.contour && options.length > 1 && <label className="min-w-0 flex-1"><span className="field-label">三轴安装定义</span>
        <select className={selectClass} value={selectedTemplate ? packageKey(selectedTemplate) : ""} onChange={e => setTemplateKey(e.target.value)}>
          <option value="">请选择对应机床的三轴资料</option>{options.map(p => <option key={packageKey(p)} value={packageKey(p)}>{identity(p)}</option>)}
        </select></label>}
    </div>
    {resource ? <MachiningSession key={JSON.stringify([layout.id, resource.id])}
      {...props} resource={resource} root={root} template={selectedTemplate} /> : <p className="surface p-4 text-sm">在设备布局中安装已声明 X、Y、Z 槽位与行程的机床后，即可编排三轴程序。</p>}
  </section>;
}
