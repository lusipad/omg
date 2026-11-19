import { useDeferredValue, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { applyMiloBomImport, importedServoPair } from "@contracts/import-apply";
import type { MaterialRow } from "@contracts/import-catalog";
import { matchMaterials } from "@contracts/material-import";
import type { MiloAxisId } from "@contracts/milo-bom";
import { isSo101ServoPart, so101BomNotes } from "@contracts/so101-bom";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { importMaterialRows, type ImportOverrides, type WorkbenchImportCandidate } from "@/lib/workbench-import";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import TwinPackagePreview, { DeviceSourceEvidence, ServoRatings } from "./TwinPackagePreview";

type Props = {
  candidate: WorkbenchImportCandidate;
  workspace: TwinWorkspace;
  confirmed: boolean;
  busy: boolean;
  error: string;
  onConfirm: (overrides?: ImportOverrides) => void;
  onUseManual: (overrides: ImportOverrides) => void;
  onClose: () => void;
  onAssemble: (device: DevicePackage) => void;
};
const labels = {
  project: ["核对工程", "确认替换工程"],
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
  const rows: [string, number | string, number | string][] = [
    ["设备包", current.packages.length, next.packages.length],
    ["设备实例", current.instances.length, next.instances.length],
    ["信号连线", current.connections.length, next.connections.length],
    ["物理模型", current.catalog?.models.length ?? 0, next.catalog?.models.length ?? 0],
    ["物料与手册", current.catalog?.materials.length ?? 0, next.catalog?.materials.length ?? 0],
  ];
  if (current.servoAxis || next.servoAxis) rows.push(["伺服轴", current.servoAxis ? "已组轴" : "—", next.servoAxis ? "已组轴" : "—"]);
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
  </>;
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
        <p className="break-words text-xs text-muted-foreground">{[row.manufacturer, row.model, row.binding ? "已有可用模型" : "待建模"].filter(Boolean).join(" · ")}</p>
        {row.source && <p className="break-all text-xs text-muted-foreground">来源 · {row.source}</p>}
      </li>)}
    </ul>
    {last > 0 && <div className="flex items-center justify-end gap-2 text-xs">
      <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setPage(index - 1)}>上一页</Button>{index + 1} / {last + 1}
      <Button size="sm" variant="outline" disabled={index === last} onClick={() => setPage(index + 1)}>下一页</Button>
    </div>}
  </>;
}

export default function WorkbenchImportPreview({ candidate, workspace, busy, confirmed, error, onConfirm, onUseManual, onClose, onAssemble }: Props) {
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
      return { rows, kept, issue: "" };
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
    <TwinPackagePreview device={candidate.device} installed={confirmed} error={error} onClose={close}
      onInstall={() => { if (!busy && !confirmed) onConfirm(); }} onAssemble={() => { if (!busy && confirmed) onAssemble(candidate.device); }} />
  </div>;

  const [heading, action] = labels[candidate.kind];
  const editable = candidate.kind === "manual" || candidate.kind === "materials";
  const waiting = editable && (draft.title !== title || draft.source !== source || draft.text !== text);
  const unavailable = busy || confirmed || waiting || !!checked.issue;
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent showCloseButton={!busy} className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-[690px]">
      <DialogHeader><DialogTitle>{heading}</DialogTitle><DialogDescription className="break-all">{candidate.name || "粘贴内容"}</DialogDescription></DialogHeader>
      {candidate.kind === "project" && <ProjectSummary current={workspace} candidate={candidate} />}
      {candidate.kind === "devices" && <>
        <p className="text-sm">确认后将这 {candidate.devices.length} 个设备包一起安装到当前工程。相同型号及修订出现内容冲突时，整批安装会停止。</p>
        <p className="text-xs text-muted-foreground">{importedServoPair(candidate.devices) ? "这组驱动器和电机已声明配套。安装后将打开伺服轴工作台，由你核对型号并组轴。" : "安装后可在设备包列表逐个选用。"}</p>
        <ul aria-label="待安装设备包" className="max-h-72 divide-y overflow-auto rounded-md border px-3">
          {candidate.devices.map((device, i) => <li key={`${packageKey(device)}-${i}`} className="py-2"><details>
            <summary className="cursor-pointer break-words text-sm"><strong>{device.model}</strong> · {device.manufacturer} · {device.revision}</summary>
            <div className="mt-2 space-y-2"><DeviceSourceEvidence source={device.source} />
              {device.servo ? <ServoRatings servo={device.servo} /> : <p className="text-xs text-muted-foreground">{device.ports.length} 个端口 · {device.rules.length} 条行为规则</p>}
            </div>
          </details></li>)}
        </ul>
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
        <p className="text-sm leading-6">将 {lineCount(candidate.program)} 行 G 代码载入 Milo v1.5 程序草稿。{workspace.milo?.program && workspace.milo.program !== candidate.program
          ? `此次导入会替换已保存的 ${lineCount(workspace.milo.program)} 行程序。` : ""}实际运行由你在三轴装配完成后启动。</p>
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
