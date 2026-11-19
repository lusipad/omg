import { lazy, Suspense, useId, useRef, useState, type ChangeEvent } from "react";
import { useSearchParams } from "react-router";
import { Boxes, ClipboardPaste, FileJson, FileText, FileUp, FolderInput, FolderOpen, Package } from "lucide-react";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { MaterialRow, ModelRef } from "@contracts/import-catalog";
import { WORKBENCH_FILE_ACCEPT, type IncomingWorkbenchModel, type WorkbenchImportOptions } from "@/lib/workbench-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import ImportCenterMaterials from "./ImportCenterMaterials";

const ImportCenterPhysics = lazy(() => import("./ImportCenterPhysics"));
const acceptedSuffixes = WORKBENCH_FILE_ACCEPT.split(",").filter((entry) => entry.startsWith("."));
type Intake = {
  onImportFiles: (files: File[], options?: WorkbenchImportOptions) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions, onCommitted?: () => void) => void;
};
type Props = Intake & {
  workspace: TwinWorkspace;
  onChange: (next: TwinWorkspace) => void;
  onOpenDevice: (device: DevicePackage) => void;
  onPreviewDevice: (device: DevicePackage, installed?: boolean) => void;
  onUseSource: (row: MaterialRow) => void;
  incomingModel?: IncomingWorkbenchModel | null;
};
const emptyPaste = { text: "", name: "", source: "" };

function ImportEntry({ onImportFiles, onImportText }: Intake) {
  const files = useRef<HTMLInputElement>(null), directory = useRef<HTMLInputElement>(null);
  const pasteId = useId();
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><FolderInput className="size-5 text-primary" />导入自己的模型和资料</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">选择文件或粘贴内容即可自动识别。模型引用外部网格、纹理时，可选择整个文件夹。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => files.current?.click()}><FileUp />选择文件</Button>
        <Button variant="outline" onClick={() => directory.current?.click()}><FolderOpen />选择文件夹</Button>
        <Button variant="outline" aria-expanded={pasteOpen} aria-controls={pasteId} onClick={() => {
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
        <Textarea autoFocus aria-label="待导入内容或链接" className="h-32 resize-y" placeholder="粘贴模型 XML、设备包 JSON、清单、手册原文、G 代码或一个 HTTP(S) 链接"
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
  </section>;
}

function InstalledDevices({ workspace, onOpenDevice, onPreviewDevice }: Pick<Props, "workspace" | "onOpenDevice" | "onPreviewDevice">) {
  const [error, setError] = useState("");
  function open(device: DevicePackage, details: boolean) {
    setError("");
    try { if (details) onPreviewDevice(device, true); else onOpenDevice(device); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开设备。"); }
  }
  return <section className="surface min-w-0 p-4 sm:p-5">
    <h3 className="text-base font-semibold">已安装设备包 <span className="mono text-sm text-muted-foreground">{workspace.packages.length}</span></h3>
    {!workspace.packages.length && <p className="mt-3 text-sm text-muted-foreground">设备包安装后，可在这里查看详情或选用设备。</p>}
    <ul className="mt-2 divide-y">{workspace.packages.map((device) => <li key={packageKey(device)} className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="min-w-0"><p className="break-all text-sm font-medium">{device.model}</p><p className="break-words text-xs text-muted-foreground">{device.manufacturer} · {device.revision}</p></div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" onClick={() => open(device, true)}>详情</Button>
        <Button size="sm" variant="outline" onClick={() => open(device, false)}><Package />选用设备</Button>
      </div>
    </li>)}</ul>
    {error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
  </section>;
}

const sections = [
  { key: "physics", title: "物理模型", icon: Boxes },
  { key: "device", title: "设备包", icon: FileJson },
  { key: "material", title: "BOM 与手册", icon: FileText },
] as const;
type Section = (typeof sections)[number]["key"];
type ModelTarget = { lastToken?: number; incoming?: IncomingWorkbenchModel; stored?: ModelRef };

export default function ImportCenter({ workspace, onChange, onOpenDevice, onPreviewDevice, onUseSource, onImportFiles, onImportText, incomingModel }: Props) {
  const [search, setSearch] = useSearchParams();
  const robotId = search.get("robot");
  const section = search.get("section");
  const visible: Section = robotId === null && (section === "device" || section === "material") ? section : "physics";
  const localPhysics = visible === "physics" && robotId === null;
  const [model, setModel] = useState<ModelTarget>({});
  if (localPhysics && incomingModel && incomingModel.token !== model.lastToken) {
    setModel({ lastToken: incomingModel.token, incoming: incomingModel });
  } else if (!localPhysics && model.incoming) {
    setModel({ lastToken: model.lastToken });
  }

  function browse(next: Section, stored?: ModelRef) {
    setModel((current) => ({ lastToken: current.lastToken, stored }));
    if (robotId === null && visible === next) return;
    setSearch((previous) => {
      const params = new URLSearchParams(previous);
      params.delete("robot");
      if (next === "physics") params.delete("section"); else params.set("section", next);
      return params;
    }, { preventScrollReset: true });
  }
  return <section className="min-w-0 space-y-4" aria-label="导入中心">
    <ImportEntry onImportFiles={onImportFiles} onImportText={onImportText} />
    <nav className="flex flex-wrap items-center gap-1.5 border-b pb-3" aria-label="浏览导入库">
      <span className="mr-1 text-xs text-muted-foreground">浏览</span>
      {sections.map(({ key, title, icon: Icon }) => <Button key={key} size="sm" variant={visible === key ? "secondary" : "ghost"} aria-pressed={visible === key}
        onClick={() => { if (visible !== key || robotId !== null) browse(key); }}><Icon />{title}</Button>)}
    </nav>
    {visible === "physics" && <Suspense fallback={<p role="status" className="p-4 text-sm">正在打开模型库…</p>}>
      <ImportCenterPhysics key={model.lastToken ?? "library"} workspace={workspace} onChange={onChange} requested={localPhysics ? model.stored ?? null : null}
        incoming={localPhysics ? model.incoming : undefined} robotId={robotId} onLocalChoice={() => browse("physics")} />
    </Suspense>}
    {visible === "device" && <InstalledDevices workspace={workspace} onOpenDevice={onOpenDevice} onPreviewDevice={onPreviewDevice} />}
    {visible === "material" && <ImportCenterMaterials workspace={workspace} onChange={onChange} onOpenDevice={onOpenDevice} onUseSource={onUseSource}
      onImportFiles={onImportFiles} onImportText={onImportText} onOpenPhysics={(ref) => browse("physics", ref)} />}
  </section>;
}
