/** Run the same Web Worker, CSV download and Modelica export as the workbench in a real browser. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";

if (!process.argv[2]) throw new Error("Usage: tsx scripts/modelica/prepare-contour-exports.ts <verification-directory>");
const root = fileURLToPath(new URL("../../", import.meta.url)), out = resolve(process.argv[2], "contour-exports");
const scratch = mkdtempSync(join(tmpdir(), "gouyuan-contour-browser-")), site = join(scratch, "site");
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const cases = new Set(["pocket", "heavy-rotor", "helical"]);
const executable = process.env.CHROME_BIN || (process.platform === "win32"
  ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
  : "google-chrome");
assert(executable, "Set CHROME_BIN to an installed Chromium executable");
const config = { configFile: false as const, root, publicDir: false as const, logLevel: "warn" as const,
  resolve: { alias: { "@contracts": join(root, "contracts"), "@": join(root, "src") } } };
const done = Promise.withResolvers<void>();
let server: PreviewServer | undefined, chrome: ChildProcess | undefined;
const timeout = setTimeout(() => done.reject(new Error("Timed out waiting for Chromium contour capture")), 120_000);

try {
  await build({ ...config, build: { outDir: site, emptyOutDir: false, rollupOptions: { input: join(root, "scripts/modelica/capture-contour-browser.ts"),
    output: { entryFileNames: "capture.js" } } } });
  mkdirSync(join(site, "modelica/runtime"), { recursive: true });
  for (const name of ["Gouyuan.mo", "GouyuanMotor.mo", "GouyuanContour.mo", "runtime/contour-axis.wasm"])
    copyFileSync(join(root, "public/modelica", name), join(site, "modelica", name));
  writeFileSync(join(site, "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="/capture.js"></script>');
  server = await preview({ ...config, build: { outDir: site }, preview: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "capture-contour-downloads",
    configurePreviewServer(s) {
      s.middlewares.use("/capture-result", async (req, res) => {
        try {
          assert.equal(req.method, "POST");
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers["content-type"]! } }).formData();
          if (form.has("error")) throw new Error(String(form.get("error")));
          const expected = JSON.parse(String(form.get("expected")));
          assert(cases.delete(expected.kind), "Unexpected or duplicate browser case");
          const archive = new Uint8Array(await (form.get("archive") as Blob).arrayBuffer()), csv = await (form.get("csv") as Blob).text();
          const folder = join(out, expected.kind);
          mkdirSync(folder, { recursive: true });
          writeFileSync(join(folder, "contour.zip"), archive);
          writeFileSync(join(folder, "browser.csv"), csv);
          writeFileSync(join(folder, "expected.json"), JSON.stringify({ ...expected, archiveSha256: sha(archive), csvSha256: sha(csv) }, null, 2) + "\n");
          console.log(`${expected.kind}: ${expected.samples} live browser observations, peak following error ${expected.maxErrorMm} mm`);
          res.end("ok");
          if (!cases.size) done.resolve();
        } catch (error) { res.statusCode = 500; res.end("capture failed"); done.reject(error); }
      });
    },
  }] });
  const url = server.resolvedUrls!.local[0];
  const options = ["--headless", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--user-data-dir=" + join(scratch, "profile"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), url];
  chrome = spawn(executable, options, { windowsHide: true, stdio: "ignore" });
  chrome.on("error", done.reject);
  chrome.on("exit", code => { if (cases.size) done.reject(new Error(`Chromium exited ${code} before capture`)); });
  await done.promise;
} finally {
  clearTimeout(timeout);
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill();
    await exited;
  }
  await server?.close();
  try { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { console.warn(`Could not clean temporary Chromium profile ${scratch}: ${error}`); }
}
