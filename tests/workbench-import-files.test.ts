import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importMaterialRows, inspectWorkbenchFiles, inspectWorkbenchText } from "../src/lib/workbench-import";
import { deviceSourceFromMaterial, inovanceSource } from "../contracts/twin-extract";
import { miloBomSource } from "../src/lib/bom-sources";
import { importedServoPair } from "../contracts/import-apply";

const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const device = fixture("../examples/GL10-1600END-A03.device.json");
const motor = fixture("../examples/MS1H1-40B30CB-A331R-INT.device.json");
const project = fixture("../examples/inovance-servo-axis.twin.json");
const bom = fixture("../public/machines/milo-v1-5/bom-facts.md");
const xml = '<mujoco model="滑台"><worldbody><body><geom type="box" size="1 1 1"/></body></worldbody></mujoco>';

afterEach(() => vi.unstubAllGlobals());

describe("同一工作台导入路径", () => {
  it("文件和粘贴返回同一个已校验候选，误从设备入口选择的工程按工程处理", async () => {
    const input = "\uFEFF```json\n" + device + "\n```";
    const fromFile = await inspectWorkbenchFiles([new File([input], "设备.json")], { hint: "json" });
    expect(fromFile).toEqual(await inspectWorkbenchText(input, "设备.json"));
    expect(fromFile.kind).toBe("device");
    expect((await inspectWorkbenchFiles([new File([project], "设备.json")], { hint: "json" })).kind).toBe("project");
  });

  it("一次选取两个设备包得到完整批次，混入工程时不接受部分安装", async () => {
    const files = [new File([device], "I-O.json"), new File([motor], "Motor.json")];
    const both = await inspectWorkbenchFiles(files);
    expect(both.kind === "devices" && both.devices.map(item => item.model)).toEqual([JSON.parse(device).model, JSON.parse(motor).model]);
    if (both.kind === "devices") expect(importedServoPair(both.devices)).toBeUndefined();
    await expect(inspectWorkbenchFiles([...files, new File([project], "工程.json")])).rejects.toThrow(/单独|分别/);
  });

  it("两份明确配套的驱动和电机按设备角色带入伺服台，选取顺序不影响结果", async () => {
    const drive = fixture("../examples/SV660NS2R8I-FS-INT.device.json");
    const pair = await inspectWorkbenchFiles([new File([motor], "A.json"), new File([drive], "B.json")]);
    if (pair.kind !== "devices") throw new Error("未识别设备包批次");
    expect(importedServoPair(pair.devices)).toMatchObject({ drive: { model: JSON.parse(drive).model }, motor: { model: JSON.parse(motor).model } });
  });

  it("从粘贴的 XML 进入与上传相同的模型入口识别", async () => {
    const a = await inspectWorkbenchFiles([new File([xml], "滑台.xml")]);
    const b = await inspectWorkbenchText(xml, "滑台.xml");
    expect(b).toEqual(a);
    expect(a.kind === "model" && a.selection.entries).toEqual(["滑台.xml"]);
    expect((await inspectWorkbenchText(xml, "粘贴内容")).kind).toBe("model");
  });

  it("模型根节点前的多条 XML 处理指令和注释不影响文件、无名粘贴的识别", async () => {
    const source = '<?xml version="1.0"?>\n<!-- 来源注释 -->\n<?xml-stylesheet type="text/xsl" href="viewer.xsl"?>\n<!-- 版本 -->\n' + xml;
    const file = await inspectWorkbenchFiles([new File([source], "未命名.xml")]);
    const paste = await inspectWorkbenchText(source, "未命名");
    expect(paste).toEqual(file);
    expect(paste.kind).toBe("model");
    expect((await inspectWorkbenchText(source, "未命名", { hint: "manual" })).kind).toBe("manual");
  });

  it("单一的 XML 围栏可作为模型，带讲解的 Markdown 以及明确指定的手册保留原文", async () => {
    const fenced = "```xml\n" + xml + "\n```";
    const plain = await inspectWorkbenchText(xml, "滑台.xml");
    const pasted = await inspectWorkbenchText(fenced, "滑台.md");
    const file = await inspectWorkbenchFiles([new File([fenced], "滑台.md")]);
    expect(pasted.kind === "model" && pasted.selection.files[0].path).toBe("滑台.xml");
    expect(file).toEqual(pasted);
    expect(plain.kind === "model" && pasted.kind === "model" && plain.selection.entries).toEqual(["滑台.xml"]);
    expect((await inspectWorkbenchText("# 手册\n\n" + fenced, "说明.md")).kind).toBe("manual");
    expect(await inspectWorkbenchText(fenced, "说明.md", { hint: "manual" })).toMatchObject({ kind: "manual", text: fenced });
  });

  it("直链读取原文件并保留来源，普通官网链接只交给资料表单", async () => {
    const url = "https://example.org/machines/sourcing_guide.md";
    const fetch = vi.fn(async () => new Response(bom, { headers: { "content-type": "text/markdown" } }));
    vi.stubGlobal("fetch", fetch);
    const linked = await inspectWorkbenchText(url, "粘贴内容");
    const local = await inspectWorkbenchFiles([new File([bom], "sourcing_guide.md")]);
    expect(linked.kind === "milo-bom" && linked.bom).toEqual(local.kind === "milo-bom" && local.bom);
    expect(linked.source).toBe(url);
    const page = "https://example.org/products/servo";
    expect(await inspectWorkbenchText(page, "粘贴内容")).toMatchObject({ kind: "source-link", url: page });
    const machinePage = "https://github.com/MillenniumMachines/Milo-v1.5";
    expect(await inspectWorkbenchText(machinePage, "粘贴内容")).toMatchObject({ kind: "source-link", url: machinePage });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("下载链接返回网页、文本编码损坏和无关格式时报错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><title>login</title>", { headers: { "content-type": "text/html" } })));
    await expect(inspectWorkbenchText("https://example.org/demo.nc", "粘贴内容")).rejects.toThrow(/网页/);
    await expect(inspectWorkbenchFiles([new File([Uint8Array.of(0xff, 0xfe, 0xff)], "资料.md")])).rejects.toThrow(/UTF-?8/i);
    await expect(inspectWorkbenchFiles([new File(["x"], "说明.jsx")])).rejects.toThrow(/格式|支持/);
  });

  it("官网采购页使用内置样例的固定原文件，来源追溯到本次实际读取的版本", async () => {
    const fetch = vi.fn(async () => new Response(bom));
    vi.stubGlobal("fetch", fetch);
    expect(await inspectWorkbenchText(miloBomSource.guideUrl, "链接")).toMatchObject({ kind: "milo-bom", source: miloBomSource.rawUrl });
    expect(fetch).toHaveBeenCalledWith(miloBomSource.rawUrl, expect.objectContaining({ credentials: "omit" }));
  });

  it("完整版的汇川 PDF 直链与上传的 PDF 使用同一资料服务及正文校验", async () => {
    const extract = vi.fn(async () => Response.json({ text: "资料正文" }));
    vi.stubGlobal("fetch", extract);
    const link = "https://www.inovance.eu/fileadmin/example.pdf";
    expect(await inspectWorkbenchText(link, "资料链接")).toMatchObject({ kind: "manual", text: "资料正文", source: link });
    expect(extract).toHaveBeenCalledWith("/api/twin-source/url", expect.objectContaining({ method: "POST" }));
    const file = new File(["%PDF"], "手册", { type: "application/pdf" });
    expect(await inspectWorkbenchFiles([file])).toMatchObject({ kind: "manual", text: "资料正文" });
    expect(extract).toHaveBeenLastCalledWith("/api/twin-source/pdf", expect.objectContaining({ body: file }));
  });

  it("核对后修改手册摘录、标题或物料默认来源时，显示与入库用同一份数据", async () => {
    const manual = await inspectWorkbenchText("# 完整手册", "来源.md");
    if (manual.kind !== "manual") throw new Error("未识别手册");
    expect(importMaterialRows(manual, { title: "摘录", source: "第 2 页", text: "有关章节" })[0]).toMatchObject({ name: "摘录", source: "第 2 页", notes: "有关章节" });
    const table = await inspectWorkbenchText("```csv\n名称,数量,来源\n导轨,2,原厂\n丝杠,1,\n```", "粘贴内容");
    if (table.kind !== "materials") throw new Error("未识别清单");
    expect(importMaterialRows(table, { source: "工位图" }).map(row => row.source)).toEqual(["原厂", "工位图"]);
  });

  it("同一已核验手册生成相同的设备草案，显式标题、来源和真实摘录优先", async () => {
    const text = "汇川 GL10-1600END 手册 19011103A03，提取的实际章节。";
    const file = new File([text], "本机副本.txt");
    const manual = await inspectWorkbenchFiles([file], { hint: "manual" });
    if (manual.kind !== "manual") throw new Error("未识别手册");
    expect(deviceSourceFromMaterial(importMaterialRows(manual)[0], file.name)).toEqual({ ...inovanceSource, text });
    const changed = importMaterialRows(manual, { title: "调试摘录", source: "https://example.org/manual.pdf" })[0];
    expect(deviceSourceFromMaterial(changed, file.name)).toMatchObject({ title: "调试摘录", url: changed.source, text });
  });
});
