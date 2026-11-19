import { useRef, useState } from "react";
import { FileText, Play, Upload } from "lucide-react";
import { parseImportCatalog, type MaterialRow, type ModelRef } from "@contracts/import-catalog";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { installPackage, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IS_PAGES } from "@/const";
import type { WorkbenchImportOptions } from "@/lib/workbench-import";
import MaterialCalibration from "./MaterialCalibration";

export type MaterialIntakeProps = {
  onImportFiles: (files: File[], options?: WorkbenchImportOptions) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions, onCommitted?: () => void) => void;
};

export function MaterialIntake({ onImportFiles, onImportText }: MaterialIntakeProps) {
  const [kind, setKind] = useState<"bom" | "manual">("bom");
  const [draft, setDraft] = useState({ name: "", source: "", content: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const options: WorkbenchImportOptions = { hint: kind, source: draft.source.trim() || undefined, title: kind === "manual" ? draft.name.trim() || undefined : undefined };
  function edit(field: keyof typeof draft, value: string) {
    revision.current++;
    setDraft((previous) => ({ ...previous, [field]: value }));
  }
  function preview() {
    const submitted = ++revision.current;
    onImportText(draft.content, kind === "bom" ? "粘贴的采购清单" : "粘贴的手册", options, () => {
      if (revision.current !== submitted) return;
      revision.current++;
      setDraft({ name: "", source: "", content: "" });
    });
  }
  return <details className="min-w-0 border-t pt-3">
    <summary className="cursor-pointer text-xs text-muted-foreground">手工录入或指定资料用途 <span className="ml-1">· BOM / 设备手册</span></summary>
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2" aria-label="资料用途">
        {(["bom", "manual"] as const).map((mode) => <Button size="sm" key={mode} variant={kind === mode ? "secondary" : "ghost"} aria-pressed={kind === mode}
          onClick={() => { if (kind !== mode) { revision.current++; setKind(mode); } }}>{mode === "bom" ? "物料清单" : "设备手册"}</Button>)}
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{kind === "bom" ? "物料表需要名称和数量列，可附单位、制造商、型号及来源。" : IS_PAGES
        ? "可导入 TXT、Markdown，或粘贴 PDF 的相关章节。原文随资料记录保存。"
        : "可导入 PDF、TXT、Markdown，或粘贴规格原文。核对提取的章节后保存。"}</p>
      <input ref={fileInput} className="hidden" aria-label="选择 BOM 或手册文件" type="file" accept={IS_PAGES ? ".csv,.tsv,.txt,.md,.markdown" : ".csv,.tsv,.txt,.md,.markdown,.pdf"} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) onImportFiles([file], options);
      }} />
      <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}><Upload />选择资料文件</Button>
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === "manual" && <label><span className="field-label">手册名称</span><Input value={draft.name} onChange={(event) => edit("name", event.target.value)} /></label>}
        <label className={kind === "bom" ? "sm:col-span-2" : ""}><span className="field-label">资料来源</span>
          <Input value={draft.source} placeholder="网址、文件名、修订或章节（可选）" onChange={(event) => edit("source", event.target.value)} />
        </label>
      </div>
      <label className="block"><span className="field-label">资料正文</span>
        <Textarea className="h-28 resize-y" value={draft.content} placeholder={kind === "bom" ? "名称,数量,单位,制造商,型号" : "粘贴手册或选型表文字"}
          onChange={(event) => edit("content", event.target.value)} />
      </label>
      <Button disabled={!draft.content.trim()} onClick={preview}>预览资料</Button>
    </div>
  </details>;
}

type DetailProps = {
  workspace: TwinWorkspace;
  row: MaterialRow;
  onChange: (workspace: TwinWorkspace) => void;
  onOpenDevice: (device: DevicePackage) => void;
  onOpenPhysics: (model: ModelRef) => void;
  onUseSource: (row: MaterialRow) => void;
  onClose: () => void;
};

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "资料操作失败，请重试。";
function sourceLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export default function MaterialDetails({ workspace, row, onChange, onOpenDevice, onOpenPhysics, onUseSource, onClose }: DetailProps) {
  const [error, setError] = useState("");
  const catalog = workspace.catalog ?? { models: [], materials: [] };
  const url = row.source && sourceLink(row.source);
  const devices = new Map(workspace.packages.map((device) => [packageKey(device), device]));
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const hasFeedParameters = row.leadMmPerRev !== undefined || row.massKg !== undefined;
  const boundFeed = row.binding?.kind === "device" && devices.get(row.binding.key)?.feed;

  function bind(item: MaterialRow, binding: MaterialRow["binding"], base = workspace) {
    const previous = base.catalog;
    if (!previous) throw new Error("资料记录已变更，请重新打开。");
    const materials = previous.materials.map((current) => current.id === item.id ? { ...current, binding } : current);
    onChange({ ...base, catalog: parseImportCatalog({ ...previous, materials }, base.packages) });
  }

  function openBinding(item: MaterialRow) {
    try {
      const binding = item.binding;
      if (!binding) return;
      if (binding.kind === "device") {
        const device = devices.get(binding.key);
        if (!device) throw new Error("绑定的设备包已不可用。");
        onOpenDevice(device);
      } else {
        const model = models.get(binding.key);
        if (!model) throw new Error("绑定的物理模型已不可用。");
        onOpenPhysics(model);
      }
      onClose();
    } catch (cause) { setError(errorText(cause)); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) { onClose(); setError(""); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[680px]">
        <DialogHeader><DialogTitle className="break-words">{row.name}</DialogTitle>
          <DialogDescription>{row.quantity} {row.unit} · {row.manufacturer && `${row.manufacturer} · `}{row.model && `${row.model} · `}{row.binding ? "已绑定模型" : hasFeedParameters ? "直线轴装配参数" : "待建模"}</DialogDescription>
        </DialogHeader>
        {row.leadMmPerRev !== undefined && <div className="text-sm"><span className="field-label">BOM 丝杠导程</span>{row.leadMmPerRev} mm/rev</div>}
        {row.massKg !== undefined && <div className="text-sm"><span className="field-label">BOM 单件移动质量</span>{row.massKg} kg</div>}
        {row.source && <div className="break-words text-sm"><span className="field-label">资料来源</span>{url
          ? <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{row.source}</a> : row.source}</div>}
        {row.notes && <div><h3 className="field-label">资料原文与备注</h3><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-xs leading-5">{row.notes}</pre></div>}
        <label><span className="field-label">绑定模型</span>
          <select aria-label="绑定模型" className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={row.binding ? JSON.stringify([row.binding.kind, row.binding.key]) : ""} onChange={(event) => {
            try {
              const pair: [string, string] | null = event.target.value ? JSON.parse(event.target.value) : null;
              bind(row, pair ? { kind: pair[0] === "physics" ? "physics" : "device", key: pair[1] } : undefined); setError("");
            } catch (cause) { setError(errorText(cause)); }
          }}>
            <option value="">{hasFeedParameters ? "使用 BOM 中的物理参数" : "待建模 · 尚未绑定"}</option>
            {models.size > 0 && <optgroup label="物理模型">{catalog.models.map((ref) => <option value={JSON.stringify(["physics", ref.id])} key={ref.id}>{ref.name} · {ref.entry} · {ref.id.slice(0, 10)}</option>)}</optgroup>}
            {devices.size > 0 && <optgroup label="设备包">{workspace.packages.map((device) => <option key={packageKey(device)} value={JSON.stringify(["device", packageKey(device)])}>{device.manufacturer} · {device.model} · {device.revision}</option>)}</optgroup>}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {row.binding && <Button onClick={() => openBinding(row)}><Play />{boundFeed ? "用于直线轴装配" : "运行绑定模型"}</Button>}
          <Button variant="outline" onClick={() => { onUseSource(row); onClose(); }}><FileText />从资料生成设备包</Button>
        </div>
        <MaterialCalibration material={row} onInstall={(device) => bind(row, { kind: "device", key: packageKey(device) }, installPackage(workspace, device))} />
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>;
}
