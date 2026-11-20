import { z } from "zod";

export const sourceArtifactPageSchema = z.strictObject({
  pageNumber: z.number().int().positive(),
  text: z.string(),
});

export const sourceArtifactKindSchema = z.enum(["pdf", "html_spec", "html_series", "text"]);

export const sourceArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.enum(["pdf", "html", "text"]),
  classification: sourceArtifactKindSchema,
  title: z.string().trim().min(1).max(512).optional(),
  sourceUrl: z.string().trim().max(2048).pipe(z.url({ protocol: /^https?$/ })).optional(),
  documentVersion: z.string().trim().min(1).max(160).optional(),
  pageCount: z.number().int().positive(),
  pages: z.array(sourceArtifactPageSchema).min(1).max(2000),
  text: z.string().min(1),
});

export type SourceArtifactPage = z.infer<typeof sourceArtifactPageSchema>;
export type SourceArtifactKind = z.infer<typeof sourceArtifactKindSchema>;
export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;

export type HtmlGateResult =
  | { gated: false }
  | {
      gated: true;
      reason: "terms_of_use" | "login_required";
      message: string;
      canContinueWithUpload: true;
    };

export class SourceGateError extends Error {
  readonly reason: "terms_of_use" | "login_required";
  readonly canContinueWithUpload = true as const;
  readonly sourceUrl?: string;

  constructor(reason: "terms_of_use" | "login_required", message: string, sourceUrl?: string) {
    super(message);
    this.name = "SourceGateError";
    this.reason = reason;
    this.sourceUrl = sourceUrl;
  }
}

export function normalizeSourceQuote(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function splitDocumentPages(rawText: string): SourceArtifactPage[] {
  const parts = rawText.split("\f");
  while (parts.length > 1 && !parts[parts.length - 1].trim()) {
    parts.pop();
  }
  return parts.map((part, index) => ({
    pageNumber: index + 1,
    text: part.trim(),
  }));
}

export function extractDocumentVersion(text: string): string | undefined {
  const matches = new Set<string>();
  for (const m of text.matchAll(/\b(DELTA_IA-[A-Z0-9_-]{4,120})\b/g)) {
    matches.add(m[1]);
  }
  for (const m of text.matchAll(/Data\s+code:\s*(\S{1,80}\s+V\d+(?:\.\d+){0,3})/gi)) {
    matches.add(m[1].replace(/\s+/g, " ").trim());
  }
  if (matches.size === 0) {
    for (const m of text.matchAll(/(?:^|\n)\s*(?:document\s*(?:no\.?|code|version)|文件号|样本编号|资料版本)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]{2,80})/gi)) {
      matches.add(m[1].trim());
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

export function detectHtmlGate(rawHtmlOrText: string, heading?: string): HtmlGateResult {
  const combined = `${heading ?? ""}\n${rawHtmlOrText}`;
  const specMatches = combined.match(/\b\d+(?:\.\d+)?\s*(?:kW|W|N[·.]m|Nm|r\/min|rpm|Arms|A\s*\(rms\)|VDC|VAC|mm\/rev|ms|Ohm)\b/gi) ?? [];
  if (specMatches.length >= 2) return { gated: false };

  const termsHit = /\bterms\s+(?:of\s+use|and\s+conditions|&\s*conditions)\b|\baccept\s+(?:the\s+)?terms\b|使用条款|条款与条件|接受条款/i.test(combined);
  const loginHit = /\bsign\s+in\s+to\s+(?:download|view|access|continue)\b|\blog\s+in\s+to\s+(?:download|view|access|continue)\b|请先登录|登录后(?:查看|下载)|member\s+login/i.test(combined);
  if (!termsHit && !loginHit) return { gated: false };

  const reason = loginHit && !termsHit ? "login_required" : "terms_of_use";
  const message = reason === "login_required"
    ? "该官网链接需要登录后才可访问规格手册。可直接上传已下载的 PDF 手册继续当前任务。"
    : "该官网链接返回了使用条款或下载确认页，而非设备规格正文。可直接上传已下载的 PDF 手册或粘贴规格段落继续当前任务。";
  return { gated: true, reason, message, canContinueWithUpload: true };
}

export function classifySourceContent(
  text: string,
  format: "pdf" | "html" | "text",
  heading?: string,
): SourceArtifactKind {
  if (format === "pdf") return "pdf";
  if (format === "text") return "text";
  const seriesHeading = heading ? /\bseries\b|系列/i.test(heading) : false;
  const seriesPattern = /\bseries\b|系列/i.test(text.slice(0, 1200));
  const wildcardModels = /[*?□△]/u.test(text);
  if (seriesHeading || (seriesPattern && wildcardModels)) {
    return "html_series";
  }
  return "html_spec";
}

export function buildSourceArtifact(input: {
  sha256: string;
  rawText: string;
  format: "pdf" | "html" | "text";
  title?: string;
  sourceUrl?: string;
  heading?: string;
}): SourceArtifact {
  const pages = splitDocumentPages(input.rawText);
  const text = input.rawText.trim();
  if (!text || !pages.some((page) => page.text.length > 0)) {
    throw new Error("此资料未读到有效正文内容。");
  }
  const documentVersion = extractDocumentVersion(text);
  const classification = classifySourceContent(text, input.format, input.heading);
  return sourceArtifactSchema.parse({
    schemaVersion: 1,
    sha256: input.sha256,
    format: input.format,
    classification,
    ...(input.title?.trim() ? { title: input.title.trim() } : input.heading?.trim() ? { title: input.heading.trim() } : {}),
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
    ...(documentVersion ? { documentVersion } : {}),
    pageCount: pages.length,
    pages,
    text,
  });
}

export function findEvidencePage(
  artifact: Pick<SourceArtifact, "pages">,
  quote: string,
): number | undefined {
  const lines = quote.split(/\r?\n/).map(normalizeSourceQuote).filter(Boolean);
  if (!lines.length) return undefined;
  for (const page of artifact.pages) {
    const normalizedPage = normalizeSourceQuote(page.text);
    if (lines.every((line) => normalizedPage.includes(line))) {
      return page.pageNumber;
    }
  }
  return undefined;
}
