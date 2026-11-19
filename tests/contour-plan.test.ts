import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planContourProgram, previewContourProgram, sampleContourCommand, type ContourProfile } from "../contracts/contour-plan";

const fixtureDir = new URL("../public/assemblies/cnc-factory/", import.meta.url);
const fixture: ContourProfile = JSON.parse(readFileSync(new URL("contour-template.device.json", fixtureDir), "utf8")).contour;

describe("机床档案驱动的圆弧参考与三轴共用时钟", () => {
  it("按当前机床的装夹零点、行程和进给限值解释相同的程序", () => {
    const custom: ContourProfile = { ...fixture, initialWorkMm: [1, 2, 4], maxFeedMmMin: [60, 120, 180],
      accelerationMmS2: [10, 20, 30], maxMm: [23, 30, 0] };
    const program = "G91 G1 X2 F600";
    const contour = planContourProgram(program, custom);
    expect(contour.plan).toEqual(previewContourProgram(program, custom));
    expect(contour.programEndS).toBeCloseTo(2.1, 12);
    expect(contour.initialWorkMm).toEqual([1, 2, 4]);
    expect(sampleContourCommand(contour, 0).positionMm).toEqual([1, 2, 4]);
    expect(sampleContourCommand(contour, 1.05)).toMatchObject({ positionMm: [2, 2, 4], velocityMmS: [1, 0, 0] });
    expect(() => previewContourProgram("G90 G0 X3.1", custom)).toThrow(/第 1 行.*X.*行程/);
    // 两端均在 X=3，逆时针半圆在途中达到 X=4。
    expect(() => previewContourProgram("G0 X3 Y1\nG3 X3 Y3 I0 J1 F60", custom)).toThrow(/第 2 行.*圆弧途中的 X/);
  });

  it("三层圆槽在每个物理程序段边界都含精确工件坐标，并保持终点一秒", () => {
    const source = readFileSync(new URL("circular-pocket.nc", fixtureDir), "utf8");
    const contour = planContourProgram(source, fixture);
    const { plan, timesS, referenceMm } = contour;
    expect(referenceMm.length).toBe(timesS.length * 3);
    expect(Array.from(referenceMm.subarray(0, 3))).toEqual([0, 0, 5]);
    const rowByTime = new Map<number, number>();
    let minGap = Infinity, maxGap = 0, maxChordError = 0;
    for (let i = 0; i < timesS.length; i++) {
      rowByTime.set(timesS[i], i);
      if (i) {
        const gap = timesS[i] - timesS[i - 1];
        minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap);
        const mid = sampleContourCommand(contour, timesS[i - 1] + gap / 2).positionMm;
        const error = mid.map((v, a) => v - (referenceMm[3 * i + a] + referenceMm[3 * (i - 1) + a]) / 2);
        maxChordError = Math.max(maxChordError, Math.hypot(...error));
      }
    }
    expect(minGap).toBeGreaterThan(0);
    expect(maxGap).toBeLessThanOrEqual(0.001 + 1e-10);
    expect(maxChordError).toBeLessThan(0.00004);
    expect(contour.programEndS).toBeCloseTo(51.070508642, 8);
    for (const segment of plan.segments) {
      const end = rowByTime.get(segment.endS);
      expect(end).toBeDefined();
      expect(Array.from(referenceMm.subarray(end! * 3, end! * 3 + 3))).toEqual(segment.endMm);
      expect(sampleContourCommand(contour, segment.endS)).toMatchObject({ line: segment.line, mode: segment.mode, velocityMmS: [0, 0, 0] });
    }
    const outer = plan.segments.filter(s => s.arc?.radiusMm === 12);
    expect(outer.map(s => [s.mode, s.endMm[2]])).toEqual([["G3", -1], ["G2", -2], ["G3", -3]]);
    const approaching = sampleContourCommand(contour, outer[0].startS + outer[0].rampS / 2);
    expect(approaching.velocityMmS[1]).toBeGreaterThan(0);
    expect(Math.hypot(approaching.positionMm[0] - 36, approaching.positionMm[1] - 30)).toBeCloseTo(12, 10);
    expect(timesS.at(-1)).toBe(contour.programEndS + 1);
    expect(sampleContourCommand(contour, contour.endS)).toMatchObject({
      timeS: contour.endS, positionMm: [36, 30, 5], velocityMmS: [0, 0, 0], line: null, mode: null,
    });
  });

  it("正反向整圆短于一个插补周期时也能在正确方向经过圆周", () => {
    const micro = { ...fixture, accelerationMmS2: [1e6, 1e6, 1e6] as [number, number, number] };
    for (const mode of ["G2", "G3"]) {
      const c = planContourProgram(mode + " I0.0001 F60000", micro);
      expect(c.programEndS).toBeLessThan(0.001);
      const beforeHalf = Array.from(c.timesS).findIndex(t => t > 0 && t < c.programEndS / 2);
      expect(beforeHalf).toBeGreaterThan(0);
      const x = c.referenceMm[beforeHalf * 3], y = c.referenceMm[beforeHalf * 3 + 1];
      expect(Math.sign(y)).toBe(mode === "G2" ? 1 : -1);
      expect(Math.hypot(x - .0001, y)).toBeCloseTo(.0001, 12);
    }
  });

  it("越界、错误圆心和超过求解窗口的程序均在准备高密度参考表前定位到源行", () => {
    expect(() => planContourProgram("G21\nG1 X1 F0.001", fixture)).toThrow(/第 2 行.*120 s/);
    expect(() => previewContourProgram("G0 X1\nG3 X2 I0 J0 F120", fixture)).toThrow(/第 2 行.*半径/);
    expect(() => planContourProgram("G0 Z0", { ...fixture, initialWorkMm: [0, 0, 50] })).toThrow(/初始.*Z|Z.*初始/);
    expect(() => previewContourProgram("G0 X1", { ...fixture, maxFeedMmMin: [1, 0, 1] })).toThrow(/进给/);
    const still = planContourProgram("G90 G0 X0 Y0 Z5", fixture);
    expect(still.programEndS).toBe(0);
    expect(still.timesS).toHaveLength(1001);
    expect(sampleContourCommand(still, 0.5)).toMatchObject({ timeS: 0.5, positionMm: [0, 0, 5], line: null });
  });
});
