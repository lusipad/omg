import { MODEL_LIMITS, type MaterialRow } from "@contracts/import-catalog";
import { createDocumentMaterial } from "@contracts/material-import";
import { emptyWorkspace, installPackage } from "@contracts/twin-simulation";
import { canReadOfficialSource, MAX_SOURCE_DOCUMENT_BYTES } from "@contracts/twin-source-url";
import {
  decodeImportUtf8, GCODE_FILE_EXTENSIONS, IMPORT_TEXT_ACCEPT, IMPORT_TEXT_LIMITS, outerFence, parseImportText,
  type ParsedTextImport, type TextImportHint,
} from "@contracts/workbench-import";
import { IS_PAGES } from "@/const";
import { downloadableSource } from "./bom-sources";
import type { ModelSelection, StoredModel } from "./model-files";
import { fetchSourceText } from "./twin-source-text";

export type WorkbenchImportOptions = { hint?: TextImportHint; source?: string; title?: string };
type Origin = { name: string; source?: string; title?: string };
export type WorkbenchImportCandidate = Origin & (
  | Exclude<ParsedTextImport, { kind: "materials" | "project" }>
  | (Extract<ParsedTextImport, { kind: "materials" }> & { text: string })
  | (Extract<ParsedTextImport, { kind: "project" }> & { models?: StoredModel[] })
  | { kind: "source-link"; url: string }
);
export type WorkbenchImportResult = WorkbenchImportCandidate | (Origin & { kind: "model"; selection: ModelSelection });
export type IncomingWorkbenchModel = { selection: ModelSelection; token: number; onInstalled?: () => void };
export type DeviceDraftPatch =
  | { kind: "link"; id: number; url: string; title?: string; locator?: string }
  | { kind: "manual"; id: number; row: MaterialRow; filename: string };
export type ImportOverrides = { title?: string; source?: string; text?: string };

const modelExtensions = ["xml", "mjcf", "urdf", "zip", "mjz", "stl", "obj", "msh", "mtl", "png", "jpg", "jpeg", "bmp", "bin", "ply"];
const textExtensions = new Set(IMPORT_TEXT_ACCEPT.split(",").map(ext => ext.trim().replace(/^\./, "")));
const programExtensions = new Set<string>(GCODE_FILE_EXTENSIONS);
export const WORKBENCH_FILE_ACCEPT = [IMPORT_TEXT_ACCEPT, ...modelExtensions.map(ext => "." + ext), ...(IS_PAGES ? [] : [".pdf"])].join(",");
const extension = (name: string) => name.match(/\.([^./\\]+)$/)?.[1].toLowerCase() ?? "";
const fileExtension = (file: File) => extension(file.name) || (file.type === "application/pdf" ? "pdf" : "");
const pagesPdfMessage = "公开站点请复制 PDF 的相关章节，使用“粘贴内容或链接”导入手册。";

export function importMaterialRows(candidate: Extract<WorkbenchImportCandidate, { kind: "manual" | "materials" }>, overrides: ImportOverrides = {}): MaterialRow[] {
  const source = (overrides.source ?? candidate.source)?.trim() || undefined;
  if (candidate.kind === "manual") {
    const title = overrides.title ?? candidate.title ?? candidate.name.replace(/\.[^./]+$/, "");
    return [createDocumentMaterial(title, overrides.text ?? candidate.text, source)];
  }
  if (source === candidate.source) return candidate.rows;
  const parsed = parseImportText(candidate.text, candidate.name, { hint: "bom", source });
  if (parsed.kind !== "materials") throw new Error("请核对物料表的名称和数量列。");
  return parsed.rows;
}

export async function prepareProjectResources(candidate: Extract<WorkbenchImportCandidate, { kind: "project" }>, signal: AbortSignal) {
  if (!candidate.workspace.catalog?.models.length) return;
  const { getModelBundle, putProjectModels } = await import("./model-files");
  signal.throwIfAborted();
  if (candidate.models) {
    await putProjectModels(candidate.models, signal);
  } else {
    for (const ref of candidate.workspace.catalog.models) {
      try {
        const bundle = await getModelBundle(ref.id, signal);
        if (bundle.entry !== ref.entry) throw new Error("模型入口不一致。");
      } catch {
        signal.throwIfAborted();
        throw new Error(`本机缺少与“${ref.name}”入口匹配的资源。请选择包含资源的完整工程 ZIP。`);
      }
      signal.throwIfAborted();
    }
  }
}

async function inspectBundle(files: File[], origin: Origin, signal?: AbortSignal): Promise<WorkbenchImportResult> {
  const { readWorkbenchBundle } = await import("./model-files");
  signal?.throwIfAborted();
  const result = await readWorkbenchBundle(files, signal);
  signal?.throwIfAborted();
  if (result.kind === "model" && !result.selection.entries.length && !result.selection.files.some(f => /\.(?:stl|obj)$/i.test(f.path))) {
    throw new Error("没有找到模型入口或网格。请选择 MJCF、URDF、STL、OBJ，或含入口及资源的完整目录。");
  }
  return { ...result, ...origin };
}

function textCandidate(text: string, name: string, options: WorkbenchImportOptions): WorkbenchImportCandidate {
  const parsed = parseImportText(text, name, options);
  const origin = { name, source: options.source?.trim() || undefined, title: options.title?.trim() || undefined };
  if (parsed.kind === "materials") return { ...parsed, ...origin, text };
  return { ...parsed, ...origin };
}

function inspectContent(text: string, name: string, options: WorkbenchImportOptions, signal?: AbortSignal): Promise<WorkbenchImportResult> | WorkbenchImportCandidate {
  const ext = extension(name);
  const explicitXml = ["xml", "mjcf", "urdf"].includes(ext);
  if (explicitXml || ((!options.hint || options.hint === "auto") && ["", "txt", "md", "markdown"].includes(ext))) {
    const fence = outerFence(text);
    const xmlFence = fence && ["xml", "mjcf", "urdf"].includes(fence.language);
    const body = fence?.body ?? text;
    const model = body.trimStart().replace(/^(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)+/, "").match(/^<(mujoco|robot)(?=[\s/>])/i);
    if (explicitXml || xmlFence || ((!fence || !fence.language) && model)) {
      if (fence && fence.body === undefined) throw new Error("模型代码围栏未闭合。");
      if (body.length > MODEL_LIMITS.maxFileBytes) throw new Error("模型文件超过 32 MiB。");
      const suffix = model?.[1].toLowerCase() === "robot" || fence?.language === "urdf" ? "urdf" : "xml";
      const fileName = explicitXml ? name : (ext ? name.replace(/\.[^./\\]+$/, "") : name) + "." + suffix;
      return inspectBundle([new File([body], fileName)], { name: fileName, source: options.source }, signal);
    }
  }
  return textCandidate(text, name, options);
}

function maxFileBytes(ext: string) {
  if (ext === "zip" || ext === "mjz") return MODEL_LIMITS.maxProjectBytes + 2 * 1024 * 1024;
  if (modelExtensions.includes(ext)) return MODEL_LIMITS.maxFileBytes;
  if (ext === "pdf") return MAX_SOURCE_DOCUMENT_BYTES;
  if (programExtensions.has(ext)) return IMPORT_TEXT_LIMITS.gcodeFileBytes;
  if (ext === "csv" || ext === "tsv") return IMPORT_TEXT_LIMITS.materialBytes;
  return IMPORT_TEXT_LIMITS.jsonBytes;
}

async function readTextFile(file: File, ext: string, limit: number, signal?: AbortSignal) {
  if (ext === "pdf" && IS_PAGES) throw new Error(pagesPdfMessage);
  if (file.size > limit) throw new Error(`“${file.name}”超过该格式的文件大小上限（${Math.ceil(limit / 1024)} KiB）。`);
  const text = ext === "pdf"
    ? await fetchSourceText("pdf", file, "application/pdf", signal ?? new AbortController().signal)
    : decodeImportUtf8(await file.arrayBuffer());
  signal?.throwIfAborted();
  return text;
}

async function inspectOne(file: File, options: WorkbenchImportOptions, signal?: AbortSignal): Promise<WorkbenchImportResult> {
  const ext = fileExtension(file);
  if (modelExtensions.includes(ext)) return inspectBundle([file], { name: file.name, source: options.source }, signal);
  if (ext && ext !== "pdf" && !textExtensions.has(ext)) throw new Error(`暂不支持 .${ext} 格式，请选择模型、设备包、工程、BOM、手册或 G 代码文件。`);
  const asDocument = options.hint === "manual" && ["", "txt", "md", "markdown"].includes(ext);
  const text = await readTextFile(file, ext, asDocument ? IMPORT_TEXT_LIMITS.materialBytes : maxFileBytes(ext), signal);
  return inspectContent(text, file.name, ext === "pdf" ? { ...options, hint: "manual" } : options, signal);
}

export async function inspectWorkbenchFiles(files: File[], options: WorkbenchImportOptions = {}, signal?: AbortSignal): Promise<WorkbenchImportResult> {
  signal?.throwIfAborted();
  if (!files.length) throw new Error("请选择要导入的文件。");
  if (!files.some(file => file.webkitRelativePath)) {
    if (files.length === 1) return inspectOne(files[0], options, signal);
    if (files.every(file => extension(file.name) === "json")) {
      let batch = emptyWorkspace();
      for (const file of files) {
        const item = await inspectOne(file, options, signal);
        if (item.kind === "device") batch = installPackage(batch, item.device);
        else if (item.kind === "devices") batch = item.devices.reduce(installPackage, batch);
        else throw new Error("完整工程、装配定义和含依赖的机械包需要单独导入。多个设备包 JSON 可以一起选择。");
      }
      return { kind: "devices", name: `${files.length} 个 JSON 文件`, devices: batch.packages };
    }
    if (files.some(file => !modelExtensions.includes(extension(file.name)) || /\.(zip|mjz)$/i.test(file.name))) {
      throw new Error("请分别导入独立的资料或工程。可以同时选择多个设备包 JSON，或同一模型的入口和配套资源。");
    }
  }
  return inspectBundle(files, { name: files[0].webkitRelativePath?.split("/")[0] || `${files.length} 个模型文件` }, signal);
}

async function inspectLink(url: URL, options: WorkbenchImportOptions, signal?: AbortSignal): Promise<WorkbenchImportResult> {
  if (url.username || url.password) throw new Error("请选择不含账号密码的公开资料链接。");
  const target = downloadableSource(url);
  let name: string;
  try { name = decodeURIComponent(target.pathname.split("/").at(-1) ?? ""); }
  catch { throw new Error("资料链接中的文件名编码无效。"); }
  const ext = extension(name);
  if (ext !== "pdf" && !textExtensions.has(ext) && !modelExtensions.includes(ext)) {
    return { kind: "source-link", name: options.title || url.hostname, url: url.href, source: options.source, title: options.title };
  }
  if (ext === "pdf" && IS_PAGES) throw new Error(pagesPdfMessage);
  if (ext === "pdf" && canReadOfficialSource(target)) {
    const body = await fetchSourceText("url", JSON.stringify({ url: target.href }), "application/json", signal ?? new AbortController().signal);
    signal?.throwIfAborted();
    return textCandidate(body, name, { ...options, hint: "manual", source: options.source || target.href });
  }
  let response: Response;
  try { response = await fetch(target.href, { credentials: "omit", referrerPolicy: "no-referrer", signal }); }
  catch (cause) {
    signal?.throwIfAborted();
    throw new Error("浏览器未能读取这个文件直链。可下载原文件后选择导入，也可使用允许跨域读取的下载地址。", { cause });
  }
  if (!response.ok || response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.ok ? "下载地址返回的是网页，请选择原始文件直链或上传下载的文件。" : `下载“${name}”失败（HTTP ${response.status}）。`);
  }
  const limit = maxFileBytes(ext);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("下载地址没有返回文件。");
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("下载文件超过该格式的大小上限。");
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("下载文件超过该格式的大小上限。");
      chunks.push(value.slice().buffer);
    }
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
  finally { reader.releaseLock(); }
  return inspectOne(new File(chunks, name), { ...options, source: options.source || target.href }, signal);
}

export async function inspectWorkbenchText(text: string, name: string, options: WorkbenchImportOptions = {}, signal?: AbortSignal): Promise<WorkbenchImportResult> {
  signal?.throwIfAborted();
  const trimmed = text.trim();
  if ((!options.hint || options.hint === "auto") && /^[a-z][a-z\d+.-]*:\/\/[^\s]+$/i.test(trimmed)) {
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new Error("资料链接格式有误。"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("资料链接须使用 HTTP 或 HTTPS，本机资料请选择文件。");
    return inspectLink(url, options, signal);
  }
  return inspectContent(text, name, options, signal);
}
