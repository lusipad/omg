import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, Boxes, ChevronDown, CircleDot, Download, Factory, GitBranch, Play, Save, Workflow } from "lucide-react";
import { nanoid } from "nanoid";
import { FACTORY_LIMITS, inspectFactoryLayout, parseFactoryLayout, type FactoryLayout, type FactoryResource } from "@contracts/factory";
import { deviceCompositionClosure } from "@contracts/device-composition";
import { applyFactoryStructureRevision, factoryStructureRoots } from "@contracts/factory-structure";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { MotorAxisLocation } from "@contracts/studio-navigation";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { runFactory, type FactoryRunResult } from "@/lib/factory-runtime";
import { contourTemplate } from "@/lib/cnc-contour-example";
import circularPocket from "../../public/assemblies/cnc-factory/circular-pocket.nc?raw";
import { downloadFile, downloadJson } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import FactoryEditor from "./FactoryEditor";
import FactoryPlayback from "./FactoryPlayback";

const DeviceCompositionView = lazy(() => import("./DeviceCompositionView"));
const MotorAxisBench = lazy(() => import("./MotorAxisBench"));
const CncContourBench = lazy(() => import("./CncContourBench"));
type Props = {
  workspace: TwinWorkspace; layout?: FactoryLayout; initialPackageKey?: string; initialStructureId?: string; trial?: boolean;
  initialMotorResourceId?: string; initialMotorAxisId?: string; initialMotorKey?: string;
  onMotorFocus?: (focus?: MotorAxisLocation) => void;
  initialContourId?: string; contourNote?: string; onContourFocus?: (id?: string) => void;
  onUpdateLibrary: (value: TwinWorkspace) => void;
  onSave: (value: FactoryLayout, revised?: TwinWorkspace) => void; onTrialReady?: (ready: boolean) => void; onImport?: () => void;
};
type Tab = "playback" | "devices" | "lines" | "structure" | "motor" | "contour";
type RunSpec = { layout: FactoryLayout; signature: string; basis: string };
type Request = RunSpec & { action: "run" | "export"; workspace: TwinWorkspace; save?: Props["onSave"] };
type Completed = RunSpec & { result: FactoryRunResult };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "工厂操作失败，请重试。";
const tabs = [
  { id: "playback", name: "工厂回放", icon: Factory }, { id: "devices", name: "设备布局", icon: Boxes },
  { id: "lines", name: "产线工序", icon: Workflow }, { id: "structure", name: "设备结构", icon: GitBranch },
  { id: "motor", name: "电机与轴", icon: Activity }, { id: "contour", name: "三轴加工", icon: CircleDot },
] as const;

function resourceFor(resources: FactoryResource[], pkg: DevicePackage, workspace: TwinWorkspace): FactoryResource {
  let n = 1;
  while (resources.some(r => r.id === "device-" + n)) n++;
  let name = pkg.model, suffix = 2;
  while (resources.some(r => r.name === name)) {
    const ending = " " + suffix++;
    name = pkg.model.slice(0, 160 - ending.length) + ending;
  }
  const key = packageKey(pkg), rows = workspace.catalog?.materials.filter(r => r.binding?.kind === "device" && r.binding.key === key);
  return { id: "device-" + n, name, packageKey: key, positionM: [((n - 1) % 5) * 3, Math.floor((n - 1) / 5) * 3],
    ...(rows?.length === 1 && { materialId: rows[0].id }) };
}

function inputs(workspace: TwinWorkspace, layout: FactoryLayout) {
  const keys = new Set(layout.resources.map(r => r.packageKey)), ids = new Set(layout.resources.map(r => r.materialId));
  const closure = deviceCompositionClosure(workspace.packages, [...keys].filter(Boolean));
  return JSON.stringify([closure.packages.map(p => [packageKey(p), p.factory, p.composition, p.mechanics?.kind === "assembly" && p.mechanics.assembly.nodes]),
    closure.missing,
    workspace.catalog?.materials.filter(row => ids.has(row.id)).map(row => [row.id, row.quantity, row.unit, row.binding])]);
}

function fresh(workspace: TwinWorkspace, saved?: FactoryLayout, initialPackageKey?: string, initialStructureId?: string, initialMotorResourceId?: string, initialContourId?: string) {
  const draft: FactoryLayout = saved ?? { schemaVersion: 1, kind: "factory-layout", id: "factory-" + nanoid(), name: "新工厂", resources: [], lines: [] };
  const initial = !saved && initialPackageKey ? workspace.packages.find(p => p.factory && packageKey(p) === initialPackageKey) : undefined;
  if (initial) draft.resources.push(resourceFor(draft.resources, initial, workspace));
  const seen = saved ? JSON.stringify(saved) : "";
  const contour = initialContourId && saved?.resources.some(resource => resource.id === initialContourId);
  const pending: Request | null = !contour && saved && !inspectFactoryLayout(workspace, saved).length
    ? { layout: saved, workspace, signature: seen, basis: inputs(workspace, saved), action: "run" } : null;
  const structure = initialStructureId && saved?.resources.some(resource => resource.id === initialStructureId);
  const motor = initialMotorResourceId && saved?.resources.some(resource => resource.id === initialMotorResourceId);
  return { draft, seen, initialPackageKey, submitted: "", tab: (contour ? "contour" : motor ? "motor" : structure ? "structure" : pending ? "playback" : "devices") as Tab, selected: draft.resources[0]?.id ?? "",
    request: pending, completed: null as Completed | null, error: "", notice: "" };
}

export default function FactoryBench({ workspace, layout, initialPackageKey, initialStructureId, initialMotorResourceId, initialMotorAxisId, initialMotorKey, initialContourId, contourNote, trial = false, onSave, onUpdateLibrary, onTrialReady, onMotorFocus, onContourFocus, onImport }: Props) {
  const [session, setSession] = useState(() => fresh(workspace, layout, initialPackageKey, initialStructureId, initialMotorResourceId, initialContourId));
  const [structureRoot, setStructureRoot] = useState(initialStructureId);
  const [editingStructure, setEditingStructure] = useState(false);
  const [motorTarget, setMotorTarget] = useState<{ resourceId?: string; axisId?: string }>({ resourceId: initialMotorResourceId, axisId: initialMotorAxisId });
  const [motorBusy, setMotorBusy] = useState(false);
  const [contourRoot, setContourRoot] = useState(initialContourId);
  const replacementSelect = useRef<HTMLSelectElement>(null), focusReplacement = useRef(false);
  const incoming = useMemo(() => layout ? JSON.stringify(layout) : "", [layout]);
  if (incoming !== session.seen || initialPackageKey !== session.initialPackageKey) {
    if (layout?.id === session.draft.id && incoming === session.submitted) setSession({ ...session, seen: incoming, submitted: "", initialPackageKey });
    else setSession(fresh(workspace, layout, initialPackageKey));
  }
  const { draft, tab } = session;
  const machining = tab === "motor" || tab === "contour";
  const contourResources = useMemo(() => {
    const installed = new Map(workspace.packages.map(p => [packageKey(p), p]));
    const templates = [...workspace.packages.filter(p => p.contour), contourTemplate];
    return draft.resources.filter(r => {
      const root = installed.get(r.packageKey);
      return root && (root.contour || templates.some(t => t.manufacturer === root.manufacturer && t.model === root.model));
    }).map(r => r.id);
  }, [draft.resources, workspace.packages]);
  const motorResources = useMemo(() => {
    const installed = new Map(workspace.packages.map(p => [packageKey(p), p]));
    return draft.resources.filter(r => installed.get(r.packageKey)?.axisPorts?.length).map(r => r.id);
  }, [draft.resources, workspace.packages]);
  const structureRoots = useMemo(() => factoryStructureRoots(draft), [draft]);
  const structureLines = useMemo(() => draft.lines.map(line => ({
    id: line.id, name: line.name, resourceIds: [...new Set(line.stages.flatMap(stage => [...stage.stations, ...stage.carriers]))],
  })), [draft.lines]);
  useLayoutEffect(() => {
    if (tab === "devices" && focusReplacement.current) {
      focusReplacement.current = false;
      replacementSelect.current?.focus();
    }
  }, [tab, session.selected]);
  const checked = useMemo(() => {
    try {
      const value = parseFactoryLayout(draft);
      return { value, signature: JSON.stringify(value), basis: inputs(workspace, value), issues: inspectFactoryLayout(workspace, value) };
    } catch (cause) { return { value: null, signature: "", basis: "", issues: [errorText(cause)] }; }
  }, [draft, workspace]);
  const pending = session.request;
  const job = pending && pending.workspace === workspace && pending.signature === checked.signature && pending.basis === checked.basis ? pending : null;
  if (session.seen === incoming && pending && !job) setSession({ ...session, request: null, completed: null, notice: "工程资料已变动，请重新运行。" });
  const prior = session.completed;
  const completed = prior && !checked.issues.length && prior.signature === checked.signature && prior.basis === checked.basis ? prior : null;
  const ready = !!checked.value && !checked.issues.length && checked.signature === incoming && !job && !session.error && !editingStructure && !(machining && motorBusy);
  useLayoutEffect(() => { if (trial) onTrialReady?.(ready); }, [trial, onTrialReady, ready]);

  useLayoutEffect(() => {
    if (!job) return;
    const controller = new AbortController(), { signal } = controller;
    async function execute(request: Request) {
      signal.throwIfAborted();
      if (request.action === "export") {
        const { exportFactoryModelica } = await import("@/lib/factory-export");
        signal.throwIfAborted();
        const file = await exportFactoryModelica(request.workspace, request.layout, signal);
        if (signal.aborted) return;
        downloadFile(file, request.layout.name + "-Modelica.zip");
        setSession(s => ({ ...s, request: null, notice: "已导出 Modelica 工程。" }));
        return;
      }
      const result = await runFactory(request.workspace, request.layout, signal);
      if (signal.aborted) return;
      request.save?.(request.layout);
      setSession(s => ({ ...s, request: null, completed: { layout: request.layout, signature: request.signature, basis: request.basis, result },
        submitted: request.save ? request.signature : "", tab: request.save ? "playback" : s.tab, error: "",
        notice: request.save && !trial ? "工厂已保存并完成仿真。" : "" }));
    }
    Promise.resolve().then(() => execute(job)).catch(cause => {
      if (!signal.aborted) setSession(s => ({ ...s, request: null, error: errorText(cause), notice: "" }));
    });
    return () => controller.abort();
  }, [job, trial]);

  function edit(next: FactoryLayout) {
    setSession(s => ({ ...s, draft: next, request: null, completed: null, submitted: "", notice: "", error: "" }));
  }
  function chooseTab(next: Tab, id?: string) {
    if (next === "structure") setStructureRoot(id);
    if (next === "contour" && id) setContourRoot(id);
    if (next === "playback" && machining && !completed && checked.value && !checked.issues.length) {
      setSession(s => ({ ...s, tab: next, request: { action: "run", layout: checked.value!, signature: checked.signature, basis: checked.basis, workspace } }));
      return;
    }
    setSession(s => ({ ...s, tab: next, selected: id ?? s.selected }));
  }
  function openMotor(resourceId: string, axisId?: string) {
    setMotorTarget({ resourceId, axisId });
    chooseTab("motor", resourceId);
  }
  function saveMachineChange(revised: TwinWorkspace, value: FactoryLayout) {
    if (value === draft) {
      onUpdateLibrary(revised);
      return;
    }
    const parsed = parseFactoryLayout(value), signature = JSON.stringify(parsed);
    onSave(parsed, revised);
    setSession(s => ({ ...s, draft: parsed, submitted: signature, request: null,
      completed: s.completed?.signature === signature ? s.completed : null, error: "", notice: "" }));
  }
  function applyStructure(id: string, revisions: TwinWorkspace, rootKey: string) {
    const original = draft.resources.find(r => r.id === id);
    if (!original) throw new Error("这个设备实例已移除。");
    const change = applyFactoryStructureRevision(workspace, draft, id, original.packageKey, revisions, rootKey);
    onSave(change.layout, change.workspace);
    const linked = change.layout.resources.find(r => r.id === id)!;
    const purchase = original.materialId && !linked.materialId ? " 原采购行仍绑定原修订，可在设备布局中另选匹配行。" : "";
    setSession(s => ({ ...s, draft: change.layout, submitted: JSON.stringify(change.layout), request: null, completed: null,
      tab: "structure", selected: id, error: "", notice: `已为“${original.name}”应用新修订，可重新运行工厂。${purchase}` }));
  }
  function act(action: "save" | "run" | "export") {
    const { value, signature, basis, issues } = checked;
    if (!value || (action !== "save" && issues.length)) return;
    if (action === "save") {
      try { onSave(value); setSession(s => ({ ...s, submitted: signature, error: "", notice: trial ? "已应用到试用工厂。" : "工厂布局已保存。" })); }
      catch (cause) { setSession(s => ({ ...s, error: errorText(cause), notice: "" })); }
      return;
    }
    setSession(s => ({ ...s, request: { action, layout: value, signature, basis, workspace, ...(action === "run" && { save: onSave }) },
      completed: action === "run" ? null : s.completed, error: "", notice: "" }));
  }
  const canRun = !!checked.value && !checked.issues.length;
  return <section aria-label="工厂搭建与仿真工作台" className="min-w-0 space-y-3">
    {!trial && tab === "playback" && <h2 className="display-title break-words text-xl font-semibold">{draft.name || "工厂"}</h2>}
    <div className="grid min-w-0 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
      <div className="flex max-w-full flex-wrap items-center gap-1" role="group" aria-label="工厂工作区视图">
        {tabs.filter(item => (item.id !== "motor" || motorResources.length || tab === "motor") && (item.id !== "contour" || contourResources.length || tab === "contour")).map(item => <Button key={item.id} type="button" size="sm" variant={tab === item.id ? "secondary" : "ghost"} aria-pressed={tab === item.id}
          disabled={editingStructure || (item.id === "playback" && !completed && !job && tab !== "playback" && !(machining && canRun))}
          onClick={() => chooseTab(item.id)}><item.icon className="hidden sm:block" />{item.name}</Button>)}
      </div>
      {!machining && <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" disabled={editingStructure}><Download className="hidden sm:block" />导出<ChevronDown className="size-3" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!checked.value} onSelect={() => { if (checked.value) downloadJson(checked.value, draft.name + ".factory.json"); }}>工厂定义 JSON</DropdownMenuItem>
            <DropdownMenuItem disabled={!canRun || !!job} onSelect={() => act("export")}>Modelica 工程 ZIP</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {tab !== "playback" && <Button type="button" size="sm" variant="outline" disabled={editingStructure || !checked.value || !!job || checked.signature === incoming}
          onClick={() => act("save")}><Save className="hidden sm:block" />{trial ? "应用到示例" : "保存布局"}</Button>}
        <Button type="button" size="sm" disabled={editingStructure || !canRun || !!job} onClick={() => act("run")}><Play />{trial ? "运行工厂" : "保存并运行"}</Button>
      </div>}
    </div>
    {job && <p role="status" className="text-sm text-primary">{job.action === "run" ? "正在计算整厂作业与运输时序…" : "正在准备 Modelica 工程…"}</p>}
    {session.error && <p role="alert" className="break-words text-sm text-destructive">{session.error}</p>}
    {session.notice && <p role="status" className="text-xs text-muted-foreground">{session.notice}</p>}
    {tab === "structure" && <Suspense fallback={<p role="status" className="p-4 text-sm">正在打开设备结构…</p>}>
      <DeviceCompositionView workspace={workspace} roots={structureRoots} lines={structureLines} initialRootId={structureRoot}
        onEditingChange={setEditingStructure} onApplyRevision={applyStructure} onOpenMotorAxis={openMotor} />
    </Suspense>}
    {tab === "motor" && <Suspense fallback={<p role="status" className="p-4 text-sm">正在打开电机组装与轴试跑…</p>}>
      <MotorAxisBench workspace={workspace} layout={draft} trial={trial} initialResourceId={motorTarget.resourceId} initialAxisId={motorTarget.axisId} initialMotorKey={initialMotorKey}
        onChange={saveMachineChange} onBusyChange={setMotorBusy} onFocusChange={onMotorFocus} onImport={trial ? undefined : onImport}
        contourResources={contourResources} onOpenContour={id => chooseTab("contour", id)} />
    </Suspense>}
    {tab === "contour" && <Suspense fallback={<p role="status" className="p-4 text-sm">正在打开三轴加工…</p>}>
      {contourNote && <p className="text-xs text-muted-foreground">{contourNote}</p>}
      <CncContourBench workspace={workspace} layout={draft} initialResourceId={contourRoot} trial={trial} defaultProgram={circularPocket}
        template={contourTemplate} onChange={saveMachineChange} onBusyChange={setMotorBusy} onFocusChange={onContourFocus} onOpenMotor={openMotor} />
    </Suspense>}
    {(tab === "devices" || tab === "lines") && <FactoryEditor draft={draft} workspace={workspace} selectedId={session.selected} tab={tab} onChange={edit} replacementRef={replacementSelect}
      onOpenStructure={id => chooseTab("structure", id)}
      onSelect={id => chooseTab("devices", id)} onImport={trial ? undefined : onImport} onAddResource={pkg => {
        if (draft.resources.length >= FACTORY_LIMITS.resources) return;
        const next = resourceFor(draft.resources, pkg, workspace); edit({ ...draft, resources: [...draft.resources, next] }); chooseTab("devices", next.id);
      }} />}
    {!machining && checked.issues.length > 0 && <details className="surface min-w-0 p-3 text-sm" open>
      <summary className="cursor-pointer font-medium">运行前待补全 {checked.issues.length} 项</summary>
      <ul className="mt-2 list-disc space-y-1 break-words pl-5 text-xs leading-5 text-amber-300">{checked.issues.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
    </details>}
    {completed && <div hidden={tab !== "playback"}><FactoryPlayback layout={completed.layout} result={completed.result} active={tab === "playback"}
      motorResourceIds={motorResources} onOpenMotor={openMotor}
      contourResourceIds={contourResources} onOpenContour={id => chooseTab("contour", id)}
      onOpenStructure={id => chooseTab("structure", id)}
      onEditResource={id => { focusReplacement.current = true; chooseTab("devices", id); }} /></div>}
    {tab === "playback" && !completed && !job && !session.error && canRun && <p className="surface p-4 text-sm text-muted-foreground">运行当前布局后可回放工件与设备。</p>}
  </section>;
}
