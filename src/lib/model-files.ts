import { zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { MODEL_LIMITS, MAX_PROJECT_JSON_BYTES, type ModelBundle, type ModelFile, type ModelRef } from "@contracts/import-catalog";
import { parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { readStoredModel, writeModels, type StoredModel } from "./model-store";

const { maxFiles, maxBundleBytes, maxFileBytes, maxProjectBytes } = MODEL_LIMITS;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encode = new TextEncoder();
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const modelExtension = /\.(?:xml|urdf|mjcf)$/i;
function hasControl(text: string) { return Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }

export class ProjectArchiveFileError extends Error {
  constructor() { super("此文件是工程包，请通过工程导入打开。"); }
}

function relativePath(raw: string, base: string[] = [], allowParent = false): string {
  const path = raw.replaceAll("\\", "/").normalize("NFC");
  if (!path || path.startsWith("/") || path.includes(":") || path.length > 2048 || hasControl(path)) {
    throw new Error("资源必须使用包内相对路径：" + raw);
  }
  const parts = [...base];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!allowParent || !parts.length) throw new Error("资源路径越出包目录：" + raw);
      parts.pop();
    } else {
      if (part === "__proto__") throw new Error("资源路径使用了保留名称：" + raw);
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error("缺少资源文件名：" + raw);
  return parts.join("/");
}

function checkPathCollisions(entries: { path: string; directory?: boolean }[]) {
  const seen = new Map<string, { path: string; directory: boolean }>();
  const explicit = new Set<string>();
  for (const { path, directory = false } of entries) {
    if (explicit.has(path)) throw new Error("重复的资源路径：" + path);
    explicit.add(path);
    const parts = path.split("/");
    for (let i = 0, prefix = ""; i < parts.length; i++) {
      prefix += (i ? "/" : "") + parts[i];
      const key = prefix.toLowerCase(), isDir = i < parts.length - 1 || directory;
      const old = seen.get(key);
      if (old && (old.path !== prefix || old.directory !== isDir)) throw new Error("资源路径存在大小写或文件夹冲突：" + path);
      if (!old) seen.set(key, { path: prefix, directory: isDir });
    }
  }
}

function validateFiles(files: ModelFile[]) {
  if (!files.length || files.length > maxFiles) throw new Error("模型包的文件数量应在 1 到 " + maxFiles + " 之间。");
  let bytes = 0;
  for (const file of files) {
    if (relativePath(file.path) !== file.path) throw new Error("资源路径尚未规范化：" + file.path);
    bytes += file.data.byteLength;
    if (file.data.byteLength > maxFileBytes || bytes > maxBundleBytes) throw new Error("模型资源超出单文件或整包大小上限。");
  }
  checkPathCollisions(files);
}

// Read ZIP directory metadata before allocating decompression buffers.
interface ZipEntry { path: string; directory: boolean; offset: number; compressed: number; size: number; crc: number; method: number }
function zipDirectory(data: Uint8Array, limit: number, countLimit: number): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (i: number) => view.getUint16(i, true), u32 = (i: number) => view.getUint32(i, true);
  const invalid = () => new Error("ZIP 目录损坏或使用了不支持的压缩格式。");
  let end = data.length - 22;
  while (end >= 0 && end >= data.length - 65557 && !(u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === data.length)) end--;
  if (end < 0 || end < data.length - 65557 || u16(end + 4) || u16(end + 6)) throw invalid();
  const count = u16(end + 10), start = u32(end + 16);
  if (u16(end + 8) !== count || count > countLimit * 2 || start + u32(end + 12) !== end) throw invalid();
  const entries: ZipEntry[] = [];
  let pos = start, total = 0, fileCount = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50) throw invalid();
    const flags = u16(pos + 8), method = u16(pos + 10), compressed = u32(pos + 20), size = u32(pos + 24);
    const length = u16(pos + 28), local = u32(pos + 42), next = pos + 46 + length + u16(pos + 30) + u16(pos + 32);
    if (flags & ~0x80e || (method !== 0 && method !== 8) || next > end || !length || length > 4096 ||
        u16(pos + 34) || local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 8) !== method || u16(local + 6) !== flags) throw invalid();
    const name = utf8.decode(data.subarray(pos + 46, pos + 46 + length)), directory = /[\\/]$/.test(name);
    const localLength = u16(local + 26), offset = local + 30 + localLength + u16(local + 28);
    if (offset + compressed > start || utf8.decode(data.subarray(local + 30, local + 30 + localLength)) !== name ||
        (method === 0 && compressed !== size) || (directory && size !== 0)) throw invalid();
    if (!directory) fileCount++;
    total += size;
    if (total > limit || size > maxFileBytes || fileCount > countLimit) throw new Error("ZIP 解压后的资源数量或大小超出上限。");
    if (name !== "./") entries.push({ path: relativePath(name), directory, offset, compressed, size, method, crc: u32(pos + 16) });
    pos = next;
  }
  if (pos !== end) throw invalid();
  checkPathCollisions(entries);
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let b = 0; b < 8; b++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n;
});

async function unzipMember(bytes: Uint8Array<ArrayBuffer>, e: ZipEntry): Promise<ModelFile> {
  const chunk = bytes.subarray(e.offset, e.offset + e.compressed);
  let data: Uint8Array = chunk;
  if (e.method === 8) {
    const output = new Uint8Array(e.size);
    const reader = new Blob([chunk]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    let n = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (n + part.value.length > output.length) { await reader.cancel(); throw new Error("ZIP 资源超出声明长度：" + e.path); }
        output.set(part.value, n);
        n += part.value.length;
      }
    } finally { reader.releaseLock(); }
    if (n !== e.size) throw new Error("ZIP 资源长度不匹配：" + e.path);
    data = output;
  }
  let crc = 0xffffffff, lastYield = performance.now();
  for (let offset = 0; offset < data.length; offset += 262144) {
    const stop = Math.min(data.length, offset + 262144);
    for (let i = offset; i < stop; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 255];
    if (performance.now() - lastYield > 12) { await nextTurn(); lastYield = performance.now(); }
  }
  if ((~crc >>> 0) !== e.crc) throw new Error("ZIP 资源校验失败：" + e.path);
  return { path: e.path, data: e.method === 0 ? data.slice() : data };
}

function projectSignature(data: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(utf8.decode(data));
    return !!value && typeof value === "object" && ["schemaVersion", "packages", "instances", "connections"].every((key) => Object.hasOwn(value, key));
  } catch { return false; }
}

async function unpackZip(file: File, project: boolean): Promise<ModelFile[]> {
  if (file.size > maxProjectBytes + 2 * 1024 * 1024) throw new Error("ZIP 文件超出工程大小上限。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = zipDirectory(bytes, maxProjectBytes, maxFiles * 8).filter((e) => !e.directory);
  const meta = entries.find((e) => e.path === "workspace.json");
  let manifest: ModelFile | undefined;
  if (!project && meta && meta.size <= MAX_PROJECT_JSON_BYTES) {
    manifest = await unzipMember(bytes, meta);
    if (projectSignature(manifest.data)) throw new ProjectArchiveFileError();
  }
  if (!project && (entries.length > maxFiles || entries.reduce((n, e) => n + e.size, 0) > maxBundleBytes)) throw new Error("模型包超出资源数量或大小上限。");
  const result: ModelFile[] = [];
  let lastYield = performance.now();
  for (const e of entries) {
    result.push(e === meta && manifest ? manifest : await unzipMember(bytes, e));
    if (performance.now() - lastYield > 12) { await nextTurn(); lastYield = performance.now(); }
  }
  return result;
}

function xmlText(file: ModelFile): string {
  const b = file.data;
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(b);
  return utf8.decode(b);
}

function xmlValue(text: string): string {
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    const builtin: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(builtin, entity)) return builtin[entity];
    if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) return String.fromCodePoint(Number(entity.slice(1).replace(/^x/i, "0x")));
    throw new Error("模型 XML 含有不支持的实体。");
  });
}

// Only element structure and attributes are needed for resource discovery. This
// iterator also runs in workers without DOMParser; MuJoCo validates the model.
function* xmlElements(file: ModelFile) {
  const text = xmlText(file), stack: string[] = [];
  const head = /<(\/?)([\w:.-]+)/y, attr = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y, end = /\s*(\/?)>/y;
  const invalid = () => new Error("模型 XML 结构无效：" + file.path);
  let cursor = 0, hadRoot = false;
  for (;;) {
    const next = text.indexOf("<", cursor);
    if (next < 0) {
      if (stack.length || !hadRoot || text.slice(cursor).trim()) throw invalid();
      return;
    }
    if (!stack.length && text.slice(cursor, next).trim()) throw invalid();
    let skipped = false;
    for (const [open, close] of [["<!--", "-->"], ["<?", "?>"], ["<![CDATA[", "]]>"]]) {
      if (!text.startsWith(open, next)) continue;
      const stop = text.indexOf(close, next + open.length);
      if (stop < 0) throw invalid();
      cursor = stop + close.length;
      skipped = true;
      break;
    }
    if (skipped) continue;
    head.lastIndex = next;
    const tag = head.exec(text);
    if (!tag) throw invalid();
    cursor = head.lastIndex;
    const attrs: Record<string, string> = Object.create(null);
    for (;;) {
      end.lastIndex = cursor;
      const finish = end.exec(text);
      if (finish) {
        cursor = end.lastIndex;
        if (tag[1]) { if (finish[1] || stack.pop() !== tag[2]) throw invalid(); }
        else {
          if (!stack.length && hadRoot) throw invalid();
          hadRoot = true;
          if (!finish[1]) stack.push(tag[2]);
          yield { name: tag[2], attrs };
        }
        break;
      }
      attr.lastIndex = cursor;
      const pair = attr.exec(text);
      if (tag[1] || !pair || Object.hasOwn(attrs, pair[1])) throw invalid();
      attrs[pair[1]] = xmlValue(pair[2] ?? pair[3]);
      cursor = attr.lastIndex;
    }
  }
}

function dirname(path: string) { return path.split("/").slice(0, -1); }

export function resolveModelResource(files: readonly ModelFile[], baseFile: string, reference: string): string {
  if (reference.startsWith("package://")) {
    const match = /^package:\/\/([^/\\:]+)\/(.+)$/.exec(reference);
    if (!match || /^\.{1,2}$/.test(match[1])) throw new Error("无效的 ROS 包内资源：" + reference);
    const tail = relativePath(match[2]), suffix = relativePath(match[1] + "/" + tail);
    const paths = new Set(files.filter((f) => f.path === suffix || f.path.endsWith("/" + suffix)).map((f) => f.path));
    for (const f of files.filter((f) => /(^|\/)package\.xml$/i.test(f.path))) {
      const packageName = /<name>\s*([^<>]+?)\s*<\/name>/.exec(xmlText(f).replace(/<!--[\s\S]*?-->/g, ""))?.[1];
      if (packageName !== match[1]) continue;
      const target = [...dirname(f.path), tail].join("/");
      if (files.some((item) => item.path === target)) paths.add(target);
    }
    if (paths.size !== 1) throw new Error("ROS 包资源缺失或匹配不唯一：" + reference);
    return [...paths][0];
  }
  const path = relativePath(reference, dirname(baseFile), true);
  if (!files.some((f) => f.path === path)) throw new Error("模型缺少资源：" + path);
  return path;
}

function isModelRoot(name: string | undefined) { return name === "mujoco" || name === "robot"; }

export async function readModelFiles(input: File[]): Promise<{ files: ModelFile[]; entries: string[] }> {
  let files: ModelFile[];
  if (input.length === 1 && !input[0].webkitRelativePath && /\.(zip|mjz)$/i.test(input[0].name)) {
    files = await unpackZip(input[0], false);
  } else {
    if (!input.length || input.length > maxFiles || input.some((f) => f.size > maxFileBytes) ||
        input.reduce((sum, f) => sum + f.size, 0) > maxBundleBytes) throw new Error("请选择大小和数量在上限内的模型文件。");
    const names = input.map((f) => relativePath(f.webkitRelativePath || f.name));
    const base = names[0].split("/")[0] + "/";
    const selectedFolder = input.every((f, i) => f.webkitRelativePath && names[i].startsWith(base));
    const paths = names.map((p) => selectedFolder ? p.slice(base.length) : p);
    checkPathCollisions(paths.map((path) => ({ path })));
    files = await Promise.all(input.map(async (f, i) => ({ path: paths[i], data: new Uint8Array(await f.arrayBuffer()) })));
  }
  validateFiles(files);
  const entries = [];
  let xmlError: unknown;
  for (const file of files) {
    if (!modelExtension.test(file.path)) continue;
    try {
      const root = xmlElements(file).next().value;
      if (root && isModelRoot(root.name)) entries.push(file.path);
    } catch (error) { xmlError = error; }
    await nextTurn();
  }
  if (!entries.length && !files.some((f) => /\.(?:stl|obj)$/i.test(f.path))) {
    throw xmlError ?? new Error("缺少 MJCF、URDF 或 STL/OBJ 网格。");
  }
  return { files, entries: entries.sort() };
}

async function inspectModel(bundle: ModelBundle, assetPaths?: Set<string>) {
  const files = bundle.files, byPath = new Map(files.map((f) => [f.path, f]));
  const first = byPath.get(bundle.entry);
  if (!first || !modelExtension.test(bundle.entry)) throw new Error("找不到指定的模型入口：" + bundle.entry);
  const root = xmlElements(first).next().value;
  if (!root || !isModelRoot(root.name)) throw new Error("入口必须是含 mujoco 或 robot 根节点的模型文件。");
  const visited = new Set<string>(), sources = new Set<string>();
  let lastYield = performance.now();
  async function inspect(main: string) {
    const queue = [main], includes = new Set<string>(), childModels: string[] = [];
    const assets: { tag: string; ref: string; owner: string }[] = [];
    const compiler: Record<string, string> = {};
    const localResource = (owner: string, ref: string) => {
      // MuJoCo resolves a nested include's resources next to that file, and
      // falls back to the main model directory for flattened resource layouts.
      if (owner !== main) {
        const candidate = relativePath(ref, dirname(owner), true);
        if (byPath.has(candidate)) return candidate;
      }
      return resolveModelResource(files, main, ref);
    };
    const urdf = xmlElements(byPath.get(main)!).next().value?.name === "robot";
    for (let i = 0; i < queue.length; i++) {
      const path = queue[i];
      if (includes.has(path)) throw new Error("模型存在重复或循环的 include：" + path);
      includes.add(path);
      sources.add(path);
      for (const { name, attrs } of xmlElements(byPath.get(path)!)) {
        if (name === "include" && attrs.file) queue.push(localResource(path, attrs.file));
        if (name === "compiler") for (const k of ["assetdir", "meshdir", "texturedir", "strippath"]) { if (attrs[k]) compiler[k] = attrs[k]; }
        if (name === "model" && attrs.file) childModels.push(localResource(path, attrs.file));
        if (["mesh", "hfield", "texture", "skin", "flexcomp"].includes(name)) {
          for (const key of ["file", "filename", "fileup", "filedown", "fileleft", "fileright", "filefront", "fileback"]) {
            if (attrs[key]) assets.push({ tag: name, ref: attrs[key], owner: path });
          }
        }
        if (performance.now() - lastYield > 12) { await nextTurn(); lastYield = performance.now(); }
      }
    }
    for (const asset of assets) {
      if (urdf && asset.ref.startsWith("package://")) {
        const path = resolveModelResource(files, asset.owner, asset.ref);
        assetPaths?.add(path);
        continue;
      }
      // Check the original reference before honoring compiler.strippath.
      const dir = (asset.tag === "texture" ? compiler.texturedir : compiler.meshdir) ?? compiler.assetdir;
      if (/^[\\/]/.test(asset.ref) || asset.ref.includes(":") || hasControl(asset.ref)) throw new Error("模型资源必须来自本地包：" + asset.ref);
      const ref = compiler.strippath === "true" ? asset.ref.replaceAll("\\", "/").split("/").at(-1)! : asset.ref;
      const path = localResource(asset.owner, dir ? dir + "/" + ref : ref);
      assetPaths?.add(path);
    }
    for (const child of childModels) {
      if (visited.has(child)) continue;
      visited.add(child);
      await inspect(child);
    }
  }
  visited.add(bundle.entry);
  await inspect(bundle.entry);
  const name = (root.attrs[root.name === "mujoco" ? "model" : "name"]?.trim() || bundle.entry.split("/").at(-1)!.replace(modelExtension, "")).slice(0, 160);
  return { name, sources };
}

export async function inspectModelSources(bundle: ModelBundle, assetPaths?: Set<string>): Promise<Set<string>> {
  validateFiles(bundle.files);
  return (await inspectModel(bundle, assetPaths)).sources;
}

async function digest(data: Uint8Array) {
  const buffer = data.buffer instanceof ArrayBuffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.slice();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function describeModel(bundle: ModelBundle): Promise<ModelRef> {
  validateFiles(bundle.files);
  if (bundle.entry.length > 1024) throw new Error("模型入口名称过长。");
  const { name } = await inspectModel(bundle);
  const manifest = [];
  const files = [...bundle.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const f of files) manifest.push([f.path, await digest(f.data)]);
  return { id: await digest(encode.encode(JSON.stringify([bundle.entry, manifest]))), name, entry: bundle.entry };
}

async function verifyModel(ref: ModelRef, bundle: ModelBundle) {
  const derived = await describeModel(bundle);
  if (ref.id !== derived.id || ref.entry !== derived.entry) throw new Error("模型入口或内容哈希与工程清单不符：" + ref.name);
}

export async function putProjectModels(models: StoredModel[]): Promise<void> {
  for (const { ref, bundle } of models) await verifyModel(ref, bundle);
  await writeModels(models);
}
export async function putModelBundle(ref: ModelRef, bundle: ModelBundle): Promise<void> {
  await putProjectModels([{ ref, bundle }]);
}
export async function getModelBundle(id: string): Promise<ModelBundle> {
  const bundle = await readStoredModel(id);
  await verifyModel({ id, name: id, entry: bundle.entry }, bundle);
  return bundle;
}

function archiveBlob(files: ModelFile[]): Blob {
  const zipped = Object.create(null) as Record<string, Uint8Array>;
  for (const f of files) zipped[f.path] = f.data;
  return new Blob([zipSync(zipped, { level: 0 })], { type: "application/zip" });
}

export function exportModelBundle(bundle: ModelBundle): Blob {
  validateFiles(bundle.files);
  if (!bundle.files.some((f) => f.path === bundle.entry)) throw new Error("模型包缺少指定入口。");
  return archiveBlob(bundle.files);
}

export async function exportProjectArchive(ws: TwinWorkspace): Promise<Blob> {
  const workspace = parseWorkspace(ws), data = encode.encode(JSON.stringify(workspace));
  if (data.length > MAX_PROJECT_JSON_BYTES) throw new Error("工程清单超过 8 MiB。");
  const files: ModelFile[] = [{ path: "workspace.json", data }];
  let total = data.length;
  for (const ref of workspace.catalog?.models ?? []) {
    const bundle = await getModelBundle(ref.id);
    if (bundle.entry !== ref.entry) throw new Error("工程中的模型入口与已保存资源不符：" + ref.name);
    for (const f of bundle.files) {
      total += f.data.length;
      if (total > maxProjectBytes || files.length >= maxFiles * 8) throw new Error("工程包资源超过数量或大小上限。");
      files.push({ path: "models/" + ref.id + "/" + f.path, data: f.data });
    }
  }
  return archiveBlob(files);
}

export async function readProjectArchive(file: File): Promise<{ workspace: TwinWorkspace; models: StoredModel[] }> {
  const files = await unpackZip(file, true);
  const manifest = files.find((f) => f.path === "workspace.json");
  if (!manifest || manifest.data.length > MAX_PROJECT_JSON_BYTES) throw new Error("缺少有效的 workspace.json 工程清单。");
  const workspace = parseWorkspace(JSON.parse(utf8.decode(manifest.data)));
  const refs = workspace.catalog?.models ?? [];
  const groups = new Map(refs.map((ref) => [ref.id, [] as ModelFile[]]));
  for (const f of files) {
    if (f === manifest) continue;
    const match = /^models\/([0-9a-f]{64})\/(.+)$/.exec(f.path);
    const group = match && groups.get(match[1]);
    if (!match || !group) throw new Error("工程包含清单之外的资源：" + f.path);
    group.push({ path: match[2], data: f.data });
  }
  const models: StoredModel[] = [];
  for (const ref of refs) {
    const bundle = { entry: ref.entry, files: groups.get(ref.id)! };
    await verifyModel(ref, bundle);
    models.push({ ref, bundle });
  }
  return { workspace, models };
}
