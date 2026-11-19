import { describe, expect, it } from "vitest";
import { inspectLinearAssembly, parseLinearAssembly, resolveModelicaFeedAxes, runLinearAssembly, upsertLinearAssembly } from "../contracts/linear-assembly";
import { servoExampleDrive, servoExampleMotor } from "../contracts/servo-example";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, parseWorkspace, type TwinWorkspace } from "../contracts/twin-simulation";

const modelRef = { id: "GouyuanLinear.FeedAxis", version: "1.0.0" };
const screwClass = { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" };
const tableClass = { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" };
const definition = {
  schemaVersion: 1, kind: "linear-axis-assembly", id: "slide", name: "卧式直线轴", modelRef,
  modules: [{ id: "slide", drive: "D", motor: "M", screw: "S", table: "T", leadMmPerRev: null }],
  axes: [{ id: "X", module: "slide", direction: [0, -3, 4], targetMm: 10 }],
};

function workspace(): TwinWorkspace {
  return { ...emptyWorkspace(), packages: [servoExampleDrive, servoExampleMotor], catalog: { models: [], materials: [
    { id: "D", name: "驱动", quantity: 1, binding: { kind: "device", key: packageKey(servoExampleDrive) } },
    { id: "M", name: "电机", quantity: 1, binding: { kind: "device", key: packageKey(servoExampleMotor) } },
    { id: "S", name: "5 mm 丝杠", quantity: 1, leadMmPerRev: 5 },
    { id: "T", name: "移动工作台", quantity: 1, massKg: 5 },
  ] } };
}

function fixturePart(model: string, feed: NonNullable<DevicePackage["feed"]>) {
  return parseDevicePackage({ schemaVersion: 1, manufacturer: "工程样件", model, revision: "A",
    source: { kind: "local", url: "", title: "工程样件记录", locator: "设计值", excerpt: model }, ports: [], rules: [], feed });
}

describe("Modelica 直线进给轴从 BOM 和已绑定设备取真实输入", () => {
  it("按行 ID 或唯一名称取四类物料，保存再导入保持版本、单位、轴向和长行程", () => {
    const assembly = parseLinearAssembly({ ...definition, modules: [{ ...definition.modules[0], table: "移动工作台" }],
      axes: [{ ...definition.axes[0], targetMm: -120 }] });
    const ws = parseWorkspace(JSON.parse(JSON.stringify(upsertLinearAssembly(workspace(), assembly))));
    expect(inspectLinearAssembly(ws, assembly)).toEqual([]);
    expect(ws.assemblies![0]).toEqual(assembly);
    expect(resolveModelicaFeedAxes(ws, ws.assemblies![0])).toEqual([{ id: "X", direction: [0, -0.6, 0.8], parameters: {
      targetMm: -120, leadMmPerRev: 5, tableMassKg: 5, rotorInertiaKgM2: 0.0000145, ratedPowerW: 400,
      ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, driveRatedCurrentA: 2.8, motorRatedCurrentA: 2.8,
    } }]);
    expect(() => runLinearAssembly(ws, assembly)).toThrow(/GouyuanLinear.FeedAxis/);
    expect(assembly.modules[0]).not.toHaveProperty("loadInertiaRatio");
  });

  it("绑定的丝杠、工作台和厂家电机可替代清单行，使用实际型号修订中的参数", () => {
    const ws = workspace(), rows = ws.catalog!.materials;
    const screw = fixturePart("试验丝杠", { kind: "lead-screw", modelRef: screwClass, leadMmPerRev: 10 });
    const table = fixturePart("试验台", { kind: "moving-table", modelRef: tableClass, massKg: 24 });
    const motor = parseDevicePackage({ ...servoExampleMotor, revision: "额定试验", servo: {
      ...servoExampleMotor.servo, ratedCurrentA: 4.3, ratedPowerW: 250, modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
    } });
    ws.packages.push(screw, table, motor);
    rows[1].binding = { kind: "device", key: packageKey(motor) };
    rows[2].binding = { kind: "device", key: packageKey(screw) }; delete rows[2].leadMmPerRev;
    rows[3].binding = { kind: "device", key: packageKey(table) }; delete rows[3].massKg;
    const assembly = parseLinearAssembly({ ...definition, modules: [{ ...definition.modules[0], loadInertiaRatio: 77 }] });
    const { parameters } = resolveModelicaFeedAxes(ws, assembly)[0];
    expect(parameters).toMatchObject({ tableMassKg: 24, leadMmPerRev: 10, ratedPowerW: 250, motorRatedCurrentA: 4.3, driveRatedCurrentA: 2.8 });
    expect(parameters).not.toHaveProperty("loadInertiaRatio");
    rows[2].leadMmPerRev = 5; rows[3].massKg = 3;
    const issues = inspectLinearAssembly(ws, assembly);
    expect(issues.join("\n")).toMatch(/导程.*不一致/);
    expect(issues.join("\n")).toMatch(/质量.*不一致/);
    expect(() => resolveModelicaFeedAxes(ws, assembly)).toThrow();
  });

  it("未知的部件模型或装配版本可保存，但在运行前报告具体模型和版本", () => {
    const ws = workspace(), rows = ws.catalog!.materials, assembly = parseLinearAssembly(definition);
    const other = fixturePart("其他丝杠", { kind: "lead-screw", leadMmPerRev: 5, modelRef: { ...screwClass, version: "2.0" } });
    ws.packages.push(other); rows[2].binding = { kind: "device", key: packageKey(other) };
    expect(() => resolveModelicaFeedAxes(ws, assembly)).toThrow(/Gouyuan.IdealLeadScrew.*2\.0/);
    ws.packages[1] = parseDevicePackage({ ...servoExampleMotor, servo: { ...servoExampleMotor.servo, modelRef: { id: "Missing.Motor", version: "3" } } });
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/Missing.Motor.*3/);
    const unknown = parseLinearAssembly({ ...definition, modelRef: { ...modelRef, version: "4" } });
    expect(parseWorkspace(upsertLinearAssembly(ws, unknown)).assemblies).toEqual([unknown]);
    expect(inspectLinearAssembly(ws, unknown).join(" ")).toMatch(/GouyuanLinear.FeedAxis.*4/);
    expect(() => runLinearAssembly(ws, unknown)).toThrow(/GouyuanLinear.FeedAxis.*4/);
  });

  it("错误角色和超量会阻止运行，缺参数不使用猜测值", () => {
    const ws = workspace(), rows = ws.catalog!.materials, assembly = parseLinearAssembly(definition);
    rows[2].binding = { kind: "physics", key: "0".repeat(64) };
    rows[3].binding = { kind: "device", key: packageKey(servoExampleDrive) };
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/工作台/);
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/丝杠/);
    delete rows[2].binding; delete rows[3].binding; delete rows[3].massKg;
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/质量/);
    rows[3].massKg = 5;
    const invalid = parseLinearAssembly({ ...definition, modules: [{ ...definition.modules[0], table: "S" }] });
    expect(inspectLinearAssembly(ws, invalid).join(" ")).toMatch(/同时用作.*丝杠.*工作台/);
    const many = parseLinearAssembly({ ...definition, axes: [...definition.axes, { ...definition.axes[0], id: "V" }] });
    expect(inspectLinearAssembly(ws, many).join(" ")).toMatch(/移动工作台.*库存不足/);
    rows[3].unit = "kg";
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/移动工作台.*件数/);
  });

  it("可补填缺失导程，资料冲突与无法表示的运动换算会阻止运行", () => {
    const ws = workspace(), screw = ws.catalog!.materials[2], assembly = parseLinearAssembly(definition);
    const manual = parseLinearAssembly({ ...definition, modules: [{ ...definition.modules[0], leadMmPerRev: 8 }] });
    expect(inspectLinearAssembly(ws, manual).join(" ")).toMatch(/导程.*不一致/);
    delete screw.leadMmPerRev;
    expect(resolveModelicaFeedAxes(ws, manual)[0].parameters.leadMmPerRev).toBe(8);
    expect(inspectLinearAssembly(ws, assembly).join(" ")).toMatch(/导程/);
    screw.leadMmPerRev = Number.MIN_VALUE;
    expect(() => resolveModelicaFeedAxes(ws, assembly)).toThrow(/范围|表示/);
  });
});
