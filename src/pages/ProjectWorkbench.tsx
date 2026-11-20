import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Boxes,
  Braces,
  Check,
  ChevronRight,
  CirclePlus,
  FileClock,
  FileJson,
  GitCommitHorizontal,
  History,
  Layers3,
  PackagePlus,
  Save,
  Sheet as SheetIcon,
  ShieldCheck,
  Trash2,
  Workflow,
} from "lucide-react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import ProductLayout from "@/components/ProductLayout";
import ProjectTodoPanel from "@/components/ProjectTodoPanel";
import StatusBadge from "@/components/StatusBadge";
const ModuleScene = lazy(() => import("@/components/ModuleScene"));
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/providers/trpc";
import { calculateModule, MODULE_KEYS, type CalculationResult, type ModuleKey } from "@contracts/engineering";
import { defaultConfiguration, MODULE_COMPONENT_ROLES, type ModuleField } from "@contracts/module-catalog";
import { convertProjectToTwinWorkspace, type ProjectComponentRevisionInput } from "@contracts/project-to-twin";
import { studioHref } from "@contracts/studio-navigation";
import { cn } from "@/lib/utils";
import { downloadBlob } from "@/lib/download";

const metricLabels: Record<string, { label: string; unit: string }> = {
  designForceN: { label: "设计推力", unit: "N" },
  screwTorqueNm: { label: "丝杠输入转矩", unit: "N·m" },
  screwSpeedRpm: { label: "丝杠转速", unit: "rpm" },
  peakPowerW: { label: "峰值功率", unit: "W" },
  averagePowerW: { label: "循环平均功率", unit: "W" },
  gravityTorqueNm: { label: "重力矩", unit: "N·m" },
  inertiaTorqueNm: { label: "加速转矩", unit: "N·m" },
  totalInertiaKgM2: { label: "总等效惯量", unit: "kg·m²" },
  outputTorqueNm: { label: "关节输出转矩", unit: "N·m" },
  motorTorqueNm: { label: "电机需求转矩", unit: "N·m" },
  motorSpeedRpm: { label: "电机需求转速", unit: "rpm" },
  designTractiveForceN: { label: "设计牵引力", unit: "N" },
  wheelTorqueNm: { label: "单轮轮端转矩", unit: "N·m" },
};
const primaryMetrics = ["designForceN", "screwTorqueNm", "outputTorqueNm", "designTractiveForceN", "motorTorqueNm", "motorSpeedRpm", "screwSpeedRpm", "peakPowerW"];
const moduleCategories = MODULE_COMPONENT_ROLES;
const categoryNames: Record<string, string> = { ball_screw: "滚珠丝杠", linear_guide: "直线导向", servo_motor: "伺服电机", servo_drive: "伺服驱动器", gearbox: "精密减速器", encoder: "编码器", controller: "控制器", wheel: "轮体", safety: "安全部件" };

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export default function ProjectWorkbench() {
  const params = useParams();
  const navigate = useNavigate();
  const projectId = Number(params.projectId);
  const utils = trpc.useUtils();
  const projectQuery = trpc.project.detail.useQuery({ projectId }, { enabled: Number.isInteger(projectId) && projectId > 0 });
  const libraryQuery = trpc.catalog.modules.useQuery();
  const componentsQuery = trpc.catalog.components.useQuery();
  const project = projectQuery.data;

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [configuration, setConfiguration] = useState<Record<string, number>>({});
  const [instanceName, setInstanceName] = useState("");
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [centerTab, setCenterTab] = useState<"scene" | "calculation" | "trace" | "versions">("scene");
  const [inspectorTab, setInspectorTab] = useState<"parameters" | "components">("parameters");
  const [addOpen, setAddOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionNote, setVersionNote] = useState("");
  const [addKey, setAddKey] = useState<ModuleKey>("linear_axis");
  const [addName, setAddName] = useState("新直线轴实例");
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);

  useEffect(() => {
    if (!project) return;
    if (selectedId === null || !project.modules.some((module) => module.id === selectedId)) {
      setSelectedId(project.modules[0]?.id ?? null);
    }
  }, [project, selectedId]);

  const selected = project?.modules.find((module) => module.id === selectedId);
  const selectedKey = selected && MODULE_KEYS.includes(selected.moduleVersion.definition.key as ModuleKey)
    ? selected.moduleVersion.definition.key as ModuleKey
    : null;
  const fields = selected ? ((selected.moduleVersion.inputSchema as { fields?: ModuleField[] }).fields ?? []) : [];

  useEffect(() => {
    if (!selected) return;
    setConfiguration(selected.configuration as Record<string, number>);
    setInstanceName(selected.instanceName);
    setSelection(selected.selectedComponentRevisionIds);
  }, [selected]);

  const preview = useMemo<{ result?: CalculationResult; error?: string }>(() => {
    if (!selectedKey) return {};
    try {
      return { result: calculateModule(selectedKey, configuration) };
    } catch (error) {
      const issue = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues?.[0];
      return { error: issue ? `${String(issue.path[0] ?? "输入")}：${issue.message}` : error instanceof Error ? error.message : "输入校验失败" };
    }
  }, [configuration, selectedKey]);

  const dirty = selected ? JSON.stringify(configuration) !== JSON.stringify(selected.configuration)
    || instanceName !== selected.instanceName
    || JSON.stringify(selection) !== JSON.stringify(selected.selectedComponentRevisionIds) : false;

  const refresh = async () => {
    await Promise.all([utils.project.detail.invalidate({ projectId }), utils.project.list.invalidate()]);
  };
  const saveModule = trpc.project.saveModule.useMutation({
    onSuccess: async (output) => {
      setSelectedId(output.projectModuleId);
      await refresh();
      toast.success(output.result.status === "blocked" ? "配置已保存，计算结果被阻断" : "配置与计算追溯已保存");
    },
    onError: (error) => toast.error(error.message),
  });
  const addModule = trpc.project.saveModule.useMutation({
    onSuccess: async (output) => {
      setSelectedId(output.projectModuleId);
      setAddOpen(false);
      await refresh();
      toast.success("模块已加入整机组成");
    },
    onError: (error) => toast.error(error.message),
  });
  const removeModule = trpc.project.removeModule.useMutation({
    onSuccess: async () => { setSelectedId(null); await refresh(); toast.success("模块实例已移除"); },
    onError: (error) => toast.error(error.message),
  });
  const createVersion = trpc.project.createVersion.useMutation({
    onSuccess: async (version) => {
      setVersionOpen(false);
      setVersionNote("");
      await refresh();
      toast.success(`版本 V${version.versionNo} 已冻结`, { description: `SHA-256 ${version.contentHash.slice(0, 12)}…` });
    },
    onError: (error) => toast.error(error.message),
  });

  async function exportProject(format: "json" | "csv") {
    setExporting(format);
    try {
      const data = await utils.project.export.fetch({ projectId });
      const safeCode = data.project.code.replace(/[^A-Za-z0-9_-]/g, "_");
      if (format === "json") {
        downloadBlob(JSON.stringify(data, null, 2), `${safeCode}_工程设计包.json`, "application/json;charset=utf-8");
      } else {
        const revisions = new Map(data.componentRevisions.map((revision) => [revision.id, revision]));
        const rows: unknown[][] = [["项目编号", "模块实例", "模块类型", "部件角色", "制造商", "型号", "部件修订", "验证状态", "样本版本", "来源定位", "官方资料"]];
        for (const module of data.modules) {
          const entries = Object.entries(module.selectedComponentRevisionIds);
          if (entries.length === 0) rows.push([data.project.code, module.instanceName, module.moduleName, "待选择", "", "", "", "", "", "", ""]);
          for (const [role, revisionId] of entries) {
            const revision = revisions.get(revisionId);
            rows.push([data.project.code, module.instanceName, module.moduleName, categoryNames[role] ?? role, revision?.component.manufacturer.name, revision?.component.model, revision?.revisionLabel, revision?.verificationStatus, revision?.sourceVersion, revision?.sourceLocator, revision?.sourceUrl]);
          }
        }
        downloadBlob(`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`, `${safeCode}_部件溯源BOM.csv`, "text/csv;charset=utf-8");
      }
      toast.success(format === "json" ? "工程设计包已导出" : "部件溯源 BOM 已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(null);
    }
  }

  if (projectQuery.isLoading) return <ProductLayout><div className="flex min-h-[70vh] items-center justify-center text-sm text-muted-foreground">正在读取项目与计算记录…</div></ProductLayout>;
  if (projectQuery.error || !project) return <ProductLayout><div className="p-8"><div className="surface mx-auto max-w-lg p-8 text-center"><AlertTriangle className="mx-auto h-6 w-6 text-destructive" /><h1 className="mt-4 text-lg font-medium">无法打开项目</h1><p className="mt-2 text-sm text-muted-foreground">{projectQuery.error?.message ?? "项目不存在"}</p><Button className="mt-5" variant="outline" onClick={() => navigate("/")}>返回项目列表</Button></div></div></ProductLayout>;

  const addDefinition = libraryQuery.data?.find((definition) => definition.key === addKey);
  const addVersion = addDefinition ? [...addDefinition.versions].sort((a, b) => b.id - a.id)[0] : undefined;
  const archived = project.status === "archived";
  const selectedAutomationMetadata = selected ? project.auditEvents.find((event) => event.action === "module.auto_calculated" && event.entityId === String(selected.id))?.metadata : undefined;
  const candidateNotes = typeof selectedAutomationMetadata === "object" && selectedAutomationMetadata !== null && "candidateNotes" in selectedAutomationMetadata && Array.isArray(selectedAutomationMetadata.candidateNotes)
    ? selectedAutomationMetadata.candidateNotes.filter((note): note is string => typeof note === "string")
    : [];

  function openInTwinStudio() {
    if (!project) return;
    try {
      const revisions: ProjectComponentRevisionInput[] = (componentsQuery.data ?? []).flatMap((component) =>
        component.revisions.map((rev) => ({
          id: rev.id,
          manufacturer: component.manufacturer.name,
          model: component.model,
          category: component.category,
          revisionLabel: rev.revisionLabel,
          sourceTitle: rev.sourceTitle,
          sourceUrl: rev.sourceUrl,
          sourceVersion: rev.sourceVersion,
          sourceLocator: rev.sourceLocator,
          sourceEvidence: rev.sourceEvidence,
          parameters: rev.parameters as Record<string, unknown>,
        })),
      );
      const conversion = convertProjectToTwinWorkspace({
        projectCode: project.code,
        projectName: project.name,
        modules: project.modules.map((m) => ({
          id: m.id,
          moduleKey: m.moduleVersion.definition.key,
          instanceName: m.instanceName,
          configuration: m.configuration as Record<string, number>,
          selectedComponentRevisionIds: m.selectedComponentRevisionIds,
        })),
        componentRevisions: revisions,
      });
      localStorage.setItem("gouyuan.twin.workspace.v1", JSON.stringify(conversion.workspace));
      localStorage.setItem("gouyuan.twin.workspace.v1.opened", nanoid());
      toast.success(
        `已转化 ${conversion.convertedPackages} 个官方部件修订与 ${conversion.workspace.systems?.length ?? 0} 套孪生系统草稿` +
          (conversion.pendingDiagnostics.length ? `（${conversion.pendingDiagnostics.length} 项待核对）` : ""),
      );
      const dest = conversion.primaryTarget
        ? studioHref({ view: "workbench", target: conversion.primaryTarget })
        : studioHref({ view: "resources" });
      navigate(`/twin${dest}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "转入数字孪生工作台失败");
    }
  }

  return (
    <ProductLayout>
      <div className="page-enter p-4 sm:p-5">
        <header className="mb-4 flex flex-col gap-4 rounded-md border bg-card px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon" onClick={() => navigate("/")} aria-label="返回项目列表"><ArrowLeft className="h-4 w-4" /></Button><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="display-title truncate text-xl font-medium">{project.name}</h1><StatusBadge status={project.status} /></div><div className="mono mt-1.5 text-[10px] text-muted-foreground">{project.code} <span className="mx-1.5 text-border">/</span> {project.modules.length} MODULES <span className="mx-1.5 text-border">/</span> {project.currentVersionNo ? `V${project.currentVersionNo}` : "NO SNAPSHOT"}</div></div></div>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" className="gap-2" onClick={openInTwinStudio}><Workflow className="h-3.5 w-3.5" />转入孪生仿真</Button><Button variant="outline" size="sm" className="gap-2" onClick={() => setVersionOpen(true)} disabled={archived}><GitCommitHorizontal className="h-3.5 w-3.5" />冻结版本</Button><Button variant="outline" size="sm" className="gap-2" disabled={exporting !== null} onClick={() => exportProject("csv")}><SheetIcon className="h-3.5 w-3.5" />{exporting === "csv" ? "导出中…" : "溯源 BOM"}</Button><Button size="sm" className="gap-2" disabled={exporting !== null} onClick={() => exportProject("json")}><FileJson className="h-3.5 w-3.5" />{exporting === "json" ? "导出中…" : "导出设计包"}</Button></div>
        </header>

        <ProjectTodoPanel
          modules={project.modules}
          automationMetadata={project.auditEvents.find((event) => event.action === "project.auto_generated")?.metadata}
          onSelect={(moduleId, tab) => {
            setSelectedId(moduleId);
            if (tab === "components") setInspectorTab("components");
            else setCenterTab("calculation");
          }}
        />

        <div className="grid items-start gap-4 xl:grid-cols-[248px_minmax(0,1fr)_360px]">
          <aside className="surface overflow-hidden xl:sticky xl:top-4">
            <div className="flex items-center justify-between border-b px-3 py-3"><span className="eyebrow">整机组成</span><Button variant="ghost" size="icon" className="h-7 w-7" disabled={archived} onClick={() => setAddOpen(true)} aria-label="添加模块"><CirclePlus className="h-4 w-4" /></Button></div>
            <div className="p-2"><div className="flex items-center gap-2 px-2 py-2 text-xs font-medium"><Boxes className="h-4 w-4 text-primary" />{project.name}</div><div className="ml-[15px] border-l pl-2">{project.modules.map((module) => { const run = module.calculationRuns[0]; return <button key={module.id} className="tree-item" data-active={selectedId === module.id} onClick={() => setSelectedId(module.id)}><ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /><Box className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{module.instanceName}</span><span className="mt-0.5 block text-[9px] text-muted-foreground">{module.moduleVersion.definition.family}</span></span><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", run?.status === "ok" ? "bg-emerald-400" : run?.status === "warning" ? "bg-amber-400" : "bg-red-400")} /></button>; })}</div>{project.modules.length === 0 && <div className="px-3 py-8 text-center text-[11px] leading-5 text-muted-foreground">尚未添加模块<br />从通用模块库组成设备</div>}</div>
            <div className="border-t p-3"><Button variant="outline" size="sm" className="w-full gap-2" disabled={archived} onClick={() => setAddOpen(true)}><PackagePlus className="h-3.5 w-3.5" />添加组成模块</Button></div>
            <div className="border-t bg-muted/20 p-3 text-[10px] leading-5 text-muted-foreground">实例配置独立于模块模板。每次保存都会新增计算运行，不会覆盖历史。</div>
          </aside>

          <main className="min-w-0">
            <div className="surface overflow-hidden">
              <div className="flex overflow-x-auto border-b px-2 thin-scrollbar">{([{ key: "scene", label: "参数化三维", icon: Boxes }, { key: "calculation", label: "工程初算", icon: Braces }, { key: "trace", label: "计算追溯", icon: History }, { key: "versions", label: "版本与审计", icon: FileClock }] as const).map((tab) => <button key={tab.key} onClick={() => setCenterTab(tab.key)} className={cn("flex h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-xs text-muted-foreground transition-colors hover:text-foreground", centerTab === tab.key && "border-primary text-primary")}><tab.icon className="h-3.5 w-3.5" />{tab.label}</button>)}</div>
              {!selected && centerTab !== "versions" ? <div className="flex min-h-[480px] flex-col items-center justify-center p-8 text-center"><Layers3 className="h-8 w-8 text-muted-foreground" strokeWidth={1.2} /><h2 className="mt-4 text-sm font-medium">选择一个组成模块</h2><p className="mt-2 text-xs text-muted-foreground">三维、参数与计算记录将在这里显示。</p></div> : <>
                {centerTab === "scene" && selected && selectedKey && <><div className="relative engineering-grid scene-vignette"><Suspense fallback={<div className="flex h-[440px] items-center justify-center text-xs text-muted-foreground sm:h-[500px]">正在加载三维工程视图…</div>}><ModuleScene moduleKey={selectedKey} configuration={configuration} instanceName={instanceName} className="h-[440px] w-full sm:h-[500px]" /></Suspense><div className="pointer-events-none absolute left-4 top-4 rounded border border-white/10 bg-black/35 px-3 py-2 backdrop-blur"><div className="mono text-[9px] uppercase tracking-[.14em] text-primary">PARAMETRIC LAYOUT · NOT CAD</div><div className="mt-1 text-xs text-white/85">{instanceName}</div></div></div>{preview.result && <div className="grid grid-cols-2 border-t md:grid-cols-4">{primaryMetrics.filter((key) => key in preview.result!.metrics).slice(0, 4).map((key) => <div key={key} className="border-b border-r p-4 last:border-r-0 md:border-b-0"><div className="eyebrow">{metricLabels[key]?.label ?? key}</div><div className="mono mt-2 text-lg text-foreground">{preview.result!.metrics[key].toLocaleString("zh-CN", { maximumFractionDigits: 2 })}<span className="ml-1.5 text-[10px] text-muted-foreground">{metricLabels[key]?.unit}</span></div></div>)}</div>}</>}
                {centerTab === "calculation" && <CalculationView result={preview.result} error={preview.error} />}
                {centerTab === "trace" && selected && <div className="p-4 sm:p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-sm font-medium">不可覆盖的计算历史</h2><p className="mt-1 text-[11px] text-muted-foreground">当前实例共 {selected.calculationRuns.length} 次已保存计算</p></div><History className="h-4 w-4 text-muted-foreground" /></div>{selected.calculationRuns.length === 0 ? <div className="rounded-md border border-dashed p-10 text-center text-xs text-muted-foreground">保存参数后生成第一条计算记录。</div> : <div className="space-y-3">{selected.calculationRuns.map((run, index) => <details key={run.id} className="rounded-md border bg-background/40" open={index === 0}><summary className="flex cursor-pointer list-none flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><span className="mono text-[10px] text-muted-foreground">RUN #{run.id}</span><StatusBadge status={run.status} /></div><div className="mono text-[10px] text-muted-foreground">{formatDate(run.createdAt)}</div></summary><div className="border-t p-4"><div className="grid gap-3 sm:grid-cols-2"><div><div className="eyebrow">规则版本</div><div className="mono mt-1.5 text-xs">{run.engineVersion}</div></div><div><div className="eyebrow">输入摘要 SHA-256</div><div className="mono mt-1.5 break-all text-[10px] text-muted-foreground">{run.inputDigest}</div></div></div><div className="mt-4 overflow-x-auto thin-scrollbar"><table className="data-table min-w-[600px]"><thead><tr><th>#</th><th>计算步骤</th><th>公式</th><th>结果</th></tr></thead><tbody>{run.steps.map((step) => <tr key={step.id}><td className="mono text-muted-foreground">{step.stepOrder}</td><td>{step.title}</td><td className="mono text-[11px]">{step.formula}</td><td className="mono text-primary">{step.value.toFixed(3)} {step.unit}</td></tr>)}</tbody></table></div></div></details>)}</div>}</div>}
                {centerTab === "versions" && <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2"><section><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-medium">项目版本快照</h2><Button size="sm" variant="outline" onClick={() => setVersionOpen(true)} disabled={archived}>新建快照</Button></div>{project.versions.length === 0 ? <div className="rounded-md border border-dashed p-8 text-center text-xs leading-6 text-muted-foreground">尚未冻结版本。<br />快照会保存组成、配置、规则版本与最新计算结果。</div> : <div className="space-y-3">{project.versions.map((version) => <details key={version.id} className="rounded-md border bg-background/40 p-4"><summary className="cursor-pointer list-none"><div className="flex items-center justify-between"><span className="mono text-xs font-medium text-primary">V{version.versionNo}</span><span className="mono text-[10px] text-muted-foreground">{formatDate(version.createdAt)}</span></div><p className="mt-2 text-xs leading-5">{version.changeNote}</p></summary><div className="mt-3 border-t pt-3"><div className="eyebrow">内容哈希</div><div className="mono mt-1.5 break-all text-[10px] text-muted-foreground">{version.contentHash}</div><pre className="mono mt-3 max-h-64 overflow-auto rounded bg-muted/40 p-3 text-[9px] leading-4 text-muted-foreground thin-scrollbar">{JSON.stringify(version.snapshot, null, 2)}</pre></div></details>)}</div>}</section><section><h2 className="mb-4 text-sm font-medium">审计事件</h2><div className="space-y-0">{project.auditEvents.map((event) => <div key={event.id} className="relative border-l pb-5 pl-5 last:pb-0"><span className="absolute -left-[3px] top-1.5 h-[5px] w-[5px] rounded-full bg-primary" /><div className="mono text-[10px] text-primary">{event.action}</div><div className="mt-1 text-xs">{event.entityType} · {event.entityId}</div><div className="mt-1 text-[10px] text-muted-foreground">{event.actor.name ?? "当前用户"} · {formatDate(event.createdAt)}</div></div>)}</div></section></div>}
              </>}
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-400/15 bg-amber-400/[.035] px-4 py-3 text-[11px] leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />三维仅用于布局与运动关系沟通；初算未完成强度、寿命、热、刚度、临界转速、附着和安全功能验证，不可直接用于制造。</div>
          </main>

          <aside className="surface min-w-0 overflow-hidden xl:sticky xl:top-4">
            {selected && selectedKey && <>
              <div className="flex border-b"><button onClick={() => setInspectorTab("parameters")} className={cn("h-11 flex-1 border-b-2 border-transparent text-xs text-muted-foreground", inspectorTab === "parameters" && "border-primary text-primary")}>需求参数</button><button onClick={() => setInspectorTab("components")} className={cn("h-11 flex-1 border-b-2 border-transparent text-xs text-muted-foreground", inspectorTab === "components" && "border-primary text-primary")}>部件与来源</button></div>
              <div className="max-h-[calc(100vh-190px)] overflow-y-auto p-4 thin-scrollbar">
                {inspectorTab === "parameters" ? <>
                  <div className="mb-4"><div className="flex items-center justify-between"><span className="eyebrow">实例配置</span>{dirty && <span className="text-[10px] text-amber-300">有未保存修改</span>}</div><Label className="mt-3" htmlFor="instance-name">实例名称</Label><Input id="instance-name" className="mt-2" value={instanceName} disabled={archived} onChange={(event) => setInstanceName(event.target.value)} /><div className="mono mt-2 text-[10px] text-muted-foreground">{selectedKey} · V{selected.moduleVersion.version}</div></div>
                  <div className="space-y-4">{fields.map((field) => <div key={field.key}><label className="field-label" htmlFor={`field-${field.key}`}><span>{field.label}</span><span className="mono text-[10px] font-normal text-primary">{field.unit}</span></label><input id={`field-${field.key}`} className="number-input" type="number" min={field.min} max={field.max} step={field.step} disabled={archived} value={configuration[field.key] ?? ""} onChange={(event) => setConfiguration((current) => ({ ...current, [field.key]: Number(event.target.value) }))} /><p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{field.description}</p></div>)}</div>
                </> : <>
                  <div className="mb-4"><div className="eyebrow">制造商部件修订</div><p className="mt-2 text-[11px] leading-5 text-muted-foreground">每个角色保存具体修订 ID。更换样本修订后需重新保存与计算。</p></div>
                  {candidateNotes.length > 0 && <div className="mb-4 rounded-md border border-sky-400/20 bg-sky-400/[.04] p-3"><div className="text-[10px] font-medium text-sky-300">首次自动候选依据（历史）</div><ul className="mt-2 space-y-2">{candidateNotes.map((note) => <li key={note} className="text-[10px] leading-4 text-muted-foreground">{note}</li>)}</ul></div>}
                  <div className="space-y-4">{moduleCategories[selectedKey].map((category) => { const options = (componentsQuery.data ?? []).filter((component) => component.category === category); return <div key={category}><Label>{categoryNames[category]}</Label><Select disabled={archived} value={String(selection[category] ?? 0)} onValueChange={(value) => setSelection((current) => { const next = { ...current }; if (value === "0") delete next[category]; else next[category] = Number(value); return next; })}><SelectTrigger className="mt-2 w-full"><SelectValue placeholder="选择已溯源部件" /></SelectTrigger><SelectContent><SelectItem value="0">未选择 / 待供应商确认</SelectItem>{options.flatMap((component) => component.revisions.map((revision) => <SelectItem key={revision.id} value={String(revision.id)}>{component.manufacturer.name} · {component.model} · {revision.revisionLabel}</SelectItem>))}</SelectContent></Select>{options.length === 0 && <p className="mt-2 text-[10px] text-amber-300/80">该类别尚无可溯源部件，不以假设型号代替。</p>}</div>; })}</div>
                  <Button variant="link" className="mt-4 h-auto px-0 text-xs" onClick={() => navigate("/components")}>打开部件来源库<ChevronRight className="ml-1 h-3 w-3" /></Button>
                </>}
              </div>
              <div className="border-t p-4">
                {preview.result && <div className="mb-3 flex items-center justify-between"><StatusBadge status={preview.result.status} /><span className="mono text-[9px] text-muted-foreground">LIVE PREVIEW</span></div>}
                {preview.error && <div className="mb-3 rounded border border-destructive/25 bg-destructive/10 p-2 text-[10px] leading-4 text-red-300">{preview.error}</div>}
                <Button className="w-full gap-2" disabled={!dirty || archived || Boolean(preview.error) || !instanceName.trim() || saveModule.isPending} onClick={() => saveModule.mutate({ projectId, projectModuleId: selected.id, moduleVersionId: selected.moduleVersionId, instanceName: instanceName.trim(), configuration, selectedComponentRevisionIds: selection, sortOrder: selected.sortOrder })}><Save className="h-4 w-4" />{saveModule.isPending ? "正在保存与计算…" : dirty ? "保存并生成计算记录" : "配置已保存"}</Button>
                <Button variant="ghost" size="sm" className="mt-2 w-full gap-2 text-muted-foreground hover:text-destructive" disabled={archived || removeModule.isPending} onClick={() => { if (window.confirm(`确定从整机移除“${selected.instanceName}”？历史审计事件保留，该实例的计算记录将一并删除。`)) removeModule.mutate({ projectId, projectModuleId: selected.id }); }}><Trash2 className="h-3.5 w-3.5" />移除此实例</Button>
              </div>
            </>}
          </aside>
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent><DialogHeader><DialogTitle>添加组成模块</DialogTitle><DialogDescription>从已发布的模块版本创建独立实例，并立即生成首条工程初算。</DialogDescription></DialogHeader><div className="space-y-4 py-3"><div><Label>模块类型</Label><Select value={addKey} onValueChange={(value) => { const key = value as ModuleKey; setAddKey(key); setAddName({ linear_axis: "新直线轴实例", rotary_joint: "新旋转关节实例", drive_wheel: "新驱动轮实例" }[key]); }}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent>{libraryQuery.data?.map((definition) => <SelectItem key={definition.id} value={definition.key}>{definition.name}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="new-instance-name">实例名称</Label><Input id="new-instance-name" className="mt-2" value={addName} onChange={(event) => setAddName(event.target.value)} /></div><div className="rounded-md border bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">模块版本 <span className="mono text-foreground">V{addVersion?.version ?? "—"}</span> · 规则 <span className="mono text-foreground">{addVersion?.ruleVersion ?? "—"}</span><br />初始值为工程假设，保存后必须按现场需求修改。</div></div><DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button><Button disabled={!addVersion || !addName.trim() || addModule.isPending} onClick={() => addVersion && addModule.mutate({ projectId, moduleVersionId: addVersion.id, instanceName: addName.trim(), configuration: defaultConfiguration(addKey), selectedComponentRevisionIds: {}, sortOrder: project.modules.length })}>{addModule.isPending ? "正在添加…" : "添加并初算"}</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent><DialogHeader><DialogTitle>冻结项目版本</DialogTitle><DialogDescription>快照包含当前组成、全部实例配置、模块与规则版本，以及每个实例最新计算结果。此操作不会冻结未保存的表单修改。</DialogDescription></DialogHeader><div className="py-3"><Label htmlFor="version-note">版本说明</Label><Textarea id="version-note" className="mt-2" rows={4} value={versionNote} onChange={(event) => setVersionNote(event.target.value)} placeholder="例如：客户评审前基线；Z 轴负载待现场称重确认。" /></div><DialogFooter><Button variant="outline" onClick={() => setVersionOpen(false)}>取消</Button><Button disabled={versionNote.trim().length < 3 || createVersion.isPending} onClick={() => createVersion.mutate({ projectId, changeNote: versionNote.trim() })}><GitCommitHorizontal className="mr-2 h-4 w-4" />{createVersion.isPending ? "正在冻结…" : `冻结为 V${project.currentVersionNo + 1}`}</Button></DialogFooter></DialogContent>
      </Dialog>
    </ProductLayout>
  );
}

function CalculationView({ result, error }: { result?: CalculationResult; error?: string }) {
  if (error) return <div className="flex min-h-[420px] flex-col items-center justify-center p-8 text-center"><AlertTriangle className="h-7 w-7 text-destructive" /><h2 className="mt-4 text-sm font-medium">输入未通过约束校验</h2><p className="mt-2 max-w-md text-xs leading-6 text-muted-foreground">{error}</p></div>;
  if (!result) return null;
  return <div className="p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="eyebrow">LIVE ENGINEERING PREVIEW</div><h2 className="mt-2 text-sm font-medium">工程公式与代入过程</h2></div><StatusBadge status={result.status} /></div>
    {result.warnings.length > 0 && <div className="mt-4 space-y-2">{result.warnings.map((warning) => <div key={warning.code} className={cn("rounded-md border p-3", warning.severity === "critical" ? "border-red-400/20 bg-red-400/[.055]" : "border-amber-400/20 bg-amber-400/[.055]")}><div className="flex items-center gap-2 text-xs font-medium"><AlertTriangle className={cn("h-4 w-4", warning.severity === "critical" ? "text-red-300" : "text-amber-300")} />{warning.message}</div><p className="mt-2 text-[11px] leading-5 text-muted-foreground">处置要求：{warning.requiredAction}</p><div className="mono mt-2 text-[9px] text-muted-foreground">{warning.code}</div></div>)}</div>}
    <div className="mt-5 overflow-x-auto rounded-md border thin-scrollbar"><table className="data-table min-w-[800px]"><thead><tr><th>#</th><th>步骤与依据</th><th>公式与代入</th><th>结果</th></tr></thead><tbody>{result.steps.map((step) => <tr key={step.key}><td className="mono text-muted-foreground">{String(step.order).padStart(2, "0")}</td><td><div className="text-xs font-medium">{step.title}</div><div className="mt-1 max-w-xs text-[10px] leading-4 text-muted-foreground">{step.basis}</div></td><td><div className="mono text-[11px] text-foreground/90">{step.formula}</div><div className="mono mt-1.5 max-w-md text-[10px] leading-4 text-muted-foreground">{step.substitution}</div></td><td className="mono whitespace-nowrap text-xs text-primary">{step.value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} <span className="text-muted-foreground">{step.unit}</span></td></tr>)}</tbody></table></div>
    <details className="mt-4 rounded-md border bg-background/40 p-4"><summary className="cursor-pointer text-xs font-medium">工程假设与未验证范围（{result.assumptions.length}）</summary><ul className="mt-3 space-y-2">{result.assumptions.map((assumption, index) => <li key={index} className="flex gap-2 text-[11px] leading-5 text-muted-foreground"><Check className="mt-1 h-3 w-3 shrink-0 text-primary" />{assumption}</li>)}</ul></details>
  </div>;
}
