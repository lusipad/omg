import { describe, expect, it } from "vitest";
import { createServoDemo } from "../contracts/twin-demo";
import { simulateServoAxis } from "../contracts/servo-axis";
import { parseWorkspace } from "../contracts/twin-simulation";
import exportedScene from "../examples/inovance-servo-axis.twin.json";

describe("汇川伺服轴示例交付", () => {
  it("独立工程文件与工作台示例使用同一对设备修订，并可直接运行", () => {
    const workspace = parseWorkspace(exportedScene);
    expect(workspace).toEqual(createServoDemo());
    expect(workspace.packages).toHaveLength(2);
    const { samples, settled } = simulateServoAxis(workspace);
    expect(settled).toBe(true);
    expect(samples[0]).toEqual({ timeMs: 0, positionDeg: 0, speedRpm: 0 });
    expect(Math.abs(samples.at(-1)!.positionDeg - 90)).toBeLessThan(0.1);
  });
});
