import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSo101ServoPart, parseSo101Bom, so101BomNotes, validateSo101Bom } from "../contracts/so101-bom";

const official = readFileSync(new URL("../public/models/so101/follower-bom.md", import.meta.url), "utf8");
const servo = "STS3215 Servo 7.4V, 1/345 gear (C001)";
const core = [{ part: servo, quantity: 6 }];
const accessories = ["Motor Control Board", "USB-C Cable 2 pcs", "Power Supply", "Table Clamp 2pcs", "Screwdriver Set"];
const full = [...core, ...accessories.map(part => ({ part, quantity: 1 }))];

describe("SO-101 单台 Follower 采购表", () => {
  it("从上游 Markdown 表读取六项物料，剥除脚注、价格与汇总", () => {
    expect(parseSo101Bom(official)).toEqual(full);
    expect(so101BomNotes(full)).toEqual([]);
    expect(full.filter(({ part }) => isSo101ServoPart(part))).toEqual(core);
  });

  it("完整说明中只读取单从臂小节", () => {
    const both = "#### Parts For Two Arms (Follower and Leader Setup):\n\n| Part | Amount |\n|---|---|\n| " + servo + " | 7 |";
    const readme = "<h1>Standard Open SO-100 & SO-101 Arms</h1>\n" + both + "\n" + official +
      "\n## Printing the Parts\n| Part | Amount |\n|---|---|\n| 另一张物料表 | 1 |";
    expect(parseSo101Bom("\uFEFF" + readme.replaceAll("\n", "\r\n"))).toEqual(full);
  });

  it("表格片段支持列重排、可选外侧竖线和 Markdown 标注", () => {
    const table = "**Amount** | Buy | Part\n:---: | --- | :---\n6 | [shop](https://example.org) | **" + servo + "**\n" +
      "1 | --- | [Screwdriver Set](https://example.org/tool)<sup>[1](#note)</sup>\n--- | --- | **Total**";
    expect(parseSo101Bom(table)).toEqual([...core, { part: "Screwdriver Set", quantity: 1 }]);
  });

  it("配套工具按采购套数记录，缺工具或增加配套件不阻断物理模型", () => {
    const rows = validateSo101Bom([...core, { part: "USB-C Cable 2 pcs", quantity: 2 }]);
    expect(rows).toHaveLength(2);
    expect(so101BomNotes(rows).join(" ")).toMatch(/Screwdriver Set/);
    expect(so101BomNotes(rows).join(" ")).toMatch(/USB-C Cable 2 pcs/);
  });

  it.each([
    ["#### Parts For Two Arms (Follower and Leader Setup):", /双臂|Leader/],
    ["### Parts for One Leader Arm:", /Leader/],
    ["<h1>Standard Open SO-100 Arm</h1>\n#### Parts for One Arm:", /SO-100/],
  ])("识别错误世代或分支 %s", (heading, expected) => {
    expect(() => parseSo101Bom(heading + "\n| Part | Amount |\n|---|---|\n|" + servo + "|6|")).toThrow(expected);
  });

  it.each(["12V, 1/345 gear (C001)", "7.4V, 1/191 gear (C044)", "7.4V, 1/345 gear (C046)"])("拒绝变体和混用的舵机 %s", variant => {
    const part = "STS3215 Servo " + variant;
    expect(isSo101ServoPart(part)).toBe(false);
    expect(() => validateSo101Bom([...core, { part, quantity: 1 }])).toThrow(/STS3215.*C001/);
  });

  it("额外或不足一个舵机、替代型号均不绑定六轴", () => {
    for (const n of [5, 7]) expect(() => validateSo101Bom([{ part: servo, quantity: n }])).toThrow(/6/);
    expect(() => validateSo101Bom([{ part: "STS3032 Servo 7.4V", quantity: 6 }])).toThrow(/STS3215/);
  });

  it("普通采购表、空文件和缺少执行机构的表分别报错", () => {
    expect(() => parseSo101Bom("")).toThrow(/采购表|文件/);
    expect(() => parseSo101Bom("### 任意资料\n| Name | Cost |\n|---|---|\n| 纸张 | 5 |")).toThrow(/Part.*Amount/);
    expect(() => validateSo101Bom([{ part: "Power Supply", quantity: 1 }])).toThrow(/缺少.*舵机/);
    expect(() => validateSo101Bom([...core, { part: "任意其他物料", quantity: 2 }])).toThrow(/物料/);
  });

  it("损坏的存档和重复行不能转换为有效采购表", () => {
    for (const raw of [null, {}, [{}], [{ part: servo, quantity: "6" }], [...core, { part: "Power Supply", quantity: -1 }]]) {
      expect(() => validateSo101Bom(raw)).toThrow();
    }
    expect(() => validateSo101Bom([...core, { part: servo.toLowerCase(), quantity: 1 }])).toThrow(/重复/);
    expect(() => parseSo101Bom("| Part | Amount |\n|---|---|\n| " + servo + " | 6.2 |")).toThrow(/正整数/);
  });
});
