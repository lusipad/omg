import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SO101_MOTION, parseSo101Motion } from "../contracts/so101";
import { parseSo101Bom } from "../contracts/so101-bom";
import { parseWorkspace } from "../contracts/twin-simulation";
import savedExample from "../examples/so101-follower.twin.json";
import servoExample from "../examples/inovance-servo-axis.twin.json";

describe("SO-101 工程文件", () => {
  it("从上游采购清单得到的装配与交付的工程文件相同", () => {
    const source = readFileSync(new URL("../public/models/so101/follower-bom.md", import.meta.url), "utf8");
    const ws = parseWorkspace(savedExample);
    expect(ws.so101?.bom).toEqual(parseSo101Bom(source));
    expect(ws.so101?.waypoints).toEqual(DEFAULT_SO101_MOTION);
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
  });

  it("同一工程可保存原有伺服轴和从臂", () => {
    const ws = parseWorkspace({ ...servoExample, so101: savedExample.so101 });
    expect(ws.servoAxis).toEqual(servoExample.servoAxis);
    expect(ws.so101).toEqual(savedExample.so101);
    expect(parseWorkspace(servoExample)).not.toHaveProperty("so101");
  });

  it("恢复工程时核对模型修订、舵机数量和动作帧", () => {
    for (const patch of [
      { modelId: "so101-leader" },
      { bom: savedExample.so101.bom.map((row) => ({ ...row, quantity: 1 })) },
      { waypoints: [{ timeS: 1, anglesDeg: [120, 0, 0, 0, 0, 0] }] },
    ]) {
      expect(() => parseWorkspace({ ...savedExample, so101: { ...savedExample.so101, ...patch } })).toThrow();
    }
  });

  it("关节位置需要六个有限角度，各关键帧按绝对到达时间递增", () => {
    const first = DEFAULT_SO101_MOTION[0];
    for (const bad of [
      [], [{ ...first, anglesDeg: [0, 0, 0, 0, 0] }],
      [{ ...first, anglesDeg: [NaN, 0, 0, 0, 0, 0] }],
      [{ ...first, timeS: 0 }], [{ ...first, timeS: 21 }], [first, { ...first, timeS: first.timeS }],
    ]) expect(() => parseSo101Motion(bad)).toThrow();
  });
});
