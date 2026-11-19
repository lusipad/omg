import { describe, expect, it } from "vitest";
import { parseMaterialTable, parseMarkdownMaterialTable, createDocumentMaterial, matchMaterials } from "../contracts/material-import";
import { packageKey, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace } from "../contracts/twin-simulation";
import { parseImportCatalog } from "../contracts/import-catalog";

const pkg: DevicePackage = { schemaVersion: 1, manufacturer: "林泽仪器", model: "P-700", revision: "A",
  source: { title: "测试", url: "https://example.org", locator: "规格", excerpt: "测试规格" },
  ports: [{ id: "x", label: "读数", direction: "input", type: "number" }], rules: [] };

describe("通用来源建档", () => {
  it("无厂商品类限制，保留数量单位、引用字段、未知的规格列和原文证据", () => {
    const text = '\uFEFF\r\n名称,数量,单位,制造商,型号,来源,备注,量程\r\n"压力,探头",1.5,米,林泽仪器,P-700,手册第 3 页,"注明 ""双线""\r\n使用",0–10 bar\r\n';
    const [row] = parseMaterialTable(text);
    expect(row).toMatchObject({ name: "压力,探头", quantity: 1.5, unit: "米", manufacturer: "林泽仪器", model: "P-700", source: "手册第 3 页" });
    expect(row.notes).toContain('注明 "双线"\n使用');
    expect(row.notes).toContain("量程");
    expect(row.notes).toContain("0–10 bar");
    expect(row.binding).toBeUndefined();
  });

  it("英文 TSV 的稳定标识保留同表中的重复行，默认来源进入标识", () => {
    const tsv = 'Unit\tPart\tQty\nkg\t"填料, B"\t2.75\nkg\t"填料, B"\t2.75';
    const rows = parseMaterialTable(tsv, "BOM-01");
    expect(rows[0]).toMatchObject({ name: "填料, B", unit: "kg", quantity: 2.75, source: "BOM-01" });
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(parseMaterialTable(tsv, "BOM-01")).toEqual(rows);
    expect(parseMaterialTable(tsv, "BOM-02")[0].id).not.toBe(rows[0].id);
  });

  it.each(["0", "-1", "Infinity", "0x10", "1,5", ""])("数量 %s 给出具体物料行错误", quantity => {
    expect(() => parseMaterialTable('name,qty\n探头,"' + quantity + '"')).toThrow(/第 2 行.*数量/);
  });

  it("歧义表头、列数错误、未关闭引号、缺必填各自可定位", () => {
    expect(() => parseMaterialTable("name,qty,quantity\na,1,2")).toThrow(/数量.*重复|重复.*数量/);
    expect(() => parseMaterialTable('name,qty,notes\nA,1,"first\nsecond"\nB,2')).toThrow(/第 4 行/);
    expect(() => parseMaterialTable('name,qty\n"未结束,1')).toThrow(/第 2 行.*引号/);
    expect(() => parseMaterialTable("description,cost\na,2")).toThrow(/名称.*数量/);
    expect(() => parseMaterialTable("name,quantity\n,1")).toThrow(/第 2 行.*名称/);
  });

  it("手册按单份资料完整留存，未知设备没有虚构型号或行为", () => {
    const manual = "  # 自制光学探头\r\n响应时间待测。\r\n";
    const row = createDocumentMaterial(" 光学探头.md ", manual, "试验记录 A");
    expect(row).toMatchObject({ name: "光学探头.md", quantity: 1, unit: "份", notes: manual, source: "试验记录 A" });
    expect(row).not.toHaveProperty("model");
    expect(row).not.toHaveProperty("binding");
    expect(createDocumentMaterial("光学探头.md", manual, "试验记录 A").id).toBe(row.id);
    expect(parseImportCatalog({ models: [], materials: [row] }, []).materials[0].notes).toBe(manual);
    expect(() => createDocumentMaterial("空", " \n ")).toThrow(/正文/);
  });
});

describe("通用物料资产绑定", () => {
  const row = parseMaterialTable("名称,数量,型号,厂商\n压力探头,1,P-700,林泽仪器")[0];
  it("用完整型号与厂商匹配唯一修订，不按物料名称猜测", () => {
    const ws = { ...emptyWorkspace(), packages: [pkg] };
    expect(matchMaterials([row], ws)[0].binding).toEqual({ kind: "device", key: packageKey(pkg) });
    expect(matchMaterials([{ ...row, model: undefined, name: pkg.model }], ws)[0].binding).toBeUndefined();
    expect(matchMaterials([{ ...row, manufacturer: "另一家厂商" }], ws)[0].binding).toBeUndefined();
  });

  it("多修订、多厂商未指定时均留待确认；显式绑定和已有选择优先", () => {
    const other = { ...pkg, revision: "B" };
    const ws = { ...emptyWorkspace(), packages: [pkg, other] };
    expect(matchMaterials([row], ws)[0].binding).toBeUndefined();
    expect(matchMaterials([{ ...row, manufacturer: undefined }], {
      ...ws, packages: [pkg, { ...pkg, manufacturer: "另一家" }],
    })[0].binding).toBeUndefined();
    const binding = { kind: "device" as const, key: packageKey(other) };
    expect(matchMaterials([{ ...row, binding }], ws)[0].binding).toEqual(binding);
    expect(matchMaterials([row], { ...ws, catalog: { materials: [{ ...row, binding }], models: [] } })[0].binding).toEqual(binding);
  });

  it("物理模型仅允许资产 ID 或已有明确选择，普通同名物料不自动绑定", () => {
    const id = "a".repeat(64);
    const ws = { ...emptyWorkspace(), catalog: { models: [{ id, name: "压力探头", entry: "sensor.xml" }], materials: [] } };
    expect(matchMaterials([row], ws)[0].binding).toBeUndefined();
    const [withId] = parseMaterialTable("name,quantity,physics model id\n新设备,1," + id);
    expect(matchMaterials([withId], ws)[0].binding).toEqual({ kind: "physics", key: id });
    const stale = { ...row, binding: { kind: "physics" as const, key: "c".repeat(64) } };
    expect(matchMaterials([stale], ws)[0].binding).toBeUndefined();
  });

  it("同一标识的内容不一致时不继承旧行绑定或覆盖原资料", () => {
    const ws = { ...emptyWorkspace(), catalog: { materials: [row], models: [] } };
    expect(() => matchMaterials([{ ...row, quantity: 999 }], ws)).toThrow(/标识.*不同/);
  });
});

describe("丝杠导程", () => {
  it("兼容旧物料与手册标识，导程空格与省略整列等价", () => {
    const header = "名称,数量,单位,厂家,型号,备注";
    const line = "滚珠丝杠,2,根,AC,P42,图 7";
    const legacy = parseMaterialTable([header, line, line].join("\n"), "手册 A");
    expect(legacy.map(row => row.id)).toEqual(["bom-0ad4ebb768b27318fc46525854085a7a", "bom-0ad4ebb768b27318fc46525854085a7a-2"]);
    expect(parseMaterialTable([header + ",导程(mm/rev)", line + ", ", line + ","].join("\n"), "手册 A")).toEqual(legacy);
    expect(legacy[0]).not.toHaveProperty("leadMmPerRev");
    expect(createDocumentMaterial("实验手册", "  始末\r\n", "架 A").id).toBe("doc-f21e5356a5dbe422d7fe7367c49de6ce");
  });

  it("CSV、TSV 与 Markdown 中带单位的别名解析为同一个数字及物料标识", () => {
    const [csv] = parseMaterialTable("名称,数量,导程(mm/rev)\n丝杠,1,2.50");
    const [tsv] = parseMaterialTable("Part\tQty\tleadMmPerRev\n丝杠\t1\t2.5");
    const md = parseMarkdownMaterialTable("| 名称 | 数量 | 丝杠导程（mm/rev） |\n|---|---|---|\n|丝杠|1|2.5|");
    expect(csv).toHaveProperty("leadMmPerRev", 2.5);
    expect(tsv).toEqual(csv);
    expect(md).toEqual([csv]);
    expect(csv).not.toHaveProperty("notes");
    expect(parseMaterialTable("名称,数量,导程(mm/rev)\n丝杠,1,4")[0].id).not.toBe(csv.id);
    expect(parseMaterialTable("名称,数量\n丝杠,1")[0].id).not.toBe(csv.id);
  });

  it("名称、备注及未注明单位的列保持原文", () => {
    const [row] = parseMaterialTable("名称,数量,导程,备注\n丝杠 8 mm/rev,1,8,样本另列 5 mm/rev");
    expect(row).not.toHaveProperty("leadMmPerRev");
    expect(row.notes).toBe("样本另列 5 mm/rev\n导程：8");
  });

  it.each(["0", "-1", "Infinity", "NaN", "0x10", "5 mm", "1e999"])("导程 %s 报告物料行与单位", value => {
    expect(() => parseMaterialTable("\n名称,数量,leadMmPerRev\n丝杠,1," + value)).toThrow(/第 3 行.*导程.*mm\/rev/i);
  });

  it("两列导程别名不能共同决定一个值", () => {
    expect(() => parseMaterialTable("名称,数量,leadMmPerRev,丝杠导程(mm/rev)\n丝杠,1,2,3")).toThrow(/第 1 行.*导程.*重复/);
  });

  it("重导沿用显式绑定，强行沿用旧 ID 却改写导程时报冲突", () => {
    const text = "名称,数量,导程(mm/rev)\n丝杠,1,2.5";
    const [row] = parseMaterialTable(text);
    const binding = { kind: "device" as const, key: packageKey(pkg) };
    const ws = { ...emptyWorkspace(), packages: [pkg], catalog: { models: [], materials: [{ ...row, binding }] } };
    expect(matchMaterials(parseMaterialTable(text), ws)[0].binding).toEqual(binding);
    expect(() => matchMaterials([{ ...row, leadMmPerRev: 5 }], ws)).toThrow(/标识.*不同/);
  });
});
