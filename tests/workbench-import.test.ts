import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeImportUtf8, GCODE_FILE_EXTENSIONS, IMPORT_TEXT_LIMITS, parseImportText } from "../contracts/workbench-import";
import { generateDevicePackage, inovanceSource } from "../contracts/twin-extract";
import { emptyWorkspace, hasWorkspaceShape } from "../contracts/twin-simulation";
import { parseMiloBom } from "../contracts/milo-bom";
import { parseSo101Bom } from "../contracts/so101-bom";
import { parseMaterialTable } from "../contracts/material-import";

const read = (path: string) => readFile(new URL("../public/" + path, import.meta.url), "utf8");
const [milo, follower, nc] = await Promise.all([
  read("machines/milo-v1-5/bom-facts.md"), read("models/so101/follower-bom.md"), read("machines/milo-v1-5/circular-pocket.nc"),
]);
const pkg = generateDevicePackage(inovanceSource);
const project = { ...emptyWorkspace(), packages: [pkg] };

describe("文本导入的格式和诊断", () => {
  it("装配类型标记优先于文件名、工程形状和 AI 待补资料", () => {
    const marked = JSON.stringify({ kind: "linear-axis-assembly", schemaVersion: 1, packages: [], instances: [], missing: ["电流"] });
    expect(() => parseImportText(marked, "workspace.json")).toThrow(/装配/);
    expect(() => parseImportText("~~~json\n" + marked + "\n~~~", "粘贴内容")).toThrow(/装配/);
    expect(() => parseImportText(marked, "asset.json")).not.toThrow(/额定电流|请补充资料/);
  });

  it("自定义标识及待补 BOM 的定义可独立导入，也可随完整工程读取", () => {
    const assembly = {
      kind: "linear-axis-assembly", schemaVersion: 1, id: "fixture-axis", name: "相机升降",
      modules: [{ id: "camera-slide", drive: "待配驱动", motor: "待配电机", screw: "", leadMmPerRev: null, loadInertiaRatio: 1 }],
      axes: [{ id: "Height", module: "camera-slide", direction: [0, 0, 1], targetMm: 3 }],
    };
    const text = JSON.stringify(assembly), expected = { kind: "assembly", assembly };
    expect(parseImportText(text, "workspace.json")).toEqual(expected);
    expect(parseImportText("~~~json\n" + text + "\n~~~", "装配说明.md", { hint: "manual" })).toEqual(expected);
    expect(parseImportText("这里是搭建说明。\n~~~json\n" + text + "\n~~~", "手册.md").kind).toBe("manual");
    const workspace = { ...emptyWorkspace(), assemblies: [assembly] };
    expect(parseImportText(JSON.stringify(workspace), "workspace.json")).toEqual({ kind: "project", workspace });
  });
  it("带 UTF-8 BOM 的文件与无名粘贴可使用同一 JSON 或 Markdown 围栏", () => {
    const json = JSON.stringify(pkg);
    const encoded = new TextEncoder().encode("\uFEFF" + json);
    expect(parseImportText(decodeImportUtf8(encoded), "drive.JSON")).toEqual({ kind: "device", device: pkg });
    expect(parseImportText("\uFEFF\n```json\r\n" + json + "\r\n```\n", "")).toEqual({ kind: "device", device: pkg });
    expect(parseImportText("```\n" + JSON.stringify(project) + "\n```", "工程.md")).toEqual({ kind: "project", workspace: project });
  });
  it("工程缺字段与设备缺字段各自返回既有契约错误", () => {
    expect(() => parseImportText('{"schemaVersion":1,"packages":[],"instances":[]}', "")).toThrow(/仿真场景.*connections/);
    expect(() => parseImportText(JSON.stringify({ ...pkg, source: undefined }), "variant.json")).toThrow(/设备包.*source/);
    expect(() => parseImportText('{"manufacturer":', "")).toThrow(/JSON/);
    expect(() => parseImportText('```json\n{"model":"A"}', "")).toThrow(/JSON|围栏/);
  });
  it("单文件与归档共用结构身份，普通元数据的一个同名字段不足以判定工程", () => {
    for (const value of [null, [], { schemaVersion: 1 }, { packages: [] }, { instances: [] }, { connections: [] }, { catalog: "厂商索引" },
      { schemaVersion: 1, vendor: "A", catalog: { series: "D" } }, Object.create({ schemaVersion: 1, packages: [] })]) {
      expect(hasWorkspaceShape(value)).toBe(false);
    }
    for (const value of [{ schemaVersion: 1, packages: [] }, { schemaVersion: 2, instances: "损坏" }, { instances: [], connections: [] }, emptyWorkspace()]) {
      expect(hasWorkspaceShape(value)).toBe(true);
    }
    expect(() => parseImportText('{"packages":[]}', "vendor.json")).toThrow(/设备包/);
    expect(() => parseImportText('{"catalog":"说明"}', "vendor.json")).toThrow(/设备包/);
    expect(() => parseImportText('{"instances":[],"connections":[]}', "")).toThrow(/仿真场景.*schemaVersion/);
    expect(() => parseImportText('{"schemaVersion":1}', "backup.twin.json")).toThrow(/仿真场景.*packages/);
    expect(parseImportText(JSON.stringify(pkg), "backup.twin.json").kind).toBe("device");
  });
  it("保留 AI 对待补资料的具体反馈", () => {
    expect(() => parseImportText('```json\n{"missing":["额定电流","编码器类型"]}\n```', "")).toThrow(/补充.*额定电流.*编码器类型/);
    expect(() => parseImportText('```json {"missing":["输出转矩"]}```', "")).toThrow(/补充.*输出转矩/);
    expect(() => parseImportText('{"schemaVersion":1}', "workspace.json")).toThrow(/仿真场景.*packages/);
  });
  it("以 UTF-8 字节应用 8 MiB JSON 与 2 MiB 资料边界，前后的空白也计入", () => {
    const manual = "a".repeat(IMPORT_TEXT_LIMITS.materialBytes);
    expect(parseImportText(manual, "手册.txt", { hint: "manual" }).kind).toBe("manual");
    expect(() => parseImportText("中".repeat(Math.floor(IMPORT_TEXT_LIMITS.materialBytes / 3) + 1), "")).toThrow(/2 MiB/);
    const json = JSON.stringify(emptyWorkspace());
    const full = json.padEnd(IMPORT_TEXT_LIMITS.jsonBytes);
    expect(parseImportText(full, "project.json").kind).toBe("project");
    expect(() => parseImportText(full + " ", "project.json")).toThrow(/8 MiB/);
    expect(parseImportText(json.padEnd(IMPORT_TEXT_LIMITS.materialBytes + 8), "").kind).toBe("project");
  });
  it("拒绝坏 UTF-8、嵌入 NUL 和空文件", () => {
    expect(() => decodeImportUtf8(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/);
    expect(() => parseImportText("a\0b", "manual.txt")).toThrow(/UTF-8|文本/);
    expect(() => parseImportText("\uFEFF  \n", "")).toThrow(/空/);
  });
});

describe("专用与通用 BOM", () => {
  it("同一组官方资料从文件、粘贴和内置入口得到原领域解析器的结果", () => {
    for (const [body, name, expected] of [
      [milo, "bom-facts.md", { kind: "milo-bom", bom: parseMiloBom(milo) }],
      [follower, "follower-bom.md", { kind: "so101-bom", bom: parseSo101Bom(follower) }],
    ] as const) {
      expect(parseImportText(body, name)).toEqual(expected);
      expect(parseImportText(body, "")).toEqual(expected);
      expect(parseImportText("\uFEFF" + body, name, { hint: "bom" })).toEqual(expected);
    }
    expect(parseImportText(follower, "Milo-v1.5 BOM.md").kind).toBe("so101-bom");
    expect(parseImportText(milo, "follower-bom.md").kind).toBe("milo-bom");
  });
  it("来源表出现非整数数量、错误版本、损坏表头时继续给出原诊断", () => {
    const badServo = follower.replace(/(\(C001\)\s*\|)\s*6\s*\|/, "$1 5 |");
    expect(() => parseImportText(badServo, "")).toThrow(/6 个 STS3215.*5/);
    expect(() => parseImportText(milo.replace("v1.5 BOM", "v1.4 BOM"), "采购表.md")).toThrow(/v1.4.*v1.5/);
    const generic = "## Individual Parts\n### Motion\n| Component | QTY |\n|---|---|\n| Motor | 1 |";
    expect(parseImportText(generic, "")).toEqual({ kind: "materials", rows: parseMaterialTable("Component,QTY\nMotor,1") });
    expect(() => parseImportText("#### Parts for One Follower Arm:\n| Unrecognised | Amount |\n|---|---|\n| Motor | 1 |", "")).toThrow(/Part.*Amount/);
  });
  it("表格式以外的机型说明仍可作为手册，明确手册意图保留原文", () => {
    const article = "# Milo v1.5 使用手册\n\nSO-101 Follower 可以对照下列章节。\n例如 G1 X2 F120。";
    expect(parseImportText(article, "机械说明.md")).toEqual({ kind: "manual", text: article });
    expect(parseImportText(milo, "手册.md", { hint: "manual" })).toEqual({ kind: "manual", text: milo });
    const withExample = "# 文档编辑指南\r\n\r\n以下展示示例小节。\r\n```md\r\n#### Parts for One Follower Arm:\r\n| Part | Amount |\r\n```\r\n请注明资料来源。";
    expect(parseImportText(withExample, "").kind).toBe("manual");
  });
  it("文件或无文件名的物料表支持既有别名/引号、重复行和默认来源", () => {
    const csv = '\uFEFF\n"Item Name","a, b","采购数量",uom\r\n"螺栓, M3",精密,2,个\r\n';
    const tsv = "制造商\t数量\t物料名称\n甲\t2\t支架";
    for (const [body, name] of [[csv, "bom.CSV"], [tsv, "parts.tsv"], [csv, ""], [tsv, ""]]) {
      const rows = parseMaterialTable(body, "手册 A");
      expect(parseImportText(body, name, { source: "手册 A" })).toEqual({ kind: "materials", rows });
    }
  });
  it("表头已明确时保留坏数量和缺数据报错；无表头的逗号段落或 Markdown 链接当作手册", () => {
    expect(() => parseImportText("部件,数量\n夹具,two", "")).toThrow(/第 2 行.*数量/);
    expect(() => parseImportText("Part Name,Qty", "")).toThrow(/只有表头/);
    const article = "[维护手册](https://example.com/manual)\n部件, 批次和尺寸参见附表。";
    expect(parseImportText(article, "")).toEqual({ kind: "manual", text: article });
  });
  it("文本标题里的机型 BOM 名不会覆盖真实 CSV 数据表头", () => {
    const body = "名称,数量\n自制夹具,1";
    expect(parseImportText(body, "Milo-v1.5 BOM.txt").kind).toBe("materials");
  });
  it("专用来源的文件缺失标题时，保留采购清单层面的错误", () => {
    const body = "## 说明\n此导出丢失了分项小节。";
    expect(() => parseImportText(body, "Milo_v1.5_BOM.md")).toThrow(/Individual Parts/);
    expect(() => parseImportText(body, "follower-bom.md")).toThrow(/Part.*Amount/);
  });
  it("匿名官方 Milo 的专属部件组合也能保留损坏数量的领域诊断", () => {
    const anonymous = milo.replace(/^# Milo v1\.5 BOM/, "# Sourcing Guide");
    const damaged = anonymous.replace(/(\|\s*Motor Drivers\s*\|[^\r\n|]*\|)\s*3\s*\|/i, "$1 many |");
    expect(damaged).not.toBe(anonymous);
    expect(() => parseImportText(damaged, "")).toThrow(/Motor Drivers.*采购数量无效/);
  });
  it("普通 Markdown 表和等价的 CSV/TSV 共享字段、来源、重复项和稳定标识", () => {
    const header = ["制造商", "Part Name", "Qty", "UOM", "订货号", "Source", "额定功率"];
    const row = ["乙厂", "电机|B", "2.5", "组", "M-8", "https://example.org/m8", "10 W"];
    const tsv = [header, row, row].map((cells) => cells.join("\t")).join("\n");
    const markdown = "\uFEFF\r\n# 乙厂物料清单\r\n" + [header.join(" | "), header.map(() => ":---:").join(" | "),
      ...[row, row].map((a) => a.map((c) => c.replaceAll("|", "\\|")).join(" | "))].join("\r\n");
    const expected = { kind: "materials", rows: parseMaterialTable(tsv, "表 B") };
    expect(parseImportText(markdown, "list.md", { source: "表 B" })).toEqual(expected);
    expect(parseImportText("| Part | Amount |\n| --- | ---: |\n| Motor | 1 |", "", { source: "表 B" }))
      .toEqual({ kind: "materials", rows: parseMaterialTable("Part,Amount\nMotor,1", "表 B") });
  });
  it("普通 Markdown 的坏列、坏数量、重复表头与只有表头都给出具体诊断", () => {
    expect(() => parseImportText("# 零件\n\n| 部件 | 数量 |\n|---|:---:|\n| 钢板 | zero |", "")).toThrow(/第 5 行数量必须是正有限数/);
    expect(() => parseImportText("| Name | Qty | Amount |\n|---|---|---|\n| A | 2 | 3 |", "")).toThrow(/数量列重复/);
    expect(() => parseImportText("Name|Qty\n:---|---:\nA|2|个", "")).toThrow(/第 3 行有 3 列，表头有 2 列/);
    expect(() => parseImportText("Name|Qty\n:--|---:\nA|2", "")).toThrow(/第 2 行.*分隔/);
    expect(() => parseImportText("Name|Qty\n:---|---:", "")).toThrow(/只有表头/);
  });
  it("正文里的采购表示例和明示手册保留全文，多表清单不能只导入第一张", () => {
    const table = "| 名称 | 数量 |\n|---|---|\n| 夹具 | 2 |";
    const manual = "# 维护手册\n以下为其中一个例子，请结合供应商规格。\n\n" + table + "\n\n读数说明见第 5 节。";
    expect(parseImportText(manual, "manual.md")).toEqual({ kind: "manual", text: manual });
    const inlineExample = "# 文档写法\n下面演示标题示例。\n#### Parts for One Follower Arm:\n| Part | Amount |\n|---|---|\n| Motor | 1 |\n参考以上示例继续工作。";
    expect(parseImportText(inlineExample, "").kind).toBe("manual");
    expect(parseImportText(table, "table.md", { hint: "manual" })).toEqual({ kind: "manual", text: table });
    expect(() => parseImportText("# 电气\n" + table + "\n\n# 机械\n" + table, "")).toThrow(/多张|多个/);
    expect(() => parseImportText(table + "\n" + table, "")).toThrow(/多张|多个/);
  });
});

describe("程序草稿与明确输入类型", () => {
  it("识别常用 NC 扩展并原样保留可继续编辑的错误行", () => {
    const program = "; 草稿\r\nG90G1X1F60\r\nG99 X3 未完\r\n";
    for (const extension of GCODE_FILE_EXTENSIONS) {
      expect(parseImportText("\uFEFF" + program, "sample." + extension.toUpperCase())).toEqual({ kind: "gcode", program });
    }
    expect(parseImportText(program, "", { hint: "gcode" })).toEqual({ kind: "gcode", program });
    expect(() => parseImportText("G1".padEnd(IMPORT_TEXT_LIMITS.gcodeChars + 1), "a.nc")).toThrow(/65,?536/);
  });
  it("无名代码可识别，资料里的代码段不会吞掉正文", () => {
    expect(parseImportText(nc, "")).toEqual({ kind: "gcode", program: nc });
    const mixed = "# 刀路说明\n请按章节检查。\n```gcode\nG21 G90\nG1 X5 F120\n```";
    expect(parseImportText(mixed, "")).toEqual({ kind: "manual", text: mixed });
    expect(parseImportText("G21\nG1 是线性插补，更多信息见附表。", "").kind).toBe("manual");
  });
  it("明确的扩展名优先于手册提示", () => {
    expect(parseImportText(JSON.stringify(pkg), "p.json", { hint: "manual" }).kind).toBe("device");
    expect(parseImportText("名称,数量\n齿轮,1", "p.csv", { hint: "manual" }).kind).toBe("materials");
    expect(parseImportText("G1", "a.nc", { hint: "manual" }).kind).toBe("gcode");
  });
});
