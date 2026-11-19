import { useDeferredValue, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { applyMiloBomImport, importedServoPair } from "@contracts/import-apply";
import type { MaterialRow } from "@contracts/import-catalog";
import { inspectFactoryLayout, type FactoryLayout } from "@contracts/factory";
import { compositionKind } from "@contracts/device-composition";
import { inspectLinearAssembly, type LinearAssembly } from "@contracts/linear-assembly";
import { inspectMechanicalAssembly, installMechanicalBundle, type MechanicalAssembly } from "@contracts/mechanical-assembly";
import { matchMaterials } from "@contracts/material-import";
import type { MiloAxisId } from "@contracts/milo-bom";
import { isSo101ServoPart, so101BomNotes } from "@contracts/so101-bom";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { installPackage, type TwinWorkspace } from "@contracts/twin-simulation";
import { importMaterialRows, type ImportOverrides, type WorkbenchImportCandidate } from "@/lib/workbench-import";
import { deviceLibraryGroups, previewDevicePackages } from "@/lib/device-library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import TwinPackagePreview, { DeviceSourceEvidence, FactoryRatings, FeedRatings, MechanicalDefinitionDetails, MechanicalDetails, MotorRatings, ServoRatings } from "./TwinPackagePreview";
import PackageStructure, { type ApplyDeviceRevision } from "./PackageStructure";

type Props = {
  candidate: WorkbenchImportCandidate;
  gcodeTarget?: string;
  workspace: TwinWorkspace;
  confirmed: boolean;
  busy: boolean;
  error: string;
  onConfirm: (overrides?: ImportOverrides) => void;
  onUseManual: (overrides: ImportOverrides) => void;
  onClose: () => void;
  onAssemble: (device: DevicePackage, mode?: "factory" | "motor") => void;
  onApplyDeviceRevision?: ApplyDeviceRevision;
};
const labels = {
  project: ["核对工程", "确认替换工程"],
  assembly: ["核对直线轴装配", "保存装配定义"],
  factory: ["核对工厂布局", "保存工厂布局"],
  mechanism: ["核对机械装配", "保存机械装配"],
  "mechanical-bundle": ["核对可复用机械包", "增量安装机械包"],
  devices: ["核对批量设备包", "确认批量安装"],
  materials: ["核对物料清单", "保存物料资料"],
  manual: ["核对设备手册", "保存手册"],
  "milo-bom": ["核对 Milo v1.5 采购清单", "导入 Milo BOM"],
  "so101-bom": ["核对 SO-101 从臂采购清单", "导入 SO-101 BOM"],
  gcode: ["核对 G 代码草稿", "载入 G 代码草稿"],
  "source-link": ["制造商资料链接", "带入设备资料"],
} as const;
function lineCount(text: string) {
  let count = text.length ? 1 : 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) count++;
  }
  return count;
}

function ProjectSummary({ candidate, current }: { candidate: Extract<WorkbenchImportCandidate, { kind: "project" }>; current: TwinWorkspace }) {
  const next = candidate.workspace;
  const [showDevices, setShowDevices] = useState(false);
  const rows: [string, number | string, number | string][] = [
    ["设备包", current.packages.length, next.packages.length],
    ["设备实例", current.instances.length, next.instances.length],
    ["信号连线", current.connections.length, next.connections.length],
    ["物理模型", current.catalog?.models.length ?? 0, next.catalog?.models.length ?? 0],
    ["物料与手册", current.catalog?.materials.length ?? 0, next.catalog?.materials.length ?? 0],
    ["直线轴装配", current.assemblies?.length ?? 0, next.assemblies?.length ?? 0],
    ["机械装配", current.mechanisms?.length ?? 0, next.mechanisms?.length ?? 0],
  ];
  const packaged = (ws: TwinWorkspace) => ws.packages.filter((pkg) => pkg.mechanics?.kind === "assembly").length;
  if (current.factories?.length || next.factories?.length) {
    const summary = (ws: TwinWorkspace) => ws.factories?.map(f => `${f.name}（${f.lines.length} 条产线，${f.resources.length} 台设备）`).join("、") || "—";
    rows.push(["工厂布局", summary(current), summary(next)]);
  }
  const beforePackaged = packaged(current), afterPackaged = packaged(next);
  if (beforePackaged || afterPackaged) rows.push(["已封装机械装配包", beforePackaged, afterPackaged]);
  const feedModels = (ws: TwinWorkspace) => ws.assemblies?.flatMap(assembly => assembly.modelRef
    ? [`${assembly.name} · ${assembly.modelRef.id} @ ${assembly.modelRef.version}`] : []).join("、");
  const beforeFeed = feedModels(current), afterFeed = feedModels(next);
  if (beforeFeed || afterFeed) rows.push(["直线轴求解模型", beforeFeed || "—", afterFeed || "—"]);
  if (current.servoAxis || next.servoAxis) {
    const name = (axis: TwinWorkspace["servoAxis"]) => axis?.modelRef ? `${axis.modelRef.id} @ ${axis.modelRef.version}` : axis ? "已组轴" : "—";
    rows.push(["伺服轴", name(current.servoAxis), name(next.servoAxis)]);
  }
  if (current.so101 || next.so101) rows.push(["SO-101 从臂", current.so101 ? `${current.so101.waypoints.length} 个关键帧` : "—", next.so101 ? `${next.so101.waypoints.length} 个关键帧` : "—"]);
  if (current.milo || next.milo) {
    const milo = (machine: TwinWorkspace["milo"]) => machine ? `${machine.assembled.length} 轴 / ${lineCount(machine.program)} 行程序` : "—";
    rows.push(["Milo v1.5", milo(current.milo), milo(next.milo)]);
  }
  return <>
    <p className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm leading-6">确认后，导入文件将替换当前浏览器中的整个工程及其装配。需要保留当前工程时，可先取消并导出备份。</p>
    <table aria-label="工程内容对照" className="w-full table-fixed border-collapse text-left text-sm">
      <thead><tr className="border-b"><th className="py-2">工程内容</th><th scope="col">当前工程</th><th scope="col">导入后</th></tr></thead>
      <tbody>{rows.map(([label, before, after]) => <tr key={label} className="border-b border-border/60">
        <th scope="row" className="py-2 pr-2 text-xs font-normal text-muted-foreground">{label}</th><td className="break-words pr-2">{before}</td><td className="break-words font-medium">{after}</td>
      </tr>)}</tbody>
    </table>
    {candidate.models !== undefined ? <p className="text-xs text-muted-foreground">工程 ZIP 附带 {candidate.models.length} 组物理模型资源，确认后一起恢复。</p> :
      !!next.catalog?.models.length && <p className="text-xs text-muted-foreground">工程 JSON 引用本机的 {next.catalog.models.length} 个物理模型。恢复这些模型需要已保存在此浏览器中的对应文件。</p>}
    {next.packages.some(p => compositionKind(p) === "assembly") && <details className="rounded-md border p-3 text-sm"
      onToggle={event => setShowDevices(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">查看工程设备与子件</summary>
      {showDevices && <div className="mt-3"><PackageList workspace={next} devices={next.packages} /></div>}
    </details>}
  </>;
}

function AssemblySummary({ definition, workspace }: { definition: LinearAssembly; workspace: TwinWorkspace }) {
  const previous = workspace.assemblies?.find((item) => item.id === definition.id);
  const issues = inspectLinearAssembly(workspace, definition);
  const materials = new Map(workspace.catalog?.materials.map((row) => [row.id, row.name]));
  const part = (ref: string) => materials.get(ref) ?? (ref || "待指定");
  return <>
    <div>
      <h3 className="break-words text-base font-semibold">{definition.name}</h3>
      <p className="mt-1 break-all text-xs text-muted-foreground">ID {definition.id} · {definition.modules.length} 个轴模块 · {definition.axes.length} 个轴实例</p>
      {definition.modelRef && <p className="mono mt-1 break-all text-xs">求解模型 · {definition.modelRef.id} @ {definition.modelRef.version}</p>}
    </div>
    {previous && <p className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm leading-6">
      当前工程已有同一 ID 的“{previous.name}”。{previous.name !== definition.name && <>新名称为“{definition.name}”。</>}本次仅替换这份装配的定义及各轴目标位移。
    </p>}
    <div className="max-h-48 overflow-auto rounded-md border">
      <table aria-label="轴与模块的对应关系" className="w-full table-fixed border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-muted"><tr><th className="p-2">轴</th><th className="p-2">引用模块</th><th className="p-2">方向向量</th><th className="p-2 text-right">目标（mm）</th></tr></thead>
        <tbody>{definition.axes.map((axis) => <tr key={axis.id} className="border-t">
          <th scope="row" className="break-all p-2 font-medium">{axis.id}</th><td className="break-all p-2">{axis.module}</td>
          <td className="break-words p-2">{axis.direction.join(", ")}</td><td className="break-all p-2 text-right">{axis.targetMm}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <section><h3 className="mb-2 text-sm font-medium">模块使用的 BOM 物料</h3>
      <ul aria-label="装配引用的物料" className="max-h-56 divide-y overflow-auto rounded-md border px-3">
        {definition.modules.map((mod) => <li key={mod.id} className="space-y-1 py-2 text-xs">
          <strong className="break-all">{mod.id}</strong>
          <p className="flex flex-wrap gap-x-4 break-words leading-5"><span>驱动器 · {part(mod.drive)}</span><span>电机 · {part(mod.motor)}</span><span>丝杠 · {part(mod.screw)}</span>
            {definition.modelRef && <span>工作台 · {part(mod.table ?? "")}</span>}</p>
          <p className="flex flex-wrap gap-x-4 text-muted-foreground"><span>导程 · {mod.leadMmPerRev === null ? "由装配物料提供或待补" : mod.leadMmPerRev + " mm/rev"}</span>
            {!definition.modelRef && <span>负载惯量比 · {mod.loadInertiaRatio}</span>}</p>
        </li>)}
      </ul>
    </section>
    {issues.length ? <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-5">
      <p className="font-semibold">运行前待处理 {issues.length} 项，可先保存装配定义。</p>
      <ul aria-label="装配待处理项" className="mt-1 max-h-36 list-disc overflow-auto pl-5">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
    </div> : <p className="text-xs text-muted-foreground">当前工程的物料和设备满足这份装配的运行检查。</p>}
  </>;
}

function MechanismSummary({ definition, workspace }: { definition: MechanicalAssembly; workspace: TwinWorkspace }) {
  const previous = workspace.mechanisms?.find((item) => item.id === definition.id);
  const issues = inspectMechanicalAssembly(workspace, definition);
  return <>
    <div><h3 className="break-words text-base font-semibold">{definition.name}</h3>
      <p className="mt-1 break-all text-xs text-muted-foreground">ID {definition.id} · {definition.nodes.length} 个机械节点</p></div>
    {previous && <p className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm leading-6">
      当前工程已有同一 ID 的“{previous.name}”。{previous.name !== definition.name && <>新名称为“{definition.name}”。</>}本次替换范围仅限此机械装配的节点、安装关系、输出和控制量。
    </p>}
    <MechanicalDefinitionDetails definition={definition} packages={workspace.packages} />
    {issues.length ? <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-5">
      <p className="font-semibold">运行前待处理 {issues.length} 项，可先保存装配草稿。</p>
      <ul aria-label="机械装配待处理项" className="mt-1 max-h-36 list-disc overflow-auto pl-5">{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
    </div> : <p className="text-xs text-muted-foreground">当前工程已满足这份机械装配的接口与资源检查。</p>}
  </>;
}

function FactorySummary({ layout, workspace }: { layout: FactoryLayout; workspace: TwinWorkspace }) {
  const issues = inspectFactoryLayout(workspace, layout), old = workspace.factories?.find(f => f.id === layout.id);
  return <div className="space-y-3">
    <h3 className="break-words font-semibold">{layout.name}</h3>
    <p className="text-sm">{layout.resources.length} 台设备 · {layout.lines.length} 条产线 · 投放 {layout.lines.reduce((sum, l) => sum + l.batch.quantity, 0)} 件</p>
    <ul className="space-y-1 text-xs">{layout.lines.map(line => <li key={line.id}>{line.name} · {line.stages.map(s => s.name).join(" → ")}</li>)}</ul>
    {old && <p className="text-xs text-amber-300">确认后会替换“{old.name}”的设备布置、工艺路线和批次。</p>}
    {issues.length > 0 && <details className="text-xs text-amber-300"><summary>运行前待补 {issues.length} 项，可先保存布局</summary>
      <ul className="mt-2 space-y-1">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
  </div>;
}

function PackageList({ workspace, devices, rootKey }: { workspace: TwinWorkspace; devices: DevicePackage[]; rootKey?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showParts, setShowParts] = useState(false);
  const groups = useMemo(() => deviceLibraryGroups(devices), [devices]);
  const preview = useMemo(() => previewDevicePackages(workspace, devices), [workspace, devices]);
  const active = devices.find(device => packageKey(device) === selected);
  if (active) return <div className="space-y-3">
    <Button size="sm" variant="outline" onClick={() => setSelected(null)}>返回设备包清单</Button>
    <PackageStructure device={active} workspace={preview} />
  </div>;
  function rows(items: DevicePackage[], label: string) {
    return <ul aria-label={label} className="max-h-72 divide-y overflow-auto rounded-md border px-3">
    {items.map((device) => {
      const key = packageKey(device);
      return <li key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-1 py-2"><details className="min-w-0">
        <summary className="cursor-pointer break-words text-sm"><strong>{device.model}</strong>
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{device.manufacturer} · 修订 {device.revision}{key === rootKey && " · 根设备"}</span></summary>
        <div className="mt-2 space-y-2"><DeviceSourceEvidence source={device.source} />
          {device.mechanics && <MechanicalDetails mechanics={device.mechanics} />}
          {device.feed && <FeedRatings feed={device.feed} />}
          {device.motorPhysics && <MotorRatings device={device} />}
          {device.factory && <FactoryRatings device={device} packages={preview.packages} />}
          {device.servo && <ServoRatings servo={device.servo} />}
          {device.ports.length > 0 && <p className="text-xs text-muted-foreground">{device.ports.length} 个端口 · {device.rules.length} 条行为规则</p>}
        </div>
      </details><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label={device.model + " 部件结构"} onClick={() => setSelected(key)}>部件结构</Button></li>;
    })}
  </ul>;
  }
  return <div className="space-y-2">
    {groups.parts.length > 0 && <p className="text-xs text-muted-foreground">根设备与独立修订 {groups.roots.length} 个 · 随附子件 {groups.parts.length} 个修订</p>}
    {rows(groups.roots, "待安装设备包")}
    {groups.parts.length > 0 && <details className="rounded-md border p-3 text-xs" onToggle={event => setShowParts(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">随附子件（{groups.parts.length} 个修订）</summary>
      {showParts && <div className="mt-2">{rows(groups.parts, "待安装子件")}</div>}
    </details>}
  </div>;
}

function BomTable({ rows }: { rows: { name: string; quantity: string | number }[] }) {
  return <div className="max-h-56 overflow-auto rounded-md border">
    <table aria-label="采购条目" className="w-full table-fixed border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-muted"><tr><th className="p-2">物料名称</th><th className="w-1/4 p-2 text-right">原数量</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index} className="border-t"><td className="break-words p-2">{row.name}</td><td className="break-words p-2 text-right">{row.quantity}</td></tr>)}</tbody>
    </table>
  </div>;
}

function MiloSummary({ candidate, workspace, kept }: { candidate: Extract<WorkbenchImportCandidate, { kind: "milo-bom" }>; workspace: TwinWorkspace; kept?: MiloAxisId[] }) {
  const groups = [...new Set<string>(candidate.bom.map((row) => row.category))];
  const [chosen, setChosen] = useState("Motion");
  const group = groups.includes(chosen) ? chosen : groups[0];
  const before = workspace.milo?.assembled ?? [];
  const removed = kept ? before.filter((axis) => !kept.includes(axis)) : [];
  return <>
    <p className="text-sm leading-6">将 {groups.length} 组、{candidate.bom.length} 行采购物料载入 Milo v1.5 的逐轴装配工作台。</p>
    {!!before.length && kept && <p className="surface-inset rounded-md p-3 text-sm">核算后已装配轴为 {kept.join("、") || "0 根"}。{removed.length ? `${removed.join("、")} 轴因关键件不足回到待装配。` : ""}</p>}
    <label className="block"><span className="field-label">物料分组</span>
      <select aria-label="预览 BOM 分组" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={group} onChange={(event) => setChosen(event.target.value)}>
        {groups.map((item) => <option key={item}>{item}</option>)}
      </select>
    </label>
    <BomTable rows={candidate.bom.filter((row) => row.category === group)} />
  </>;
}

function MaterialRows({ rows }: { rows: MaterialRow[] }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(rows.length / 12) - 1), index = Math.min(last, page);
  return <>
    <ul aria-label="待保存物料" className="max-h-60 divide-y overflow-auto rounded-md border px-3">
      {rows.slice(index * 12, (index + 1) * 12).map((row) => <li key={row.id} className="space-y-1 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3"><strong className="break-words text-sm">{row.name}</strong><span className="text-xs">{row.quantity} {row.unit ?? "（未填单位）"}</span></div>
        <p className="break-words text-xs text-muted-foreground">{[row.manufacturer, row.model, row.leadMmPerRev !== undefined && `导程 ${row.leadMmPerRev} mm/rev`,
          row.massKg !== undefined && `移动质量 ${row.massKg} kg`, row.binding ? "已有可用模型" : row.massKg === undefined && row.leadMmPerRev === undefined && "待建模"].filter(Boolean).join(" · ")}</p>
        {row.source && <p className="break-all text-xs text-muted-foreground">来源 · {row.source}</p>}
      </li>)}
    </ul>
    {last > 0 && <div className="flex items-center justify-end gap-2 text-xs">
      <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setPage(index - 1)}>上一页</Button>{index + 1} / {last + 1}
      <Button size="sm" variant="outline" disabled={index === last} onClick={() => setPage(index + 1)}>下一页</Button>
    </div>}
  </>;
}

export default function WorkbenchImportPreview({ candidate, workspace, gcodeTarget, busy, confirmed, error, onConfirm, onUseManual, onClose, onAssemble, onApplyDeviceRevision }: Props) {
  const [edit, setEdit] = useState<{ owner: WorkbenchImportCandidate; title: string; source: string; text: string } | null>(null);
  const draft = edit?.owner === candidate ? edit : {
    owner: candidate, title: candidate.title ?? candidate.name.replace(/\.[^./\\]+$/, ""), source: candidate.source ?? "",
    text: candidate.kind === "manual" ? candidate.text : "",
  };
  const title = useDeferredValue(draft.title), source = useDeferredValue(draft.source), text = useDeferredValue(draft.text);
  const checked = useMemo(() => {
    try {
      const rows = candidate.kind === "materials" || candidate.kind === "manual" ? matchMaterials(importMaterialRows(candidate, { title, source, text }), workspace) : [];
      const kept = candidate.kind === "milo-bom" ? applyMiloBomImport(workspace, candidate.bom, candidate.source || candidate.name).milo.assembled : undefined;
      const added = candidate.kind === "mechanical-bundle" ? installMechanicalBundle(workspace, candidate.bundle).packages.length - workspace.packages.length
        : candidate.kind === "devices" ? candidate.devices.reduce(installPackage, workspace).packages.length - workspace.packages.length : undefined;
      return { rows, kept, added, issue: "" };
    }
    catch (cause) { return { rows: [], issue: cause instanceof Error ? cause.message : "请检查资料标题和来源。" }; }
  }, [candidate, title, source, text, workspace]);
  const close = () => { if (!busy) onClose(); };

  if (candidate.kind === "device") return <div className="contents" onClickCapture={(event) => {
    // 安装后同一位置会出现装配按钮，双击的第二次点击仍属于原安装动作。
    if (confirmed && event.detail > 1 && event.target instanceof Element && event.target.closest("button")) {
      event.preventDefault(); event.stopPropagation();
    }
  }}>
    <TwinPackagePreview device={candidate.device} workspace={workspace} installed={confirmed} error={error} onClose={close}
      onApplyDeviceRevision={confirmed ? onApplyDeviceRevision : undefined}
      onInstall={() => { if (!busy && !confirmed) onConfirm(); }} onAssemble={mode => { if (!busy && confirmed) onAssemble(candidate.device, mode); }} />
  </div>;

  const [heading, defaultAction] = labels[candidate.kind];
  const replacing = (candidate.kind === "assembly" && workspace.assemblies?.some((item) => item.id === candidate.assembly.id)) ||
    (candidate.kind === "mechanism" && workspace.mechanisms?.some((item) => item.id === candidate.assembly.id));
  const action = candidate.kind === "factory" && workspace.factories?.some(f => f.id === candidate.layout.id)
    ? "确认替换工厂布局" : replacing ? "确认替换装配" : defaultAction;
  const editable = candidate.kind === "manual" || candidate.kind === "materials";
  const waiting = editable && (draft.title !== title || draft.source !== source || draft.text !== text);
  const unavailable = busy || confirmed || waiting || !!checked.issue;
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent showCloseButton={!busy} className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-[690px]">
      <DialogHeader><DialogTitle>{heading}</DialogTitle><DialogDescription className="break-all">{candidate.name || "粘贴内容"}</DialogDescription></DialogHeader>
      {candidate.kind === "project" && <ProjectSummary current={workspace} candidate={candidate} />}
      {candidate.kind === "factory" && <FactorySummary layout={candidate.layout} workspace={workspace} />}
      {candidate.kind === "assembly" && <AssemblySummary definition={candidate.assembly} workspace={workspace} />}
      {candidate.kind === "mechanism" && <MechanismSummary definition={candidate.assembly} workspace={workspace} />}
      {candidate.kind === "mechanical-bundle" && <>
        <p className="text-sm leading-6">根设备和依赖共 {candidate.bundle.packages.length} 个设备修订，将增量安装到当前工程。相同修订可复用，任一同修订内容冲突会阻止整批安装。</p>
        {checked.added !== undefined && <p className="text-xs text-muted-foreground">新增 {checked.added} 个 · 复用 {candidate.bundle.packages.length - checked.added} 个</p>}
        <PackageList workspace={workspace} devices={candidate.bundle.packages} rootKey={candidate.bundle.rootKey} />
      </>}
      {candidate.kind === "devices" && <>
        <p className="text-sm">即将安装 {candidate.devices.length} 个设备修订。{checked.added !== undefined && `新增 ${checked.added} 个，复用 ${candidate.devices.length - checked.added} 个。`}</p>
        {importedServoPair(candidate.devices) && <p className="text-xs text-muted-foreground">这组驱动器和电机已声明配套，可用于组装伺服轴。</p>}
        <PackageList workspace={workspace} devices={candidate.devices} />
      </>}
      {candidate.kind === "milo-bom" && <MiloSummary candidate={candidate} workspace={workspace} kept={checked.kept} />}
      {candidate.kind === "so101-bom" && <>
        <p className="text-sm leading-6">将 {candidate.bom.length} 项物料载入 SO-101 Follower 工作台。清单包含 {candidate.bom.filter((row) => isSo101ServoPart(row.part)).reduce((sum, row) => sum + row.quantity, 0)} 个 STS3215 舵机，用于绑定从臂的六个关节。</p>
        <BomTable rows={candidate.bom.map((row) => ({ name: row.part, quantity: row.quantity }))} />
        {so101BomNotes(candidate.bom).map((note) => <p key={note} className="text-xs text-muted-foreground">{note}</p>)}
      </>}
      {(candidate.kind === "milo-bom" || candidate.kind === "so101-bom") && candidate.source && <p className="break-all text-xs text-muted-foreground">采购清单来源 · {candidate.source}</p>}
      {editable && <>
        <p className="text-sm">{candidate.kind === "manual" ? "手册正文将存入当前工程的“物料与手册”，供后续绑定或建立设备模型。" : `将在“物料与手册”中合并 ${candidate.rows.length} 条记录。可逐项核对数量、单位与来源。`}</p>
        {candidate.kind === "manual" && <label><span className="field-label">手册标题</span>
          <Input required disabled={busy} value={draft.title} onChange={(event) => setEdit({ ...draft, title: event.target.value })} />
        </label>}
        <label><span className="field-label">{candidate.kind === "materials" ? "默认来源" : "资料来源"}</span>
          <Input disabled={busy} value={draft.source} placeholder={candidate.kind === "materials" ? "用于清单内未填写来源的行（可选）" : "网址、文件或章节（可选）"}
            onChange={(event) => setEdit({ ...draft, source: event.target.value })} />
        </label>
        {candidate.kind === "manual" ? <div>
          <label htmlFor="workbench-manual-text" className="field-label"><span>手册正文</span><span className="font-normal text-muted-foreground">{lineCount(draft.text)} 行 · {draft.text.length} 字符</span></label>
          <Textarea id="workbench-manual-text" aria-label="手册正文" className="h-40 resize-y text-xs leading-5" value={draft.text} disabled={busy}
            onChange={(event) => setEdit({ ...draft, text: event.target.value })} />
          <p className="mt-1 text-xs text-muted-foreground">可在此选摘需要归档或用于建模的章节。</p>
        </div> : !checked.issue && <MaterialRows rows={checked.rows} />}
      </>}
      {candidate.kind === "gcode" && <>
          <p className="text-sm leading-6">将 {lineCount(candidate.program)} 行 G 代码载入 {gcodeTarget ?? "Milo v1.5"} 程序草稿。{!gcodeTarget && workspace.milo?.program && workspace.milo.program !== candidate.program
            ? `此次导入会替换已保存的 ${lineCount(workspace.milo.program)} 行程序。` : ""}可在三轴装配完成后运行。</p>
        <pre aria-label="待导入的 G 代码" className="mono max-h-64 overflow-auto rounded-md border p-3 text-xs leading-5">{candidate.program}</pre>
      </>}
      {candidate.kind === "source-link" && <>
        <p className="text-sm leading-6">将网址带入设备库的制造商资料表单，继续核对产品型号和规格原文。</p>
        <a href={candidate.url} target="_blank" rel="noreferrer" className="break-all text-sm text-primary hover:underline">{candidate.url} <ExternalLink className="inline size-3.5" /></a>
      </>}
      {(error || checked.issue) && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error || checked.issue}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={close}>取消</Button>
        {candidate.kind === "manual" && <Button variant="outline" disabled={unavailable} onClick={() => {
          if (!unavailable) onUseManual({ title: draft.title, source: draft.source, text: draft.text });
        }}>带入设备资料</Button>}
        <Button disabled={unavailable} onClick={() => {
          if (unavailable) return;
          if (candidate.kind === "manual") onConfirm({ title: draft.title, source: draft.source, text: draft.text });
          else if (candidate.kind === "materials") onConfirm({ source: draft.source });
          else onConfirm();
        }}>{busy && <Loader2 className="animate-spin" />}{busy ? "正在处理…" : action}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
