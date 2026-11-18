import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { twinSourceRouter } from "../api/twin-source";

function fromUrl(url: string) {
  return twinSourceRouter.request("/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

function pdfUpload(body: BodyInit, additionalHeaders: Record<string, string> = {}) {
  return twinSourceRouter.request("/pdf", {
    method: "POST", headers: { "Content-Type": "application/pdf", ...additionalHeaders }, body,
  });
}

// A single page of selectable text, small enough to exercise the real converter without a vendor download.
function testPdf(text: string): string {
  const stream = `BT /F1 12 Tf 20 45 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const entries = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    entries.push(`${String(pdf.length).padStart(10, "0")} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return `${pdf}xref\n0 ${entries.length}\n${entries.join("\n")}\ntrailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

const pdfToolAvailable = spawnSync("pdftotext", ["-v"], { windowsHide: true }).status === 0;
afterEach(() => { vi.unstubAllGlobals(); });

describe("官方资料读取", () => {
  it("仅接受 JSON 格式的链接请求", async () => {
    const response = await twinSourceRouter.request("/url", { method: "POST", body: "{}" });
    expect(response.status).toBe(415);
    const broken = await twinSourceRouter.request("/url", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    });
    expect(broken.status).toBe(400);
  });

  it("跟随官网相对跳转并保留网页规格表的行和值", async () => {
    const fetchDocument = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/manual" } }))
      .mockResolvedValueOnce(new Response(
        "<head><title>页头</title></head><script>dynamic()</script><table><tr><td>ON voltage</td><td>&gt; 15 VDC</td></tr><tr><td>OFF voltage</td><td>&lt; 5 VDC</td></tr></table>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ));
    vi.stubGlobal("fetch", fetchDocument);
    const response = await fromUrl("https://www.inovance.com/product");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "ON voltage > 15 VDC\nOFF voltage < 5 VDC" });
    expect(String(fetchDocument.mock.calls[1][0])).toBe("https://www.inovance.com/manual");
    expect(fetchDocument.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([
    "http://www.inovance.com/doc", "https://www.inovance.eu:444/doc",
    "https://user@www.inovance.com/doc", "https://example.org/doc",
  ])("发送请求前拒绝不符合官方来源要求的地址 %s", async url => {
    const fetchDocument = vi.fn();
    vi.stubGlobal("fetch", fetchDocument);
    expect((await fromUrl(url)).status).toBe(400);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("逐跳检查官网重定向目的地", async () => {
    const fetchDocument = vi.fn().mockResolvedValue(
      new Response(null, { status: 301, headers: { location: "https://example.org/other" } }),
    );
    vi.stubGlobal("fetch", fetchDocument);
    expect((await fromUrl("https://portal-file.inovance.com/manual")).status).toBe(400);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("检测缺乏正文的动态网页，提供手动读取途径", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      '<html><script src="app.js"></script><div id="app"></div></html>',
      { headers: { "Content-Type": "text/html" } },
    )));
    const response = await fromUrl("https://www.inovance.com/product");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining("规格表") });
  });

  it("按上限停止循环跳转", async () => {
    const fetchDocument = vi.fn().mockImplementation(async () => new Response(null, {
      status: 302, headers: { location: "/again" },
    }));
    vi.stubGlobal("fetch", fetchDocument);
    expect((await fromUrl("https://www.inovance.com/again")).status).toBe(502);
    expect(fetchDocument).toHaveBeenCalledTimes(5);
  });

  it("官网异常可转用已下载文件", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const response = await fromUrl("https://www.inovance.eu/manual");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: expect.stringContaining("上传 PDF") });
  });
});

describe("上传 PDF", () => {
  it("从原始 PDF 读取文字，或在未安装 Poppler 时提供粘贴入口", async () => {
    const response = await pdfUpload(testPdf("DI filter time 10 ms"));
    expect(response.status).toBe(pdfToolAvailable ? 200 : 503);
    if (pdfToolAvailable) expect(await response.json()).toEqual({ text: "DI filter time 10 ms" });
    else expect(await response.json()).toEqual({ error: expect.stringContaining("pdftotext") });
  });

  it("检查上传格式及实际文件内容", async () => {
    expect((await pdfUpload("a text file", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await pdfUpload("a text file")).status).toBe(415);
  });

  it.skipIf(!pdfToolAvailable)("无文字层时返回可操作的说明", async () => {
    const response = await pdfUpload(testPdf(""));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining("OCR") });
  });

  it("按实际读取字节限制大小", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
    const response = await pdfUpload(bytes, { "Content-Length": "1" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("8 MiB") });
  });
});
