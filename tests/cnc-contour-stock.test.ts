import { describe, expect, it } from "vitest";
import { createFeedbackStockPlayback, MILO_STOCK } from "../contracts/milo-stock";
import type { MiloVec3 } from "../contracts/milo-motion";

const point = (timeS: number, actualMm: MiloVec3, commandMm: MiloVec3 = actualMm) => ({ timeS, actualMm, commandMm });
const cell = (x: number, y: number) => Math.floor(y / MILO_STOCK.cellSizeMm) * MILO_STOCK.columns + Math.floor(x / MILO_STOCK.cellSizeMm);

describe("按三轴反馈去料", () => {
  it("指令先进入毛坯时保留表面，反馈抵达后才形成各层切深", () => {
    const stock = createFeedbackStockPlayback([
      point(0, [10, 10, 5]), point(1, [10, 10, 5], [40, 20, -3]),
      point(2, [10, 10, -1]), point(3, [10, 10, -2]), point(4, [10, 10, -3]),
    ]);
    expect(stock.seek(1).removedVolumeMm3).toBe(0);
    expect(stock.seek(2).heights[cell(10, 10)]).toBe(-1);
    expect(stock.seek(3).maxDepthMm).toBe(2);
    expect(stock.seek(4).heights[cell(40, 20)]).toBe(0);
    expect(stock.seek(4).maxDepthMm).toBe(3);
  });

  it("刀盘按连续反馈线段扫掠，倒拖只保留该时刻之前的表面", () => {
    const stock = createFeedbackStockPlayback([point(0, [8, 10, 2]), point(1, [8, 10, -1]), point(3, [28, 10, -3])]);
    const first = stock.seek(2);
    const partialHeight = first.heights.slice();
    expect(first.heights[cell(17, 10)]).toBeCloseTo(-2, 6);
    expect(first.heights[cell(25, 10)]).toBe(0);
    const final = stock.seek(3);
    expect(final.heights[cell(27, 10)]).toBe(-3);
    expect(final.heights[cell(18, 14)]).toBe(0);
    expect(stock.seek(2).heights).toEqual(partialHeight);
    expect(stock.seek(0).removedVolumeMm3).toBe(0);
  });
});
