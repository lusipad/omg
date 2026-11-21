import { useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { BookOpen, Camera, ClipboardPaste, Cpu, Download, FileUp, FolderInput, FolderOpen, Link2, Package, Play, Plus, Search, Workflow } from "lucide-react";
import { listRegisteredModels, modelKey } from "@contracts/model-registry";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { MaterialRow, ModelRef } from "@contracts/import-catalog";
import { readStudioRoute, studioHref, type StudioTarget } from "@contracts/studio-navigation";
import { WORKBENCH_FILE_ACCEPT } from "@/lib/workbench-import";
import { downloadFile } from "@/lib/download";
import { deviceLibraryGroups, isStructureOnly, motorRoleNames } from "@/lib/device-library";
import { compositionKind } from "@contracts/device-composition";
import { VisionIntakePanel } from "@/components/VisionIntakePanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import MaterialDetails, { MaterialIntake, type MaterialIntakeProps } from "./ImportCenterMaterials";

const acceptedSuffixes = WORKBENCH_FILE_ACCEPT.split(",").filter((entry) => entry.startsWith("."));
type System = "so101" | "milo" | "servo" | "wiring" | `assembly:${string}` | `mechanism:${string}` | `factory:${string}` | `system:${string}`;
type Props = MaterialIntakeProps & {
  workspace: TwinWorkspace;
  onChange: (next: TwinWorkspace) => void;
  onOpenDevice: (device: DevicePackage) => void;
  onPreviewDevice: (device: DevicePackage, installed?: boolean) => void;
  onUseSource: (row: MaterialRow) => void;
  onOpenModel: (model: ModelRef) => void;
  onOpenSystem: (system: System) => void;
  onCreateDevice: () => void;
  onBrowseExamples: () => void;
  active?: boolean;
};
const emptyPaste = { text: "", name: "", source: "" };

type ImportEntryProps = MaterialIntakeProps & {
  workspace: TwinWorkspace;
  onApplyVision: (nextWorkspace: TwinWorkspace, options?: { openTarget?: StudioTarget; message?: string }) => void;
  onBrowseRegistry: () => void;
};

function ImportEntry({
  onImportFiles,
  onImportText,
  workspace,
  onApplyVision,
  onBrowseRegistry,
}: ImportEntryProps) {
  const files = useRef<HTMLInputElement>(null), directory = useRef<HTMLInputElement>(null);
  const pasteId = useId();
  const [intakeTab, setIntakeTab] = useState<"vision" | "files">("vision");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [{ text, name, source }, setDraft] = useState(emptyPaste);
  const revision = useRef(0);
  function edit(field: keyof typeof emptyPaste, value: string) {
    revision.current++;
    setDraft((current) => ({ ...current, [field]: value }));
  }
  function select(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selected.length) onImportFiles(selected);
  }

  return <section className="surface min-w-0 space-y-4 p-4 sm:p-5" aria-label="统一导入入口">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <div className="flex items-center gap-2">
        <FolderInput className="size-5 text-primary" />
        <h2 className="text-base font-semibold">快速导入器件或草图</h2>
      </div>
      <div role="tablist" aria-label="导入方式切换" className="flex flex-wrap gap-1 rounded-md border bg-background/60 p-1">
        <Button
          size="sm"
          type="button"
          role="tab"
          aria-selected={intakeTab === "vision"}
          variant={intakeTab === "vision" ? "secondary" : "ghost"}
          onClick={() => setIntakeTab("vision")}
        >
          <Camera />
          拍照 / 传图自动构建
        </Button>
        <Button
          size="sm"
          type="button"
          role="tab"
          aria-selected={intakeTab === "files"}
          variant={intakeTab === "files" ? "secondary" : "ghost"}
          onClick={() => setIntakeTab("files")}
        >
          <FileUp />
          导入文件 / 链接与 BOM
        </Button>
      </div>
    </div>

    {intakeTab === "vision" ? (
      <VisionIntakePanel
        workspace={workspace}
        onApply={onApplyVision}
        onBrowseRegistry={onBrowseRegistry}
      />
    ) : (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="text-xs leading-6 text-muted-foreground">
            选择文件或文件夹（支持 .twin.json / STEP / GLB / URDF / XML / BOM 清单），或在下方粘贴资料链接与规格文本。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => files.current?.click()}><FileUp />选择文件</Button>
            <Button size="sm" variant="outline" onClick={() => directory.current?.click()}><FolderOpen />选择文件夹</Button>
            <Button size="sm" variant="outline" aria-expanded={pasteOpen} aria-controls={pasteId} onClick={() => {
              if (!pasteOpen && (name || source)) setMetadataOpen(true);
              setPasteOpen(!pasteOpen);
            }}><ClipboardPaste />粘贴内容或链接</Button>
          </div>
        </div>
        <input ref={files} className="hidden" type="file" multiple accept={WORKBENCH_FILE_ACCEPT} aria-label="统一选择导入文件" onChange={select} />
        <input ref={directory} className="hidden" type="file" multiple {...{ webkitdirectory: "" }} aria-label="统一选择导入目录" onChange={select} />
        {pasteOpen && <form id={pasteId} className="space-y-3 border-t pt-4" onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          const title = name.trim(), location = source.trim();
          const fileName = acceptedSuffixes.some((suffix) => title.toLowerCase().endsWith(suffix)) ? title : "粘贴内容";
          const submitted = ++revision.current;
          onImportText(text, fileName, { hint: "auto", ...(title && { title }), ...(location && { source: location }) }, () => {
            if (revision.current !== submitted) return;
            revision.current++;
            setDraft(emptyPaste);
            setMetadataOpen(false);
          });
          setPasteOpen(false);
        }}>
          <label className="block"><span className="field-label">内容或资料链接</span>
            <Textarea autoFocus aria-label="待导入内容或链接" className="h-32 resize-y" placeholder="粘贴模型 XML、设备包或装配 JSON、清单、手册、G 代码或资料链接"
              value={text} onChange={(event) => edit("text", event.target.value)} />
          </label>
          <details className="text-xs" open={metadataOpen} onToggle={(event) => setMetadataOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-muted-foreground">名称与来源（可选）</summary>
            <div className="mt-3 grid items-end gap-3 sm:grid-cols-2">
              <label><span className="field-label">名称（可选）</span>
                <Input aria-label="粘贴资料名称" value={name} onChange={(event) => edit("name", event.target.value)} placeholder="文件名或资料标题" />
              </label>
              <label><span className="field-label">来源（可选）</span>
                <Input aria-label="粘贴资料来源" value={source} onChange={(event) => edit("source", event.target.value)} placeholder="网址、版本或章节" />
              </label>
            </div>
          </details>
          <Button size="sm" type="submit" disabled={!text.trim()}>识别并导入</Button>
        </form>}
        <MaterialIntake onImportFiles={onImportFiles} onImportText={onImportText} />
      </div>
    )}
  </section>;
}

const filters = [
  { key: "all", label: "全部" },
  { key: "device", label: "设备包" },
  { key: "physics", label: "物理模型" },
  { key: "material", label: "BOM 与手册" },
  { key: "system", label: "装配与程序" },
] as const;
type Filter = (typeof filters)[number]["key"];
type Resource = { id: string; category: string; name: string; detail: string; section: Exclude<Filter, "all"> } & (
  | { kind: "device"; device: DevicePackage }
  | { kind: "physics"; model: ModelRef }
  | { kind: "material"; row: MaterialRow }
  | { kind: "system"; system: System; action: string }
);

function projectResources(workspace: TwinWorkspace) {
  const rows: Resource[] = [];
  const { so101, milo, servoAxis } = workspace;
  for (const factory of workspace.factories ?? []) {
    rows.push({ id: `factory:${factory.id}`, kind: "system", system: `factory:${factory.id}`, section: "system",
      category: "工厂装配", name: factory.name, detail: `${factory.lines.length} 条产线 · ${factory.resources.length} 台设备`, action: "打开工厂" });
  }
  for (const assembly of workspace.mechanisms ?? []) {
    rows.push({ id: `mechanism:${assembly.id}`, kind: "system", system: `mechanism:${assembly.id}`, section: "system",
      category: "机械装配", name: assembly.name, detail: `${assembly.nodes.length} 个部件实例`, action: "打开装配" });
  }
  for (const assembly of workspace.assemblies ?? []) {
    rows.push({ id: `assembly:${assembly.id}`, kind: "system", system: `assembly:${assembly.id}`, section: "system",
      category: "直线轴装配", name: assembly.name, detail: `${assembly.modules.length} 种轴模块 · ${assembly.axes.length} 根轴`, action: "打开装配" });
  }
  for (const sys of workspace.systems ?? []) {
    rows.push({ id: `system:${sys.id}`, kind: "system", system: `system:${sys.id}`, section: "system",
      category: "机电控系统", name: sys.name, detail: `${sys.axes.length} 根轴 · ${sys.sensors.length} 开关 · ${sys.diChannels.length} 滤波通道`, action: "打开系统" });
  }
  if (so101) rows.push({ id: "system:so101", kind: "system", system: "so101", section: "material",
    category: "BOM", name: "SO-101 Follower 采购清单", detail: `${so101.bom.length} 行物料 · ${so101.waypoints.length} 个动作关键帧`, action: "打开 SO-101" });
  if (milo?.bom) rows.push({ id: "milo:bom", kind: "system", system: "milo", section: "material",
    category: "BOM", name: "Milo v1.5 采购清单", detail: `${milo.bom.length} 行物料 · 已装配 ${milo.assembled.length} / 3 轴`, action: "查看装配" });
  if (milo?.program.trim()) rows.push({ id: "milo:program", kind: "system", system: "milo", section: "system",
    category: "数控程序", name: "Milo v1.5 G 代码", detail: `${milo.program.trimEnd().split(/\r\n?|\n/).length} 行 NC 程序 · 已装配 ${milo.assembled.length} / 3 轴`, action: "查看程序" });
  if (workspace.instances.length) rows.push({ id: "system:wiring", kind: "system", system: "wiring", section: "system",
    category: "信号装配", name: "设备接线场景", detail: `${workspace.instances.length} 个设备实例 · ${workspace.connections.length} 条连线`, action: "打开接线" });
  if (servoAxis) {
    const models = new Map(workspace.packages.map((device) => [packageKey(device), device.model]));
    rows.push({ id: "system:servo", kind: "system", system: "servo", section: "system", category: "伺服装配", name: "伺服单轴",
      detail: [models.get(servoAxis.driveKey), models.get(servoAxis.motorKey), `目标 ${servoAxis.targetDeg}°`,
        servoAxis.modelRef && `${servoAxis.modelRef.id} @ ${servoAxis.modelRef.version}`].filter(Boolean).join(" · "), action: "打开伺服轴" });
  }
  for (const device of workspace.packages) {
    const kind = device.factory ? `工厂设备 · ${device.factory.modelRef.id} @ ${device.factory.modelRef.version}`
      : device.motorPhysics ? `${motorRoleNames[device.motorPhysics.kind]} · ${device.motorPhysics.fit}`
      : device.feed ? (device.feed.kind === "lead-screw" ? `丝杠 · ${device.feed.leadMmPerRev} mm/rev` : `移动工作台 · ${device.feed.massKg} kg`)
      : device.mechanics ? (device.mechanics.kind === "assembly" ? "机械子装配" : "机械部件")
      : device.servo ? (device.servo.kind === "drive" ? "伺服驱动器" : "伺服电机")
      : isStructureOnly(device) ? (compositionKind(device) === "leaf" ? "最小件" : "结构总成") : `${device.ports.length} 个端口`;
    rows.push({ kind: "device", section: "device", id: "pkg:" + packageKey(device), category: isStructureOnly(device) ? "结构件" : "设备包", name: device.model,
      detail: [device.manufacturer, device.revision, kind, isStructureOnly(device) && device.source.locator].filter(Boolean).join(" · "), device });
  }
  for (const model of workspace.catalog?.models ?? []) rows.push({ kind: "physics", section: "physics", id: "model:" + model.id, category: "物理模型", name: model.name,
    detail: `${model.entry} · ${model.id.slice(0, 10)}`, model });
  for (const row of workspace.catalog?.materials ?? []) rows.push({ kind: "material", section: "material", id: "material:" + row.id,
    category: row.id.startsWith("doc-") ? "设备手册" : row.id.startsWith("bom-") ? "BOM 物料" : "资料记录", name: row.name,
    detail: [`${row.quantity}${row.unit ? " " + row.unit : ""}`, row.manufacturer, row.model,
      row.leadMmPerRev !== undefined && `导程 ${row.leadMmPerRev} mm/rev`,
      row.massKg !== undefined && `移动质量 ${row.massKg} kg`,
      (row.massKg !== undefined || row.leadMmPerRev !== undefined) && row.source,
      row.binding ? "已绑定模型" : row.leadMmPerRev === undefined && row.massKg === undefined && "待建模"].filter(Boolean).join(" · "), row });
  return rows;
}

const pageSize = 16;
export default function ImportCenter({ workspace, onChange, onOpenDevice, onPreviewDevice, onUseSource, onOpenModel, onOpenSystem, onCreateDevice,
  onBrowseExamples, onImportFiles, onImportText, active = true }: Props) {
  const location = useLocation(), navigate = useNavigate();
  const route = readStudioRoute(location.search, location.hash);
  const section = route.view === "resources" ? route.section : undefined;
  const filter: Filter = section === "physics" || section === "device" || section === "material" || section === "system" ? section : "all";
  const [query, setQuery] = useState("");
  const [showComponents, setShowComponents] = useState(false);
  const [cursor, setCursor] = useState({ filter, query, page: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [error, setError] = useState("");
  const registeredModels = useMemo(() => listRegisteredModels(), []);
  if (!active && selected !== null) setSelected(null);
  const resources = useMemo(() => projectResources(workspace), [workspace]);
  const componentKeys = useMemo(() => new Set(deviceLibraryGroups(workspace.packages).parts.map(packageKey)), [workspace.packages]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return resources.filter(item => (filter === "all" || item.section === filter)
      && (item.kind !== "device" || showComponents || needle || !componentKeys.has(packageKey(item.device)))
      && (!needle || [item.name, item.category, item.detail, item.kind === "device" ? item.device.source.title : ""].join(" ").toLowerCase().includes(needle)));
  }, [resources, filter, query, showComponents, componentKeys]);
  const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
  const page = cursor.filter === filter && cursor.query === query ? Math.min(cursor.page, lastPage) : 0;
  const rows = matches.slice(page * pageSize, (page + 1) * pageSize);
  const selectedRow = active && selected ? workspace.catalog?.materials.find(row => row.id === selected) : undefined;
  function choose(next: Filter) {
    setError("");
    if (next !== filter) navigate(studioHref(next === "all" ? { view: "resources" } : { view: "resources", section: next }), { preventScrollReset: true });
  }
  async function run(action: () => void | Promise<void>) {
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开这项资源。"); }
  }
  async function download(model: ModelRef) {
    const { getModelBundle, exportModelBundle } = await import("@/lib/model-files");
    const bundle = await getModelBundle(model.id);
    downloadFile(exportModelBundle(bundle), model.name + ".zip");
  }
  function actions(item: Resource) {
    switch (item.kind) {
      case "device": return isStructureOnly(item.device) ? <Button size="sm" variant="outline" onClick={() => void run(() => onPreviewDevice(item.device, true))}>部件结构</Button>
        : <><Button size="sm" variant="ghost" onClick={() => void run(() => onPreviewDevice(item.device, true))}>详情</Button>
        <Button size="sm" variant="outline" onClick={() => void run(() => onOpenDevice(item.device))}><Package />选用设备</Button></>;
      case "physics": return <><Button size="sm" variant="outline" onClick={() => void run(() => onOpenModel(item.model))}><Play />打开模型</Button>
        <Button size="sm" variant="ghost" aria-label="下载模型 ZIP" onClick={() => void run(() => download(item.model))}><Download />下载 ZIP</Button></>;
      case "material": return <Button size="sm" variant="outline" onClick={() => { setError(""); setSelected(item.row.id); }}><Link2 />查看与绑定</Button>;
      case "system": return <Button size="sm" variant="outline" onClick={() => void run(() => onOpenSystem(item.system))}>{item.action}</Button>;
    }
  }
  return <section className="min-w-0 space-y-4" aria-label="设备与资料">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">设备与资料</h1>
        <p className="mt-1 text-xs text-muted-foreground">先拍照或导入真实器件参数，再绑定可执行行为模型并进入闭环装配。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setRegistryOpen(true)}><Cpu />模型注册表 ({registeredModels.length})</Button>
        <Button variant="secondary" onClick={() => navigate(studioHref({ view: "workbench", target: "system-new" }))}><Workflow />机电控闭环装配</Button>
        <Button variant="outline" onClick={onCreateDevice}><Plus />创建设备</Button>
      </div>
    </header>
    <ImportEntry
      workspace={workspace}
      onImportFiles={onImportFiles}
      onImportText={onImportText}
      onBrowseRegistry={() => setRegistryOpen(true)}
      onApplyVision={(nextWs, opts) => {
        onChange(nextWs);
        if (opts?.openTarget) navigate(studioHref({ view: "workbench", target: opts.openTarget }));
      }}
    />
    <section className="surface min-w-0 p-4 sm:p-5" aria-label="工程资源清单">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">资源清单 <span className="mono ml-1 text-sm text-muted-foreground">{resources.length}</span></h2>
        {resources.length > 0 && <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:w-auto">
          <label className="relative block min-w-0 sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input type="search" className="pl-8" aria-label="搜索工程资源" placeholder={componentKeys.size ? "搜索资源和子件" : "搜索资源"} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><span>资源类型</span>
            <select aria-label="资源类型" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={filter} onChange={(event) => choose(event.target.value as Filter)}>
              {filters.filter(({ key }) => key !== "system" || filter === key || resources.some(item => item.section === key)).map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        </div>}
      </div>
      {!!componentKeys.size && !query.trim() && (filter === "all" || filter === "device") && <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showComponents} onChange={event => {
          setShowComponents(event.currentTarget.checked); setCursor({ filter, query, page: 0 });
        }} />显示随附子件（{componentKeys.size} 个修订）
      </label>}
      {!resources.length ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t py-5">
        <p className="text-sm text-muted-foreground">当前工程还没有资源。可导入自己的文件，或直接体验跨品牌闭环仿真。</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate(studioHref({ view: "workbench", exampleId: "closed-loop-feed-system" }))}><Play />体验跨品牌闭环与实测对标</Button>
          <Button size="sm" variant="outline" onClick={onBrowseExamples}><BookOpen />浏览示例库</Button>
        </div>
      </div> : !rows.length ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t py-5">
        <p className="text-sm text-muted-foreground">当前筛选下没有匹配的资源。</p>
        <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setCursor({ filter: "all", query: "", page: 0 }); choose("all"); }}>显示全部</Button>
      </div> : <>
        <div aria-hidden="true" className="mt-4 hidden grid-cols-[minmax(0,1fr)_6rem_15rem] gap-x-4 border-t pb-1 pt-3 text-xs text-muted-foreground sm:grid">
          <span>资源名称</span><span>类别</span><span className="text-right">操作</span>
        </div>
        <ul aria-label="工程资源列表" className="mt-3 divide-y border-t sm:mt-0 sm:border-t-0">
        {rows.map((item) => <li key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_15rem]">
          <div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{item.detail}</p></div>
          <span className="text-xs text-muted-foreground">{item.category}</span>
          <div className="col-span-2 flex flex-wrap gap-1 sm:col-auto sm:justify-end">{actions(item)}</div>
        </li>)}
        </ul>
      </>}
      {lastPage > 0 && <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t pt-3 text-xs">
        <Button variant="outline" size="sm" disabled={!page} onClick={() => setCursor({ filter, query, page: page - 1 })}>上一页</Button>
        {page + 1} / {lastPage + 1}
        <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setCursor({ filter, query, page: page + 1 })}>下一页</Button>
      </div>}
      {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    </section>
    {selectedRow && <MaterialDetails key={selectedRow.id} row={selectedRow} workspace={workspace} onChange={onChange} onOpenDevice={onOpenDevice}
      onOpenPhysics={onOpenModel} onUseSource={onUseSource} onClose={() => setSelected(null)} />}
    <Dialog open={registryOpen} onOpenChange={setRegistryOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>统一模型注册表（{registeredModels.length} 个锁定版本）</DialogTitle>
          <DialogDescription>平台按 SSP / IDTA 统一声明每个模型版本的参数量纲、端口因果方向、问题分级与原生校验工件。</DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-xs">
          {registeredModels.map((m) => (
            <li key={modelKey(m)} className="space-y-1.5 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{m.label}</span>
                <span className="mono rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                  {m.id} @ {m.version} · {m.kind === "kernel" ? "WASM 求解内核" : "组件模型"} · {m.simPurpose.tier}
                </span>
              </div>
              <p className="text-muted-foreground">{m.simPurpose.summary}</p>
              <p className="mono text-[11px] text-muted-foreground">
                参数：{m.parameters.length ? m.parameters.map((p) => `${p.key} (${p.unit})`).join("、") : "无"}
              </p>
              <p className="mono text-[11px] text-muted-foreground">
                端口：{m.ports.length ? m.ports.map((p) => `${p.id} [${p.causality}/${p.domain}]`).join("、") : "配置内部求解"}
              </p>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  </section>;
}
