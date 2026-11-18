import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planMiloProgram, sampleMiloMotion } from "../contracts/milo-motion";
import { createMiloStockPlayback, MILO_TOOL_DIAMETER_MM } from "../contracts/milo-stock";

const program = readFileSync(new URL("../public/machines/milo-v1-5/circular-pocket.nc", import.meta.url), "utf8");
const plan = planMiloProgram(program);
const layerEnds = plan.segments.filter(s => s.arc && Math.abs(s.arc.radiusMm - 12) < 1e-9);

describe("交付的 Milo 圆形凹槽 NC 程序", () => {
  it("使用两种方向的圆弧加工三层，刀具外缘达到直径 30 mm，最后退至圆心上方", () => {
    expect(layerEnds.map(s => s.endMm[2])).toEqual([-1, -2, -3]);
    expect(layerEnds.map(s => s.mode)).toEqual(["G3", "G2", "G3"]);
    for (const s of layerEnds) {
      expect(s.arc!.centerMm).toEqual([36, 30]);
      expect(Math.abs(s.arc!.sweepRad)).toBeCloseTo(2 * Math.PI, 10);
      expect(2 * s.arc!.radiusMm + MILO_TOOL_DIAMETER_MM).toBe(30);
    }
    expect(sampleMiloMotion(plan, plan.durationS)).toMatchObject({ positionMm: [36, 30, 5], velocityMmS: [0, 0, 0] });
  });

  it("逐格核对每层的平底、完整圆心和外部余料，倒拖及重播得到相同的材料", () => {
    const stock = createMiloStockPlayback(plan);
    for (const depth of [0, 1, 2, 3, 1, 0, 3]) {
      const t = depth === 0 ? 0 : layerEnds[depth - 1].endS;
      const frame = stock.seek(t);
      let mismatches = 0;
      for (let row = 0; row < frame.rows; row++) {
        for (let col = 0; col < frame.columns; col++) {
          const x = (col + 0.5) * frame.cellSizeMm - 36;
          const y = (row + 0.5) * frame.cellSizeMm - 30;
          const expectedHeight = x * x + y * y <= 15 ** 2 ? -depth : 0;
          if (frame.heights[row * frame.columns + col] !== expectedHeight) mismatches++;
        }
      }
      expect(mismatches).toBe(0);
      expect(frame.maxDepthMm).toBe(depth);
      expect(Math.abs(frame.removedVolumeMm3 - Math.PI * 15 ** 2 * depth)).toBeLessThan(0.5);
    }
    const finishedVolume = stock.seek(layerEnds[2].endS).removedVolumeMm3;
    expect(stock.seek(plan.durationS).removedVolumeMm3).toBe(finishedVolume);
  });
});
