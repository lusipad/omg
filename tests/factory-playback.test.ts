import { describe, expect, it } from "vitest";
import { factoryFrame, indexFactoryRun } from "../src/lib/factory-playback";
import type { FactoryOperation, FactoryRunResource, FactoryRunResult } from "../src/lib/factory-runtime";

const resource = (id: string, role: FactoryRunResource["role"], x: number, y: number): FactoryRunResource => ({
  id,
  name: id,
  role,
  positionM: [x, y],
  modelRef: { id: "test." + role, version: "1" },
  busyS: 0,
  reservedS: 0,
});
const service = (
  jobId: string,
  lineId: string,
  stageId: string,
  stationId: string,
  from: number,
  to: number
): FactoryOperation => ({
  jobId,
  lineId,
  stageId,
  stationId,
  readyS: from,
  dispatchS: from,
  pickupStartS: from,
  loadedStartS: from,
  dropStartS: from,
  serviceStartS: from,
  finishS: to,
});
const mainTransfer: FactoryOperation = {
  ...service("a/1", "a", "cut", "cnc-a", 2, 18),
  carrierId: "amr",
  fromStationId: "load",
  carrierOriginId: "amr",
  dispatchS: 4,
  pickupStartS: 6,
  loadedStartS: 7,
  dropStartS: 11,
  serviceStartS: 13,
};
const run = {
  makespanS: 18,
  resources: [
    resource("load", "handle", 1, 1),
    resource("cnc-a", "machine", 5, 1),
    resource("cnc-b", "machine", 3, -2),
    resource("amr", "mobile", 1, -1),
  ],
  jobs: [
    { id: "a/1", lineId: "a", serial: 1, releaseS: 0, finishS: 18 },
    { id: "b/1", lineId: "b", serial: 1, releaseS: 6, finishS: 16 },
  ],
  operations: [service("a/1", "a", "input", "load", 0, 2), mainTransfer, service("b/1", "b", "cut", "cnc-b", 6, 16)],
} satisfies FactoryRunResult;
const timeline = indexFactoryRun(run);
const at = (time: number) => factoryFrame(timeline, time);

describe("整厂回放使用同一时刻的工件和设备事件", () => {
  it("释放前不计入制品；预占期间机器人空驶，工件留在上游", () => {
    expect(at(0)).toMatchObject({ completed: 0, wip: 1, pending: 1, waiting: 0 });
    expect(at(3).parts[0]).toMatchObject({ phase: "waiting", point: [1, 1] });
    const s = at(5);
    expect(s.equipment.get("amr")).toMatchObject({ phase: "empty", point: [1, 0] });
    expect(s.parts[0]).toMatchObject({ phase: "waiting", point: [1, 1] });
    expect(s.equipment.get("cnc-a")?.phase).toBe("reserved");
  });
  it("按半开区间交接，载货时工件位置与机器人相同，完工后车辆停在最后落点", () => {
    expect(at(6).parts[0].phase).toBe("pickup");
    expect(at(7).parts[0].phase).toBe("carrying");
    const loaded = at(9);
    expect(loaded.equipment.get("amr")?.point).toEqual([3, 1]);
    expect(loaded.parts[0].point).toEqual(loaded.equipment.get("amr")?.point);
    expect(at(11).parts[0]).toMatchObject({ phase: "drop", point: [5, 1] });
    const parallel = at(13);
    expect([parallel.equipment.get("cnc-a")?.phase, parallel.equipment.get("cnc-b")?.phase]).toEqual(["processing", "processing"]);
    expect(parallel.equipment.get("amr")).toMatchObject({ phase: "idle", point: [5, 1] });
    expect(at(16)).toMatchObject({ pending: 0, completed: 1, wip: 1 });
    expect(at(18)).toMatchObject({ pending: 0, completed: 2, wip: 0 });
    expect(timeline.events).toEqual([0, 2, 4, 6, 7, 11, 13, 16, 18]);
  });

  it("同一辆车跨线再派工时，从上次实际落点空驶到新取件位", () => {
    const transfer = {
      ...service("c/1", "c", "cut", "cnc-b", 3, 29),
      carrierId: "amr",
      fromStationId: "load",
      carrierOriginId: "cnc-a",
      dispatchS: 17,
      pickupStartS: 21,
      loadedStartS: 22,
      dropStartS: 25,
      serviceStartS: 26,
    };
    const extended = indexFactoryRun({
      ...run,
      makespanS: 29,
      jobs: [...run.jobs, { id: "c/1", lineId: "c", serial: 1, releaseS: 2, finishS: 29 }],
      operations: [...run.operations, service("c/1", "c", "input", "load", 2, 3), transfer],
    });
    const before = factoryFrame(extended, 16),
      half = factoryFrame(extended, 19);
    expect(before.equipment.get("amr")).toMatchObject({ phase: "idle", point: [5, 1] });
    expect(half.equipment.get("amr")).toMatchObject({ phase: "empty", point: [3, 1], operation: { jobId: "c/1", lineId: "c" } });
    expect(half.parts.find(p => p.id === "c/1")).toMatchObject({ phase: "waiting", point: [1, 1] });
  });

  it("固定输送带不随工件移动，零时长取放在边界直接交给下一阶段", () => {
    const belt = resource("belt", "conveyor", 3, 1);
    const transfer = {
      ...mainTransfer,
      carrierId: "belt",
      carrierOriginId: "load",
      dispatchS: 4,
      pickupStartS: 4,
      loadedStartS: 4,
      dropStartS: 8,
      serviceStartS: 8,
    };
    const fixture = indexFactoryRun({
      ...run,
      resources: [...run.resources, belt],
      operations: [run.operations[0], transfer, run.operations[2]],
    });
    expect(factoryFrame(fixture, 4).parts[0]).toMatchObject({ phase: "carrying", point: [1, 1] });
    expect(factoryFrame(fixture, 5).parts[0].point).toEqual([2, 1]);
    expect(factoryFrame(fixture, 5).equipment.get("belt")).toMatchObject({ phase: "carrying", point: [3, 1] });
    expect(factoryFrame(fixture, 8).parts[0]).toMatchObject({ phase: "processing", point: [5, 1] });
    expect(factoryFrame(fixture, 8).equipment.get("belt")?.phase).toBe("idle");
  });
});
