import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyMiloBomImport, applySo101BomImport, mergeImportedMaterials } from "../contracts/import-apply";
import { initialMiloWorkspace } from "../contracts/milo-workspace";
import { parseMiloBom } from "../contracts/milo-bom";
import { SO101_MODEL_ID } from "../contracts/so101";
import { parseSo101Bom } from "../contracts/so101-bom";
import { createDocumentMaterial, matchMaterials, parseMaterialTable } from "../contracts/material-import";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { packageKey, type DevicePackage } from "../contracts/twin-device";
import { parseImportText } from "../contracts/workbench-import";
import { importMaterialRows, inspectWorkbenchFiles } from "../src/lib/workbench-import";

const milo = parseMiloBom(readFileSync(new URL("../public/machines/milo-v1-5/bom-facts.md", import.meta.url), "utf8"));
const follower = parseSo101Bom(readFileSync(new URL("../public/models/so101/follower-bom.md", import.meta.url), "utf8"));
const device: DevicePackage = {
  schemaVersion: 1, manufacturer: "仪表厂", model: "X8", revision: "B",
  source: { kind: "local", url: "", title: "记录", locator: "台架 A", excerpt: "模拟输入" },
  ports: [{ id: "x", label: "信号", type: "boolean", direction: "input" }], rules: [],
};

describe("确认导入到当前工程", () => {
  it("Milo 清单重核保留程序和仍有料的轴，不动当前其他工作区", () => {
    const base = { ...emptyWorkspace(), milo: { ...initialMiloWorkspace, bom: milo, assembled: ["Y", "X", "Z"] as ("X" | "Y" | "Z")[], program: "G1 X12 F60" } };
    const next = applyMiloBomImport(base, milo.filter(row => !row.name.includes("550mm (min - X-Axis)")), "新实测表");
    expect(next.milo).toMatchObject({ assembled: ["Y", "Z"], program: "G1 X12 F60", bomSource: "新实测表" });
    expect(base.milo.assembled).toEqual(["Y", "X", "Z"]);
    expect(next.instances).toBe(base.instances);
    expect(() => applyMiloBomImport(base, [], "空清单")).toThrow();
    expect(base.milo.assembled).toEqual(["Y", "X", "Z"]);
  });

  it("首次从采购表装配 SO-101 仅给一个零位保持点，重导保留已编辑路点", () => {
    const initial = applySo101BomImport(emptyWorkspace(), follower);
    expect(initial.so101).toMatchObject({ modelId: SO101_MODEL_ID, bom: follower, waypoints: [{ timeS: 1, anglesDeg: [0, 0, 0, 0, 0, 0] }] });
    const customized = [{ timeS: 1.5, anglesDeg: [1, 2, 3, 4, 5, 6] }];
    const ws = { ...initial, so101: { ...initial.so101!, waypoints: customized } };
    const next = applySo101BomImport(ws, follower.filter(row => !row.part.startsWith("Screwdriver")));
    expect(next.so101?.waypoints).toEqual(customized);
    expect(ws.so101.bom).toHaveLength(6);
    expect(() => applySo101BomImport(ws, [{ part: "未知舵机", quantity: 5 }])).toThrow();
    expect(ws.so101.waypoints).toEqual(customized);
  });

  it("物料按已有规则匹配、幂等合并，已有人工绑定优先", () => {
    const [row] = parseMaterialTable("名称,数量,制造商,型号\n传感器,2,仪表厂,X8", "设备表");
    const manual = createDocumentMaterial("手册", " 原文\n", "试验文件");
    const base = { ...emptyWorkspace(), packages: [device] };
    const next = mergeImportedMaterials(base, [row, manual]);
    expect(next.catalog?.materials[0].binding).toEqual({ kind: "device", key: packageKey(device) });
    expect(mergeImportedMaterials(next, [row, manual])).toEqual(next);
    const newRevision = { ...device, revision: "C" };
    const ws = { ...next, packages: [device, newRevision] };
    const incoming = { ...row, binding: { kind: "device" as const, key: packageKey(newRevision) } };
    expect(mergeImportedMaterials(ws, [incoming]).catalog?.materials[0].binding).toEqual(next.catalog?.materials[0].binding);
    expect(base).not.toHaveProperty("catalog");
  });

  it("资料保存后安装唯一设备，重导补上绑定；有冲突时整批保持原工程", () => {
    const [row] = parseMaterialTable("name,qty,model\n探头,1,X8");
    const ws = mergeImportedMaterials(emptyWorkspace(), [row]);
    expect(ws.catalog?.materials[0].binding).toBeUndefined();
    const installed = { ...ws, packages: [device] };
    expect(mergeImportedMaterials(installed, [row]).catalog?.materials[0].binding?.key).toBe(packageKey(device));
    expect(() => mergeImportedMaterials(ws, [createDocumentMaterial("新文件", "数据"), { ...row, quantity: 20 }])).toThrow(/标识相同/);
    expect(ws.catalog?.materials).toEqual([row]);
  });

  it("同批重复项幂等，有相同标识的不同内容时拒绝整批", () => {
    const base = emptyWorkspace();
    const row = createDocumentMaterial("标定记录", "值为 4 mA");
    expect(mergeImportedMaterials(base, [row, row]).catalog?.materials).toEqual([row]);
    expect(() => mergeImportedMaterials(base, [row, { ...row, notes: "值为 8 mA" }])).toThrow(/标识相同/);
    expect(base.catalog).toBeUndefined();
  });

  it("重导旧版已读过的原始导程列，用旧标识升级资料并保留人工绑定", () => {
    const csv = readFileSync(new URL("../public/assemblies/xy-stage/bom.csv", import.meta.url), "utf8");
    const current = parseMaterialTable(csv);
    const binding = { kind: "device" as const, key: packageKey(device) };
    // 旧版按未知列处理同一文件时，以下两条记录已可被其他装配引用。
    const previous = [
      ...current.slice(0, 2),
      { id: "bom-3396a429e5db31260e560744d8a41119", name: "5 mm 导程丝杠", quantity: 2, unit: "根", source: "本例装配记录 A", notes: "直驱丝杠\n导程(mm/rev)：5", binding },
      { id: "bom-e0e83a572d2bf6d7c8547488d977dabe", name: "10 mm 导程丝杠", quantity: 2, unit: "根", source: "本例装配记录 B", notes: "用于比较的备用丝杠\n导程(mm/rev)：10" },
    ];
    const ws = parseWorkspace({ ...emptyWorkspace(), packages: [device], catalog: { models: [], materials: previous } });
    expect(ws.catalog?.materials).toEqual(previous);
    const next = mergeImportedMaterials(ws, current);
    expect(next.catalog?.materials).toEqual([
      ...previous.slice(0, 2),
      { ...previous[2], notes: "直驱丝杠", leadMmPerRev: 5 },
      { ...previous[3], notes: "用于比较的备用丝杠", leadMmPerRev: 10 },
    ]);
    const reopened = parseWorkspace(JSON.parse(JSON.stringify(next)));
    expect(mergeImportedMaterials(reopened, parseMaterialTable(csv))).toEqual(next);
  });

  it("同名、不同来源或导程分开保存，普通备注与被改写的旧记录都不触发升级", () => {
    const previous = parseMaterialTable('名称,数量,来源,备注\n丝杠,1,清单 A,"第 2 页\n导程(mm/rev)：5"')[0];
    const original = "名称,数量,来源,备注,导程(mm/rev)\n丝杠,1,清单 A,第 2 页,5";
    for (const text of [original.replace("清单 A", "清单 B"), original.replace(",5", ",10"), original.replace("第 2 页", "第 3 页")]) {
      const ws = mergeImportedMaterials(emptyWorkspace(), [previous]);
      expect(mergeImportedMaterials(ws, parseMaterialTable(text)).catalog?.materials).toEqual([previous, ...parseMaterialTable(text)]);
    }
    for (const old of [{ ...previous, notes: "曾有手工变更" }, { ...previous, id: "自定义记录" }]) {
      const ws = mergeImportedMaterials(emptyWorkspace(), [old]);
      expect(mergeImportedMaterials(ws, parseMaterialTable(original)).catalog?.materials).toEqual([old, ...parseMaterialTable(original)]);
    }
  });

  it("重导原始清单能够升级两个历史版本的质量备注，保留行 ID、重复序号和人工绑定", () => {
    const rows = (header: string, record: string) => parseMaterialTable([header, record, record].join("\n"), "工作台装配图 A");
    const text = "名称,数量,导程(mm/rev),移动质量(kg),备注\n滑台,1,5,2.50,按图\n滑台,1,5,2.50,按图";
    const oldest = rows("名称,数量,备注", '滑台,1,"按图\n导程(mm/rev)：5\n移动质量(kg)：2.50"');
    const previous = rows("名称,数量,导程(mm/rev),备注", '滑台,1,5,"按图\n移动质量(kg)：2.50"');
    const binding = { kind: "device" as const, key: packageKey(device) };
    for (const history of [oldest, previous, previous.map((row, i) => ({ ...row, id: oldest[i].id }))]) {
      const originals = history.map(row => ({ ...row, binding }));
      const ws = parseWorkspace({ ...emptyWorkspace(), packages: [device], catalog: { models: [], materials: originals } });
      const saved = mergeImportedMaterials(ws, parseMaterialTable(text, "工作台装配图 A"));
      expect(saved.catalog?.materials).toEqual(originals.map(row => ({ ...row, notes: "按图", leadMmPerRev: 5, massKg: 2.5 })));
      expect(mergeImportedMaterials(parseWorkspace(JSON.parse(JSON.stringify(saved))), parseMaterialTable(text, "工作台装配图 A"))).toEqual(saved);
      expect(mergeImportedMaterials(ws, parseMaterialTable(text.replaceAll("2.50", "5"), "工作台装配图 A")).catalog?.materials).toHaveLength(4);
    }
  });

  it("上传后修改预览来源会按原表重算旧身份，保留未知列顺序与重复行编号", async () => {
    const line = "丝杠\t2\tA\t5.00\t17\t现场核对";
    const text = ["名称\t数量\t图册\tleadMmPerRev\t批次\t备注", line, line].join("\n");
    const oldLine = '丝杠,2,"现场核对\n图册：A\nleadMmPerRev：5.00\n批次：17"';
    const previous = parseMaterialTable(["名称,数量,备注", oldLine, oldLine].join("\n"), "机台 A");
    const ws = mergeImportedMaterials(emptyWorkspace(), previous);
    const file = await inspectWorkbenchFiles([new File([text], "物料.tsv")], { source: "待核对" });
    if (file.kind !== "materials") throw new Error("未识别物料表");
    const rows = importMaterialRows(file, { source: "机台 A" });
    const expected = previous.map(row => ({ ...row, leadMmPerRev: 5, notes: "现场核对\n图册：A\n批次：17" }));
    expect(matchMaterials(rows, ws)).toEqual(expected);
    const next = mergeImportedMaterials(ws, rows);
    expect(next.catalog?.materials).toEqual(expected);
    const pasted = parseImportText(text, "物料.tsv", { source: "机台 A" });
    if (pasted.kind !== "materials") throw new Error("未识别粘贴的物料表");
    expect(mergeImportedMaterials(next, pasted.rows)).toEqual(next);
    expect(mergeImportedMaterials(ws, importMaterialRows(file)).catalog?.materials).toHaveLength(4);
  });
});
