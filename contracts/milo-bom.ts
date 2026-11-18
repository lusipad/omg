import { z } from "zod";
import { readTwinData } from "./twin-device";

export const miloAxisIds = ["X", "Y", "Z"] as const;
export const miloAxisSchema = z.enum(miloAxisIds);
export type MiloAxisId = z.infer<typeof miloAxisSchema>;
const categories = ["Printed Parts", "Fasteners", "Frame", "Electronics", "Motion", "Cabling", "Misc"] as const;
type Category = typeof categories[number];

interface AxisPart {
  category: Category;
  name: string;
  label: string;
  // Counts for X, Y, Z, respectively. The XY gantry plate is the same physical part for both axes.
  counts: readonly [number, number, number];
  shared?: boolean;
}

const axisParts: AxisPart[] = [
  { category: "Electronics", name: "NEMA 23 motor 23HP22-2804S / 2303HS200AW / LDO-57STH56-2804AC", label: "NEMA 23 步进电机", counts: [1, 1, 1] },
  { category: "Electronics", name: "Motor Drivers", label: "步进驱动器", counts: [1, 1, 1] },
  { category: "Electronics", name: "Omron SS-5GL micro switch", label: "归零微动开关", counts: [1, 1, 1] },
  { category: "Motion", name: "TR8x8 4-Start Lead-screw 550mm (min - X-Axis)", label: "X 轴 TR8×8 丝杠（最短 550 mm）", counts: [1, 0, 0] },
  { category: "Motion", name: "TR8x8 4-Start Lead-screw 535mm (Y-Axis)", label: "Y 轴 TR8×8 丝杠（535 mm）", counts: [0, 1, 0] },
  { category: "Motion", name: "TR8x8 4-Start Lead-screw 300mm (min - Z-Axis)", label: "Z 轴 TR8×8 丝杠（最短 300 mm）", counts: [0, 0, 1] },
  { category: "Motion", name: "MGN15 Rail 500mm", label: "500 mm 直线导轨", counts: [2, 0, 0] },
  { category: "Motion", name: "MGN15 Rail 350mm", label: "350 mm 直线导轨", counts: [0, 2, 0] },
  { category: "Motion", name: "MGN15 Rail 250mm", label: "250 mm 直线导轨", counts: [0, 0, 2] },
  { category: "Motion", name: "MGN15C Rail Carriage", label: "MGN15C 滑块", counts: [4, 4, 4] },
  { category: "Motion", name: "TR8x8 4-Start Brass Lead-screw Nut", label: "TR8×8 黄铜丝杠螺母", counts: [2, 2, 2] },
  { category: "Motion", name: "Spider or Rigid coupler 8mm to 6.35mm (1/4 inch)", label: "8 mm 至 6.35 mm 联轴器", counts: [1, 1, 0] },
  { category: "Motion", name: "GT2 20T (6mm wide) Pulley (6.35mm (1/4 inch) bore)", label: "GT2 主动轮（20 齿）", counts: [0, 0, 1] },
  { category: "Motion", name: "GT2 40T (6mm wide) Pulley (8mm bore)", label: "GT2 从动轮（40 齿）", counts: [0, 0, 1] },
  { category: "Motion", name: "200mm GT2 Closed-loop belt", label: "200 mm GT2 闭环带", counts: [0, 0, 1] },
  { category: "Motion", name: "608 2Z Shielded deep groove ball bearing", label: "608 ZZ 轴承", counts: [1, 4, 3] },
  { category: "Motion", name: "F608 2Z Shielded deep groove ball bearing", label: "F608 ZZ 法兰轴承", counts: [2, 2, 0] },
  { category: "Motion", name: "8mm Bore locking-collar", label: "8 mm 锁紧环", counts: [2, 2, 2] },
  { category: "Motion", name: "XY gantry plate", label: "X/Y 共享滑台板", counts: [1, 1, 0], shared: true },
  { category: "Motion", name: "Z gantry plate", label: "Z 轴安装板", counts: [0, 0, 1] },
];

function display(value: string) {
  return value.trim().replace(/\(\s*\[see note\]\[[^\]]+\]\s*\)/gi, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "").replace(/\\([*_|])/g, "$1").trim();
}

function partKey(category: string, name: string) {
  return category + "/" + name.normalize("NFKC").toLowerCase().replace(/[‐‑‒–—]/g, "-").replaceAll("×", "x")
    .replace(/\s+/g, " ").replace(/(\d)\s+mm\b/g, "$1mm").replace(/\s*\/\s*/g, "/").trim();
}

const axisKeys = new Set(axisParts.map(part => partKey(part.category, part.name)));
const quantityFormat = /^(?:N\/A|\d+(?:\.\d+)?\s*(?:m|mm|cm|l|ml|kg|g|pcs?)?|\d+\s*\/\s*\d+\s*\(FMJ\))$/i;
const pieceCount = /^(\d+(?:\.0+)?)(?:\s*pcs?)?$/i;
const alternative = /^(\d+)\s*\/\s*\d+\s*\(FMJ\)$/i;
const bomRow = z.strictObject({
  category: z.enum(categories), name: z.string().trim().min(1).max(300),
  quantity: z.string().trim().min(1).max(70), standard: z.string().trim().min(1).max(240).optional(),
});
export type MiloBomRow = z.infer<typeof bomRow>;

export const miloBomSchema = z.array(bomRow).min(1).max(800).superRefine((rows, ctx) => {
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    const key = partKey(row.category, row.name);
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: [index, "name"], message: `同一类别重复列出“${row.name}”，请核对库存。` });
    keys.add(key);
    const numbers = row.quantity.match(/\d+(?:\.\d+)?/g) ?? [];
    if (!quantityFormat.test(row.quantity) || numbers.some(n => Number(n) > Number.MAX_SAFE_INTEGER)
      || (axisKeys.has(key) && !pieceCount.test(row.quantity) && !alternative.test(row.quantity) && !/^N\/A$/i.test(row.quantity))) {
      ctx.addIssue({ code: "custom", path: [index, "quantity"], message: `“${row.name}”的采购数量无效。运动件须按非负整数计件，未知数量可填 N/A。` });
    }
  });
  const has = (category: Category, name: string) => keys.has(partKey(category, name));
  const frame = has("Frame", "Openbuilds 4080x470mm C-Beam extrusion");
  const screw = axisParts.some(part => part.name.includes("Lead-screw ") && part.name.includes("Axis)") && has(part.category, part.name));
  const motor = has("Electronics", "NEMA 23 motor 23HP22-2804S / 2303HS200AW / LDO-57STH56-2804AC");
  const plates = has("Motion", "XY gantry plate") && has("Motion", "Z gantry plate");
  const rails = has("Motion", "MGN15C Rail Carriage") && has("Motion", "MGN15 Rail 350mm") && has("Motion", "MGN15 Rail 500mm");
  if ((!frame && !screw) || [frame, screw, motor, plates, rails].filter(Boolean).length < 3) {
    ctx.addIssue({ code: "custom", message: "未识别 Milo v1.5 的 C-Beam、分轴 TR8×8 丝杠与导向/驱动组合，请使用官方 Individual Parts 分项采购表。" });
  }
});
export type MiloBom = z.infer<typeof miloBomSchema>;

function cells(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => display(cell));
}

export function parseMiloBom(text: string): MiloBom {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const heading = (line: string) => line.trim().match(/^(#{1,6})\s+(.+?)\s*#*$/);
  const sections = lines.flatMap((line, index) => {
    const h = heading(line);
    return h && /^Individual Parts:?$/i.test(display(h[2])) ? [{ index, level: h[1].length }] : [];
  });
  if (sections.length !== 1) throw new Error("请选择一份含有 Individual Parts 小节的 Milo v1.5 采购表。");
  const section = sections[0], rows: MiloBomRow[] = [];
  const title = lines.slice(0, section.index).find(line => /^\s*#\s+/.test(line)) ?? "";
  const version = title.match(/\bMilo[\s_-]*v?\s*(\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
  if (version && version !== "1.5") throw new Error(`此采购表标注为 Milo v${version}，工作台需要 Milo v1.5。`);
  let category: Category | undefined;
  for (let i = section.index + 1; i < lines.length; i++) {
    const h = heading(lines[i]);
    if (h) {
      if (h[1].length <= section.level) break;
      category = categories.find(c => c.toLowerCase() === display(h[2]).toLowerCase());
      continue;
    }
    if (!category || !lines[i].includes("|")) continue;
    const header = cells(lines[i]).map(cell => cell.toLowerCase());
    const name = header.indexOf("component"), qty = header.indexOf("qty"), std = header.indexOf("standard");
    if (name < 0 && qty < 0) continue;
    const divider = cells(lines[i + 1] ?? "");
    if (name < 0 || qty < 0 || header.lastIndexOf("component") !== name || header.lastIndexOf("qty") !== qty
      || header.lastIndexOf("standard") !== std || divider.length !== header.length || !divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
      throw new Error(`第 ${i + 1} 行的 ${category} 表需要明确的 Component、QTY 列及 Markdown 分隔行。`);
    }
    i++;
    while (i + 1 < lines.length && lines[i + 1].includes("|") && !heading(lines[i + 1])) {
      const data = cells(lines[++i]);
      if (!data[name] || !data[qty]) throw new Error(`第 ${i + 1} 行的 ${category} 物料缺少名称或数量。`);
      rows.push({ category, name: data[name], quantity: data[qty], ...(std >= 0 && data[std] ? { standard: data[std] } : {}) });
    }
  }
  return readTwinData(miloBomSchema, rows, "Milo 采购表");
}

export interface MiloAxisRequirement {
  category: Category;
  name: string;
  label: string;
  stock: number;
  reserved: number;
  available: number;
  required: number;
  shortfall: number;
  shared: boolean;
}

export function getMiloAxisRequirements(bom: MiloBom, axis: MiloAxisId, assembled: readonly MiloAxisId[] = []): MiloAxisRequirement[] {
  const index = miloAxisIds.indexOf(axis);
  if (index < 0 || assembled.some(id => !miloAxisIds.includes(id))) throw new Error("请选择 X、Y 或 Z 轴。");
  if (new Set(assembled).size !== assembled.length) throw new Error("已装轴重复，请核对装配记录。");
  const others = assembled.filter(id => id !== axis);
  const inventory = new Map(bom.map(row => [partKey(row.category, row.name), row.quantity]));
  return axisParts.filter(part => part.counts[index] > 0).map(part => {
    const original = inventory.get(partKey(part.category, part.name)) ?? "";
    const stock = Number((original.match(pieceCount) ?? original.match(alternative))?.[1] ?? 0);
    const shares = others.map(id => part.counts[miloAxisIds.indexOf(id)]);
    const reserved = part.shared ? Math.max(0, ...shares) : shares.reduce((sum, count) => sum + count, 0);
    const required = part.shared && reserved > 0 ? 0 : part.counts[index];
    return { category: part.category, name: part.name, label: part.label, stock, reserved, required, shared: !!part.shared,
      available: Math.max(0, stock - reserved), shortfall: Math.max(0, reserved + required - stock) };
  });
}

export function validateMiloAssembly(bom: MiloBom, assembled: readonly MiloAxisId[]): MiloAxisId[] {
  const checked: MiloAxisId[] = [];
  for (const axis of assembled) {
    if (checked.includes(axis)) throw new Error(`${axis} 轴重复装配。`);
    const missing = getMiloAxisRequirements(bom, axis, checked).filter(row => row.shortfall > 0);
    if (missing.length) throw new Error(`${axis} 轴缺料，${missing.map(part => `${part.label}还差 ${part.shortfall} 件`).join("、")}。`);
    checked.push(axis);
  }
  return checked;
}

export function assembleMiloAxis(bom: MiloBom, assembled: readonly MiloAxisId[], axis: MiloAxisId): MiloAxisId[] {
  return validateMiloAssembly(bom, assembled.includes(axis) ? assembled : [...assembled, axis]);
}
