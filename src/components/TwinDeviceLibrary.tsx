import { lazy, Suspense, useCallback, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Box, Copy, FileJson, FileUp, Link2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IS_PAGES } from "@/const";
import { useCancelOnNewImport } from "@/hooks/useWorkbenchImport";
import { fetchSourceText } from "@/lib/twin-source-text";
import type { DeviceDraftPatch, WorkbenchImportOptions } from "@/lib/workbench-import";
import { trpc } from "@/providers/trpc";
import type { MaterialRow } from "@contracts/import-catalog";
import { parseDevicePackage, type DevicePackage } from "@contracts/twin-device";
import { deviceExtractionPrompt, deviceSourceFromMaterial, generateDevicePackage, inovanceSource, suggestSourceMetadata, type DeviceSourceInput } from "@contracts/twin-extract";

const emptySource: DeviceSourceInput = { manufacturer: "", model: "", revision: "", title: "", url: "", locator: "", text: "" };
const LocalLeafForm = lazy(() => import("./DeviceCompositionEditor").then(module => ({ default: module.LocalLeafForm })));
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

export default function TwinDeviceLibrary({ initialSource, incomingSource, onImportFile, onImportText, onPreviewDevice, active = true }: {
  initialSource?: Partial<DeviceSourceInput>;
  incomingSource?: DeviceDraftPatch;
  active?: boolean;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
  onPreviewDevice: (device: DevicePackage, installed?: boolean) => void;
}) {
  const [mode, setMode] = useState<"source" | "package" | "leaf">("source");
  const [source, setSource] = useState<DeviceSourceInput>(() => ({ ...emptySource, ...initialSource }));
  const latestSource = useRef(source);
  useLayoutEffect(() => { latestSource.current = source; }, [source]);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"url" | "ai" | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [manualPrompt, setManualPrompt] = useState("");
  const task = useRef<AbortController | null>(null);
  const textOrigin = useRef<{ url: string; text: string } | null>(null);
  const lastPatch = useRef<number | null>(null);
  const autofilled = useRef(new Set<SourceKey>());
  const sourceFile = useRef<HTMLInputElement>(null);
  const packageFile = useRef<HTMLInputElement>(null);
  const aiStatus = trpc.twinAi.status.useQuery(undefined, { enabled: active && !IS_PAGES && aiOpen, retry: false, staleTime: 60_000 });
  const aiClient = trpc.useUtils().client;

  const cancelRead = useCallback(() => task.current?.abort(), []);
  useCancelOnNewImport(cancelRead);
  useLayoutEffect(() => {
    if (!active) cancelRead();
    return cancelRead;
  }, [active, cancelRead]);

  function invalidate() {
    cancelRead();
    task.current = null;
    setBusy(null);
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

  function withUrl(current: DeviceSourceInput, url: string) {
    const next = { ...current, url };
    autofilled.current.delete("url");
    const origin = textOrigin.current;
    if (origin && url !== origin.url) {
      clearAutofilled(next);
      if (current.text === origin.text) next.text = "";
      textOrigin.current = null;
    }
    return next;
  }

  function updateSource(key: keyof DeviceSourceInput, value: string) {
    invalidate();
    if (key === "url") setSource(withUrl(source, value));
    else {
      if (key !== "text") autofilled.current.delete(key);
      setSource({ ...source, [key]: value });
    }
  }

  function suggestFromText(text: string) {
    const next = { ...source, text };
    if (autofilled.current.has("model") && !text.toLowerCase().includes(source.model.toLowerCase())) {
      if (next.url === textOrigin.current?.url) next.url = "";
      clearAutofilled(next);
      textOrigin.current = null;
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

  function applyManualToCurrentDraft(row: MaterialRow, filename: string) {
    const hints = deviceSourceFromMaterial(row, filename);
    const next = { ...latestSource.current, text: hints.text };
    if (next.url === textOrigin.current?.url) next.url = "";
    clearAutofilled(next);
    // 用户在预览里明确改过的标题和链接优先于原草稿，其他元数据只补空字段。
    if (row.name !== filename.replace(/\.[^./\\]+$/, "").trim()) next.title = hints.title;
    if (hints.url && hints.url === row.source?.trim()) next.url = hints.url;
    fillBlanks(next, hints);
    textOrigin.current = next.url && next.url === hints.url ? { url: next.url, text: next.text } : null;
    setSource(next); setMode("source"); setError(""); setNotice(`已带入“${row.name}”的手册正文。`);
  }

  const applyIncoming = useEffectEvent((patch: DeviceDraftPatch) => {
    invalidate();
    if (patch.kind === "manual") {
      applyManualToCurrentDraft(patch.row, patch.filename);
      return;
    }
    const next = withUrl(latestSource.current, patch.url);
    for (const field of ["title", "locator"] as const) {
      if (patch[field] !== undefined) {
        next[field] = patch[field];
        autofilled.current.delete(field);
      }
    }
    setSource(next); setMode("source");
  });
  useLayoutEffect(() => {
    if (incomingSource && lastPatch.current !== incomingSource.id) {
      lastPatch.current = incomingSource.id;
      applyIncoming(incomingSource);
    }
  }, [incomingSource]);

  async function readOfficialSource() {
    if (IS_PAGES) return;
    const controller = start("url");
    try {
      if (!source.url.trim()) throw new Error("请先填写汇川官方资料链接。");
      const result = await fetchSourceText("url", JSON.stringify({ url: source.url }), "application/json", controller.signal);
      if (controller.signal.aborted) return;
      if (!result.trim()) throw new Error("资料中没有可提取的文字，请粘贴所需规格表。");
      const next = { ...source, text: result };
      fillBlanks(next, isSampleUrl(source.url) ? inovanceSource : suggestSourceMetadata(result));
      textOrigin.current = { url: next.url, text: next.text };
      setSource(next);
      setNotice("已读取官网正文，请核对型号和规格表。");
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      finish(controller);
    }
  }

  function generate() {
    invalidate();
    if (mode === "package") {
      onImportText(json, "粘贴的设备包 JSON", { hint: "json" });
      return;
    }
    try {
      onPreviewDevice(generateDevicePackage(source, !source.url.trim()));
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function generateWithAi() {
    const controller = start("ai");
    try {
      const result = await aiClient.twinAi.generate.mutate(source, { signal: controller.signal });
      if (!controller.signal.aborted) onPreviewDevice(parseDevicePackage(result.device));
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

  return (
    <section className="surface min-w-0" aria-labelledby="twin-add-heading">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
          <h1 id="twin-add-heading" className="text-xl font-semibold">创建设备</h1>
          <div className="flex flex-wrap gap-1 rounded-md border bg-background/50 p-1">
            <Button size="sm" variant={mode === "source" ? "secondary" : "ghost"} aria-pressed={mode === "source"} onClick={() => switchMode("source")}><BookOpen />从资料生成</Button>
            <Button size="sm" variant={mode === "package" ? "secondary" : "ghost"} aria-pressed={mode === "package"} onClick={() => switchMode("package")}><FileJson />导入设备包</Button>
            <Button size="sm" variant={mode === "leaf" ? "secondary" : "ghost"} aria-pressed={mode === "leaf"} onClick={() => switchMode("leaf")}><Box />创建最小件</Button>
          </div>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          {mode === "source" ? <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-md text-xs leading-5 text-muted-foreground">本地规则可从数字量输入模块规格表提取通道数、通断阈值和滤波时间。</p>
              <Button variant="outline" size="sm" onClick={() => {
                invalidate();
                setSource({ ...inovanceSource });
                textOrigin.current = { url: inovanceSource.url, text: inovanceSource.text };
                autofilled.current = new Set(metadataKeys);
                setNotice("已填入汇川 GL10-1600END 的示例规格摘录。");
              }}><BookOpen />填入汇川示例</Button>
            </div>
            <div>
              <label className="field-label" htmlFor="twin-source-url">制造商资料链接</label>
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input id="twin-source-url" type="url" className="min-w-0 flex-1 basis-52" placeholder="https://…" value={source.url} onChange={(event) => updateSource("url", event.target.value)} />
                {!IS_PAGES && <Button variant="outline" disabled={!source.url.trim() || busy !== null} onClick={() => void readOfficialSource()}>
                  {busy === "url" ? <Loader2 className="animate-spin" /> : <Link2 />}读取汇川官网
                </Button>}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">本地资料可留空链接，用标题、页码和原文记录出处。{IS_PAGES && "粘贴规格或选择 TXT、Markdown 即可本地解析。"}</p>
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-medium" htmlFor="twin-source-text">规格原文</label>
                <input ref={sourceFile} type="file" className="hidden" accept={IS_PAGES ? ".txt,.md,.markdown,text/plain,text/markdown" : ".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"} aria-label="厂商资料文件" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) { invalidate(); onImportFile(file, "manual"); }
                }} />
                <Button size="sm" variant="ghost" onClick={() => sourceFile.current?.click()}><FileUp />{IS_PAGES ? "打开 TXT / MD" : "上传 PDF / TXT / MD"}</Button>
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
                {!IS_PAGES && source.url.trim() && aiStatus.data?.available && aiStatus.data.authenticated && <div className="border-t pt-2">
                  <p className="mb-2 leading-5 text-muted-foreground">点击后，型号、资料链接、定位和规格原文将发送给工作区配置的模型服务。</p>
                  <Button variant="outline" size="sm" disabled={busy !== null || !source.text.trim()} onClick={() => void generateWithAi()}>
                    {busy === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles />}发送当前资料给 AI，生成草案
                  </Button>
                </div>}
              </div>
            </details>
          </> : mode === "leaf" ? <Suspense fallback={<p role="status">正在打开部件表单…</p>}>
            <LocalLeafForm onCreate={device => onPreviewDevice(device)} submitLabel="核对最小件" />
          </Suspense> : <>
            <p className="text-xs leading-5 text-muted-foreground">选择已有设备包，或粘贴人工编写、AI 提取的设备包 JSON。</p>
            <input ref={packageFile} type="file" accept=".json,application/json" className="hidden" aria-label="设备包 JSON 文件" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) { invalidate(); onImportFile(file); }
            }} />
            <Button variant="outline" disabled={busy !== null} onClick={() => packageFile.current?.click()}><FileUp />选择设备包文件</Button>
            <div><label className="field-label" htmlFor="twin-package-json">设备包 JSON</label>
              <Textarea id="twin-package-json" className="mono h-56 resize-y text-xs" spellCheck={false} value={json} placeholder="粘贴完整设备包 JSON" onChange={(event) => { invalidate(); setJson(event.target.value); }} />
            </div>
            <Button disabled={!json.trim() || busy !== null} onClick={generate}>预览设备包<ArrowRight /></Button>
          </>}
          {busy !== null && <p role="status" className="text-xs text-muted-foreground">{busy === "ai" ? "正在从模型服务读取草案…" : "正在读取资料…"}</p>}
          {error && <p role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="break-words text-xs leading-5 text-primary">{notice}</p>}
        </div>
      </section>
  );
}
