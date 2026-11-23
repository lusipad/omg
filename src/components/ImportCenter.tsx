import { useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { BookOpen, Camera, ChevronDown, ChevronUp, ClipboardPaste, Cpu, Download, FileSpreadsheet, FileUp, FolderInput, FolderOpen, Link2, Package, Play, Plus, Search } from "lucide-react";
import {
  effectiveModelBindings,
  evaluateBindingReadiness,
  hasFeedRole,
  hasServoRole,
  tryResolveServoDriveRatings,
  tryResolveServoMotorRatings,
} from "@contracts/device-model-binding";
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
  const [collapsed, setCollapsed] = useState(false);
  const [intakeTab, setIntakeTab] = useState<"vision" | "files" | "material">("vision");
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

  return <section className="surface min-w-0 space-y-3 p-4" aria-label="统一导入入口">
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b pb-2.5">
      <div className="flex items-center gap-2">
        <FolderInput className="size-4 text-primary" />
        <h2 className="text-sm font-semibold sm:text-base">快速入库 · 拍照识别与资料提取</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="导入方式切换" className="flex flex-wrap gap-1 rounded-md border bg-background/60 p-0.5">
          <Button
            size="sm"
            type="button"
            role="tab"
            className="h-7 px-2.5 text-xs"
            aria-selected={intakeTab === "vision" && !collapsed}
            variant={intakeTab === "vision" && !collapsed ? "secondary" : "ghost"}
            onClick={() => { setCollapsed(false); setIntakeTab("vision"); }}
          >
            <Camera className="size-3.5" />
            拍照 / 铭牌识别
          </Button>
          <Button
            size="sm"
            type="button"
            role="tab"
            className="h-7 px-2.5 text-xs"
            aria-selected={intakeTab === "files" && !collapsed}
            variant={intakeTab === "files" && !collapsed ? "secondary" : "ghost"}
            onClick={() => { setCollapsed(false); setIntakeTab("files"); }}
          >
            <FileUp className="size-3.5" />
            文件 / CAD / 链接
          </Button>
          <Button
            size="sm"
            type="button"
            role="tab"
            className="h-7 px-2.5 text-xs"
            aria-selected={intakeTab === "material" && !collapsed}
            variant={intakeTab === "material" && !collapsed ? "secondary" : "ghost"}
            onClick={() => { setCollapsed(false); setIntakeTab("material"); }}
          >
            <FileSpreadsheet className="size-3.5" />
            BOM 与手册录入
          </Button>
        </div>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          {collapsed ? "展开入库台" : "收起"}
        </Button>
      </div>
    </div>

    {!collapsed && intakeTab === "vision" && (
      <VisionIntakePanel
        workspace={workspace}
        onApply={onApplyVision}
        onBrowseRegistry={onBrowseRegistry}
      />
    )}

    {!collapsed && intakeTab === "files" && (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p className="text-xs leading-5 text-muted-foreground">
            导入 `.twin.json` 工程/设备包、`.step/.glb/.stl/.urdf/.xml` 三维模型或 G 代码与配置文件。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => files.current?.click()}><FileUp />选择文件</Button>
            <Button size="sm" variant="outline" onClick={() => directory.current?.click()}><FolderOpen />选择文件夹</Button>
            <Button size="sm" variant="outline" aria-expanded={pasteOpen} aria-controls={pasteId} onClick={() => {
              if (!pasteOpen && (name || source)) setMetadataOpen(true);
              setPasteOpen(!pasteOpen);
            }}><ClipboardPaste />{pasteOpen ? "收起文本框" : "粘贴链接或文本"}</Button>
          </div>
        </div>
        <input ref={files} className="hidden" type="file" multiple accept={WORKBENCH_FILE_ACCEPT} aria-label="统一选择导入文件" onChange={select} />
        <input ref={directory} className="hidden" type="file" multiple {...{ webkitdirectory: "" }} aria-label="统一选择导入目录" onChange={select} />
        {pasteOpen && <form id={pasteId} className="space-y-3 border-t pt-3" onSubmit={(event) => {
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
            <Textarea autoFocus aria-label="待导入内容或链接" className="h-28 resize-y" placeholder="粘贴模型 XML、设备包或装配 JSON、G 代码或官网资料链接"
              value={text} onChange={(event) => edit("text", event.target.value)} />
          </label>
          <details className="text-xs" open={metadataOpen} onToggle={(event) => setMetadataOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-muted-foreground">名称与来源（可选）</summary>
            <div className="mt-2.5 grid items-end gap-3 sm:grid-cols-2">
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
      </div>
    )}

    {!collapsed && intakeTab === "material" && (
      <MaterialIntake inline onImportFiles={onImportFiles} onImportText={onImportText} />
    )}
  </section>;
}

const filters = [
  { key: "all", label: "全部" },
  { key: "system", label: "装配与程序" },
  { key: "device", label: "设备包" },
  { key: "physics", label: "物理模型" },
  { key: "material", label: "BOM 与手册" },
] as const;
type Filter = (typeof filters)[number]["key"];
type StatusBadge = { label: string; tone: "ready" | "pending" | "neutral" };
type Resource = {
  id: string;
  category: string;
  name: string;
  detail: string;
  section: Exclude<Filter, "all">;
  statusBadge?: StatusBadge;
} & (
  | { kind: "device"; device: DevicePackage }
  | { kind: "physics"; model: ModelRef }
  | { kind: "material"; row: MaterialRow }
  | { kind: "system"; system: System; action: string }
);

function describeDevicePackage(device: DevicePackage): { category: string; detail: string; statusBadge: StatusBadge } {
  const bindings = effectiveModelBindings(device);
  let pendingCount = 0;
  for (const b of bindings) {
    const r = evaluateBindingReadiness(device, b.id);
    pendingCount += r.pendingParameters.length + r.missingParameters.length;
  }

  let category = "设备包";
  let specSummary = "";

  if (device.factory) {
    category = "工厂设备";
    specSummary = `${device.factory.modelRef.id}`;
  } else if (device.motorPhysics) {
    category = motorRoleNames[device.motorPhysics.kind];
    specSummary = `适配口 ${device.motorPhysics.fit}`;
  } else if (hasServoRole(device, "drive")) {
    category = "伺服驱动器";
    const ratings = tryResolveServoDriveRatings(device);
    specSummary = ratings ? `额定 ${ratings.ratedCurrentA} A · 峰值 ${ratings.peakCurrentA} A` : "待补全驱动参数";
  } else if (hasServoRole(device, "motor")) {
    category = "伺服电机";
    const ratings = tryResolveServoMotorRatings(device);
    specSummary = ratings
      ? `${ratings.ratedPowerW} W · ${ratings.ratedTorqueNm} N·m · ${ratings.ratedSpeedRpm} rpm`
      : "已提取部分铭牌参数";
  } else if (hasFeedRole(device, "screw")) {
    category = "滚珠丝杠";
    const b = bindings.find((item) => item.modelRef.id === "Gouyuan.IdealLeadScrew");
    const ready = b ? evaluateBindingReadiness(device, b.id) : undefined;
    const lead = device.feed?.kind === "lead-screw"
      ? device.feed.leadMmPerRev
      : typeof ready?.values.leadMmPerRev === "number" ? ready.values.leadMmPerRev : undefined;
    specSummary = lead !== undefined ? `导程 ${lead} mm/rev` : "待补全丝杠导程";
  } else if (hasFeedRole(device, "table")) {
    category = "移动工作台";
    const b = bindings.find((item) => item.modelRef.id === "Modelica.Mechanics.Translational.Components.Mass");
    const ready = b ? evaluateBindingReadiness(device, b.id) : undefined;
    const mass = device.feed?.kind === "moving-table"
      ? device.feed.massKg
      : typeof ready?.values.massKg === "number" ? ready.values.massKg : undefined;
    specSummary = mass !== undefined ? `负载质量 ${mass} kg` : "待补全负载质量";
  } else if (bindings.some((b) => b.modelRef.id === "GouyuanSignal.PositionLimitSwitch")) {
    category = "限位开关";
    specSummary = "离散位置限位触发模型";
  } else if (bindings.some((b) => b.modelRef.id === "GouyuanSignal.DebounceDiChannel")) {
    category = "DI 滤波模块";
    specSummary = "数字输入防抖滤波模型";
  } else if (device.mechanics) {
    category = device.mechanics.kind === "assembly" ? "三维子装配" : "三维机械件";
    specSummary = device.mechanics.kind === "assembly" ? `${device.mechanics.assembly.nodes.length} 个部件节点` : `${device.mechanics.outputs.length} 个安装接口`;
  } else if (isStructureOnly(device)) {
    category = "结构件";
    specSummary = `${compositionKind(device) === "leaf" ? "最小件" : "结构总成"}${device.source.locator ? ` · ${device.source.locator}` : ""}`;
  } else {
    category = "电气与控制件";
    specSummary = `${device.ports.length} 个电气/信号端口`;
  }

  const cleanRev = device.revision && !/^photo-\d+$/i.test(device.revision) ? `版本 ${device.revision}` : undefined;
  const detail = [device.manufacturer, cleanRev, specSummary].filter(Boolean).join(" · ");

  const statusBadge: StatusBadge = bindings.length > 0
    ? pendingCount > 0
      ? { label: `待补 ${pendingCount} 项参数`, tone: "pending" }
      : { label: "可执行就绪", tone: "ready" }
    : device.servo || device.feed || device.factory || device.ports.length > 0
      ? { label: "可执行就绪", tone: "ready" }
      : { label: "结构定义", tone: "neutral" };

  return { category, detail, statusBadge };
}

function projectResources(workspace: TwinWorkspace) {
  const rows: Resource[] = [];
  const { so101, milo, servoAxis } = workspace;
  for (const sys of workspace.systems ?? []) {
    rows.push({
      id: `system:${sys.id}`, kind: "system", system: `system:${sys.id}`, section: "system",
      category: "机电控系统", name: sys.name,
      detail: `${sys.axes.length} 根进给轴 · ${sys.sensors.length} 开关 · ${sys.diChannels.length} 滤波通道`,
      action: "进入仿真", statusBadge: { label: "闭环系统", tone: "ready" },
    });
  }
  for (const assembly of workspace.mechanisms ?? []) {
    rows.push({
      id: `mechanism:${assembly.id}`, kind: "system", system: `mechanism:${assembly.id}`, section: "system",
      category: "三维机构", name: assembly.name,
      detail: `${assembly.nodes.length} 个可动零部件实例`,
      action: "打开三维装配", statusBadge: { label: "三维机构", tone: "ready" },
    });
  }
  for (const assembly of workspace.assemblies ?? []) {
    rows.push({
      id: `assembly:${assembly.id}`, kind: "system", system: `assembly:${assembly.id}`, section: "system",
      category: "直线轴装配", name: assembly.name,
      detail: `${assembly.modules.length} 种轴模块 · ${assembly.axes.length} 根轴`,
      action: "打开装配", statusBadge: { label: "直驱进给", tone: "ready" },
    });
  }
  for (const factory of workspace.factories ?? []) {
    rows.push({
      id: `factory:${factory.id}`, kind: "system", system: `factory:${factory.id}`, section: "system",
      category: "工厂产线", name: factory.name,
      detail: `${factory.lines.length} 条产线 · ${factory.resources.length} 台设备`,
      action: "打开产线", statusBadge: { label: "产线节拍", tone: "ready" },
    });
  }
  if (so101) rows.push({
    id: "system:so101", kind: "system", system: "so101", section: "material",
    category: "BOM", name: "SO-101 Follower 采购清单",
    detail: `${so101.bom.length} 行物料 · ${so101.waypoints.length} 个动作关键帧`,
    action: "打开 SO-101",
  });
  if (milo?.bom) rows.push({
    id: "milo:bom", kind: "system", system: "milo", section: "material",
    category: "BOM", name: "Milo v1.5 采购清单",
    detail: `${milo.bom.length} 行物料 · 已装配 ${milo.assembled.length} / 3 轴`,
    action: "查看装配",
  });
  if (milo?.program.trim()) rows.push({
    id: "milo:program", kind: "system", system: "milo", section: "system",
    category: "数控程序", name: "Milo v1.5 G 代码",
    detail: `${milo.program.trimEnd().split(/\r\n?|\n/).length} 行 NC 程序 · 已装配 ${milo.assembled.length} / 3 轴`,
    action: "查看程序",
  });
  if (workspace.instances.length) rows.push({
    id: "system:wiring", kind: "system", system: "wiring", section: "system",
    category: "信号接线", name: "设备接线场景",
    detail: `${workspace.instances.length} 个设备实例 · ${workspace.connections.length} 条连线`,
    action: "打开接线",
  });
  if (servoAxis) {
    const models = new Map(workspace.packages.map((device) => [packageKey(device), device.model]));
    rows.push({
      id: "system:servo", kind: "system", system: "servo", section: "system", category: "伺服装配", name: "伺服单轴",
      detail: [models.get(servoAxis.driveKey), models.get(servoAxis.motorKey), `目标 ${servoAxis.targetDeg}°`,
        servoAxis.modelRef && `${servoAxis.modelRef.id} @ ${servoAxis.modelRef.version}`].filter(Boolean).join(" · "),
      action: "打开伺服轴",
    });
  }
  for (const device of workspace.packages) {
    const info = describeDevicePackage(device);
    rows.push({
      kind: "device", section: "device", id: "pkg:" + packageKey(device),
      category: info.category, name: device.model, detail: info.detail, statusBadge: info.statusBadge, device,
    });
  }
  for (const model of workspace.catalog?.models ?? []) {
    rows.push({
      kind: "physics", section: "physics", id: "model:" + model.id, category: "物理模型", name: model.name,
      detail: `入口文件 ${model.entry}`, model, statusBadge: { label: "多体模型", tone: "ready" },
    });
  }
  for (const row of workspace.catalog?.materials ?? []) {
    rows.push({
      kind: "material", section: "material", id: "material:" + row.id,
      category: row.id.startsWith("doc-") ? "设备手册" : row.id.startsWith("bom-") ? "BOM 物料" : "资料记录",
      name: row.name,
      detail: [`${row.quantity}${row.unit ? " " + row.unit : ""}`, row.manufacturer, row.model,
        row.leadMmPerRev !== undefined && `导程 ${row.leadMmPerRev} mm/rev`,
        row.massKg !== undefined && `移动质量 ${row.massKg} kg`,
        (row.massKg !== undefined || row.leadMmPerRev !== undefined) && row.source].filter(Boolean).join(" · "),
      statusBadge: row.binding
        ? { label: "已绑定模型", tone: "ready" }
        : row.leadMmPerRev !== undefined || row.massKg !== undefined
          ? { label: "含直线参数", tone: "ready" }
          : { label: "待建模", tone: "pending" },
      row,
    });
  }
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
  const resources = useMemo(() => projectResources(workspace), [workspace]);
  const componentKeys = useMemo(() => new Set(deviceLibraryGroups(workspace.packages).parts.map(packageKey)), [workspace.packages]);

  const filterCounts = useMemo(() => {
    const visibleAll = resources.filter(
      (item) => item.kind !== "device" || showComponents || !componentKeys.has(packageKey(item.device)),
    );
    const counts: Record<Filter, number> = { all: visibleAll.length, system: 0, device: 0, physics: 0, material: 0 };
    for (const item of visibleAll) counts[item.section]++;
    return counts;
  }, [resources, showComponents, componentKeys]);

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
        : <><Button size="sm" variant="ghost" onClick={() => void run(() => onPreviewDevice(item.device, true))}>参数详情</Button>
        <Button size="sm" variant="outline" onClick={() => void run(() => onOpenDevice(item.device))}><Package />带入装配</Button></>;
      case "physics": return <><Button size="sm" variant="outline" onClick={() => void run(() => onOpenModel(item.model))}><Play />打开模型</Button>
        <Button size="sm" variant="ghost" aria-label="下载模型 ZIP" onClick={() => void run(() => download(item.model))}><Download />下载 ZIP</Button></>;
      case "material": return <Button size="sm" variant="outline" onClick={() => { setError(""); setSelected(item.row.id); }}><Link2 />查看与绑定</Button>;
      case "system": return <Button size="sm" variant="outline" onClick={() => void run(() => onOpenSystem(item.system))}>{item.action}</Button>;
    }
  }

  return <section className="min-w-0 space-y-3.5" aria-label="设备与资料">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="display-title text-xl font-semibold tracking-tight sm:text-2xl">设备与资料库</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">① 拍照或导入真实器件参数 → ② 绑定严格模型注册表 → ③ 进入装配与闭环对标</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setRegistryOpen(true)}><Cpu />模型注册表 ({registeredModels.length})</Button>
        <Button size="sm" variant="secondary" onClick={onCreateDevice}><Plus />新建参数化设备</Button>
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
    <section className="surface min-w-0 space-y-3 p-4" aria-label="工程资源清单">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold sm:text-base">资源清单</h2>
          <div role="tablist" aria-label="资源分类筛选" className="flex flex-wrap items-center gap-1 rounded-md border bg-background/60 p-0.5">
            {filters.map(({ key, label }) => {
              const count = filterCounts[key];
              if (key !== "all" && filter !== key && count === 0) return null;
              const selectedTab = filter === key;
              return (
                <Button
                  key={key}
                  size="sm"
                  type="button"
                  role="tab"
                  aria-selected={selectedTab}
                  variant={selectedTab ? "secondary" : "ghost"}
                  className="h-7 px-2 text-xs"
                  onClick={() => choose(key)}
                >
                  <span>{label}</span>
                  <span className="mono ml-1 text-[10px] text-muted-foreground">{count}</span>
                </Button>
              );
            })}
          </div>
        </div>
        {resources.length > 0 && (
          <label className="relative block min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input type="search" className="h-8 pl-8 text-xs" aria-label="搜索工程资源" placeholder={componentKeys.size ? "搜索设备型号、参数或子件…" : "搜索工程资源…"} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
      </div>
      {!!componentKeys.size && !query.trim() && (filter === "all" || filter === "device") && <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showComponents} onChange={event => {
          setShowComponents(event.currentTarget.checked); setCursor({ filter, query, page: 0 });
        }} />显示随附子件（{componentKeys.size} 个修订）
      </label>}
      {!resources.length ? <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3.5">
        <p className="text-xs text-muted-foreground">当前工程还没有设备或模型。点击上方拍照识别一键试玩，或直接载入参考工程模板。</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate(studioHref({ view: "workbench", exampleId: "closed-loop-feed-system" }))}><Play />体验跨品牌闭环与实测对标</Button>
          <Button size="sm" variant="outline" onClick={onBrowseExamples}><BookOpen />浏览参考模板</Button>
        </div>
      </div> : !rows.length ? <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">当前筛选下没有匹配的资源。</p>
        <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setCursor({ filter: "all", query: "", page: 0 }); choose("all"); }}>显示全部</Button>
      </div> : <>
        <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_8.5rem_14rem] gap-x-4 border-t pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground sm:grid">
          <span>资源名称与规格摘要</span><span>类别与就绪状态</span><span className="text-right">操作</span>
        </div>
        <ul aria-label="工程资源列表" className="divide-y border-t sm:border-t-0">
        {rows.map((item) => <li key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_8.5rem_14rem]">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{item.name}</p>
            <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.detail}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:flex-col sm:items-start sm:gap-1">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground/90">{item.category}</span>
            {item.statusBadge && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                item.statusBadge.tone === "ready"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : item.statusBadge.tone === "pending"
                    ? "bg-amber-500/15 text-amber-200"
                    : "bg-muted/70 text-muted-foreground"
              }`}>
                {item.statusBadge.label}
              </span>
            )}
          </div>
          <div className="col-span-2 flex flex-wrap gap-1.5 sm:col-auto sm:justify-end">{actions(item)}</div>
        </li>)}
        </ul>
      </>}
      {lastPage > 0 && <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3 text-xs">
        <Button variant="outline" size="sm" disabled={!page} onClick={() => setCursor({ filter, query, page: page - 1 })}>上一页</Button>
        {page + 1} / {lastPage + 1}
        <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setCursor({ filter, query, page: page + 1 })}>下一页</Button>
      </div>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
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
