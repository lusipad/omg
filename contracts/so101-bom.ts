import { z } from "zod";
import { readTwinData } from "./twin-device";

export type So101BomRow = { part: string; quantity: number };

const actuator = "STS3215 Servo 7.4V, 1/345 gear (C001)";
const accessories = ["Motor Control Board", "USB-C Cable 2 pcs", "Power Supply", "Table Clamp 2pcs", "Screwdriver Set"];
const rowsSchema = z.array(z.strictObject({ part: z.string().trim().min(1).max(240), quantity: z.number().int().positive() })).min(1);

function label(text: string): string {
  return text.normalize("NFKC")
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>|\[\^[^\]]+\]|\[\d+\]\(#[^)]*\)/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "")
    .replace(/[‐‑‒–—−]/g, "-").replace(/\s+/g, " ").trim();
}

export function isSo101ServoPart(part: string): boolean {
  return /^(?:feetech )?STS3215 Servo 7\.4\s*V\s*,?\s*1\s*\/\s*345 gear\s*\(\s*C001\s*\)$/i.test(label(part));
}

function accessoryKey(part: string) {
  return label(part).toLowerCase().replace(/(\d)\s+pcs\b/g, "$1pcs");
}

export function validateSo101Bom(raw: unknown): So101BomRow[] {
  const input = readTwinData(rowsSchema, raw, "SO-101 采购清单");
  const seen = new Set<string>();
  const rows = input.map(({ part, quantity }) => {
    const name = isSo101ServoPart(part) ? actuator : accessories.find(item => accessoryKey(item) === accessoryKey(part));
    if (!name) {
      if (/servo|舵机|\b(?:STS|SCS)\d/i.test(part)) throw new Error("此从臂需要 STS3215 舵机，规格为 7.4 V、1/345 减速比、C001 料号。");
      throw new Error(`单台 SO-101 Follower 官方采购表中没有物料“${part}”。`);
    }
    if (seen.has(name)) throw new Error(`采购清单重复列出“${name}”，请核对单台从臂的物料行。`);
    seen.add(name);
    if (name === actuator && quantity !== 6) throw new Error(`单台 Follower 需要 6 个 STS3215 舵机，当前数量为 ${quantity}。`);
    return { part: name, quantity };
  });
  if (!seen.has(actuator)) throw new Error("单台 Follower 采购清单缺少 6 个 STS3215 舵机。");
  return rows;
}

export function so101BomNotes(rows: So101BomRow[]): string[] {
  const counts = new Map(rows.map(({ part, quantity }) => [part, quantity]));
  return accessories.flatMap(part => {
    const count = counts.get(part);
    if (count === 1) return [];
    return [count === undefined ? `清单未列出 ${part}，可按装配需要核对。` : `${part} 采购数量为 ${count}，上游单从臂表列 1。`];
  });
}

function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim());
}

export function parseSo101Bom(text: string): So101BomRow[] {
  if (typeof text !== "string" || !text.trim()) throw new Error("采购表文件为空，请选择 SO-101 Follower 的 Markdown 清单。");
  let lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const mainTitle = label(lines.find(line => /^\s*#\s|<h1\b/i.test(line)) ?? "");
  if (/\bSO-?100\b/i.test(mainTitle) && !/\bSO-?101\b/i.test(mainTitle)) throw new Error("当前文件为 SO-100，请选择 SO-101 Follower 的采购表。");
  if (/\bLeader\b/i.test(mainTitle) && !/\bFollower\b/i.test(mainTitle)) throw new Error("当前文件为 Leader 主臂，请选择单台 Follower 从臂的采购表。");

  const headings = lines.flatMap((line, index) => {
    const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
    return match ? [{ index, level: match[1].length, title: label(match[2]).replace(/[:#\s]+$/, "") }] : [];
  });
  const sections = headings.filter(({ title }) => /^Parts for One Follower Arm$/i.test(title));
  if (sections.length > 1) throw new Error("文件包含多个单从臂小节，请选择一份采购表。");
  if (sections.length) {
    const section = sections[0];
    const end = headings.find(entry => entry.index > section.index && entry.level <= section.level);
    lines = lines.slice(section.index + 1, end?.index);
  } else if (headings.some(({ title }) => /\b(?:Leader|Two Arms)\b/i.test(title))) {
    throw new Error("当前清单为 Leader 主臂或双臂套装，请选择 Parts for One Follower Arm 小节。");
  }

  const headers = lines.flatMap((line, index) => {
    if (!line.includes("|")) return [];
    const names = cells(line).map(cell => label(cell).toLowerCase());
    return names.includes("part") && names.includes("amount") ? [{ index, names }] : [];
  });
  if (headers.length !== 1) throw new Error("请提供一张包含 Part 和 Amount 列的单台 Follower 采购表。");
  const { index, names } = headers[0];
  const divider = cells(lines[index + 1] ?? "");
  if (divider.length !== names.length || !divider.every(cell => /^:?-{3,}:?$/.test(cell))
    || names.filter(name => name === "part").length !== 1 || names.filter(name => name === "amount").length !== 1) {
    throw new Error("采购表的 Part、Amount 列或 Markdown 表头分隔行格式有误。");
  }
  const partColumn = names.indexOf("part"), amountColumn = names.indexOf("amount");
  const rows: So101BomRow[] = [];
  for (const line of lines.slice(index + 2)) {
    if (!line.includes("|")) break;
    const data = cells(line);
    const part = label(data[partColumn] ?? "");
    if (/^total$/i.test(part)) continue;
    const amount = label(data[amountColumn] ?? "");
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < 1) throw new Error(`“${part}”的 Amount 必须是正整数。`);
    rows.push({ part, quantity: Number(amount) });
  }
  return validateSo101Bom(rows);
}
