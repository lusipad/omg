export async function fetchSourceText(kind: "url" | "pdf", body: BodyInit, contentType: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`/api/twin-source/${kind}`, { method: "POST", headers: { "Content-Type": contentType }, body, signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.text !== "string") {
    throw new Error(typeof data?.error === "string" ? data.error : "资料服务未能读取正文。可复制规格表文字后继续。");
  }
  return data.text;
}
