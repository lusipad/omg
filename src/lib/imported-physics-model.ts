import type { MainModule, MjModel } from "@mujoco/mujoco";
import type { ModelBundle } from "@contracts/import-catalog";
import { inspectModelSources, resolveModelResource } from "./model-files";

const utf8 = new TextEncoder();
const memoryLimit = 128 * 1024 * 1024;
const xmlEscape = (path: string) => path.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;");
const hasControl = (value: string) => Array.from(value).some((c) => c.charCodeAt(0) < 32);

function attributeValue(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (_, token: string) => {
    if (token.startsWith("#")) return String.fromCodePoint(Number(token[1].toLowerCase() === "x" ? "0x" + token.slice(2) : token.slice(1)));
    return ({ amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" })[token as "amp"];
  });
}

function relativePath(from: string[], target: string) {
  const parts = target.split("/");
  let same = 0;
  while (same < from.length && from[same] === parts[same]) same++;
  return [...from.slice(same).map(() => ".."), ...parts.slice(same)].join("/");
}

function resourcePath(ref: string, path: string, files: ModelBundle["files"], urdf: boolean): string {
  const from = path.split("/").slice(0, -1);
  if (urdf && ref.startsWith("package://")) {
    return relativePath(from, resolveModelResource(files, path, ref));
  }
  if (/^(?:[a-z][\w+.-]*:|[\\/])/i.test(ref) || hasControl(ref)) throw new Error(`模型需要包外资源：${ref}`);
  return ref.replaceAll("\\", "/");
}

function checkGeneratedSizes(xml: string, budget: { elements: number; pixels: number }) {
  const replicas: number[] = [];
  for (const match of xml.matchAll(/<(\/?)(replicate|flexcomp|composite|texture|hfield|size|body|geom|joint|freejoint|site)\b([^>]*)>/gi)) {
    const [, close, tag, attrs] = match;
    if (close) { if (tag === "replicate") replicas.pop(); continue; }
    const numbers = (name: string) => (new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attrs)?.[1] || "").trim().split(/\s+/).map(Number);
    budget.elements += replicas.reduce((a, b) => a * b, 1);
    if (budget.elements > 16_384) throw new Error("模型展开后的部件数量超过本地仿真容量。");
    if (tag === "replicate" || tag === "flexcomp" || tag === "composite") {
      const count = numbers("count").reduce((a, b) => a * b, 1);
      if (count * replicas.reduce((a, b) => a * b, 1) > 2048) throw new Error("模型的展开数量超过本地仿真容量。");
      if (tag === "replicate" && !attrs.endsWith("/")) replicas.push(Math.max(1, count));
    }
    if (tag === "texture" || tag === "hfield") {
      const pixels = tag === "texture" ? numbers("width")[0] * numbers("height")[0] : numbers("nrow")[0] * numbers("ncol")[0];
      budget.pixels += Math.max(0, pixels);
      if (pixels > 8_000_000 || budget.pixels > 16_000_000) throw new Error("模型纹理或高度场超过本地仿真容量。");
    }
    if (tag === "size") {
      const allocation = /\bmemory\s*=\s*["']\s*(\d+)\s*([kmgtp]?)\s*["']/i.exec(attrs);
      if (allocation && Number(allocation[1]) * 1024 ** ("kmgtp".indexOf(allocation[2].toLowerCase()) + (allocation[2] ? 1 : 0)) > memoryLimit) {
        throw new Error("模型请求的工作内存超过 128 MiB。");
      }
      if (["nstack", "njmax", "nconmax"].some((name) => numbers(name)[0] > 2_000_000)) throw new Error("模型请求的工作空间超过本地仿真容量。");
      if (numbers("nkey")[0] > 2048 || numbers("nuserdata")[0] > 1_000_000 ||
        Array.from(attrs.matchAll(/\bnuser_\w+\s*=\s*["'](\d+)["']/g)).some((m) => Number(m[1]) > 1024)) throw new Error("模型状态存储超过本地仿真容量。");
    }
  }
}

function localXml(bytes: Uint8Array, path: string, files: ModelBundle["files"], budget: { elements: number; pixels: number }): Uint8Array {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error(`XML 文件超过 4 MiB：${path}`);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^(<\?xml\b[^?]*?encoding\s*=\s*["'])[^"']+(["'])/i, "$1utf-8$2");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b|<(?:[\w.-]+:)?(?:extension|plugin|script)\b/i.test(xml)) throw new Error("本地仿真不加载 XML 外部实体、脚本或模型插件。");
  checkGeneratedSizes(xml, budget);
  const urdf = /<robot(?:\s|>)/.test(xml);
  const resourceTag = /<(?:mesh|skin|texture|hfield|flexcomp|model|include|compiler)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let prepared = xml.replace(resourceTag, (tag) => tag.replace(/\s+([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g, (raw, key: string, quote: string, encoded: string) => {
    if (!/^(?:file(?:name|up|down|right|left|front|back)?|meshdir|texturedir|assetdir)$/.test(key)) return raw;
    const value = attributeValue(encoded);
    const resolved = resourcePath(value.trim(), path, files, urdf);
    return resolved === value ? raw : ` ${key}=${quote}${xmlEscape(resolved)}${quote}`;
  }));
  // URDF 默认丢弃视觉件、剥离网格目录。显式的作者配置优先，否则保留本地外观及目录结构。
  if (urdf) {
    const compiler = '<compiler discardvisual="false" strippath="false"/>';
    if (!/<mujoco\b/.test(prepared)) prepared = prepared.replace(/<robot\b[^>]*>/, (start) => start + `<mujoco>${compiler}</mujoco>`);
    else prepared = prepared.replace(/<mujoco\s*\/>/, `<mujoco>${compiler}</mujoco>`).replace(/<mujoco\b[^>]*>[\s\S]*?<\/mujoco>/, (block) => {
      if (!/<compiler\b/.test(block)) return block.replace("</mujoco>", compiler + "</mujoco>");
      return block.replace(/<compiler\b[^>]*>/, (tag) => tag.replace("<compiler", "<compiler" +
        (/\bdiscardvisual\s*=/.test(tag) ? "" : ' discardvisual="false"') + (/\bstrippath\s*=/.test(tag) ? "" : ' strippath="false"')));
    });
  }
  return utf8.encode(prepared);
}

export async function compileImportedModel(mj: MainModule, bundle: ModelBundle): Promise<MjModel> {
  if (!Array.isArray(bundle.files) || bundle.files.some((file) => !(file.data instanceof Uint8Array))) throw new Error("模型包需要本地二进制文件。");
  const vfs = new mj.MjVFS();
  try {
    const assets = new Set<string>();
    const sources = await inspectModelSources(bundle, assets);
    const budget = { elements: 0, pixels: 0 };
    for (const { path, data } of bundle.files) {
      if (sources.has(path)) vfs.addBuffer(path, localXml(data, path, bundle.files, budget));
      else if (assets.has(path)) vfs.addBuffer(path, data);
    }
    const model = mj.MjModel.from_xml_path(bundle.entry, vfs);
    if (model.nplugin || model.ngeom > 2048 || model.nbody > 2048 || model.nsite > 4096 || model.nq > 512 || model.nv > 512 || model.nu > 256 ||
      model.nmeshvert > 1_000_000 || model.nmeshface > 2_000_000 || model.narena > memoryLimit) {
      model.delete();
      throw new Error("模型包含插件或超出本地仿真的自由度、几何或内存容量。");
    }
    return model;
  } catch (error) {
    throw new Error(`模型编译失败。 ${error instanceof Error ? error.message : String(error)}`);
  } finally { vfs.delete(); }
}
