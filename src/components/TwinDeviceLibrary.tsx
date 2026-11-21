import { lazy, Suspense, useCallback, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, Box, Copy, FileJson, FileUp, Link2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IS_PAGES } from "@/const";
import { useCancelOnNewImport } from "@/hooks/useWorkbenchImport";
import { fetchSourceArtifactFromPdf, fetchSourceArtifactFromUrl } from "@/lib/twin-source-text";
import type { DeviceDraftPatch, WorkbenchImportOptions } from "@/lib/workbench-import";
import { trpc } from "@/providers/trpc";
import type { MaterialRow } from "@contracts/import-catalog";
import {
  modelExtractionPrompt,
  verifyAndBuildExtractedDevice,
  type ModelExtractionRequest,
} from "@contracts/model-extraction";
import { listRegisteredModels, modelKey } from "@contracts/model-registry";
import { SourceGateError, type SourceArtifact } from "@contracts/source-artifact";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { parseDevicePackage, type DevicePackage } from "@contracts/twin-device";
import { deviceExtractionPrompt, deviceSourceFromMaterial, generateDevicePackage, inovanceSource, suggestSourceMetadata, type DeviceSourceInput } from "@contracts/twin-extract";

const emptySource: DeviceSourceInput = { manufacturer: "", model: "", revision: "", title: "", url: "", locator: "", text: "" };
const LocalLeafForm = lazy(() => import("./DeviceCompositionEditor").then(module => ({ default: module.LocalLeafForm })));
const MotorAssemblyForm = lazy(() => import("./MotorAssemblyForm"));
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

export default function TwinDeviceLibrary({ workspace, initialSource, incomingSource, initialMotorPartKey, onImportFile, onImportText, onPreviewDevice, active = true }: {
  workspace: TwinWorkspace;
  initialMotorPartKey?: string;
  initialSource?: Partial<DeviceSourceInput>;
  incomingSource?: DeviceDraftPatch;
  active?: boolean;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
  onPreviewDevice: (device: DevicePackage, installed?: boolean) => void;
}) {
  const [mode, setMode] = useState<"source" | "package" | "leaf" | "motor">(initialMotorPartKey ? "motor" : "source");
  const [source, setSource] = useState<DeviceSourceInput>(() => ({ ...emptySource, ...initialSource }));
  const latestSource = useRef(source);
  useLayoutEffect(() => { latestSource.current = source; }, [source]);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"url" | "pdf" | "ai" | null>(null);
  const [manualPrompt, setManualPrompt] = useState("");
  const [artifact, setArtifact] = useState<SourceArtifact | null>(null);
  const [gateHint, setGateHint] = useState("");
  const [targetModelKey, setTargetModelKey] = useState("auto");
  const [extractedJson, setExtractedJson] = useState("");
  const task = useRef<AbortController | null>(null);
  const textOrigin = useRef<{ url: string; text: string } | null>(null);
  const lastPatch = useRef<number | null>(null);
  const autofilled = useRef(new Set<SourceKey>());
  const sourceFile = useRef<HTMLInputElement>(null);
  const continuePdfFile = useRef<HTMLInputElement>(null);
  const packageFile = useRef<HTMLInputElement>(null);
  const aiStatus = trpc.twinAi.status.useQuery(undefined, { enabled: active && !IS_PAGES, retry: false, staleTime: 60_000 });
  const aiClient = trpc.useUtils().client;
  const componentModels = useMemo(() => listRegisteredModels().filter((m) => m.kind === "component"), []);
  const selectedModel = useMemo(
    () => componentModels.find((m) => modelKey(m) === targetModelKey),
    [componentModels, targetModelKey],
  );

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
      setArtifact(null);
      setGateHint("");
    }
    return next;
  }

  function updateSource(key: keyof DeviceSourceInput, value: string) {
    invalidate();
    if (key === "url") setSource(withUrl(source, value));
    else {
      if (key !== "text") autofilled.current.delete(key);
      else {
        setArtifact(null);
        setGateHint("");
      }
      setSource({ ...source, [key]: value });
    }
  }

  function suggestFromText(text: string) {
    const next = { ...source, text };
    if (text !== artifact?.text) setArtifact(null);
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

  function applyArtifactToSource(loaded: SourceArtifact, modeNote: string) {
    const next = { ...source, text: loaded.text };
    const defaultLocator = loaded.documentVersion
      ?? (loaded.pageCount > 1 ? `PDF 第 1–${loaded.pageCount} 页` : undefined);
    const meta = isSampleUrl(source.url)
      ? inovanceSource
      : {
        ...suggestSourceMetadata(loaded.text),
        ...(loaded.title ? { title: loaded.title } : {}),
        ...(defaultLocator ? { locator: defaultLocator } : {}),
      };
    fillBlanks(next, meta);
    if (loaded.sourceUrl && !next.url.trim()) next.url = loaded.sourceUrl;
    textOrigin.current = next.url.trim() ? { url: next.url, text: next.text } : null;
    setArtifact(loaded);
    setGateHint("");
    setSource(next);
    setNotice(modeNote);
  }

  async function readOfficialSource() {
    if (IS_PAGES) return;
    const controller = start("url");
    setGateHint("");
    try {
      if (!source.url.trim()) throw new Error("请先填写制造商官方资料链接。");
      const loaded = await fetchSourceArtifactFromUrl(source.url, controller.signal);
      if (controller.signal.aborted) return;
      const summary = loaded.classification === "html_series"
        ? "已读取系列概览页，请锁定具体订货号或补充选型表 PDF。"
        : `已读取官方资料正文${loaded.pageCount > 1 ? `（共 ${loaded.pageCount} 页）` : ""}，请核对型号和规格表。`;
      applyArtifactToSource(loaded, summary);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof SourceGateError) {
        setGateHint(cause.message);
      } else {
        setError(message(cause));
      }
    } finally {
      finish(controller);
    }
  }

  async function continueWithLocalPdf(file: File) {
    if (IS_PAGES) return;
    const controller = start("pdf");
    try {
      const loaded = await fetchSourceArtifactFromPdf(file, {
        sourceUrl: source.url.trim() || undefined,
        title: source.title.trim() || undefined,
      }, controller.signal);
      if (controller.signal.aborted) return;
      const note = `已载入本地 PDF（共 ${loaded.pageCount} 页，SHA-256 ${loaded.sha256.slice(0, 12)}…）${loaded.sourceUrl ? "，已继承原来源链接" : ""}。`;
      applyArtifactToSource(loaded, note);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      finish(controller);
    }
  }

  function buildExtractionRequest(): ModelExtractionRequest {
    if (!selectedModel) throw new Error("请先选择目标行为模型。");
    const matchingArtifact = artifact && artifact.text.trim() === source.text.trim() ? artifact : null;
    const cleanUrl = source.url.trim() || undefined;
    return {
      manufacturer: source.manufacturer.trim(),
      model: source.model.trim(),
      revision: source.revision.trim(),
      modelRef: { id: selectedModel.id, version: selectedModel.version },
      artifact: matchingArtifact
        ? {
          sha256: matchingArtifact.sha256,
          title: source.title.trim() || matchingArtifact.title || source.model.trim() || "本地技术资料",
          ...(cleanUrl && { sourceUrl: cleanUrl }),
          ...(matchingArtifact.documentVersion && { documentVersion: matchingArtifact.documentVersion }),
          ...(matchingArtifact.pages.length <= 200 && { pages: matchingArtifact.pages }),
          text: source.text,
        }
        : {
          title: source.title.trim(),
          ...(cleanUrl && { sourceUrl: cleanUrl }),
          text: source.text,
        },
    };
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

  function verifyLocalExtraction() {
    invalidate();
    try {
      const req = buildExtractionRequest();
      const raw = JSON.parse(extractedJson.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")) as unknown;
      const result = verifyAndBuildExtractedDevice(req, raw);
      if (result.warnings.length) setNotice(result.warnings.join("；"));
      onPreviewDevice(result.device);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "提取结果 JSON 格式有误，请核对后重试。" : message(cause));
    }
  }

  async function generateWithAi() {
    const controller = start("ai");
    try {
      if (selectedModel) {
        const result = await aiClient.twinAi.extractForModel.mutate(buildExtractionRequest(), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.warnings.length) setNotice(result.warnings.join("；"));
        onPreviewDevice(parseDevicePackage(result.device));
      } else {
        const result = await aiClient.twinAi.generate.mutate(source, { signal: controller.signal });
        if (!controller.signal.aborted) onPreviewDevice(parseDevicePackage(result.device));
      }
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
      prompt = selectedModel ? modelExtractionPrompt(buildExtractionRequest()) : deviceExtractionPrompt(source);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    const controller = new AbortController();
    task.current = controller;
    try {
      if (!navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(prompt);
      if (!controller.signal.aborted) {
        setNotice(selectedModel
          ? "已复制按目标模型生成的提取提示词。把 AI 返回的 JSON 贴入下方校验框即可核对并生成设备包。"
          : "已复制提示词和当前资料。将模型返回的 JSON 贴入“导入设备包”即可核对。");
      }
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
          <div className="flex flex-wrap items-center gap-1 rounded-md border bg-background/50 p-1">
            <Button size="sm" variant={mode === "source" ? "secondary" : "ghost"} aria-pressed={mode === "source"} onClick={() => switchMode("source")}><BookOpen />从资料提取</Button>
            <Button size="sm" variant={mode === "package" ? "secondary" : "ghost"} aria-pressed={mode === "package"} onClick={() => switchMode("package")}><FileJson />导入设备包</Button>
            <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <Button size="sm" variant={mode === "leaf" ? "secondary" : "ghost"} aria-pressed={mode === "leaf"} onClick={() => switchMode("leaf")}><Box />创建最小件</Button>
            <Button size="sm" variant={mode === "motor" ? "secondary" : "ghost"} aria-pressed={mode === "motor"} onClick={() => switchMode("motor")}>零件组装电机</Button>
          </div>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          {mode === "source" ? <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-md text-xs leading-5 text-muted-foreground">支持任意品牌信号手册本地提取，或选择目标行为模型后按统一模型契约提取并校验单位与原文证据。</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => {
                  invalidate();
                  const panaUrl = "https://industry.panasonic.com/global/en/products/motor/fa-motor/ac-servo/number/msmf012l1t1";
                  const panaText = [
                    "MSMF012L1T1 — MINAS A6 Series AC Servo Motor",
                    "Rated output: 100 W",
                    "Rated torque: 0.32 N·m",
                    "Momentary Max. peak torque: 0.95 N·m",
                    "Rated rotational speed: 3000 r/min",
                    "Max. rotational speed: 6000 r/min",
                    "Inertia of rotor: 0.051 ×10⁻⁴ kg·m²",
                    "Rated current: 1.1 A (rms)",
                  ].join("\n");
                  setSource({
                    manufacturer: "Panasonic Industry",
                    model: "MSMF012L1T1",
                    revision: "A6-1.0",
                    title: "MSMF012L1T1 — Spec Detail (MINAS A6)",
                    url: panaUrl,
                    locator: "Spec Detail 表",
                    text: panaText,
                  });
                  textOrigin.current = { url: panaUrl, text: panaText };
                  autofilled.current = new Set(metadataKeys);
                  setTargetModelKey("Gouyuan.RatedTorqueMotor@1.0.0");
                  setExtractedJson(JSON.stringify({
                    fields: {
                      ratedPowerW: { status: "confirmed", value: 100, rawUnit: "W", tableLocation: "Spec Detail", excerpt: "Rated output: 100 W" },
                      ratedTorqueNm: { status: "confirmed", value: 0.32, rawUnit: "N·m", tableLocation: "Spec Detail", excerpt: "Rated torque: 0.32 N·m" },
                      peakTorqueNm: { status: "confirmed", value: 0.95, rawUnit: "N·m", tableLocation: "Spec Detail", excerpt: "Momentary Max. peak torque: 0.95 N·m" },
                      ratedSpeedRpm: { status: "confirmed", value: 3000, rawUnit: "r/min", tableLocation: "Spec Detail", excerpt: "Rated rotational speed: 3000 r/min" },
                      maxSpeedRpm: { status: "confirmed", value: 6000, rawUnit: "r/min", tableLocation: "Spec Detail", excerpt: "Max. rotational speed: 6000 r/min" },
                      rotorInertiaKgM2: { status: "confirmed", value: 0.051, rawUnit: "10^-4 kg.m2", tableLocation: "Spec Detail", excerpt: "Inertia of rotor: 0.051 ×10⁻⁴ kg·m²" },
                      motorRatedCurrentA: { status: "confirmed", value: 1.1, rawUnit: "A (rms)", tableLocation: "Spec Detail", excerpt: "Rated current: 1.1 A (rms)" },
                    },
                  }, null, 2));
                  setNotice("已填入松下 MSMF012L1T1 资料与待核验提取 JSON，可直接点下方“校验提取结果并生成草案”体验跨品牌惯量单位换算与摘录核验。");
                }}><Sparkles />填入松下电机跨品牌示例</Button>
                <Button variant="outline" size="sm" onClick={() => {
                  invalidate();
                  setSource({ ...inovanceSource });
                  textOrigin.current = { url: inovanceSource.url, text: inovanceSource.text };
                  autofilled.current = new Set(metadataKeys);
                  setNotice("已填入汇川 GL10-1600END 的示例规格摘录。");
                }}><BookOpen />填入汇川示例</Button>
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="twin-source-url">制造商资料链接</label>
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input id="twin-source-url" type="url" className="min-w-0 flex-1 basis-52" placeholder="https://…" value={source.url} onChange={(event) => updateSource("url", event.target.value)} />
                {!IS_PAGES && <Button variant="outline" disabled={!source.url.trim() || busy !== null} onClick={() => void readOfficialSource()}>
                  {busy === "url" ? <Loader2 className="animate-spin" /> : <Link2 />}读取官方资料
                </Button>}
              </div>
              {!IS_PAGES && <input ref={continuePdfFile} type="file" accept=".pdf,application/pdf" className="hidden" aria-label="上传本地 PDF 继续提取" onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void continueWithLocalPdf(file);
              }} />}
              {gateHint && <div role="alert" className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <p className="leading-5 text-amber-200">{gateHint}</p>
                {!IS_PAGES && <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => continuePdfFile.current?.click()}>
                  {busy === "pdf" ? <Loader2 className="animate-spin" /> : <FileUp />}上传本地 PDF 继续当前提取
                </Button>}
              </div>}
              {artifact && <p className="mt-1.5 text-xs text-primary">
                资料工件已就绪：{artifact.format.toUpperCase()} · {artifact.pageCount} 页{artifact.documentVersion ? ` · ${artifact.documentVersion}` : ""} · SHA-256 {artifact.sha256.slice(0, 12)}…
              </p>}
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
            <div className="space-y-3 rounded-md border bg-background/40 p-3 text-xs">
              <label className="block"><span className="field-label">目标行为模型</span>
                <select aria-label="目标行为模型" className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs" value={targetModelKey} onChange={(event) => {
                  invalidate();
                  setTargetModelKey(event.target.value);
                }}>
                  <option value="auto">通用信号/安装点规则（本地规则直接生成）</option>
                  {componentModels.map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {model.label}（{model.id} @ {model.version}）
                    </option>
                  ))}
                </select>
              </label>

              {!selectedModel ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={busy !== null} onClick={generate}>生成信号设备草案<ArrowRight /></Button>
                  <Button variant="outline" size="sm" disabled={busy !== null || !source.text.trim()} onClick={() => void copyPrompt()}><Copy />复制提取提示词</Button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className="leading-5 text-muted-foreground">
                    系统会只向 AI 索取目标模型所需参数的原始值、单位与逐字摘录，再由确定性代码校验并换算；照片或草图建库建议直接使用「设备与资料 → 拍照/传图自动构建」。
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {!IS_PAGES && aiStatus.data?.available && aiStatus.data.authenticated && (
                      <Button disabled={busy !== null || !source.text.trim()} onClick={() => void generateWithAi()}>
                        {busy === "ai" ? <Loader2 className="animate-spin" /> : <Sparkles />}AI 提取参数并绑定模型
                      </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={busy !== null || !source.text.trim()} onClick={() => void copyPrompt()}><Copy />复制提取提示词</Button>
                  </div>
                  {manualPrompt && (
                    <label className="block"><span className="field-label">请选择并复制提示词</span>
                      <Textarea value={manualPrompt} readOnly onFocus={(event) => event.target.select()} />
                    </label>
                  )}
                  <div className="space-y-2 border-t pt-2">
                    <label className="block"><span className="field-label">粘贴 AI 提取结果 JSON（本地防幻觉核验）</span>
                      <Textarea className="mono h-28 resize-y text-xs" spellCheck={false} value={extractedJson} placeholder='{"fields": { ... }}' onChange={(event) => setExtractedJson(event.target.value)} />
                    </label>
                    <Button size="sm" variant={!IS_PAGES && aiStatus.data?.available && aiStatus.data.authenticated ? "outline" : "default"} disabled={busy !== null || !extractedJson.trim() || !source.text.trim()} onClick={verifyLocalExtraction}>
                      校验提取结果并生成草案<ArrowRight />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </> : mode === "motor" ? <Suspense fallback={<p role="status">正在打开电机选件表单…</p>}>
            <MotorAssemblyForm key={initialMotorPartKey} workspace={workspace} initialPartKey={initialMotorPartKey}
              submitLabel="核对组装电机" onBuild={device => onPreviewDevice(device)} />
          </Suspense> : mode === "leaf" ? <Suspense fallback={<p role="status">正在打开部件表单…</p>}>
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
          {error && <div role="alert" className="space-y-2 break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{error}</p>
            {!IS_PAGES && mode === "source" && source.url.trim() && (
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => continuePdfFile.current?.click()}>
                <FileUp />上传本地 PDF 继续当前提取
              </Button>
            )}
          </div>}
          {notice && <p role="status" className="break-words text-xs leading-5 text-primary">{notice}</p>}
        </div>
      </section>
  );
}
