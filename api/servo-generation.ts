import { TRPCError } from "@trpc/server";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseDevicePackage } from "@contracts/twin-device";
import { readOfficialDocument, type OfficialDocument } from "./twin-source";

const officialLink = z.string().trim().max(2048).pipe(z.url({ protocol: /^https$/, message: "请提供官方 HTTPS 链接。" }));
const modelHint = z.string().trim().min(1).max(160).optional();
export const servoPairInputSchema = z.strictObject({
  driveUrl: officialLink, motorUrl: officialLink, catalogUrl: officialLink.optional(),
  driveModel: modelHint, motorModel: modelHint,
});
export type ServoPairInput = z.infer<typeof servoPairInputSchema>;

const sv660Catalog = "https://www.inovance.eu/fileadmin/downloads/Brochures/EN/SV660N_FIyer_Spreads_Web_EN_v0.6.pdf";
const chartTitle = "SV660N Selection Chart";
const compact = (line: string) => line.trim().replace(/\s+/gu, " ");
const incomplete = (message: string) => new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
const modelTag = /^[A-Z0-9][A-Z0-9-]*[0-9][A-Z0-9-]*$/;

function modelFrom(doc: OfficialDocument, role: "驱动器" | "电机", hint?: string): string {
  if (doc.heading && modelTag.test(doc.heading)) {
    if (hint && doc.heading !== hint) throw incomplete(`${role}型号与官方产品页标题不一致。`);
    return doc.heading;
  }
  const pattern = role === "驱动器" ? /\bSV[\dA-Z]+(?:-[\dA-Z]+)+\b/g : /\bMS\d[\dA-Z]+(?:-[\dA-Za-z]+){2,}\b/g;
  const models = [...new Set(doc.text.match(pattern) ?? [])];
  if (hint) {
    if (models.includes(hint) || (role === "电机" && models.some(model => motorEncoding(model, hint, doc.text)))) return hint;
    throw incomplete(`${role}资料中未找到指定型号 ${hint}，请提供该型号的产品页或编码对照表。`);
  }
  if (models.length === 1 && modelTag.test(models[0])) return models[0];
  throw incomplete(`请填写${role}的具体型号。所给资料包含多个型号或未提供完整订货号。`);
}

// The flyer supplies inertia for motors without brakes. Decode only choices explicitly listed in its notes.
function motorEncoding(pattern: string, model: string, page: string) {
  const suffix = model.match(/-([A-Z][0-9])3(\d)R-INT$/);
  if (!suffix || pattern.replace("yn", suffix[1]).replace("z", suffix[2]) !== model) return undefined;
  const legends = page.match(/[“"']yn[”"']\s*can be\s*:\s*([^\n]+)\s+[“"']z[”"']\s*can be[^:\n]*:\s*([^\n]+)/i);
  if (!legends) return undefined;
  const encoder = legends[1].split(";").map(compact).find(note => note.startsWith(suffix[1] + ":") && /\bencoder\b/i.test(note));
  const brake = legends[2].split(";").map(compact).find(note => note.startsWith(suffix[2] + ":"));
  if ((pattern.includes("yn") && !encoder) || !brake) return undefined;
  if (!/W\/O brake|without brake/i.test(brake)) {
    throw incomplete("该电机配置带抱闸，当前列仅给出无抱闸转子惯量，请补充含抱闸惯量及配套关系的规格表。");
  }
  return { locator: (pattern.includes("yn") ? `yn=${suffix[1]}，` : "") + `z=${suffix[2]}（无抱闸）`, evidence: [encoder, brake].filter(Boolean).join("; ") };
}

const numeric = z.number().finite().positive();
const driveShape = z.strictObject({ model: z.string(), ratedCurrentA: numeric, peakCurrentA: numeric });
const motorShape = z.strictObject({
  model: z.string(), ratedPowerW: numeric, ratedTorqueNm: numeric, peakTorqueNm: numeric,
  ratedSpeedRpm: numeric, maxSpeedRpm: numeric, rotorInertiaKgM2: numeric,
});
const answerSchema = z.strictObject({ drive: driveShape, motor: motorShape, pairRow: z.string().min(1).max(2000) });

function selectionRow(doc: OfficialDocument, drive: string, motor: string) {
  const pages = doc.text.split("\f");
  const hits = [];
  for (const [pageIndex, page] of pages.entries()) {
    const headingAt = page.indexOf(chartTitle);
    if (headingAt === -1) continue;
    const lines = page.slice(headingAt).split(/\r?\n/).map(compact);
    const firstData = lines.findIndex(line => /^\d+\s+\d+\s+\d+\s+/.test(line));
    if (firstData < 0) continue;
    const headingLine = lines.findIndex(line => line.includes("Rotor inertia MS1 motor type SV660N-FS Type Material SV660 SV660"));
    const columns = lines.slice(headingLine, headingLine + 4);
    // Validate the stacked headings in order before interpreting a value by its column position.
    if (headingLine < 0 || headingLine + 4 > firstData || columns.some(line => line.length > 500)
      || !columns[0].includes("Drive Motor Motor Motor Motor Motor peak Motor Rotor inertia")
      || !columns[1].includes("power base maximum rated rated torque frame without brake") || !columns[1].includes("code of rated peak")
      || !columns[2].includes("supply speed speed power torque (N·m) size (10-4 kg·m2) SV660N current current")
      || !columns[3].includes("voltage (rpm) (rpm) (W) (N·m) (mm) (A) (A)")) {
      throw incomplete("选型表的列名或单位与支持的 SV660N 配套表不一致，请提供含转矩、惯量和驱动电流列的原版资料。");
    }
    const version = lines.slice(0, headingLine).join("\n").match(/Data code:\s*\S{1,80}\s+V(\d+(?:\.\d+){0,3})/i);
    if (!version) throw incomplete("配套表缺少资料修订版号。");
    const header = [chartTitle, version[0], ...columns].join("\n");
    for (const line of lines.slice(firstData)) {
      const c = line.split(" ");
      const rowDrive = c[8];
      if (!rowDrive?.startsWith("SV660N") || !/^\d+[xX×]\d+$/.test(c[5]) || !/^\d+$/.test(c[9])) continue;
      const pattern = c[7].replace(/\*$/, "");
      const encoding = motorEncoding(pattern, motor, page);
      if (!encoding) continue;
      const match = answerSchema.safeParse({
        pairRow: line,
        drive: { model: rowDrive, ratedCurrentA: Number(c[10]), peakCurrentA: Number(c[11]) },
        motor: { model: motor, ratedPowerW: Number(c[2]), ratedTorqueNm: Number(c[3]), peakTorqueNm: Number(c[4]),
          ratedSpeedRpm: Number(c[0]), maxSpeedRpm: Number(c[1]), rotorInertiaKgM2: Number(c[6] + "e-4") },
      });
      if (!match.success) throw incomplete("所选型号行缺少可确认的额定值、峰值或无抱闸惯量。");
      const pageLabel = doc.format === "pdf" ? `PDF 第 ${pageIndex + 1} 页 · ` : "";
      if (encoding.evidence.length > 1000) throw incomplete("编码说明超出可核对的单项规格，请选择具体型号的选型页。");
      hits.push({ expected: match.data, header, encoding: encoding.evidence, revision: "v" + version[1],
        driveExcerpt: c.slice(8, 12).join(" "), driveLocator: `${pageLabel}${chartTitle} · ${rowDrive} · 额定/峰值电流`,
        locator: `${pageLabel}${chartTitle} · ${pattern} / ${rowDrive} · ${encoding.locator}` });
    }
  }
  const selected = hits.filter(hit => hit.expected.drive.model === drive);
  if (selected.length !== 1) throw incomplete(selected.length
    ? "同一组合匹配了多个选型行，请提供单一修订的官方配套表。"
    : "未找到同时匹配这台驱动器、该电机订货编码、惯量及电流单位的 SV660N 选型行。请核对两个型号和官方配套表。");
  const chosen = selected[0];
  if (hits.some(hit => hit.revision !== chosen.revision)) throw incomplete("资料包含多个修订的配套数据，请提供单一版本。");
  const ratingsDiffer = hits.some(hit => JSON.stringify(hit.expected.motor) !== JSON.stringify(chosen.expected.motor));
  const motorRows = ratingsDiffer ? selected : hits.sort((a, b) => a.expected.drive.model.localeCompare(b.expected.drive.model));
  return { ...chosen, motorRevision: ratingsDiffer ? `${chosen.revision}/${drive}` : chosen.revision,
    compatible: motorRows.map(hit => hit.expected.drive.model),
    motorLocator: motorRows.map(hit => hit.locator).join(" / "), motorExcerpt: motorRows.map(hit => hit.expected.pairRow).join("\n") };
}

async function loadOfficial(url: string) {
  try { return await readOfficialDocument(url); }
  catch (error) {
    if (error instanceof HTTPException) throw new TRPCError({ code: error.status === 400 ? "BAD_REQUEST" : "BAD_GATEWAY", message: error.message });
    throw error;
  }
}

export async function generateServoPair(raw: ServoPairInput, callModel: (prompt: string) => Promise<unknown>) {
  const input = servoPairInputSchema.parse(raw);
  const [driveDoc, motorDoc] = await Promise.all([loadOfficial(input.driveUrl), loadOfficial(input.motorUrl)]);
  const drive = modelFrom(driveDoc, "驱动器", input.driveModel);
  const motor = modelFrom(motorDoc, "电机", input.motorModel);
  const catalogUrl = input.catalogUrl || (driveDoc.text.includes(chartTitle) ? input.driveUrl : motorDoc.text.includes(chartTitle) ? input.motorUrl
    : /^SV660N/.test(drive) && /^MS1/.test(motor) ? sv660Catalog : undefined);
  if (!catalogUrl) throw incomplete("两个产品页缺少驱动器与电机的配套选型行，请补充官方配套选型表链接。");
  const catalog = catalogUrl === input.driveUrl ? driveDoc : catalogUrl === input.motorUrl ? motorDoc : await loadOfficial(catalogUrl);
  const row = selectionRow(catalog, drive, motor);
  const prompt = [
    "请从汇川配套选型表独立读取指定电机和驱动器的额定值，只输出一个 JSON 对象。",
    '{"drive":{"model":"驱动器完整型号","ratedCurrentA":数值,"peakCurrentA":数值},"motor":{"model":"电机完整型号","ratedPowerW":数值,"ratedTorqueNm":数值,"peakTorqueNm":数值,"ratedSpeedRpm":数值,"maxSpeedRpm":数值,"rotorInertiaKgM2":数值},"pairRow":"逐字复制同一行，空白折叠为单空格"}',
    "惯量列以 10^-4 kg·m² 计数，返回 kg·m²。SV660 电流列属于驱动器，电机额定电流此表未列。资料缺失时仅输出 {\"missing\":[\"缺少的资料\"]}。",
    `官网驱动器订货号 ${drive}\n官网电机订货号 ${motor}`,
    `配套表列名\n${row.header}\n同一选型行：\n${row.expected.pairRow}\n型号脚注：\n${row.encoding}`,
  ].join("\n\n");
  const rawAnswer = await callModel(prompt);
  const missing = z.object({ missing: z.array(z.string().trim().min(1).max(160)).min(1).max(12) }).safeParse(rawAnswer);
  if (missing.success) throw incomplete("模型请求补充资料：" + missing.data.missing.join("、"));
  const parsed = answerSchema.safeParse(rawAnswer);
  if (!parsed.success) throw incomplete("模型未返回两份完整的规格和同一行配套证据。");
  const answer = parsed.data;
  if (compact(answer.pairRow) !== row.expected.pairRow || answer.drive.model !== drive || answer.motor.model !== motor) {
    throw incomplete("模型返回的设备身份或配套行与官网资料不符。");
  }
  for (const role of ["drive", "motor"] as const) {
    const observed: Record<string, string | number> = answer[role];
    for (const [key, value] of Object.entries(row.expected[role])) {
      if (typeof value === "number" && Math.abs(Number(observed[key]) - value) > value * 1e-8) {
        throw incomplete(`模型返回的 ${key} 与选型表对应列或单位不符，请核对该组合的资料。`);
      }
    }
  }
  const source = { title: "SV660N – Single-Axis EtherCAT Servo", url: catalogUrl, locator: row.locator, excerpt: row.expected.pairRow };
  const device = { schemaVersion: 1, manufacturer: "汇川技术", revision: row.revision, ports: [], rules: [] };
  const { model: driveModel, ...driveRatings } = row.expected.drive;
  const { model: motorModel, ...motorRatings } = row.expected.motor;
  return {
    drive: parseDevicePackage({ ...device, model: driveModel, source: { ...source, locator: row.driveLocator, excerpt: row.driveExcerpt, productUrl: input.driveUrl },
      servo: { kind: "drive", ...driveRatings } }),
    motor: parseDevicePackage({ ...device, model: motorModel, revision: row.motorRevision,
      source: { ...source, locator: row.motorLocator, excerpt: row.motorExcerpt, productUrl: input.motorUrl },
      servo: { kind: "motor", ...motorRatings, compatibleDriveModels: row.compatible } }),
  };
}
