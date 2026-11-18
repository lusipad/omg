import { describe, expect, it } from "vitest";
import { planMiloProgram } from "../contracts/milo-motion";
import { createMiloStockPlayback, MILO_STOCK, type MiloStockState } from "../contracts/milo-stock";

function atCell(frame: MiloStockState, x: number, y: number) {
  return frame.heights[Math.floor(y / frame.cellSizeMm) * frame.columns + Math.floor(x / frame.cellSizeMm)];
}

function pocket() {
  const lines = ["G21 G90 G94"];
  for (let depth = 1; depth <= 3; depth++) {
    lines.push("G0 Z3", "G0 X36 Y30", "G1 Z-" + depth + " F120");
    for (const r of [4, 8, 12]) {
      lines.push("G1 X" + (36 + r) + " F600", (r === 8 ? "G2" : "G3") + " I-" + r + " J0");
    }
  }
  return planMiloProgram(lines.join("\n"));
}

describe("Milo 平底铣刀去料", () => {
  it("无位移的程序在任意有限时刻都给出初始毛坯", () => {
    const play = createMiloStockPlayback(planMiloProgram("G21 G90"));
    const first = play.seek(0);
    expect(play.seek(9)).toBe(first);
    expect(first).toMatchObject({ timeS: 0, removedVolumeMm3: 0, maxDepthMm: 0 });
    expect(() => play.seek(NaN)).toThrow(/有限/);
  });

  it("毛坯初始平整，G0 和表面上方进给不去料", () => {
    const plan = planMiloProgram("G0 X20 Y15 Z-4\nG0 Z3\nG1 X50 F400\nG1 Z0");
    const play = createMiloStockPlayback(plan);
    expect(play.seek(0).heights.length).toBe(MILO_STOCK.columns * MILO_STOCK.rows);
    expect(play.seek(plan.durationS)).toMatchObject({ removedVolumeMm3: 0, maxDepthMm: 0 });
  });

  it("垂直进给在刀盘范围内按实际时刻加深", () => {
    const plan = planMiloProgram("G0 X15.25 Y15.25 Z0\nG1 Z-2 F120");
    const move = plan.segments.at(-1)!;
    const play = createMiloStockPlayback(plan);
    const mid = play.seek((move.startS + move.endS) / 2);
    expect(atCell(mid, 15.25, 15.25)).toBeCloseTo(-1);
    expect(atCell(mid, 18.25, 15.25)).toBeCloseTo(-1);
    expect(atCell(mid, 18.75, 15.25)).toBe(0);
    const halfVolume = mid.removedVolumeMm3;
    expect(play.seek(move.endS).removedVolumeMm3).toBeCloseTo(halfVolume * 2);
  });

  it("毛坯边界截断刀盘，底面限定最深去料", () => {
    const plan = planMiloProgram("G0 X0 Y0 Z2\nG1 Z-12 F240");
    const result = createMiloStockPlayback(plan).seek(plan.durationS);
    expect(result.maxDepthMm).toBe(10);
    expect(atCell(result, 0, 0)).toBe(-10);
    expect(atCell(result, 3, 3)).toBe(0);
    expect(Math.abs(result.removedVolumeMm3 - Math.PI * 9 * 10 / 4)).toBeLessThan(3);
  });

  it("斜线的下降和反向上升得到相同刀痕，接触末端决定最低 Z", () => {
    const down = planMiloProgram("G0 X10 Y10 Z-1\nG1 X20 Z-5 F300");
    const up = planMiloProgram("G0 X20 Y10 Z-5\nG1 X10 Z-1 F300");
    const a = createMiloStockPlayback(down).seek(down.durationS);
    const b = createMiloStockPlayback(up).seek(up.durationS);
    const contact = (15.25 + Math.sqrt(3 ** 2 - 0.25 ** 2) - 10) / 10;
    expect(atCell(a, 15.25, 10.25)).toBeCloseTo(-1 - 4 * contact, 6);
    expect(a.heights).toEqual(b.heights);
  });

  it.each([["G3", 0, -4, 0.25], ["G2", 0, -4, 0.75], ["G3", -4, 0, 0.25]] as const)(
    "%s 螺旋进给 %s 到 %s 按刀盘与圆轨迹的接触角计算最低 Z",
    (mode, z0, z1, turn) => {
      const plan = planMiloProgram("G0 X35.25 Y25.25 Z" + z0 + "\n" + mode + " I-10 J0 Z" + z1 + " F600");
      const play = createMiloStockPlayback(plan), result = play.seek(plan.durationS);
      const half = 2 * Math.asin(3 / 20) / (Math.PI * 2);
      const u = turn + (z1 < z0 ? half : -half);
      expect(atCell(result, 25.25, 35.25)).toBeCloseTo(z0 + (z1 - z0) * u, 5);
      expect(atCell(result, 25.25, 25.25)).toBe(0);
    },
  );

  it("截止到半圈时只保留已扫过的半圆弧", () => {
    const plan = planMiloProgram("G0 X35.25 Y25.25 Z-2\nG3 I-10 J0 F600");
    const arc = plan.segments.at(-1)!;
    const frame = createMiloStockPlayback(plan).seek((arc.startS + arc.endS) / 2);
    expect(atCell(frame, 25.25, 35.25)).toBe(-2);
    expect(atCell(frame, 25.25, 15.25)).toBe(0);
  });

  it("大半径浅弧在刀盘两侧区分轻微覆盖与擦边未接触", () => {
    const plan = planMiloProgram("G0 X10.25 Y20.25 Z0\nG3 X70.25 Y20.25 R10000000000 Z-8 F600");
    const frame = createMiloStockPlayback(plan).seek(plan.durationS);
    expect(atCell(frame, 40.25, 20.25)).toBeCloseTo(-4.4, 5);
    expect(atCell(frame, 40.25, 17.25)).toBeLessThan(-4);
    expect(atCell(frame, 40.25, 23.25)).toBe(0);
  });

  it("升起的圆弧保留起点刀盘边缘的完整入刀深度", () => {
    const plan = planMiloProgram("G0 X27.25 Y31.25 Z-9\nG2 X24.3968304511 Y27.3229490169 Z1 I0 J-3 F3400");
    const frame = createMiloStockPlayback(plan).seek(plan.durationS);
    expect(atCell(frame, 27.25, 28.25)).toBe(-9);
  });

  it("圆心进刀与三个环真实覆盖三层口袋，逐层体积符合理论值", () => {
    const plan = pocket(), play = createMiloStockPlayback(plan);
    const ends = plan.segments.filter((s) => s.arc?.radiusMm === 12);
    expect(ends).toHaveLength(3);
    ends.forEach((s, index) => {
      const state = play.seek(s.endS), depth = index + 1;
      expect(atCell(state, 36, 30)).toBe(-depth);
      expect(state.maxDepthMm).toBe(depth);
      expect(Math.abs(state.removedVolumeMm3 - Math.PI * 15 ** 2 * depth)).toBeLessThan(1);
      expect(atCell(state, 51.5, 30)).toBe(0);
    });
  });

  it("单步、快进、倒拖和重播给出逐格相同的状态，重复同一时刻不改 revision", () => {
    const plan = pocket(), play = createMiloStockPlayback(plan);
    const t = plan.durationS * 0.63;
    const expected = createMiloStockPlayback(plan).seek(t);
    for (let i = 1; i <= 70; i++) play.seek(t * i / 71);
    const forward = play.seek(t);
    expect(forward.heights).toEqual(expected.heights);
    expect(forward.removedVolumeMm3).toBe(expected.removedVolumeMm3);
    expect(play.seek(t)).toBe(forward);
    play.seek(plan.durationS);
    const back = play.seek(t);
    expect(back.heights).toEqual(expected.heights);
    expect(back.revision).toBeGreaterThan(forward.revision);
    expect(play.seek(-1).removedVolumeMm3).toBe(0);
    expect(play.seek(t).heights).toEqual(expected.heights);
  });

  it("支持 1000 段程序在多个检查点之间往返", () => {
    const moves = Array.from({ length: 999 }, (_, i) => "G1 X" + (i % 2 ? 12 : 13) + " Z-" + ((i + 1) * 0.009).toFixed(3) + " F600");
    const plan = planMiloProgram(["G0 X12 Y15 Z0", ...moves].join("\n"));
    const play = createMiloStockPlayback(plan);
    expect(plan.segments).toHaveLength(1000);
    expect(play.seek(plan.durationS).maxDepthMm).toBeCloseTo(8.991, 5);
    const time = plan.segments[381].startS;
    expect(play.seek(time).heights).toEqual(createMiloStockPlayback(plan).seek(time).heights);
    expect(play.seek(plan.durationS).maxDepthMm).toBeCloseTo(8.991, 5);
  });
});
