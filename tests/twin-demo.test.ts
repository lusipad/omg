import { describe, expect, it } from "vitest";
import { createTwinDemo } from "../contracts/twin-demo";
import { parseDevicePackage } from "../contracts/twin-device";
import officialPackage from "../examples/GL10-1600END-A03.device.json";
import { advanceSimulation, initialSimulation, parseWorkspace, setInput } from "../contracts/twin-simulation";

describe("汇川接线示例", () => {
  it("从官方 PDF 导出的设备包与离线示例定义一致", () => {
    expect(createTwinDemo().packages[0]).toEqual(parseDevicePackage(officialPackage));
  });

  it("从导出工程还原后，24 V 输入持续 10 ms 导通，撤去信号再保持 10 ms 关断", () => {
    const workspace = parseWorkspace(JSON.parse(JSON.stringify(createTwinDemo())));
    const [receiver, source] = workspace.instances;
    const step9 = advanceSimulation(workspace, initialSimulation(workspace), 9);
    expect(step9.outputs[receiver.id].di0).toBe(false);
    const step10 = advanceSimulation(workspace, step9, 1);
    expect(step10.outputs[receiver.id].di0).toBe(true);
    expect(step10.outputs[receiver.id].di1).toBe(false);
    const switchedOff = setInput(workspace, source.id, "setting", 0);
    const step19 = advanceSimulation(switchedOff, step10, 9);
    expect(step19.outputs[receiver.id].di0).toBe(true);
    expect(advanceSimulation(switchedOff, step19, 1).outputs[receiver.id].di0).toBe(false);
  });
});
