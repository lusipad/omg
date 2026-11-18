import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Copy, FileJson, FileUp, Layers3, Link2, Loader2, PackageOpen, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IS_PAGES } from "@/const";
import { trpc } from "@/providers/trpc";
import TwinPackagePreview from "./TwinPackagePreview";
import { packageKey, parseDevicePackage, type DevicePackage } from "@contracts/twin-device";
import { deviceExtractionPrompt, generateDevicePackage, inovanceSource, suggestSourceMetadata, type DeviceSourceInput } from "@contracts/twin-extract";

const emptySource: DeviceSourceInput = { manufacturer: "", model: "", revision: "", title: "", url: "", locator: "", text: "" };
const sourceFields = [
  { key: "manufacturer", label: "制造商", hint: "资料中的制造商名称" },
  { key: "model", label: "设备型号", hint: "完整订货型号" },
  { key: "revision", label: "设备包版本", hint: "例如 1.0" },
  { key: "title", label: "资料标题", hint: "制造商手册或规格页名称" },
  { key: "locator", label: "证据位置", hint: "页码、章节或规格表名" },
] as const;
type SourceKey = Exclude<keyof DeviceSourceInput, "text">;
const metadataKeys: SourceKey[] = [...sourceFields.map(({ key }) => key), "url"];

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "操作失败，请重新尝试。";
}

function isSampleUrl(value: string) {
  try {
    const url = new URL(value);
    const sample = new URL(inovanceSource.url);
    return url.origin === sample.origin && decodeURI(url.pathname) === decodeURI(sample.pathname);
  } catch {
    return false;
  }
}

async function fetchText(path: string, body: BodyInit, contentType: string, signal: AbortSignal) {
  const response = await fetch(`/api/twin-source/${path}`, { method: "POST", headers: { "Content-Type": contentType }, body, signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.text !== "string") {
    throw new Error(typeof data?.error === "string" ? data.error : "资料服务未能读取正文。可复制规格表文字后继续。");
  }
  return data.text as string;
}

function parseJson(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"));
  } catch {
    throw new Error("设备包 JSON 格式有误，请检查括号、引号和完整性。");
  }
  if (raw && typeof raw === "object" && "missing" in raw && Array.isArray(raw.missing)) {
    const missing = raw.missing.filter((item) => typeof item === "string" && item.trim()).slice(0, 12);
    if (missing.length) throw new Error(`请补充资料中的${missing.join("、")}。`);
  }
  return parseDevicePackage(raw);
}

export default function TwinDeviceLibrary({ packages, onInstall, onAssemble }: {
  packages: DevicePackage[];
  onInstall: (pkg: DevicePackage) => void;
  onAssemble: (pkg: DevicePackage) => void;
}) {
  const [mode, setMode] = useState<"source" | "package">("source");
  const [source, setSource] = useState<DeviceSourceInput>({ ...emptySource });
  const [json, setJson] = useState("");
  const [preview, setPreview] = useState<{ device: DevicePackage; installed: boolean } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"url" | "file" | "ai" | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [manualPrompt, setManualPrompt] = useState("");
  const task = useRef<AbortController | null>(null);
  const textSourceUrl = useRef("");
  const autofilled = useRef(new Set<SourceKey>());
  const sourceFile = useRef<HTMLInputElement>(null);
  const packageFile = useRef<HTMLInputElement>(null);
  const aiStatus = trpc.twinAi.status.useQuery(undefined, { enabled: !IS_PAGES && aiOpen, retry: false, staleTime: 60_000 });
  const ai = trpc.twinAi.generate.useMutation();

  useEffect(() => () => task.current?.abort(), []);

  function invalidate() {
    task.current?.abort();
    task.current = null;
    setBusy(null);
    setPreview(null);
    setManualPrompt("");
    setError("");
    setNotice("");
  }

  function clearAutofilled(next: DeviceSourceInput) {
    for (const key of autofilled.current) next[key] = "";
    autofilled.current.clear();
  }

  function fillBlanks(next: DeviceSourceInput, hints: Partial<DeviceSourceInput>) {
    for (const key of metadataKeys) {
      const suggestion = hints[key];
      if (!next[key].trim() && suggestion) {
        next[key] = suggestion;
        autofilled.current.add(key);
      }
    }
  }

  function updateSource(key: keyof DeviceSourceInput, value: string) {
    invalidate();
    const next = { ...source, [key]: value };
    if (key !== "text") autofilled.current.delete(key);
    if (key === "url" && textSourceUrl.current && value !== textSourceUrl.current) {
      textSourceUrl.current = "";
      clearAutofilled(next);
      next.text = "";
    }
    setSource(next);
  }

  function suggestFromText(text: string) {
    const next = { ...source, text };
    if (autofilled.current.has("model") && !text.toLowerCase().includes(source.model.toLowerCase())) {
      if (next.url === textSourceUrl.current) next.url = "";
      clearAutofilled(next);
      textSourceUrl.current = "";
    }
    fillBlanks(next, suggestSourceMetadata(text));
    setSource(next);
  }

  function switchMode(next: typeof mode) {
    invalidate();
    setMode(next);
  }

  function start(operation: NonNullable<typeof busy>) {
    invalidate();
    const controller = new AbortController();
    task.current = controller;
    setBusy(operation);
    return controller;
  }

  function finish(controller: AbortController) {
    if (task.current === controller) {
      task.current = null;
      setBusy(null);
    }
  }

  async function readSource(file?: File) {
    const isPdf = file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (IS_PAGES && (!file || isPdf)) {
      invalidate();
      setError("请打开 UTF-8 编码的 TXT 文件，或粘贴规格表文字。");
      return;
    }
    const controller = start(file ? "file" : "url");
    const previousReadUrl = textSourceUrl.current;
    textSourceUrl.current = "";
    setSource((previous) => ({ ...previous, text: "" }));
    try {
      let result: string;
      if (!file) {
        if (!source.url.trim()) throw new Error("请先填写汇川官方资料链接。");
        result = await fetchText("url", JSON.stringify({ url: source.url }), "application/json", controller.signal);
      } else if (isPdf) {
        if (file.size > 8 * 1024 * 1024) throw new Error("PDF 超过 8 MiB，请粘贴规格表原文。");
        result = await fetchText("pdf", file, "application/pdf", controller.signal);
      } else {
        if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") throw new Error(IS_PAGES ? "请选择 UTF-8 编码的 TXT 资料。" : "请选择 PDF 或 UTF-8 编码的 TXT 资料。");
        if (file.size > 1024 * 1024) throw new Error("TXT 超过 1 MiB，请仅粘贴相关规格表原文。");
        result = await file.text();
      }
      if (controller.signal.aborted) return;
      if (!result.trim()) throw new Error("资料中没有可提取的文字，请粘贴所需规格表。");
      const next = { ...source, text: result };
      const knownGuide = file
        ? /\bGL10-1600END\b/i.test(result) && /19011103A03/i.test(result) && /inovance|汇川/i.test(result)
        : isSampleUrl(source.url);
      if (file) {
        if (!knownGuide && next.url === previousReadUrl) next.url = "";
        clearAutofilled(next);
      }
      fillBlanks(next, knownGuide ? inovanceSource : suggestSourceMetadata(result));
      textSourceUrl.current = !file || knownGuide ? next.url : "";
      setSource(next);
      setNotice(file ? `已读取 ${file.name}，请核对资料位置和规格原文。` : "已读取官网正文，请核对型号和规格表。");
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      finish(controller);
    }
  }

  async function readPackage(file: File) {
    const controller = start("file");
    setJson("");
    try {
      if (file.size > 1024 * 1024) throw new Error("设备包超过 1 MiB，请检查选择的 JSON 文件。");
      const content = await file.text();
      if (controller.signal.aborted) return;
      setJson(content);
      setPreview({ device: parseJson(content), installed: false });
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      finish(controller);
    }
  }

  function generate() {
    invalidate();
    try {
      const device = mode === "source" ? generateDevicePackage(source) : parseJson(json);
      setPreview({ device, installed: false });
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function generateWithAi() {
    const controller = start("ai");
    try {
      const result = await ai.mutateAsync(source);
      if (!controller.signal.aborted) setPreview({ device: parseDevicePackage(result.device), installed: false });
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      finish(controller);
    }
  }

  async function copyPrompt() {
    invalidate();
    let prompt: string;
    try {
      prompt = deviceExtractionPrompt(source);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    const controller = new AbortController();
    task.current = controller;
    try {
      if (!navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(prompt);
      if (!controller.signal.aborted) setNotice("已复制提示词和当前资料。将模型返回的 JSON 贴入“导入设备包”即可核对。");
    } catch {
      if (!controller.signal.aborted) setManualPrompt(prompt);
    } finally {
      finish(controller);
    }
  }

  function install(device: DevicePackage) {
    setError("");
    try {
      onInstall(device);
      setPreview({ device, installed: true });
      setNotice(`已安装 ${device.model}。`);
    } catch (cause) {
      setError(message(cause));
    }
  }

  function assemble(device: DevicePackage) {
    setError("");
    try {
      onAssemble(device);
      setPreview(null);
    } catch (cause) {
      setError(message(cause));
    }
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(17rem,1fr)]">
      <section className="surface min-w-0" aria-labelledby="twin-add-heading">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
          <h2 id="twin-add-heading" className="text-base font-semibold">添加设备</h2>
          <div className="flex flex-wrap gap-1 rounded-md border bg-background/50 p-1">
            <Button size="sm" variant={mode === "source" ? "secondary" : "ghost"} aria-pressed={mode === "source"} onClick={() => switchMode("source")}><BookOpen />从资料生成</Button>
            <Button size="sm" variant={mode === "package" ? "secondary" : "ghost"} aria-pressed={mode === "package"} onClick={() => switchMode("package")}><FileJson />导入设备包</Button>
          </div>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          {mode === "source" ? <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-md text-xs leading-5 text-muted-foreground">本地规则可从数字量输入模块规格表提取通道数、通断阈值和滤波时间。</p>
              <Button variant="outline" size="sm" onClick={() => {
                invalidate();
                setSource({ ...inovanceSource });
                textSourceUrl.current = inovanceSource.url;
                autofilled.current = new Set(metadataKeys);
                setNotice("已填入汇川 GL10-1600END 的示例规格摘录。");
              }}><BookOpen />填入汇川示例</Button>
            </div>
            <div>
              <label className="field-label" htmlFor="twin-source-url">制造商资料链接</label>
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input id="twin-source-url" type="url" className="min-w-0 flex-1 basis-52" placeholder="https://…" value={source.url} onChange={(event) => updateSource("url", event.target.value)} />
                {!IS_PAGES && <Button variant="outline" disabled={!source.url.trim() || busy !== null} onClick={() => void readSource()}>
                  {busy === "url" ? <Loader2 className="animate-spin" /> : <Link2 />}读取汇川官网
                </Button>}
              </div>
              {IS_PAGES && <p className="mt-1.5 text-xs leading-5 text-muted-foreground">链接用于记录资料出处。粘贴规格表或选择 TXT 即可本地解析，官网读取、PDF 解析和在线模型提取需连接独立后端。</p>}
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-medium" htmlFor="twin-source-text">规格原文</label>
                <input ref={sourceFile} type="file" className="hidden" accept={IS_PAGES ? ".txt,text/plain" : ".pdf,.txt,application/pdf,text/plain"} aria-label="厂商资料文件" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void readSource(file);
                }} />
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => sourceFile.current?.click()}><FileUp />{IS_PAGES ? "打开 TXT 文件" : "上传 PDF / TXT"}</Button>
              </div>
              <Textarea id="twin-source-text" className="h-36 resize-y text-xs leading-5" value={source.text} placeholder="粘贴任意厂商的中文或英文规格表，保留单位与大于、小于符号。" onChange={(event) => {
                if ((event.nativeEvent as InputEvent).inputType === "insertFromPaste") {
                  invalidate();
                  suggestFromText(event.target.value);
                } else {
                  updateSource("text", event.target.value);
                }
              }} onBlur={() => suggestFromText(source.text)} />
            </div>
            <div className="grid gap-x-3 gap-y-3 sm:grid-cols-6">
              {sourceFields.map((field, index) => (
                <label key={field.key} className={index < 3 ? "sm:col-span-2" : "sm:col-span-3"}>
                  <span className="field-label">{field.label}</span>
                  <Input value={source[field.key]} placeholder={field.hint} onChange={(event) => updateSource(field.key, event.target.value)} />
                </label>
              ))}
            </div>
            <Button disabled={busy !== null} onClick={generate}>生成设备草案<ArrowRight /></Button>
            <details className="rounded-md border bg-background/30 px-3 py-2 text-xs" onToggle={(event) => setAiOpen(event.currentTarget.open)}>
              <summary className="cursor-pointer py-1 font-medium">AI 辅助提取</summary>
              <div className="mt-2 space-y-2">
                <p className="leading-5 text-muted-foreground">可复制当前资料及设备包格式给自己的 AI，再将返回的 JSON 导入并核对。</p>
                <Button variant="outline" size="sm" disabled={busy !== null || !source.text.trim()} onClick={() => void copyPrompt()}><Copy />复制 AI 提取提示词</Button>
                {manualPrompt && <label className="block"><span className="field-label">请选择并复制提示词</span><Textarea value={manualPrompt} readOnly onFocus={(event) => event.target.select()} /></label>}
                {!IS_PAGES && aiStatus.data?.available && aiStatus.data.authenticated && <div className="border-t pt-2">
                  <p className="mb-2 leading-5 text-muted-foreground">点击后，型号、资料链接、定位和规格原文将发送给工作区配置的模型服务。</p>
                  <Button variant="outline" size="sm" disabled={busy !== null || !source.text.trim()} onClick={() => void generateWithAi()}>
                    {busy === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles />}发送当前资料给 AI，生成草案
                  </Button>
                </div>}
              </div>
            </details>
          </> : <>
            <p className="text-xs leading-5 text-muted-foreground">选择已有设备包，或粘贴人工编写、AI 提取的设备包 JSON。</p>
            <input ref={packageFile} type="file" accept=".json,application/json" className="hidden" aria-label="设备包 JSON 文件" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void readPackage(file);
            }} />
            <Button variant="outline" disabled={busy !== null} onClick={() => packageFile.current?.click()}><FileUp />选择设备包文件</Button>
            <div><label className="field-label" htmlFor="twin-package-json">设备包 JSON</label>
              <Textarea id="twin-package-json" className="mono h-56 resize-y text-xs" spellCheck={false} value={json} placeholder="粘贴完整设备包 JSON" onChange={(event) => { invalidate(); setJson(event.target.value); }} />
            </div>
            <Button disabled={!json.trim() || busy !== null} onClick={generate}>预览设备包<ArrowRight /></Button>
          </>}
          {busy !== null && <p role="status" className="text-xs text-muted-foreground">{busy === "ai" ? "正在从模型服务读取草案…" : "正在读取资料…"}</p>}
          {error && !preview && <p role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
          {notice && !preview && <p role="status" className="break-words text-xs leading-5 text-primary">{notice}</p>}
        </div>
      </section>
      <section className="surface min-w-0" aria-labelledby="twin-installed-heading">
        <header className="flex items-center justify-between border-b px-4 py-4 sm:px-5">
          <h2 id="twin-installed-heading" className="text-base font-semibold">已安装设备</h2>
          <span className="mono text-xs text-muted-foreground">{packages.length} 个型号修订</span>
        </header>
        {packages.length === 0
          ? <div className="px-5 py-8"><PackageOpen className="mb-3 size-6 text-muted-foreground" /><p className="text-sm text-muted-foreground">设备库为空。可先用汇川示例生成并安装第一台设备的定义。</p></div>
          : <ul className="divide-y">{packages.map((pkg) => (
            <li key={packageKey(pkg)} className="px-4 py-4 sm:px-5">
              <div className="flex items-start gap-3">
                <Layers3 className="mt-1 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">{pkg.model}</h3>
                  <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                    {pkg.manufacturer} · {pkg.revision} · {pkg.servo
                      ? (pkg.servo.kind === "drive" ? `伺服驱动器 · 额定 ${pkg.servo.ratedCurrentA} A` : `伺服电机 · ${pkg.servo.ratedPowerW} W · ${pkg.servo.ratedTorqueNm} N·m`)
                      : `${pkg.ports.length} 个端口`}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { invalidate(); setPreview({ device: pkg, installed: true }); }}>{pkg.servo ? "来源与参数" : "来源与规则"}</Button>
                    <Button size="sm" variant="secondary" onClick={() => assemble(pkg)}><Plus />{pkg.servo ? "用于伺服仿真" : "装配实例"}</Button>
                  </div>
                </div>
              </div>
            </li>
          ))}</ul>}
      </section>
      {preview && <TwinPackagePreview device={preview.device} installed={preview.installed} error={error}
        onClose={() => { setPreview(null); setError(""); }}
        onInstall={() => install(preview.device)} onAssemble={() => assemble(preview.device)} />}
    </div>
  );
}
