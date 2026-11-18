import { describe, expect, it } from "vitest";
import { deviceExtractionPrompt, generateDevicePackage, inovanceSource, suggestSourceMetadata } from "../contracts/twin-extract";

const secondSource = {
  manufacturer: "实验仪器厂",
  model: "LX-8",
  revision: "1.2",
  title: "LX-8 输入模块规格",
  url: "https://example.org/lx-8",
  locator: "第 2 页，输入特性",
  text: "型号：LX-8\n输入点数：8 路\n接通电压：高于 12.5 VDC\n关断电压：低于 2 V\n输入滤波时间：0.004 s",
};

describe("厂商资料生成设备包", () => {
  it("把汇川规格逐通道转成可追溯的规则", () => {
    const pkg = generateDevicePackage(inovanceSource);
    expect(pkg.ports).toHaveLength(32);
    expect(pkg.rules).toHaveLength(16);
    expect(pkg.rules[15]).toEqual({ op: "digitalInput", input: "v15", output: "di15", onAbove: 15, offBelow: 5, filterMs: 10 });
    expect(pkg.source.url).toBe(inovanceSource.url);
    expect(pkg.source.locator).toContain("General specifications");
    expect(pkg.source.excerpt).toContain("15 V");
  });

  it("识别 PDF 保留双栏布局时出现在行末的英文规格", () => {
    const text = [
      "GL10-1600END   Digital input module     16-channel DI",
      "Number of input channels                                      16",
      "Note      ON voltage                                  > 15 VDC",
      "Note      OFF voltage                                 < 5 VDC",
      "          DI filter time                              10ms",
    ].join("\n");
    const pkg = generateDevicePackage({ ...inovanceSource, text });
    expect(pkg.rules[0]).toMatchObject({ onAbove: 15, offBelow: 5, filterMs: 10 });
    expect(pkg.source.excerpt).toContain("Number of input channels 16");
    expect(pkg.source.excerpt).not.toContain("Note");
    expect(pkg).toEqual(generateDevicePackage(inovanceSource));
  });

  it("保留不同厂商的身份、通道数和参数，按单位换算滤波时间", () => {
    const pkg = generateDevicePackage(secondSource);
    expect([pkg.manufacturer, pkg.model, pkg.revision]).toEqual(["实验仪器厂", "LX-8", "1.2"]);
    expect(pkg.ports).toHaveLength(16);
    expect(pkg.rules[7]).toMatchObject({ onAbove: 12.5, offBelow: 2, filterMs: 4 });
    expect(pkg.source.excerpt).toContain("0.004 s");
  });

  it("列出未找到的必需规格，不填入示例参数", () => {
    expect(() => generateDevicePackage({ ...secondSource, text: "额定电压 24 V" })).toThrow(/通道.*接通.*关断.*滤波/);
  });

  it("拒绝同一文档内冲突的通道数", () => {
    expect(() => generateDevicePackage({ ...secondSource, text: secondSource.text + "\n数字量输入通道数：32" })).toThrow(/通道.*冲突/);
  });

  it("已有一个可识别值时仍拒绝同名字段中的其他阈值条件", () => {
    expect(() => generateDevicePackage({ ...secondSource, text: secondSource.text + "\n接通电压：≥14 V" })).toThrow(/接通电压/);
  });

  it("阻止把来源中明确标注的型号归到其他设备", () => {
    expect(() => generateDevicePackage({ ...secondSource, model: "LX-16" })).toThrow(/型号/);
  });

  it.each([
    ["接通电压：高于 12.5 VDC", "接通电压：≥12.5 VDC", "接通"],
    ["关断电压：低于 2 V", "关断电压：＜2 A", "关断"],
    ["输入滤波时间：0.004 s", "输入滤波时间：2 ms 或 4 ms", "滤波"],
    ["输入滤波时间：0.004 s", "输入滤波时间：2 至 8 ms", "滤波"],
    ["输入点数：8 路", "输入点数：8.5 路", "通道"],
  ])("阻止未经支持的规格字段 %s", (before, after, field) => {
    expect(() => generateDevicePackage({ ...secondSource, text: secondSource.text.replace(before, after) })).toThrow(new RegExp(field));
  });

  it("拒绝无法形成高低电平区间的阈值", () => {
    expect(() => generateDevicePackage({ ...secondSource, text: secondSource.text.replace("低于 2 V", "低于 13 V") })).toThrow(/阈值|接通电压/);
  });

  it("要求给出可回查的资料定位", () => {
    expect(() => generateDevicePackage({ ...secondSource, locator: " " })).toThrow(/定位/);
  });

  it("将资料及声明式规则约束交给可选的 AI 工具", () => {
    const prompt = deviceExtractionPrompt(secondSource);
    expect(prompt).toContain(secondSource.url);
    expect(prompt).toContain("0.004 s");
    expect(prompt).toContain("digitalInput");
    expect(prompt).toContain("linear");
    expect(prompt).toContain("copy");
    expect(prompt).toContain("缺失");
  });
});

describe("从明确标签预填资料表单", () => {
  it("仅提取单一厂商、型号、修订，支持中英文与简单资料表", () => {
    expect(suggestSourceMetadata("Manufacturer: Birch Controls\n型号：BC-401\n| Revision | B02 |\nModel: BC-401")).toEqual({
      manufacturer: "Birch Controls", model: "BC-401", revision: "B02",
    });
    expect(suggestSourceMetadata("制造商：实验仪器厂；产品型号：LX-8；资料版本：1.2")).toEqual({
      manufacturer: secondSource.manufacturer, model: secondSource.model, revision: secondSource.revision,
    });
  });

  it("同一字段出现多个值或型号列表时留空", () => {
    expect(suggestSourceMetadata("制造商：甲公司\n型号：LX-8\n型号：LX-16\nRevision: A03\nRevision: B02")).toEqual({ manufacturer: "甲公司" });
    expect(suggestSourceMetadata("Model: LX-8 / LX-16")).toEqual({});
  });

  it("不根据网址、正文中提及的品牌或空白表单猜测身份", () => {
    expect(suggestSourceMetadata("LX-8 digital input by Birch Controls\nhttps://example.org/LX-8/A03\nProduct model:\nRevision:")).toEqual({});
  });
});
