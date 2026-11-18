import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Boxes, FileJson, FileText, FolderInput, Package, Upload } from "lucide-react";
import { packageKey, parseDevicePackage, type DevicePackage } from "@contracts/twin-device";
import { installPackage, type TwinWorkspace } from "@contracts/twin-simulation";
import type { MaterialRow, ModelRef } from "@contracts/import-catalog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import TwinPackagePreview from "./TwinPackagePreview";
import ImportCenterMaterials from "./ImportCenterMaterials";

const ImportCenterPhysics = lazy(() => import("./ImportCenterPhysics"));
type Props = {
  workspace: TwinWorkspace;
  onChange: (next: TwinWorkspace) => void;
  onOpenDevice: (device: DevicePackage) => void;
  onUseSource: (row: MaterialRow) => void;
  onOpenProject: (file: File) => Promise<void>;
};

function DeviceImport({ workspace, onChange, onOpenDevice, onOpenProject }: Omit<Props, "onUseSource">) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ device: DevicePackage; installed: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);

  async function read(file?: File) {
    const sequence = ++version.current;
    setError(""); setPreview(null);
    try {
      if (file && file.size > 8 * 1024 * 1024) throw new Error("请选择 8 MiB 以内的 JSON 文件。");
      const content = file ? await file.text() : text;
      if (version.current !== sequence) return;
      let data: unknown;
      try { data = JSON.parse(content.trim()); } catch { throw new Error("JSON 格式有误，请检查文件或粘贴的内容。"); }
      if (data && typeof data === "object" && "packages" in data && "instances" in data && "connections" in data) {
        await onOpenProject(file ?? new File([content], "工程.json", { type: "application/json" }));
      } else {
        setPreview({ device: parseDevicePackage(data), installed: false });
      }
    } catch (cause) {
      if (version.current === sequence) setError(cause instanceof Error ? cause.message : "读取设备包失败。");
    }
  }
  function openDevice(device: DevicePackage) {
    try { onOpenDevice(device); setPreview(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开设备。"); }
  }
  return <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
    <section className="surface space-y-3 p-4 sm:p-5">
      <h3 className="text-base font-semibold">导入设备包</h3>
      <p className="text-sm text-muted-foreground">选择设备包 JSON，核对来源、端口或伺服参数后安装。</p>
      <input ref={fileInput} type="file" className="hidden" aria-label="选择设备包 JSON" accept=".json,application/json" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void read(file);
      }} />
      <Button onClick={() => fileInput.current?.click()}><Upload />选择 JSON 文件</Button>
      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer">粘贴设备包 JSON</summary>
        <Textarea aria-label="设备包 JSON 原文" className="mono my-3 h-32 text-xs" value={text} onChange={(event) => {
          version.current++; setPreview(null); setError(""); setText(event.target.value);
        }} />
        <Button size="sm" variant="outline" disabled={!text.trim()} onClick={() => void read()}>预览设备包</Button>
      </details>
      {error && !preview && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    </section>
    <section className="surface min-w-0 p-4 sm:p-5">
      <h3 className="text-base font-semibold">已安装设备包 <span className="mono text-sm text-muted-foreground">{workspace.packages.length}</span></h3>
      {!workspace.packages.length && <p className="mt-3 text-sm text-muted-foreground">安装后可在这里选用设备。</p>}
      <ul className="mt-2 divide-y">{workspace.packages.map((device) => <li key={packageKey(device)} className="flex flex-wrap items-center justify-between gap-2 py-3">
        <div className="min-w-0"><p className="break-all text-sm font-medium">{device.model}</p><p className="text-xs text-muted-foreground">{device.manufacturer} · {device.revision}</p></div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => { version.current++; setError(""); setPreview({ device, installed: true }); }}>详情</Button>
          <Button size="sm" variant="outline" onClick={() => openDevice(device)}><Package />选用设备</Button>
        </div>
      </li>)}</ul>
    </section>
    {preview && <TwinPackagePreview {...preview} error={error} onClose={() => { setPreview(null); setError(""); }} onInstall={() => {
      try { onChange(installPackage(workspace, preview.device)); setError(""); setPreview({ ...preview, installed: true }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "安装设备失败。"); }
    }} onAssemble={() => openDevice(preview.device)} />}
  </div>;
}

const modes = [
  { key: "physics", title: "物理模型", icon: Boxes },
  { key: "device", title: "设备包", icon: FileJson },
  { key: "material", title: "BOM 与手册", icon: FileText },
] as const;

export default function ImportCenter({ workspace, onChange, onOpenDevice, onUseSource, onOpenProject }: Props) {
  const [mode, setMode] = useState<(typeof modes)[number]["key"]>("physics");
  const [requested, setRequested] = useState<ModelRef | null>(null);
  const [search, setSearch] = useSearchParams();
  const robotId = search.get("robot");
  const visibleMode = robotId === null ? mode : "physics";
  function clearRobot() {
    if (robotId === null) return;
    setSearch((previous) => { const next = new URLSearchParams(previous); next.delete("robot"); return next; }, { preventScrollReset: true });
  }
  return <section className="min-w-0 space-y-4" aria-label="导入中心">
    <div className="surface flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><FolderInput className="size-5 text-primary" />导入自己的模型和资料</h2>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="导入类型">
        {modes.map(({ key, title, icon: Icon }) => <Button key={key} size="sm" variant={visibleMode === key ? "default" : "outline"} aria-pressed={visibleMode === key} onClick={() => {
          if (visibleMode !== key) { setRequested(null); setMode(key); clearRobot(); }
        }}><Icon />{title}</Button>)}
      </div>
    </div>
    {visibleMode === "physics" && <Suspense fallback={<p role="status" className="p-4 text-sm">正在打开模型库…</p>}>
      <ImportCenterPhysics workspace={workspace} onChange={onChange} requested={requested} onOpenProject={onOpenProject} robotId={robotId}
        onLocalChoice={() => { setMode("physics"); clearRobot(); }} />
    </Suspense>}
    {visibleMode === "device" && <DeviceImport workspace={workspace} onChange={onChange} onOpenDevice={onOpenDevice} onOpenProject={onOpenProject} />}
    {visibleMode === "material" && <ImportCenterMaterials workspace={workspace} onChange={onChange} onOpenDevice={onOpenDevice} onUseSource={onUseSource}
      onOpenPhysics={(ref) => { setRequested(ref); setMode("physics"); }} />}
  </section>;
}
