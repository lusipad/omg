import { describe, expect, it } from "vitest";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import {
  addInstance, advanceSimulation, connectPorts, disconnectPorts, emptyWorkspace, initialSimulation,
  installPackage, parseWorkspace, removeInstance, setInput, type TwinConnection,
} from "../contracts/twin-simulation";

const digital: DevicePackage = {
  schemaVersion: 1, manufacturer: "测试厂商甲", model: "DI-1", revision: "A",
  source: { title: "试验模型参数", url: "https://example.com/di", locator: "输入特性", excerpt: "1 路，接通 >15 V、断开 <5 V，滤波 10 ms。" },
  ports: [
    { id: "v0", label: "输入电压", direction: "input", type: "number", unit: "V" },
    { id: "di0", label: "输入状态", direction: "output", type: "boolean" },
  ],
  rules: [{ op: "digitalInput", input: "v0", output: "di0", onAbove: 15, offBelow: 5, filterMs: 10 }],
};

const voltage: DevicePackage = {
  ...digital, manufacturer: "测试厂商乙", model: "AMP", ports: [
    { id: "in", label: "输入", direction: "input", type: "number", unit: "V" },
    { id: "out", label: "输出", direction: "output", type: "number", unit: "V" },
  ],
  rules: [{ op: "linear", input: "in", output: "out", gain: 2, offset: 0 }],
};

function oneDevice(pkg = digital) {
  const ws = addInstance(installPackage(emptyWorkspace(), pkg), packageKey(pkg), "实例一");
  return { ws, id: ws.instances[0].id };
}

function wire(source: string, output: string, target: string, input: string): TwinConnection {
  return { from: { instanceId: source, portId: output }, to: { instanceId: target, portId: input } };
}

describe("设备包与场景导入", () => {
  it("同版重复安装幂等，相同型号在不同厂商、修订下可并存", () => {
    const ws = installPackage(emptyWorkspace(), digital);
    expect(installPackage(ws, JSON.parse(JSON.stringify(digital)))).toEqual(ws);
    expect(() => installPackage(ws, { ...digital, rules: [{ ...digital.rules[0], op: "copy" }] })).toThrow();
    expect(() => installPackage(ws, { ...digital, source: { ...digital.source, excerpt: "另一份资料" } })).toThrow(/修订|版本/);
    const other = installPackage(ws, { ...digital, manufacturer: voltage.manufacturer });
    expect(installPackage(other, { ...digital, revision: "B" }).packages).toHaveLength(3);
  });

  it.each([
    { ports: [{ ...digital.ports[0], unit: "mV" }, digital.ports[1]] },
    { schemaVersion: 2 }, { source: { ...digital.source, url: "javascript:alert(1)" } },
    { ports: [digital.ports[0], digital.ports[0]] }, { ports: [{ ...digital.ports[0], id: "constructor" }] },
    { rules: [] }, { rules: [digital.rules[0], digital.rules[0]] },
    { rules: [{ op: "copy", input: "v0", output: "di0" }] },
    { rules: [{ ...digital.rules[0], input: "di0" }] }, { rules: [{ ...digital.rules[0], input: "missing" }] },
    { rules: [{ ...digital.rules[0], offBelow: 15 }] }, { rules: [{ ...digital.rules[0], filterMs: -1 }] },
    { rules: [{ op: "script", input: "v0", output: "di0", script: "return true" }] },
    { unexpected: "extra" },
  ])("拒绝不完整、非法或不受支持的设备声明 %#", (change) => {
    expect(() => parseDevicePackage({ ...digital, ...change })).toThrow();
  });

  it("重新加载时验证实例、引用和手工输入，拒绝损坏的场景", () => {
    const { ws, id } = oneDevice();
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
    expect(() => parseWorkspace({ ...ws, instances: [...ws.instances, ws.instances[0]] })).toThrow();
    expect(() => parseWorkspace({ ...ws, packages: [] })).toThrow();
    expect(() => parseWorkspace({ ...ws, instances: [{ ...ws.instances[0], inputs: { v0: true } }] })).toThrow();
    expect(() => parseWorkspace({ ...ws, connections: [wire("missing", "out", id, "v0")] })).toThrow();
    expect(() => parseWorkspace({ ...ws, instances: [{ ...ws.instances[0], inputs: JSON.parse('{"__proto__": 2}') }] })).toThrow();
  });
});

describe("设备接线", () => {
  it("跨厂商接线按拓扑传播，保存场景后可复现，移除实例时一并清理接线", () => {
    const { ws: first, id: sink } = oneDevice();
    const two = addInstance(installPackage(first, voltage), packageKey(voltage), "传感器");
    const source = two.instances[1].id;
    const link = wire(source, "out", sink, "v0");
    const ws = setInput(connectPorts(two, link), source, "in", 10);
    const replay = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    expect(advanceSimulation(replay, initialSimulation(replay), 10).outputs[sink].di0).toBe(true);
    expect(advanceSimulation(ws, initialSimulation(ws), 10).outputs[source].out).toBe(20);
    expect(() => connectPorts(ws, link)).toThrow();
    expect(() => setInput(ws, sink, "v0", 3)).toThrow();
    expect(setInput(disconnectPorts(ws, link), sink, "v0", 3).instances[0].inputs.v0).toBe(3);
    expect(removeInstance(ws, source).connections).toEqual([]);
    expect(ws.connections).toEqual([link]);
  });

  it("拒绝环、同方向与类型不合的连接，支持同类型布尔量传递", () => {
    const { ws, id } = oneDevice(voltage);
    const two = addInstance(ws, packageKey(voltage), "放大器二");
    const other = two.instances[1].id;
    const connected = connectPorts(two, wire(id, "out", other, "in"));
    expect(() => connectPorts(connected, wire(other, "out", id, "in"))).toThrow(/环/);
    expect(() => connectPorts(two, wire(id, "in", other, "in"))).toThrow();
    const mixed = addInstance(installPackage(two, digital), packageKey(digital), "输入模块");
    expect(() => connectPorts(mixed, wire(mixed.instances[2].id, "di0", id, "in"))).toThrow();
    const lamp: DevicePackage = {
      ...digital, model: "信号监视器",
      ports: [
        { id: "on", label: "开关", direction: "input", type: "boolean" },
        { id: "lit", label: "显示", direction: "output", type: "boolean" },
      ], rules: [{ op: "copy", input: "on", output: "lit" }],
    };
    const withLamp = addInstance(installPackage(mixed, lamp), packageKey(lamp), "指示灯");
    const diId = mixed.instances[2].id, lampId = withLamp.instances[3].id;
    const withSignal = setInput(connectPorts(withLamp, wire(diId, "di0", lampId, "on")), diId, "v0", 24);
    expect(advanceSimulation(withSignal, initialSimulation(withSignal), 10).outputs[lampId].lit).toBe(true);
  });

  it("物理量单位必须匹配，非有限数和布尔/数值混写均被拒绝", () => {
    const { ws, id } = oneDevice(voltage);
    const other: DevicePackage = { ...voltage, model: "电流换算", ports: voltage.ports.map((p) => ({ ...p, unit: "A" })) };
    const both = addInstance(installPackage(ws, other), packageKey(other), "电流模块");
    expect(() => connectPorts(both, wire(id, "out", both.instances[1].id, "in"))).toThrow(/单位/);
    expect(() => setInput(ws, id, "in", Infinity)).toThrow();
    expect(() => setInput(ws, id, "in", false)).toThrow();
    expect(() => setInput(ws, id, "out", 5)).toThrow();
  });
});

describe("离散信号仿真", () => {
  it("连续越过接通/断开阈值满 10 ms 才切换，进入未定义区间或恰在阈值会取消短脉冲", () => {
    const { ws, id } = oneDevice();
    const sample = (v: number) => setInput(ws, id, "v0", v);
    let state = advanceSimulation(sample(15), initialSimulation(ws), 20);
    expect(state.outputs[id].di0).toBe(false);
    state = advanceSimulation(sample(24), state, 9);
    expect(state.outputs[id].di0).toBe(false);
    state = advanceSimulation(sample(12), state, 1);
    state = advanceSimulation(sample(24), state, 1);
    expect(state.outputs[id].di0).toBe(false);
    state = advanceSimulation(sample(24), state, 9);
    expect(state.outputs[id].di0).toBe(true);
    state = advanceSimulation(sample(5), state, 20);
    state = advanceSimulation(sample(0), state, 9);
    expect(state.outputs[id].di0).toBe(true);
    state = advanceSimulation(sample(0), state, 1);
    expect(state.outputs[id].di0).toBe(false);
    expect(state.timeMs).toBe(70);
  });

  it("两个实例各自保有滤波状态，分步时间与整段时间给出同一结果", () => {
    const { ws, id } = oneDevice();
    const two = addInstance(ws, packageKey(digital), "实例二");
    const other = two.instances[1].id;
    const high = setInput(two, id, "v0", 24);
    const start = initialSimulation(high);
    const partial = advanceSimulation(high, start, 4);
    const split = advanceSimulation(high, partial, 6);
    expect(split).toEqual(advanceSimulation(high, start, 10));
    expect(split.outputs[id].di0).toBe(true);
    expect(split.outputs[other].di0).toBe(false);
    expect(partial.outputs[id].di0).toBe(false);
    expect(start.timeMs).toBe(0);
    expect(() => advanceSimulation(high, start, -1)).toThrow();
  });
});
