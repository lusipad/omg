import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPdfParseCacheForTest,
  pdfParseCacheStats,
  twinSourceRouter,
} from "../api/twin-source";
import { canReadOfficialSource } from "../contracts/twin-source-url";

function multiPagePdf(pages: string[]): string {
  // Objects: 1=Catalog, 2=Pages, 3..=Page objects, next=Font, remaining=Content streams
  const pageCount = pages.length;
  const fontObjId = 3 + pageCount;
  const kids = pages.map((_, idx) => `${3 + idx} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    const contentObjId = fontObjId + 1 + i;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = `BT /F1 12 Tf 20 45 Td (${escaped}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = "%PDF-1.4\n";
  const entries = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    entries.push(`${String(pdf.length).padStart(10, "0")} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return `${pdf}xref\n0 ${entries.length}\n${entries.join("\n")}\ntrailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

const pdfToolAvailable = spawnSync("pdftotext", ["-v"], { windowsHide: true }).status === 0;

beforeEach(() => {
  clearPdfParseCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("可追溯资料工件与拦截识别", () => {
  it("扩展官方域名白名单但仍拒绝不安全协议与第三方域名", () => {
    expect(canReadOfficialSource(new URL("https://www.deltaww.com/en-US/products/Servo-Systems/5158"))).toBe(true);
    expect(canReadOfficialSource(new URL("https://industry.panasonic.com/global/en/products/motor/msmf012l1t1"))).toBe(true);
    expect(canReadOfficialSource(new URL("https://tech.thk.com/en/products/pdf/en_a01_182.pdf"))).toBe(true);
    expect(canReadOfficialSource(new URL("http://www.deltaww.com/en-US/products"))).toBe(false);
    expect(canReadOfficialSource(new URL("https://example.org/manual.pdf"))).toBe(false);
  });

  it("识别 HTTP 200 使用条款拦截页，绝不误当规格正文解析", async () => {
    const deltaTermsUrl = "https://www.deltaww.com/en-US/products/Servo-Systems-AC-Servo-Motors-and-Drives/5158";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><head><title>Terms of Use - Delta Electronics</title></head><body><h1>Terms of Use</h1><p>Please read and accept Terms and Conditions before downloading brochures.</p></body></html>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )));

    const response = await twinSourceRouter.request("/artifact/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: deltaTermsUrl }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      gated: true,
      gateReason: "terms_of_use",
      canContinueWithUpload: true,
      sourceUrl: deltaTermsUrl,
    });
  });

  it("正常网页规格不被误判拦截，且按页面分类返回可追溯工件", async () => {
    const specUrl = "https://industry.panasonic.com/global/en/products/motor/fa-motor/ac-servo/number/msmf012l1t1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><head><title>MSMF012L1T1 Spec Detail</title></head><body><h1>MSMF012L1T1</h1><p>Rated output: 100 W</p><p>Rated torque: 0.32 N·m</p><p>Rated speed: 3000 r/min</p><a href='/terms'>Terms of Use</a></body></html>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )));

    const response = await twinSourceRouter.request("/artifact/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: specUrl }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifact).toMatchObject({
      format: "html",
      classification: "html_spec",
      sourceUrl: specUrl,
      pageCount: 1,
      title: "MSMF012L1T1",
    });
  });

  it.skipIf(!pdfToolAvailable)("上传本地 PDF 续接拦截任务：记录 SHA-256、分页文本且相同 PDF 只解析一次", async () => {
    const originUrl = "https://www.deltaww.com/en-US/products/Servo-Systems-AC-Servo-Motors-and-Drives/5158";
    const pdfContent = multiPagePdf([
      "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703 Page 1 Summary",
      "ASD-B3-0421-L Continuous current 2.65 Arms",
    ]);
    const expectedSha = createHash("sha256").update(Buffer.from(pdfContent, "utf8")).digest("hex");

    const first = await twinSourceRouter.request("/artifact/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-source-url": originUrl,
        "x-source-title": encodeURIComponent("ASDA-B3 Series Catalogue"),
      },
      body: pdfContent,
    });
    expect(first.status).toBe(200);
    const body1 = await first.json();
    expect(body1.artifact).toMatchObject({
      sha256: expectedSha,
      format: "pdf",
      classification: "pdf",
      sourceUrl: originUrl,
      title: "ASDA-B3 Series Catalogue",
      documentVersion: "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703",
      pageCount: 2,
    });
    expect(body1.artifact.pages[0].pageNumber).toBe(1);
    expect(body1.artifact.pages[1].text).toContain("ASD-B3-0421-L");
    expect(pdfParseCacheStats()).toEqual({ size: 1, hits: 0, misses: 1 });

    // 第二次提交相同字节 PDF：直接命中 SHA-256 缓存，不重复调用 pdftotext
    const second = await twinSourceRouter.request("/artifact/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdfContent,
    });
    expect(second.status).toBe(200);
    const body2 = await second.json();
    expect(body2.artifact.sha256).toBe(expectedSha);
    expect(pdfParseCacheStats()).toEqual({ size: 1, hits: 1, misses: 1 });
  });

  it("检查 PDF 工件接口的真实文件头", async () => {
    const invalid = await twinSourceRouter.request("/artifact/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: "<html>fake pdf</html>",
    });
    expect(invalid.status).toBe(415);
  });
});
