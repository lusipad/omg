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

function tableRecords(text: string, separator: string, firstLine: number) {
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

export function parseMaterialTable(text: string, defaultSource?: string): MaterialRow[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const leading = normalized.match(/^(?:[ \t]*\n)+/)?.[0] ?? "";
  const body = normalized.slice(leading.length);
  if (!body.trim()) throw new Error("物料表为空，请提供名称和数量。");
  const [header, ...records] = tableRecords(body, tableSeparator(body), 1 + (leading.match(/\n/g)?.length ?? 0));
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
    if (cells.length !== names.length) throw new Error(`第 ${line} 行有 ${cells.length} 列，表头有 ${names.length} 列。含分隔符的字段请用双引号包住。`);
    const fields: Fields = { name: "", quantity: 0 };
    const extra: string[] = [];
    cells.forEach((cell, index) => {
      const value = cell.trim(), key = keys[index];
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
    if (!fields.source && defaultSource?.trim()) fields.source = defaultSource.trim();
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
