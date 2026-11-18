import { describe, expect, it } from "vitest";
import { MILO_MACHINE, MILO_MAX_PROGRAM_CHARS, MiloProgramError, miloDemoGcode, planMiloProgram, sampleMiloMotion } from "../contracts/milo-motion";

describe("Milo v1.5 的坐标和程序块", () => {
  it("采用参考 FLY-CDYv3 的三轴边界、驱动单位和独立的虚拟工件原点", () => {
    expect(MILO_MACHINE.minMm).toEqual([0, 0, -120]);
    expect(MILO_MACHINE.maxMm).toEqual([335, 208, 0]);
    expect(MILO_MACHINE.maxFeedMmMin).toEqual([1500, 1500, 1000]);
    expect(MILO_MACHINE.accelerationMmS2).toEqual([200, 200, 100]);
    expect(MILO_MACHINE.stepsPerMm).toEqual([800, 800, 1600]);
    const p = planMiloProgram("G90 G0 X0 Y0 Z5");
    const s = sampleMiloMotion(p, 0);
    expect(s.positionMm).toEqual([0, 0, 5]);
    expect(s.machineMm).toEqual([10, 10, -15]);
    expect(s.stepCounts).toEqual([8000, 8000, -24000]);
    expect(p.durationS).toBe(0);
  });

  it("读取紧凑词、浮点数、N 行号、两类注释和模态继承，保留物理文件行号", () => {
    const p = planMiloProgram("\uFEFF(g code)\r\n N100G21G90G94 \r\nn110g01x+.5y2.f600 (备注; XY)\r\nG91x.25; ignored G2 X9\r\nY-1\r\nG90 X2\r\n");
    expect(p.segments.map((s) => s.line)).toEqual([3, 4, 5, 6]);
    expect(p.segments.map((s) => s.endMm)).toEqual([[.5, 2, 5], [.75, 2, 5], [.75, 1, 5], [2, 1, 5]]);
    expect(p.segments.every((s) => s.feedMmMin === 600 && s.mode === "G1")).toBe(true);
  });

  it("G0 用轴速度上限，F 保持到下一段 G1，零长度块仍更新模态", () => {
    const p = planMiloProgram("G90 G1 F120\nX0\nG0 X80 F240\nG1 X70");
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0].feedMmMin).toBeNull();
    expect(p.segments[0].peakSpeedMmS).toBe(25);
    expect(p.segments[1].feedMmMin).toBe(240);
    expect(p.segments[1].peakSpeedMmS).toBe(4);
  });

  it("行程在机床系检查，整段在线性坐标盒内，增量累加也受限", () => {
    const p = planMiloProgram("G90 G0 X-10 Y-10 Z-100\nX325 Y198 Z20");
    expect(sampleMiloMotion(p, p.segments[0].endS).machineMm).toEqual(MILO_MACHINE.minMm);
    expect(sampleMiloMotion(p, p.durationS).machineMm).toEqual(MILO_MACHINE.maxMm);
    expect(() => planMiloProgram("G0 X325\nG91 X.00001")).toThrow(/第 2 行.*X/);
    expect(() => planMiloProgram("G0 Z20.01")).toThrow(/第 1 行.*Z/);
  });

  it.each([
    ["N10 G2 X0 Y0", "圆弧"], ["G03 X1", "圆弧"], ["M3", "M"], ["G20", "G20"], ["G93", "G93"],
    ["G90.1", "G90.1"], ["G0 G1 X1", "运动"], ["G90 G91 X1", "坐标"], ["G1 X1 X2 F5", "X"],
    ["Y1Z", "Z"], ["G1X1.2.3F2", "."], ["G1X1E2F30", "E"], ["G1 A2 F10", "A"],
    ["G0 X1, Y2", ","], ["G1 X0 (未结束", "注释"], ["G0 )", ")"], ["G1 X2 F0", "F"], ["G1 X2 F-1", "F"],
  ])("逐行拒绝 %s，错误指出具体词", (line, message) => {
    let error: unknown;
    try { planMiloProgram("G90 G1 F120\n" + line + "\nX0"); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(MiloProgramError);
    expect((error as MiloProgramError).line).toBe(2);
    expect((error as MiloProgramError).column).toBeGreaterThan(0);
    expect((error as Error).message).toContain(message);
  });
  it("缺省进给、未选择运动模式、超长源码和空程序明确报错", () => {
    expect(() => planMiloProgram("G1 X1")).toThrow(/F/);
    expect(() => planMiloProgram("X1")).toThrow(/G0.*G1/);
    expect(() => planMiloProgram(" ".repeat(MILO_MAX_PROGRAM_CHARS + 1))).toThrow(MiloProgramError);
    expect(() => planMiloProgram("; 备注\n (只有注释)")).toThrow(/程序/);
  });
  it("报错指向原始词的首列，单行中的非法尾词不会被吞掉", () => {
    try { planMiloProgram("G21\nN40 G0X5Y2 !尾部"); }
    catch (err) {
      expect(err).toMatchObject({ name: "MiloProgramError", line: 2, column: 12 });
      return;
    }
    throw new Error("非法尾词被接受");
  });
  it("一千段程序仍有界，超过段数或文件行数时报告第一个超限的位置", () => {
    const moves = Array.from({ length: 1000 }, (_, i) => `G0X${(i + 1) % 2}`).join("\n");
    const allowed = planMiloProgram(moves);
    expect(allowed.segments).toHaveLength(1000);
    expect(allowed.samples.length).toBeLessThanOrEqual(5001);
    expect(() => planMiloProgram(moves + "\nX1")).toThrow(/第 1001 行.*1,000/);
    expect(() => planMiloProgram("G90\n".repeat(2000) + "G21")).toThrow(/第 2001 行.*2,000/);
  });
});

describe("三轴同步的梯形和三角形速度规划", () => {
  it("30/40 斜线 F600 对应 50 mm、5.04 s、轴速度 6/8 mm/s", () => {
    const p = planMiloProgram("G90 G21 G94\nG1X30Y40F600");
    const s = p.segments[0];
    expect(s.lengthMm).toBe(50); expect(s.accelerationMmS2).toBe(250);
    expect(s.rampS).toBeCloseTo(.04, 12); expect(s.cruiseS).toBeCloseTo(4.96, 12);
    expect(s.endS).toBeCloseTo(5.04, 12); expect(p.totalLengthMm).toBe(50);
    expect(sampleMiloMotion(p, 2.52).positionMm).toEqual([15, 20, 5]);
    expect(sampleMiloMotion(p, 2.52).velocityMmS).toEqual([6, 8, 0]);
    expect(sampleMiloMotion(p, 2.52).pathSpeedMmS).toBe(10);
    expect(sampleMiloMotion(p, 2.52).stepCounts).toEqual([20000, 24000, -24000]);
  });

  it("短行程在到达设定进给前减速，半程速度和位置符合解析解", () => {
    const p = planMiloProgram("G1 X.01 F600");
    const s = p.segments[0], half = sampleMiloMotion(p, p.durationS / 2);
    expect(s.cruiseS).toBe(0); expect(s.peakSpeedMmS).toBeCloseTo(Math.sqrt(2), 12);
    expect(p.durationS).toBeCloseTo(2 * Math.sqrt(.01 / 200), 12);
    expect(half.positionMm[0]).toBeCloseTo(.005, 12);
    expect(half.velocityMmS[0]).toBeCloseTo(Math.sqrt(2), 12);
  });

  it("相邻段不跨越停稳点，反向进给换向且首尾状态精确", () => {
    const p = planMiloProgram("G1 X30 F600\nX15");
    const t = p.segments[0].endS, turn = sampleMiloMotion(p, t);
    expect(turn.line).toBe(1); expect(turn.positionMm).toEqual([30, 0, 5]); expect(turn.velocityMmS).toEqual([0, 0, 0]);
    expect(sampleMiloMotion(p, t + .01).line).toBe(2);
    expect(sampleMiloMotion(p, t + .01).velocityMmS[0]).toBeLessThan(0);
    expect(sampleMiloMotion(p, -1).timeS).toBe(0);
    expect(sampleMiloMotion(p, p.durationS + 1).positionMm).toEqual([15, 0, 5]);
    expect(sampleMiloMotion(p, p.durationS).pathSpeedMmS).toBe(0);
    expect(() => sampleMiloMotion(p, NaN)).toThrow();
  });

  it("三轴联动遇到 Z 上限时按同一比例限速限加速度，未偏离线段", () => {
    const p = planMiloProgram("G1 X30 Y40 Z-55 F60000");
    const s = p.segments[0], mid = sampleMiloMotion(p, p.durationS / 2);
    expect(s.peakSpeedMmS).toBeCloseTo(1000 / 60 * s.lengthMm / 60, 12);
    expect(s.accelerationMmS2).toBeCloseTo(100 * s.lengthMm / 60, 12);
    expect(mid.positionMm[0]).toBeCloseTo(15, 10); expect(mid.positionMm[2]).toBeCloseTo(-25, 10);
    expect(mid.velocityMmS[2]).toBeCloseTo(-1000 / 60, 10);
    p.samples.forEach((record) => {
      expect(record.positionMm[0] / 30).toBeCloseTo((5 - record.positionMm[2]) / 60, 10);
      expect(record.positionMm[1] / 40).toBeCloseTo(record.positionMm[0] / 30, 10);
    });
  });

  it("默认路径含对角线、三轴增量与退刀，图表保留所有段末且最后完全静止", () => {
    const p = planMiloProgram(miloDemoGcode);
    const diagonal = p.segments.find((s) => s.line === 5)!;
    expect(diagonal.endMm).toEqual([30, 40, 0]); expect(diagonal.lengthMm).toBe(50);
    expect(p.segments.find((s) => s.line === 7)?.endMm).toEqual([24, 32, 3]);
    for (const s of p.segments) expect(p.samples.find((pt) => pt.timeS === s.endS)?.velocityMmS).toEqual([0, 0, 0]);
    expect(p.samples.at(-1)?.positionMm).toEqual([0, 0, 8]); expect(p.samples.at(-1)?.velocityMmS).toEqual([0, 0, 0]);
    expect(p.samples.every((point, i) => i === 0 || point.timeS > p.samples[i - 1].timeS)).toBe(true);
  });
});
