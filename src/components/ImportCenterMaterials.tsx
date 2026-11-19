import { useRef, useState } from "react";
import { Link } from "react-router";
import { FileText, Link2, Play, Upload } from "lucide-react";
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

type Props = {
  workspace: TwinWorkspace;
  onChange: (workspace: TwinWorkspace) => void;
  onOpenDevice: (device: DevicePackage) => void;
  onOpenPhysics: (model: ModelRef) => void;
  onUseSource: (row: MaterialRow) => void;
  onImportFiles: (files: File[], options?: WorkbenchImportOptions) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
};
const pageSize = 16;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "资料操作失败，请重试。";

function sourceLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export default function ImportCenterMaterials({ workspace, onChange, onOpenDevice, onOpenPhysics, onUseSource, onImportFiles, onImportText }: Props) {
  const [kind, setKind] = useState<"bom" | "manual">("bom");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const catalog = workspace.catalog ?? { models: [], materials: [] };
  const row = catalog.materials.find((item) => item.id === selected);
  const url = row?.source && sourceLink(row.source);
  const devices = new Map(workspace.packages.map((device) => [packageKey(device), device]));
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const filtered = catalog.materials.filter((item) => [item.name, item.manufacturer, item.model].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);

  function options(): WorkbenchImportOptions {
    return { hint: kind, source: source.trim() || undefined, title: kind === "manual" ? name.trim() || undefined : undefined };
  }

  function preview() {
    setError("");
    const label = kind === "bom" ? "粘贴的采购清单" : "粘贴的手册";
    onImportText(content, label, options());
  }

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
      setSelected("");
    } catch (cause) { setError(errorText(cause)); }
  }

  return <div className="min-w-0 space-y-4">
    <details className="surface min-w-0 p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-medium">手工录入或指定资料用途</summary>
      <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">资料用途</h3>
        <div className="flex flex-wrap gap-1">
          {(["bom", "manual"] as const).map((mode) => <Button size="sm" key={mode} variant={kind === mode ? "secondary" : "ghost"} aria-pressed={kind === mode}
            onClick={() => { setKind(mode); setError(""); }}>{mode === "bom" ? "物料清单" : "设备手册"}</Button>)}
        </div>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{kind === "bom" ? "CSV、TSV 需有名称和数量列，可附单位、制造商、型号及来源。SO-101 和 Milo 的官方 Markdown 清单可在预览中核对装配用途。" : IS_PAGES
        ? "可导入 TXT、Markdown，或粘贴 PDF 的相关章节。原文随资料记录保存。"
        : "可导入 PDF、TXT、Markdown，或粘贴规格原文。核对提取的章节后保存。"}</p>
      <input ref={fileInput} className="hidden" aria-label="选择 BOM 或手册文件" type="file" accept={IS_PAGES ? ".csv,.tsv,.txt,.md,.markdown" : ".csv,.tsv,.txt,.md,.markdown,.pdf"} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) { setError(""); onImportFiles([file], options()); }
      }} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}><Upload />选择资料文件</Button>
        {kind === "bom" && <Link to="?view=milo" className="text-sm text-primary underline-offset-4 hover:underline">从官网导入 Milo v1.5 BOM</Link>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {kind === "manual" && <label><span className="field-label">手册名称</span><Input value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <label className={kind === "bom" ? "sm:col-span-2" : ""}><span className="field-label">资料来源</span>
          <Input value={source} placeholder="网址、文件名、修订或章节（可选）" onChange={(event) => setSource(event.target.value)} />
        </label>
      </div>
      <label className="block" htmlFor="import-material-body"><span className="field-label">资料正文</span></label>
      <Textarea id="import-material-body" className="h-28 resize-y" value={content} placeholder={kind === "bom" ? "名称,数量,单位,制造商,型号" : "粘贴手册或选型表文字"}
        onChange={(event) => setContent(event.target.value)} />
      <Button disabled={!content.trim()} onClick={preview}>预览资料</Button>
      {error && !row && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      </div>
    </details>
    <section className="surface min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">物料与手册 <span className="mono text-sm text-muted-foreground">{catalog.materials.length}</span></h3>
        {catalog.materials.length > 0 && <Input aria-label="搜索物料和手册" className="sm:max-w-64" value={query} placeholder="搜索名称、制造商或型号" onChange={(event) => { setQuery(event.target.value); setPage(0); }} />}
      </div>
      {filtered.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{catalog.materials.length ? "没有匹配的资料。" : "保存清单或手册后，可为记录绑定物理模型或设备包。"}</p> :
        <ul className="mt-2 divide-y">{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}</p>
            <p className="break-words text-xs text-muted-foreground">{item.quantity} {item.unit} · {item.manufacturer && `${item.manufacturer} · `}{item.model && `${item.model} · `}{item.binding ? "已绑定模型" : "待建模"}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setSelected(item.id); setError(""); }}><Link2 />查看与绑定</Button>
        </li>)}</ul>}
      {lastPage > 0 && <div className="mt-3 flex items-center justify-end gap-2 text-xs">
        <Button variant="outline" size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button>{currentPage + 1} / {lastPage + 1}
        <Button variant="outline" size="sm" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button>
      </div>}
    </section>
    {row && <Dialog open onOpenChange={(open) => { if (!open) { setSelected(""); setError(""); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[680px]">
        <DialogHeader><DialogTitle className="break-words">{row.name}</DialogTitle>
          <DialogDescription>{row.quantity} {row.unit} · {row.manufacturer && `${row.manufacturer} · `}{row.model && `${row.model} · `}{row.binding ? "已绑定模型" : "待建模"}</DialogDescription>
        </DialogHeader>
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
            <option value="">待建模 · 尚未绑定</option>
            {models.size > 0 && <optgroup label="物理模型">{catalog.models.map((ref) => <option value={JSON.stringify(["physics", ref.id])} key={ref.id}>{ref.name} · {ref.entry} · {ref.id.slice(0, 10)}</option>)}</optgroup>}
            {devices.size > 0 && <optgroup label="设备包">{workspace.packages.map((device) => <option key={packageKey(device)} value={JSON.stringify(["device", packageKey(device)])}>{device.manufacturer} · {device.model} · {device.revision}</option>)}</optgroup>}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {row.binding && <Button onClick={() => openBinding(row)}><Play />运行绑定模型</Button>}
          <Button variant="outline" onClick={() => { onUseSource(row); setSelected(""); }}><FileText />从资料生成设备包</Button>
        </div>
        <MaterialCalibration material={row} onInstall={(device) => bind(row, { kind: "device", key: packageKey(device) }, installPackage(workspace, device))} />
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>}
  </div>;
}
