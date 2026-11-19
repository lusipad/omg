import type { MaterialRow } from "./import-catalog";
import { packageKey } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

type Fields = Omit<MaterialRow, "id" | "binding">;
const aliases = {
  name: ["名称", "物料", "物料名称", "零件名称", "零件", "部件名称", "部件", "设备名称", "品名", "name", "part", "partname", "item", "itemname", "component", "componentname"],
  quantity: ["数量", "用量", "采购数量", "需求数量", "quantity", "qty", "amount"],
  unit: ["单位", "计量单位", "unit", "uom"],
  manufacturer: ["制造商", "厂商", "厂家", "生产商", "制造厂家", "manufacturer", "maker", "mfr"],
  model: ["型号", "设备型号", "规格型号", "订货号", "料号", "模型资产id", "model", "modelnumber", "sku", "partnumber", "physicsmodelid"],
  source: ["来源", "资料来源", "来源定位", "来源链接", "资料链接", "官方资料", "source", "sourceurl", "sourcelink", "url"],
  notes: ["备注", "说明", "描述", "notes", "note", "description"],
} satisfies Record<keyof Fields, string[]>;
const normalizeHeader = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]/g, "");
const headerKeys = new Map(Object.entries(aliases).flatMap(([key, labels]) => labels.map(word => [word, key as keyof Fields] as const)));
const limits = { name: 300, unit: 80, manufacturer: 240, model: 240, source: 2048, notes: 80_000 };

function signature(fields: Fields): string {
  return JSON.stringify([fields.name, fields.quantity, fields.unit, fields.manufacturer, fields.model, fields.source, fields.notes]);
}

function identify(fields: Fields, kind: "doc" | "bom"): MaterialRow {
  for (const [key, max] of Object.entries(limits)) {
    const field = key as keyof typeof limits;
    if ((fields[field]?.length ?? 0) > max) throw new Error(`${aliases[field][0]}超过 ${max} 个字符。`);
  }
  // RFC 9923 FNV-1a/128. Hash the canonical UTF-8 fields for synchronous, repeatable browser imports.
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const octet of new TextEncoder().encode(signature(fields))) {
    hash = BigInt.asUintN(128, (hash ^ BigInt(octet)) * 0x0000000001000000000000000000013bn);
  }
  return { id: `${kind}-${hash.toString(16).padStart(32, "0")}`, ...fields };
}

export function createDocumentMaterial(name: string, text: string, source?: string): MaterialRow {
  if (!name.trim()) throw new Error("请输入资料名称或选择带文件名的手册。");
  if (!text.trim()) throw new Error("设备资料正文为空。");
  return identify({ name: name.trim(), quantity: 1, unit: "份", notes: text, ...(source?.trim() ? { source: source.trim() } : {}) }, "doc");
}

function tableSeparator(text: string): string {
  let quoted = false, commas = false, tabs = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") commas = true;
    else if (!quoted && char === "\t") tabs = true;
    else if (!quoted && char === "\n") break;
  }
  if (commas && tabs) throw new Error("物料表表头同时使用逗号和制表符，请选择一种分隔符。");
  if (!commas && !tabs) throw new Error("物料表需要名称和数量两列，请使用 CSV 或 TSV。");
  return tabs ? "\t" : ",";
}

function tableRecords(text: string, separator: string, firstLine: number, headerOnly = false) {
  const records: { line: number; cells: string[] }[] = [];
  let line = firstLine, start = line, cells: string[] = [], field = "", quoted = false, closed = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === undefined) throw new Error(`第 ${start} 行的引号没有闭合。`);
      if (char !== '"') { field += char; if (char === "\n") line++; }
      else if (text[index + 1] === '"') { field += '"'; index++; }
      else { quoted = false; closed = true; }
    } else if (char === separator) {
      cells.push(field);
      field = ""; closed = false;
    } else if (char === undefined || char === "\n") {
      if (cells.length || field.trim() || closed) records.push({ line: start, cells: [...cells, field] });
      if (headerOnly && records.length) return records;
      if (records.length > 2001) throw new Error("一次最多导入 2000 个物料行。");
      cells = []; field = ""; closed = false; start = ++line;
    } else if (char === '"') {
      if (closed || field.trim()) throw new Error(`第 ${line} 行字段中的双引号需要成对转义。`);
      field = ""; quoted = true;
    } else if (closed) {
      if (!/^[ \t]$/.test(char)) throw new Error(`第 ${line} 行的结束引号后出现多余字符。`);
    } else {
      field += char;
    }
  }
  return records;
}

function tableInput(text: string) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const leading = normalized.match(/^(?:[ \t]*\n)+/)?.[0] ?? "";
  return { body: normalized.slice(leading.length), firstLine: 1 + (leading.match(/\n/g)?.length ?? 0) };
}

/** 只读表头，数量、引号等行级诊断交给完整的物料解析器。 */
export function hasMaterialTableHeader(text: string): boolean {
  const { body, firstLine } = tableInput(text);
  try {
    const header = tableRecords(body, tableSeparator(body), firstLine, true)[0];
    const keys = header?.cells.map((value) => headerKeys.get(normalizeHeader(value))) ?? [];
    return keys.includes("name") && keys.includes("quantity");
  } catch { return false; }
}

export function parseMaterialTable(text: string, defaultSource?: string): MaterialRow[] {
  const { body, firstLine } = tableInput(text);
  if (!body.trim()) throw new Error("物料表为空，请提供名称和数量。");
  const [header, ...records] = tableRecords(body, tableSeparator(body), firstLine);
  return materialRows(header, records, defaultSource, false);
}

type TableRecord = { line: number; cells: string[] };
const mdDivider = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
function markdownCells(text: string): string[] {
  const line = text.trim(), cells: string[] = [];
  let field = "", lastPipe = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && (line[i + 1] === "|" || line[i + 1] === "\\")) field += line[++i];
    else if (ch === "|") { cells.push(field.trim()); field = ""; lastPipe = i; }
    else field += ch;
  }
  if (lastPipe < 0) return [];
  cells.push(field.trim());
  if (line.startsWith("|")) cells.shift();
  if (lastPipe === line.length - 1) cells.pop();
  return cells;
}

function markdownLabel(cell: string) {
  const wrapped = /^(\*\*|__|`)(.+)\1$/.exec(cell);
  return wrapped ? wrapped[2].trim() : cell;
}

/** 单表或标题加单表。正文、示例代码块及无表格的 Markdown 交回手册入口。 */
export function parseMarkdownMaterialTable(text: string, defaultSource?: string, expectTable = false): MaterialRow[] | undefined {
  if (!text.includes("|")) return;
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const blocks: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^#{1,6}\s+/.test(line)) {
      if (!expectTable && /^#{1,6}\s+.*(?:手册|教程|说明书|\bmanual\b)/i.test(line)) return;
      continue;
    }
    if (!line.includes("|") || /^(?:`{3,}|~{3,})/.test(line)) return;
    const last = blocks.at(-1);
    if (last?.end === i - 1) last.end = i;
    else blocks.push({ start: i, end: i });
  }
  if (!blocks.length) return;
  const materialLike = blocks.some(({ start }) => {
    const keys = markdownCells(lines[start]).map((s) => headerKeys.get(normalizeHeader(markdownLabel(s))));
    return keys.includes("name") && keys.includes("quantity");
  });
  if (!materialLike && !expectTable) return;
  if (blocks.length > 1) throw new Error("检测到多个 Markdown 表块，请分别导入每张物料表。");
  const { start, end } = blocks[0];
  const header = { line: start + 1, cells: markdownCells(lines[start]).map(markdownLabel) };
  const divider = markdownCells(lines[start + 1] ?? "");
  if (divider.length !== header.cells.length || !mdDivider(divider)) throw new Error(`第 ${start + 2} 行的 Markdown 表头分隔行格式有误。`);
  if (end - start - 1 > 2000) throw new Error("一次最多导入 2000 个物料行。");
  const records: TableRecord[] = [];
  for (let i = start + 2; i <= end; i++) {
    const cells = markdownCells(lines[i]).map(markdownLabel);
    if (mdDivider(cells)) throw new Error("检测到多张 Markdown 物料表，请分别导入。");
    records.push({ line: i + 1, cells });
  }
  return materialRows(header, records, defaultSource, true);
}

function materialRows(header: TableRecord, records: TableRecord[], defaultSource: string | undefined, markdown: boolean): MaterialRow[] {
  const names = header.cells.map(value => value.trim());
  const keys = names.map(name => headerKeys.get(normalizeHeader(name)));
  if (!keys.includes("name") || !keys.includes("quantity")) throw new Error(`第 ${header.line} 行表头必须包含名称和数量列。`);
  const seen = new Set<string>();
  names.forEach((name, index) => {
    const key = keys[index], field = key ?? normalizeHeader(name);
    if (!field) throw new Error(`第 ${header.line} 行包含空列名。`);
    if (seen.has(field)) throw new Error(`第 ${header.line} 行表头的${key ? aliases[key][0] : name}列重复，无法确定取值。`);
    seen.add(field);
  });
  if (!records.length) throw new Error("物料表只有表头，请添加至少一行物料。");
  const occurrences = new Map<string, number>();
  return records.map(({ line, cells }) => {
    if (cells.length !== names.length) throw new Error(`第 ${line} 行有 ${cells.length} 列，表头有 ${names.length} 列。${markdown ? "格内的竖线请写作 \\|。" : "含分隔符的字段请用双引号包住。"}`);
    const fields: Fields = { name: "", quantity: 0 };
    const extra: string[] = [];
    let nameLink: string | undefined;
    cells.forEach((cell, index) => {
      const key = keys[index];
      let value = cell.trim();
      if (markdown && (key === "source" || key === "name")) {
        const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i.exec(value);
        if (link && key === "source") value = link[2];
        else if (link) { value = link[1]; nameLink = link[2]; }
      }
      if (key === "name") fields.name = value;
      else if (key === "quantity") {
        const quantity = Number(value);
        if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`第 ${line} 行数量必须是正有限数，计量单位请填写在单位列。`);
        }
        fields.quantity = quantity;
      } else if (value && key) fields[key] = key === "notes" ? cell : value;
      else if (value) extra.push(`${names[index]}：${cell}`);
    });
    if (!fields.name) throw new Error(`第 ${line} 行缺少物料名称。`);
    if (!fields.source && (nameLink || defaultSource?.trim())) fields.source = nameLink || defaultSource?.trim();
    if (extra.length) fields.notes = [fields.notes, ...extra].filter(Boolean).join("\n");
    let row: MaterialRow;
    try { row = identify(fields, "bom"); } catch (cause) { throw new Error(`第 ${line} 行${(cause as Error).message}`); }
    const occurrence = (occurrences.get(row.id) ?? 0) + 1;
    occurrences.set(row.id, occurrence);
    if (occurrence > 1) row.id += `-${occurrence}`;
    return row;
  });
}

export function matchMaterials(rows: MaterialRow[], workspace: TwinWorkspace): MaterialRow[] {
  const saved = new Map((workspace.catalog?.materials ?? []).map(row => [row.id, row]));
  const models = new Set((workspace.catalog?.models ?? []).map(model => model.id));
  const devices = new Set(workspace.packages.map(packageKey));
  return rows.map(row => {
    const { binding, ...fields } = row;
    const old = saved.get(row.id);
    if (old && signature(old) !== signature(row)) throw new Error(`物料“${row.name}”与已有记录标识相同、内容不同，请核对来源。`);
    const chosen = binding ?? old?.binding;
    if (chosen) return (chosen.kind === "physics" ? models : devices).has(chosen.key) ? { ...fields, binding: chosen } : fields;
    if (!row.model) return fields;
    const candidates = workspace.packages.filter(pkg => pkg.model === row.model && (!row.manufacturer || pkg.manufacturer === row.manufacturer));
    const physics = /^[0-9a-f]{64}$/.test(row.model) && models.has(row.model);
    if (physics && !candidates.length) return { ...fields, binding: { kind: "physics", key: row.model } };
    if (!physics && candidates.length === 1) return { ...fields, binding: { kind: "device", key: packageKey(candidates[0]) } };
    return fields;
  });
}
