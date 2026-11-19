import { execFile } from "node:child_process";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readLimitedBytes } from "./lib/read-limited-bytes";
import { canReadOfficialSource, MAX_SOURCE_DOCUMENT_BYTES } from "../contracts/twin-source-url";

const maxTextBytes = 1024 * 1024;
const maxUrlBytes = 8192;

function officialUrl(value: unknown, base?: URL): URL {
  if (typeof value !== "string" || !value.trim() || value.length > maxUrlBytes) {
    throw new HTTPException(400, { message: "请填写汇川官方资料的完整 HTTPS 链接。" });
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new HTTPException(400, { message: "资料链接格式有误，请复制完整网址。" });
  }
  if (!canReadOfficialSource(url)) {
    throw new HTTPException(400, { message: "在线读取仅支持汇川官方资料站；其他来源可上传 PDF 或粘贴规格原文。" });
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

function pdfText(data: Buffer): Promise<string> {
  if (!isPdf(data)) throw new HTTPException(415, { message: "文件内容无法识别为 PDF，请重新选择手册。" });
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
  }).then(requireText);
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
  format: "pdf" | "html" | "text";
  heading?: string;
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
      if (isPdf(data) || type.includes("application/pdf")) return { text: await pdfText(data), format: "pdf" };
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
      if (type.startsWith("text/html")) {
        const heading = decoded.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
        return { text: requireText(htmlText(decoded)), format: "html", heading: heading ? htmlText(heading).trim() : undefined };
      }
      return { text: requireText(decoded), format: "text" };
    }
    throw new HTTPException(502, { message: "官方资料的跳转次数过多，请复制最终手册链接。" });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (signal.aborted) throw new HTTPException(504, { message: "读取官网资料超时，请上传 PDF 或粘贴规格原文。" });
    throw new HTTPException(502, { message: "无法读取官网资料，请上传 PDF 或粘贴规格原文。" });
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
  const data = await readLimitedBytes(c.req.raw, maxUrlBytes, new HTTPException(413, { message: "资料链接过长。" }));
  let input;
  try {
    input = JSON.parse(data.toString("utf8"));
  } catch {
    throw new HTTPException(400, { message: "资料链接请求需要 JSON 格式。" });
  }
  const { text } = await readOfficialDocument(input?.url);
  return c.json({ text });
});

twinSourceRouter.post("/pdf", async c => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new HTTPException(415, { message: "请选择 PDF 文件，或直接粘贴规格原文。" });
  }
  return c.json({ text: await pdfText(await documentBytes(c.req.raw)) });
});
