import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  buildSourceArtifact,
  detectHtmlGate,
  splitDocumentPages,
  type SourceArtifact,
  type SourceArtifactPage,
} from "../contracts/source-artifact";
import { canReadOfficialSource, MAX_SOURCE_DOCUMENT_BYTES } from "../contracts/twin-source-url";
import { readLimitedBytes } from "./lib/read-limited-bytes";

const maxTextBytes = 1024 * 1024;
const maxUrlBytes = 8192;
const maxPdfCacheEntries = 32;

interface CachedPdf {
  rawText: string;
  text: string;
  pages: SourceArtifactPage[];
}

const pdfParseCache = new Map<string, CachedPdf>();
let pdfCacheHits = 0;
let pdfCacheMisses = 0;

export function clearPdfParseCacheForTest() {
  pdfParseCache.clear();
  pdfCacheHits = 0;
  pdfCacheMisses = 0;
}

export function pdfParseCacheStats() {
  return { size: pdfParseCache.size, hits: pdfCacheHits, misses: pdfCacheMisses };
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function officialUrl(value: unknown, base?: URL): URL {
  if (typeof value !== "string" || !value.trim() || value.length > maxUrlBytes) {
    throw new HTTPException(400, { message: "请填写制造商官方资料的完整 HTTPS 链接。" });
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new HTTPException(400, { message: "资料链接格式有误，请复制完整网址。" });
  }
  if (!canReadOfficialSource(url)) {
    throw new HTTPException(400, { message: "在线读取仅支持已登记的制造商官方 HTTPS 资料站；其他来源可上传 PDF 或粘贴规格原文。" });
  }
  return url;
}

function documentBytes(message: Request | Response): Promise<Buffer> {
  return readLimitedBytes(message, MAX_SOURCE_DOCUMENT_BYTES, new HTTPException(413, {
    message: "资料超过 8 MiB，请选择规格页或粘贴所需段落。",
  }));
}

function requireText(value: string): string {
  const text = value.trim();
  if (!text) throw new HTTPException(422, { message: "此资料未读到文字。扫描件可先做 OCR，动态网页可复制规格表或上传文字版 PDF。" });
  if (Buffer.byteLength(text) > maxTextBytes) throw new HTTPException(413, { message: "资料文字过多，请选择规格页或粘贴所需段落。" });
  return text;
}

function isPdf(data: Buffer): boolean {
  return data.toString("ascii", 0, 5) === "%PDF-";
}

function runPdfToText(data: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
      encoding: "utf8", maxBuffer: maxTextBytes, timeout: 15_000, windowsHide: true,
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      if (error.code === "ENOENT") return reject(new HTTPException(503, { message: "服务端未安装 Poppler（pdftotext），可直接粘贴手册的规格段落。" }));
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new HTTPException(413, { message: "PDF 文字过多，请选择规格页或粘贴所需段落。" }));
      return reject(new HTTPException(422, { message: "PDF 文字提取失败，请选择可复制文字的规格页或粘贴手册原文。" }));
    });
    // A converter that exits early closes stdin. Its exit callback above carries the useful error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(data);
  });
}

async function parsePdfCached(data: Buffer): Promise<CachedPdf & { sha256: string }> {
  if (!isPdf(data)) throw new HTTPException(415, { message: "文件内容无法识别为 PDF，请重新选择手册。" });
  const sha256 = sha256Hex(data);
  const hit = pdfParseCache.get(sha256);
  if (hit) {
    pdfCacheHits += 1;
    return { ...hit, sha256 };
  }
  const rawText = await runPdfToText(data);
  const text = requireText(rawText);
  const pages = splitDocumentPages(rawText);
  pdfCacheMisses += 1;
  if (pdfParseCache.size >= maxPdfCacheEntries) {
    const oldest = pdfParseCache.keys().next().value;
    if (oldest !== undefined) pdfParseCache.delete(oldest);
  }
  const entry: CachedPdf = { rawText, text, pages };
  pdfParseCache.set(sha256, entry);
  return { ...entry, sha256 };
}

function htmlText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:p|tr|div|li|h[1-6]|br)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (matched: string, entity: string) => {
      const key = entity.toLowerCase();
      if (entities[key] !== undefined) return entities[key];
      const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : matched;
    })
    .replace(/[^\S\n]+/g, " ").replace(/ *\n(?: *\n)* */g, "\n");
}

export interface OfficialDocument {
  text: string;
  rawText: string;
  format: "pdf" | "html" | "text";
  sha256: string;
  finalUrl: string;
  heading?: string;
  pageTitle?: string;
}

export async function readOfficialDocument(value: unknown): Promise<OfficialDocument> {
  let url = officialUrl(value);
  const signal = AbortSignal.timeout(15_000);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        url = officialUrl(response.headers.get("location"), url);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new HTTPException(502, { message: `官网返回 HTTP ${response.status}，请检查资料链接或上传已下载的 PDF。` });
      }
      const type = response.headers.get("content-type")?.toLowerCase() ?? "";
      const data = await documentBytes(response);
      if (isPdf(data) || type.includes("application/pdf")) {
        const parsed = await parsePdfCached(data);
        return { text: parsed.text, rawText: parsed.rawText, format: "pdf", sha256: parsed.sha256, finalUrl: url.href };
      }
      if (!type.startsWith("text/html") && !type.startsWith("text/plain")) {
        throw new HTTPException(415, { message: "此链接未返回 PDF 或资料正文，请打开具体手册再复制链接。" });
      }
      const charset = type.match(/charset=["']?([\w-]+)/)?.[1] ?? "utf-8";
      let decoded: string;
      try {
        decoded = new TextDecoder(charset).decode(data);
      } catch {
        throw new HTTPException(422, { message: "网页字符编码无法识别，请粘贴规格原文。" });
      }
      const sha256 = sha256Hex(data);
      if (type.startsWith("text/html")) {
        const heading = decoded.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
        const title = decoded.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
        const text = requireText(htmlText(decoded));
        return {
          text,
          rawText: text,
          format: "html",
          sha256,
          finalUrl: url.href,
          heading: heading ? htmlText(heading).trim() : undefined,
          pageTitle: title ? htmlText(title).trim() : undefined,
        };
      }
      const text = requireText(decoded);
      return { text, rawText: decoded, format: "text", sha256, finalUrl: url.href };
    }
    throw new HTTPException(502, { message: "官方资料的跳转次数过多，请复制最终手册链接。" });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (signal.aborted) throw new HTTPException(504, { message: "读取官网资料超时，请上传 PDF 或粘贴规格原文。" });
    throw new HTTPException(502, { message: "无法读取官网资料，请上传 PDF 或粘贴规格原文。" });
  }
}

async function parseJsonUrlBody(raw: Request): Promise<unknown> {
  let input: unknown;
  const data = await readLimitedBytes(raw, maxUrlBytes, new HTTPException(413, { message: "资料链接过长。" }));
  try {
    input = JSON.parse(data.toString("utf8"));
  } catch {
    throw new HTTPException(400, { message: "资料链接请求需要 JSON 格式。" });
  }
  return input && typeof input === "object" && "url" in input ? input.url : undefined;
}

function optionalHeaderUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length > 2048 || !URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
}

function optionalHeaderTitle(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return decodeURIComponent(trimmed).trim().slice(0, 512) || undefined;
  } catch {
    return trimmed.slice(0, 512) || undefined;
  }
}

export const twinSourceRouter = new Hono();
twinSourceRouter.onError((error, c) => error instanceof HTTPException
  ? c.json({ error: error.message }, error.status)
  : c.json({ error: "读取资料失败，请重试或粘贴规格原文。" }, 500));

twinSourceRouter.post("/url", async c => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPException(415, { message: "资料链接请求需要 JSON 格式。" });
  }
  const { text } = await readOfficialDocument(await parseJsonUrlBody(c.req.raw));
  return c.json({ text });
});

twinSourceRouter.post("/pdf", async c => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new HTTPException(415, { message: "请选择 PDF 文件，或直接粘贴规格原文。" });
  }
  const { text } = await parsePdfCached(await documentBytes(c.req.raw));
  return c.json({ text });
});

twinSourceRouter.post("/artifact/url", async c => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPException(415, { message: "资料链接请求需要 JSON 格式。" });
  }
  const doc = await readOfficialDocument(await parseJsonUrlBody(c.req.raw));
  if (doc.format === "html") {
    const gate = detectHtmlGate(doc.text, doc.heading ?? doc.pageTitle);
    if (gate.gated) {
      return c.json({
        error: gate.message,
        gated: true,
        gateReason: gate.reason,
        canContinueWithUpload: true,
        sourceUrl: doc.finalUrl,
      }, 422);
    }
  }
  const artifact: SourceArtifact = buildSourceArtifact({
    sha256: doc.sha256,
    rawText: doc.rawText,
    format: doc.format,
    title: doc.heading ?? doc.pageTitle,
    sourceUrl: doc.finalUrl,
    heading: doc.heading ?? doc.pageTitle,
  });
  return c.json({ artifact });
});

twinSourceRouter.post("/artifact/pdf", async c => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new HTTPException(415, { message: "请选择 PDF 文件，或直接粘贴规格原文。" });
  }
  const parsed = await parsePdfCached(await documentBytes(c.req.raw));
  const sourceUrl = optionalHeaderUrl(c.req.header("x-source-url"));
  const title = optionalHeaderTitle(c.req.header("x-source-title"));
  const artifact: SourceArtifact = buildSourceArtifact({
    sha256: parsed.sha256,
    rawText: parsed.rawText,
    format: "pdf",
    ...(title && { title }),
    ...(sourceUrl && { sourceUrl }),
  });
  return c.json({ artifact });
});
