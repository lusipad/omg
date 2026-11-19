import { MAX_PROJECT_JSON_BYTES, type MaterialRow } from "./import-catalog";
import { parseFactoryLayout, type FactoryLayout } from "./factory";
import { parseLinearAssembly, type LinearAssembly } from "./linear-assembly";
import { parseMechanicalAssembly, parseMechanicalBundle, type MechanicalAssembly, type MechanicalBundle } from "./mechanical-assembly";
import { hasMaterialTableHeader, parseMarkdownMaterialTable, parseMaterialTable } from "./material-import";
import { parseMiloBom, type MiloBom } from "./milo-bom";
import { MILO_MAX_PROGRAM_CHARS } from "./milo-motion";
import { parseSo101Bom, type So101BomRow } from "./so101-bom";
import { parseDevicePackage, type DevicePackage } from "./twin-device";
import { emptyWorkspace, hasWorkspaceShape, installPackage, maxPackages, parseWorkspace, type TwinWorkspace } from "./twin-simulation";

export type TextImportHint = "auto" | "manual" | "bom" | "gcode" | "json";
export type ParsedTextImport =
  | { kind: "device"; device: DevicePackage }
  | { kind: "devices"; devices: DevicePackage[] }
  | { kind: "assembly"; assembly: LinearAssembly }
  | { kind: "factory"; layout: FactoryLayout }
  | { kind: "mechanism"; assembly: MechanicalAssembly }
  | { kind: "mechanical-bundle"; bundle: MechanicalBundle }
  | { kind: "project"; workspace: TwinWorkspace }
  | { kind: "milo-bom"; bom: MiloBom }
  | { kind: "so101-bom"; bom: So101BomRow[] }
  | { kind: "materials"; rows: MaterialRow[] }
  | { kind: "manual"; text: string }
  | { kind: "gcode"; program: string };

export const IMPORT_TEXT_LIMITS = {
  jsonBytes: MAX_PROJECT_JSON_BYTES, materialBytes: 2 * 1024 * 1024,
  gcodeChars: MILO_MAX_PROGRAM_CHARS, gcodeFileBytes: 4 * MILO_MAX_PROGRAM_CHARS + 3,
} as const;
export const GCODE_FILE_EXTENSIONS = ["gcode", "gco", "nc", "ngc", "cnc", "tap", "g"] as const;
export const IMPORT_TEXT_ACCEPT = ["json", "csv", "tsv", "md", "markdown", "txt", ...GCODE_FILE_EXTENSIONS].map((ext) => "." + ext).join(",");
const ncExtensions = new Set<string>(GCODE_FILE_EXTENSIONS);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), encoder = new TextEncoder();

export function decodeImportUtf8(bytes: ArrayBuffer | Uint8Array): string {
  try { return decoder.decode(bytes); }
  catch { throw new Error("文本文件编码无效，请使用 UTF-8。"); }
}

function byteLimit(text: string, json: boolean) {
  const limit = json ? IMPORT_TEXT_LIMITS.jsonBytes : IMPORT_TEXT_LIMITS.materialBytes;
  if (text.length > limit || encoder.encode(text).length > limit) {
    throw new Error(json ? "JSON 超过 8 MiB，请缩小导入文件。" : "资料超过 2 MiB，请选择相关章节或物料表。");
  }
}

// 只揭开包裹整个输入的代码块，保留带示例的手册正文。
export function outerFence(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") && !trimmed.startsWith("~~~")) return;
  const open = /^(`{3,}|~{3,})[ \t]*([\w+-]*)[ \t]*(?:\r\n|[\r\n])/.exec(trimmed);
  if (!open) {
    const inline = /^(`{3,}|~{3,})(json\b)?[ \t]*/i.exec(trimmed)!;
    const rest = trimmed.slice(inline[0].length);
    if ((rest.startsWith("{") || rest.startsWith("[")) && rest.endsWith(inline[1])) {
      return { language: "json", body: rest.slice(0, -inline[1].length) };
    }
    return inline[2] && !rest.includes(inline[1]) ? { language: "json", body: undefined } : undefined;
  }
  const content = trimmed.slice(open[0].length);
  const close = new RegExp(`^[ \\t]*${open[1][0]}{${open[1].length},}[ \\t]*$`, "m").exec(content);
  if (close && content.slice(close.index + close[0].length).trim()) return;
  return { language: open[2].toLowerCase(), body: close ? content.slice(0, close.index) : undefined };
}

function jsonImport(raw: unknown, name: string): ParsedTextImport {
  if (raw && typeof raw === "object") {
    if ("missing" in raw && Array.isArray(raw.missing)) {
      const missing = raw.missing.filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 12);
      if (missing.length) throw new Error(`请补充资料中的${missing.map((s) => s.trim()).join("、")}。`);
    }
    const projectFile = /(?:^|[\\/])workspace\.json$|\.twin\.json$/i.test(name) &&
      !["manufacturer", "model", "ports", "rules", "servo", "source"].some((key) => Object.hasOwn(raw, key));
    if (projectFile || hasWorkspaceShape(raw)) {
      return { kind: "project", workspace: parseWorkspace(raw) };
    }
  }
  return { kind: "device", device: parseDevicePackage(raw) };
}

// 识别专用清单时只看正文，技术手册常把采购表的写法放在示例代码块里。
function outsideExamples(text: string) {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const parts: string[] = [];
  let open = "", start = 0;
  for (const fence of text.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/gm)) {
    if (!open) { parts.push(text.slice(start, fence.index)); open = fence[1]; }
    else if (!fence[2].trim() && fence[1][0] === open[0] && fence[1].length >= open.length) {
      open = ""; start = fence.index + fence[0].length;
    }
  }
  if (!open) parts.push(text.slice(start));
  return parts.join("\n");
}

// 通用部件类别和 Component/QTY 表头本身不标识机型。检查成套分轴丝杠或多个专属部件族。
function hasMiloPartCombination(text: string): boolean {
  const screws = new Set(Array.from(text.matchAll(/\bTR8[x×]8\s+4[- ]Start\s+Lead[- ]screw\s+(?:550|535|300)\s*mm[^|\r\n]*?\b([XYZ])[- ]Axis\b/gi), (m) => m[1].toUpperCase()));
  const frame = /\bOpenbuilds\s+4080[x×]470\s*mm\s+C[- ]Beam\b/i.test(text);
  const motor = /\b23HP22-2804S\s*\/\s*2303HS200AW\s*\/\s*LDO-57STH56-2804AC\b/i.test(text);
  const plates = /\bXY gantry plate\b/i.test(text) && /\bZ gantry plate\b/i.test(text);
  return screws.size >= 2 || ((frame || screws.size > 0) && [frame, screws.size > 0, motor, plates].filter(Boolean).length >= 2);
}

function specialBill(text: string, origin: string, requested: boolean): "milo-bom" | "so101-bom" | undefined {
  text = outsideExamples(text);
  const headings = (text.match(/^[ \t]*(?:#{1,6}[ \t]+|<h[1-6]\b[^>\r\n]*>)[^\r\n]+/gim) ?? []).map((h) => h.replace(/[*`]/g, "").replaceAll("_", " "));
  const originLabel = origin.replaceAll("_", " ");
  if (!requested && headings.some((h) => /^[ \t]*#\s+.*(?:手册|教程|说明书|\bmanual\b)/i.test(h))) return;
  const miloModel = /\bmilo\b/i, soModel = /\bSO[ _-]?(?:ARM[ _-]?)?10[01]\b/i;
  const bill = /\bbom\b|bill[ _-]+of[ _-]+materials|sourcing[ _-]+guide|采购(?:表|清单|指南)|物料清单/i;
  const title = headings.find((h) => /^\s*(?:#\s+|<h1\b)/i.test(h)) ?? "";
  const exampleProse = /^(?![ \t]*[#|])[^|\r\n]*(?:示例|例子|例如|范例|\bexample\b)[^|\r\n]*$/im;
  if (!requested && !miloModel.test(title) && !soModel.test(title) && !bill.test(title) && !bill.test(originLabel) && exampleProse.test(text)) return;
  const individual = headings.some((h) => /^\s*#{1,6}\s+Individual Parts\s*:?[\s#]*$/i.test(h));
  const miloTable = /^(?=[^\r\n]*\|)(?=[^\r\n]*\bcomponent\b)[^\r\n]*\bqty\b/im.test(text);
  const milo = headings.some((h) => miloModel.test(h) && (bill.test(h) || individual || miloTable)) ||
    ((individual || miloTable) && hasMiloPartCombination(text));
  const soTable = /^(?=[^\r\n]*\|)(?=[^\r\n]*\bpart\b)[^\r\n]*\bamount\b/im.test(text);
  const follower = headings.some((h) => /\bparts for (?:one (?:follower|leader) arm|two arms)\b/i.test(h) || (soModel.test(h) && bill.test(h))) ||
    (soTable && (headings.some((h) => soModel.test(h)) || /\bSTS3215\b[^\r\n|]*\bC001\b/i.test(text)));
  if (milo && follower) throw new Error("资料中有两种专用采购表，请分别选择 Milo 或 SO-101 清单。");
  if (milo) return "milo-bom";
  if (follower) return "so101-bom";
  const billLabel = bill.test(originLabel) || headings.some((h) => bill.test(h));
  if ((individual && miloModel.test(originLabel)) || (/milo[\s_.-]*v?1[._]5/i.test(origin) && billLabel)) return "milo-bom";
  if (/(?:^|[\s_/#.-])follower[ _-]bom(?:[\s./#_-]|$)|#parts-for-one-follower-arm\b/i.test(origin) ||
    (soModel.test(originLabel) && billLabel)) return "so101-bom";
}

// 自动识别只判断文本是否由程序块组成；语法诊断由 Milo 编辑器在运行时给出。
function looksLikeProgram(text: string): boolean {
  if (!/^[\s]*(?:[;(NnGgMmTtFfXYZxyz%])/.test(text)) return false;
  let seenG = false;
  for (const line of text.split(/\r\n?|\n/)) {
    let code = "", depth = 0;
    for (const ch of line) {
      if (!depth && ch === ";") break;
      if (ch === "(") depth++;
      else if (depth && ch === ")") depth--;
      else if (!depth) code += ch;
    }
    code = code.trim();
    if (!code || code === "%") continue;
    if (!/^(?:[a-z][ \t]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)[ \t]*)+$/i.test(code)) return false;
    if (/G[ \t]*[+-]?\d/i.test(code)) seenG = true;
  }
  return seenG;
}

export function parseImportText(text: string, name: string, options: { hint?: TextImportHint; source?: string } = {}): ParsedTextImport {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1].toLowerCase() ?? "";
  const format = ext === "json" ? "json" : ext === "csv" || ext === "tsv" ? "table" : ncExtensions.has(ext) ? "gcode" : options.hint ?? "auto";
  if (text.length > IMPORT_TEXT_LIMITS.jsonBytes) {
    if (format === "gcode") throw new Error(`G 代码超过 ${MILO_MAX_PROGRAM_CHARS} 个字符。`);
    byteLimit(text, format === "json" || (format === "auto" && /^\s*(?:\{|\[|(?:`{3,}|~{3,})\s*(?:json\b|\{|\[))/i.test(text)));
  }
  if (!text.trim()) throw new Error("导入文本为空。");
  if (text.includes("\0")) throw new Error("文本含有 NUL 字节，请选择 UTF-8 文本文件。");
  const plain = text.replace(/^\uFEFF/, "");
  const fence = outerFence(plain), body = fence?.body ?? plain;
  const inferredJson = /^\s*(?:\{\s*(?:["}]|$)|\[\s*(?:\{|\]))/.test(body) || fence?.language === "json";
  const asJson = format === "json" || (format === "auto" && inferredJson);
  const mechanicalMarker = !asJson && (/^\s*\{/.test(body) || fence?.language === "json") &&
    /"kind"\s*:\s*"(?:device-library|factory-layout|linear-axis-assembly|mechanical-assembly|mechanical-package)"|"mechanics"\s*:/.test(body);
  if (asJson || mechanicalMarker) {
    byteLimit(text, true);
    if (fence && fence.body === undefined) throw new Error("JSON 代码围栏未闭合。");
    let raw: unknown;
    try { raw = JSON.parse(body.trim()); } catch { throw new Error("JSON 格式有误，请检查括号、引号和内容完整性。"); }
    if (raw && typeof raw === "object") {
      if ("kind" in raw) {
        if (raw.kind === "device-library") {
          if (!("schemaVersion" in raw) || raw.schemaVersion !== 1 || !("packages" in raw) || !Array.isArray(raw.packages) || !raw.packages.length) {
            throw new Error("设备库须声明 schemaVersion 1 并包含设备包列表。");
          }
          if (raw.packages.length > maxPackages) throw new Error(`一份设备库最多包含 ${maxPackages} 个设备修订。`);
          return { kind: "devices", devices: raw.packages.reduce<TwinWorkspace>(installPackage, emptyWorkspace()).packages };
        }
        if (raw.kind === "factory-layout") return { kind: "factory", layout: parseFactoryLayout(raw) };
        if (raw.kind === "linear-axis-assembly") return { kind: "assembly", assembly: parseLinearAssembly(raw) };
        if (raw.kind === "mechanical-assembly") return { kind: "mechanism", assembly: parseMechanicalAssembly(raw) };
        if (raw.kind === "mechanical-package") return { kind: "mechanical-bundle", bundle: parseMechanicalBundle(raw) };
      }
      if (Object.hasOwn(raw, "mechanics")) return { kind: "device", device: parseDevicePackage(raw) };
    }
    if (asJson) return jsonImport(raw, name);
  }
  if (format === "manual") { byteLimit(text, false); return { kind: "manual", text: plain }; }
  const draft = (): ParsedTextImport => {
    if (body.length > MILO_MAX_PROGRAM_CHARS) throw new Error(`G 代码超过 ${MILO_MAX_PROGRAM_CHARS} 个字符。`);
    if (!body.trim()) throw new Error("G 代码程序为空。");
    return { kind: "gcode", program: body };
  };
  if (format === "gcode") return draft();
  byteLimit(text, false);
  if (format === "table" || fence?.language === "csv" || fence?.language === "tsv" || hasMaterialTableHeader(body)) {
    return { kind: "materials", rows: parseMaterialTable(body, options.source) };
  }
  const type = specialBill(body, name + " " + (options.source ?? ""), format === "bom");
  if (type === "milo-bom") return { kind: type, bom: parseMiloBom(body) };
  if (type === "so101-bom") return { kind: type, bom: parseSo101Bom(body) };
  const markdownRows = parseMarkdownMaterialTable(body, options.source, format === "bom");
  if (markdownRows) return { kind: "materials", rows: markdownRows };
  if (format === "bom") return { kind: "materials", rows: parseMaterialTable(body, options.source) };
  if (ncExtensions.has(fence?.language ?? "") || looksLikeProgram(body)) return draft();
  return { kind: "manual", text: plain };
}
