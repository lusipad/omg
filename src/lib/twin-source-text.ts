import { SourceGateError, sourceArtifactSchema, type SourceArtifact } from "@contracts/source-artifact";

export async function fetchSourceText(kind: "url" | "pdf", body: BodyInit, contentType: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`/api/twin-source/${kind}`, { method: "POST", headers: { "Content-Type": contentType }, body, signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.text !== "string") {
    throw new Error(typeof data?.error === "string" ? data.error : "资料服务未能读取正文。可复制规格表文字后继续。");
  }
  return data.text;
}

export async function fetchSourceArtifactFromUrl(url: string, signal: AbortSignal): Promise<SourceArtifact> {
  const response = await fetch("/api/twin-source/artifact/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (data?.gated === true && (data.gateReason === "terms_of_use" || data.gateReason === "login_required")) {
      throw new SourceGateError(
        data.gateReason,
        typeof data.error === "string" ? data.error : "官网返回了拦截页，请上传已下载的 PDF 手册。",
        typeof data.sourceUrl === "string" ? data.sourceUrl : url,
      );
    }
    throw new Error(typeof data?.error === "string" ? data.error : "资料服务未能读取正文。可上传 PDF 或复制规格表文字后继续。");
  }
  return sourceArtifactSchema.parse(data?.artifact);
}

export async function fetchSourceArtifactFromPdf(
  file: File,
  meta: { sourceUrl?: string; title?: string },
  signal: AbortSignal,
): Promise<SourceArtifact> {
  const headers = new Headers({ "Content-Type": "application/pdf" });
  if (meta.sourceUrl?.trim()) headers.set("x-source-url", meta.sourceUrl.trim());
  const title = meta.title?.trim() || file.name.replace(/\.[^./\\]+$/, "").trim();
  if (title) headers.set("x-source-title", encodeURIComponent(title));
  const response = await fetch("/api/twin-source/artifact/pdf", {
    method: "POST",
    headers,
    body: file,
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "PDF 解析失败，可复制规格表文字后继续。");
  }
  return sourceArtifactSchema.parse(data?.artifact);
}
