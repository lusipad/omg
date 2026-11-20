import { describe, expect, it } from "vitest";
import {
  applyLinearTransform,
  areUnitsCompatible,
  convertUnit,
  parseQuantityText,
  parseUnitSpec,
} from "../contracts/units";

describe("物理量纲与单位换算", () => {
  it("准确换算电机、丝杠、力学和电学工程样本常用单位", () => {
    expect(convertUnit(0.254, "10⁻⁴ kg·m²", "kg.m2")).toBe(0.0000254);
    expect(convertUnit(0.051, "×10⁻⁴ kg·m²", "kg.m2")).toBe(0.0000051);
    expect(convertUnit(0.4, "kW", "W")).toBe(400);
    expect(convertUnit(3000, "r/min", "rpm")).toBe(3000);
    expect(convertUnit(2.65, "Arms", "A")).toBe(2.65);
    expect(convertUnit(2.4, "A (rms)", "A")).toBe(2.4);
    expect(convertUnit(27.6, "kN", "N")).toBe(27600);
    expect(convertUnit(5, "mm/rev", "m/rev")).toBe(0.005);
    expect(convertUnit(4, "mH", "H")).toBe(0.004);
    expect(convertUnit(600, "mm/min", "mm/s")).toBeCloseTo(10, 12);
    expect(convertUnit(180, "deg", "rad")).toBeCloseTo(Math.PI, 12);
  });

  it("同规范单位换算保持浮点位级恒等", () => {
    for (const sample of [1.27, 0.1234567890123456, 0, -0]) {
      expect(Object.is(convertUnit(sample, "N·m", "N.m"), sample)).toBe(true);
      expect(Object.is(convertUnit(sample, "r/min", "rpm"), sample)).toBe(true);
    }
    expect(parseUnitSpec("kg·m²")?.canonical).toBe("kg.m2");
    expect(areUnitsCompatible("10⁻⁴ kg·m²", "kg.cm2")).toBe(true);
    expect(areUnitsCompatible("N.m", "kg.m2")).toBe(false);
  });

  it("拒绝跨量纲与未知单位，支持线性极性缩放", () => {
    expect(() => convertUnit(1, "N.m", "kg.m2")).toThrow(/量纲不匹配/);
    expect(() => convertUnit(1, "foo", "m")).toThrow(/不支持/);
    expect(() => convertUnit(Number.NaN, "mm", "m")).toThrow(/无效/);
    expect(applyLinearTransform(10000, -1, 0)).toBe(-10000);
    expect(applyLinearTransform(10, 2, -5)).toBe(15);
  });

  it("解析确定单值数量文本，拒绝区间、多维尺寸与不等式", () => {
    expect(parseQuantityText("0.051 ×10⁻⁴ kg·m²")).toMatchObject({ value: 0.051, unit: "1e-4 kg.m2" });
    expect(parseQuantityText("0.4 kW")).toMatchObject({ value: 0.4, unit: "kW" });
    expect(parseQuantityText("3000 r/min")).toMatchObject({ value: 3000, unit: "rpm" });
    expect(parseQuantityText("1.1 A (rms)")).toMatchObject({ value: 1.1, unit: "A" });
    expect(parseQuantityText("27.6 kN")).toMatchObject({ value: 27.6, unit: "kN" });
    expect(parseQuantityText("5~7 dB")).toBeUndefined();
    expect(parseQuantityText("5～7 dB")).toBeUndefined();
    expect(parseQuantityText("10-20 mm")).toBeUndefined();
    expect(parseQuantityText("≥0.294 N·m")).toBeUndefined();
    expect(parseQuantityText("> 15 VDC")).toBeUndefined();
    expect(parseQuantityText("40 × 48 × 83.1 mm")).toBeUndefined();
  });
});
