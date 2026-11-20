import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilitiesForDevice,
  effectiveModelBindings,
  evaluateBindingReadiness,
  resolveParameterChoice,
} from "../contracts/device-model-binding";
import { parseLinearAssembly, upsertLinearAssembly } from "../contracts/linear-assembly";
import { bindModelicaServo, MODELICA_SERVO_REF } from "../contracts/modelica-servo";
import {
  MODEL_REGISTRY,
  matchCompiledKernel,
  requireRegisteredModel,
} from "../contracts/model-registry";
import { assembleServoAxis, simulateServoAxis } from "../contracts/servo-axis";
import { packageKey, parseDevicePackage, type DevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import gl10Sample from "../examples/GL10-1600END-A03.device.json";
import ms1h1Sample from "../examples/MS1H1-40B30CB-A331R-INT.device.json";
import sv660Sample from "../examples/SV660NS2R8I-FS-INT.device.json";
import cncFeedSample from "../public/assemblies/cnc-factory/devices/cnc-feed.device.json";
import cncDeviceLib from "../public/assemblies/cnc-factory/devices.library.json";
import contourMotorSample from "../public/assemblies/cnc-factory/contour-motor.device.json";
import motorKitLib from "../public/assemblies/motor-kit/components.library.json";
import contourLibrary from "../public/modelica/contour-library.json";
import factoryLibrary from "../public/modelica/factory-library.json";
import servoLibrary from "../public/modelica/library.json";
import linearLibrary from "../public/modelica/linear-library.json";
import motorLibrary from "../public/modelica/motor-library.json";

const servoWasmBytes = readFileSync(new URL("../public/modelica/runtime/servo-axis.wasm", import.meta.url));
const feedWasmBytes = readFileSync(new URL("../public/modelica/runtime/feed-axis.wasm", import.meta.url));

async function loadServoRuntime() {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(servoWasmBytes))));
  return (await import("../src/lib/modelica-servo-runtime")).runModelicaServo;
}

async function loadFeedRuntime() {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(feedWasmBytes))));
  return (await import("../src/lib/modelica-feed-runtime")).runModelicaLinearAssembly;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const deltaManualMeta = {
  title: "Delta AC Servo Drive & Motor ASDA-B3 Series Catalogue",
  url: "https://www.gapp.co.uk/download/file/127/2460/deltaia-asdaasda-b3cen20240703-3pdf",
};

function deltaDrivePackage(): DevicePackage {
  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer: "Delta Electronics",
    model: "ASD-B3-0421-L",
    revision: "ASDA-B3-20240703",
    source: {
      ...deltaManualMeta,
      locator: "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703 · p.32",
      excerpt: "ASD-B3-0421-L Continuous output current 2.65 Arms",
    },
    ports: [],
    rules: [],
    parameters: {
      continuousCurrent: {
        status: "catalog",
        value: 2.65,
        unit: "Arms",
        label: "连续输出电流",
        locator: "p.32",
      },
      peakCurrent: {
        status: "catalog",
        value: 7.95,
        unit: "Arms",
        label: "瞬时最大电流",
        locator: "p.32",
      },
    },
    modelBindings: [
      {
        id: "servo-drive",
        modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
        mappings: [
          { kind: "parameter", source: "continuousCurrent", target: "driveRatedCurrentA" },
          { kind: "parameter", source: "peakCurrent", target: "drivePeakCurrentA" },
        ],
      },
    ],
  });
}

function deltaMotorPackagePending(): DevicePackage {
  return parseDevicePackage({
    schemaVersion: 1,
    manufacturer: "Delta Electronics",
    model: "ECM-B3M-CA0604RB1",
    revision: "ASDA-B3-20240703-pending",
    source: {
      ...deltaManualMeta,
      locator: "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703 · p.21 / p.37 / p.41",
      excerpt: "ECM-B3M-CA0604 400W 1.27 N.m 3.81 N.m 3000 r/min 6000 r/min 2.40 Arms Rotor inertia 0.254 / 0.264 (10^-4 kg.m2)",
    },
    ports: [],
    rules: [],
    parameters: {
      ratedPower: { status: "catalog", value: 0.4, unit: "kW", locator: "p.41" },
      ratedTorque: { status: "catalog", value: 1.27, unit: "N·m", locator: "p.41" },
      peakTorque: { status: "catalog", value: 3.81, unit: "N·m", locator: "p.41" },
      ratedSpeed: { status: "catalog", value: 3000, unit: "r/min", locator: "p.41" },
      maxSpeed: { status: "catalog", value: 6000, unit: "r/min", locator: "p.41" },
      ratedCurrent: { status: "catalog", value: 2.4, unit: "Arms", locator: "p.41" },
      rotorInertia: {
        status: "pending",
        label: "转子转动惯量",
        unit: "10⁻⁴ kg·m²",
        reason: "第 41 页 400 W 列区分无抱闸（0.254）与带抱闸（0.264），请按订货编码第 13 位选件确认。",
        candidates: [
          { option: "无抱闸（订货编码含 R，带油封）", value: 0.254, unit: "10⁻⁴ kg·m²", locator: "p.37 / p.41", excerpt: "0.254 (without brake)" },
          { option: "带抱闸", value: 0.264, unit: "10⁻⁴ kg·m²", locator: "p.37 / p.41", excerpt: "0.264 (with brake)" },
        ],
      },
    },
    modelBindings: [
      {
        id: "servo-motor",
        modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
        compatiblePeerModels: ["ASD-B3-0421-L"],
        mappings: [
          { kind: "parameter", source: "rotorInertia", target: "rotorInertiaKgM2" },
          { kind: "parameter", source: "ratedTorque", target: "ratedTorqueNm" },
          { kind: "parameter", source: "peakTorque", target: "peakTorqueNm" },
          { kind: "parameter", source: "ratedPower", target: "ratedPowerW" },
          { kind: "parameter", source: "ratedSpeed", target: "ratedSpeedRpm" },
          { kind: "parameter", source: "maxSpeed", target: "maxSpeedRpm" },
          { kind: "parameter", source: "ratedCurrent", target: "motorRatedCurrentA" },
        ],
      },
    ],
  });
}

describe("统一模型注册表与通用设备绑定", () => {
  it("对齐全部 Modelica 清单与信号模型，拒绝未知模型版本降级", () => {
    expect(requireRegisteredModel({ id: servoLibrary.assembly.id, version: servoLibrary.version }).id).toBe("Gouyuan.ServoAxis");
    expect(requireRegisteredModel({ id: linearLibrary.assembly.id, version: linearLibrary.version }).id).toBe("GouyuanLinear.FeedAxis");
    expect(requireRegisteredModel({ id: motorLibrary.assembly.id, version: motorLibrary.version }).id).toBe("GouyuanMotor.CncFeedAxis");
    expect(requireRegisteredModel({ id: contourLibrary.assembly.id, version: contourLibrary.version }).id).toBe("GouyuanContour.TrackingAxis");
    for (const model of factoryLibrary.models) {
      expect(MODEL_REGISTRY.has(`${model.id}@${factoryLibrary.version}`)).toBe(true);
    }
    expect(() => requireRegisteredModel({ id: "Gouyuan.ServoAxis", version: "9.9.9" })).toThrow(/9\.9\.9/);
    expect(matchCompiledKernel({
      drive: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
      motor: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      screw: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      table: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
    })?.id).toBe("GouyuanLinear.FeedAxis");
  });

  it("既有设备包通过通用绑定视图零损投影且无需改动原存档", () => {
    const sv660 = parseDevicePackage(sv660Sample);
    const ms1h1 = parseDevicePackage(ms1h1Sample);
    const gl10 = parseDevicePackage(gl10Sample);
    const contourMotor = parseDevicePackage(contourMotorSample);
    const cncFeed = parseDevicePackage(cncFeedSample);
    const motorKitPackages = motorKitLib.packages.map(parseDevicePackage);
    const cncPackages = cncDeviceLib.packages.map(parseDevicePackage);

    for (const [pkg, deps] of [
      [sv660, []],
      [ms1h1, []],
      [gl10, []],
      [contourMotor, motorKitPackages],
      [cncFeed, cncPackages],
    ] as const) {
      const bindings = effectiveModelBindings(pkg);
      expect(bindings.length).toBeGreaterThan(0);
      const readiness = evaluateBindingReadiness(pkg, bindings[0].id, { workspacePackages: [...deps, pkg] });
      expect(readiness.status).toBe("ready");
    }
  });

  it("台达 ASDA-B3 纯通用绑定基准：阻断未决选件，确认后换算 0.0000254 并在 433 ms 收敛", async () => {
    const drive = deltaDrivePackage();
    const pendingMotor = deltaMotorPackagePending();
    expect(pendingMotor.servo).toBeUndefined();
    expect(drive.servo).toBeUndefined();

    // 1. 待确认选件态：评估返回 pending，运行被阻断并明确给出第 41 页待确认理由
    const pendingReadiness = evaluateBindingReadiness(pendingMotor, "servo-motor");
    expect(pendingReadiness.status).toBe("pending");
    expect(pendingReadiness.pendingParameters[0].key).toBe("rotorInertiaKgM2");
    expect(pendingReadiness.pendingParameters[0].candidates[0].convertedValue).toBe(0.0000254);

    const pendingWs = assembleServoAxis(
      installPackage(installPackage(emptyWorkspace(), drive), pendingMotor),
      { driveKey: packageKey(drive), motorKey: packageKey(pendingMotor), targetDeg: 90, loadInertiaRatio: 1, modelRef: MODELICA_SERVO_REF },
    );
    expect(() => simulateServoAxis({ ...pendingWs, servoAxis: { ...pendingWs.servoAxis!, modelRef: undefined } })).toThrow(/第 41 页.*无抱闸/);
    expect(() => bindModelicaServo(pendingWs)).toThrow(/第 41 页.*无抱闸/);

    // 2. 选定无抱闸候选后，自动换算并验证 433 ms 收敛与 Modelica WASM 求解
    const resolvedMotor = resolveParameterChoice(pendingMotor, "rotorInertia", 0, "ASDA-B3-20240703-R");
    const readyReadiness = evaluateBindingReadiness(resolvedMotor, "servo-motor");
    expect(readyReadiness.status).toBe("ready");
    expect(readyReadiness.values).toMatchObject({
      rotorInertiaKgM2: 0.0000254,
      ratedPowerW: 400,
      ratedTorqueNm: 1.27,
      ratedSpeedRpm: 3000,
      motorRatedCurrentA: 2.4,
    });

    const readyWs = parseWorkspace(JSON.parse(JSON.stringify(assembleServoAxis(
      installPackage(installPackage(emptyWorkspace(), drive), resolvedMotor),
      { driveKey: packageKey(drive), motorKey: packageKey(resolvedMotor), targetDeg: 90, loadInertiaRatio: 1, modelRef: MODELICA_SERVO_REF },
    ))));
    const bound = bindModelicaServo(readyWs);
    expect(bound).toEqual({
      targetDeg: 90,
      loadInertiaRatio: 1,
      rotorInertiaKgM2: 0.0000254,
      ratedTorqueNm: 1.27,
      ratedPowerW: 400,
      ratedSpeedRpm: 3000,
      driveRatedCurrentA: 2.65,
      motorRatedCurrentA: 2.4,
    });

    const legacyResult = simulateServoAxis({ ...readyWs, servoAxis: { ...readyWs.servoAxis!, modelRef: undefined } });
    expect(legacyResult.settled).toBe(true);
    expect(legacyResult.samples.at(-1)?.timeMs).toBe(433);

    const runServo = await loadServoRuntime();
    const modelicaResult = await runServo(bound);
    expect(modelicaResult.settled).toBe(true);
    expect(modelicaResult.samples.at(-1)?.timeMs).toBeGreaterThan(400);

    // 3. 搭配纯 modelBindings 丝杠和滑台运行直线进给轴 WASM
    const screw = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "THK",
      model: "BNK1405-demo",
      revision: "1",
      source: { kind: "local", url: "", title: "丝杠测试件", locator: "5 mm/rev", excerpt: "导程 5 mm/rev" },
      ports: [],
      rules: [],
      parameters: { lead: { status: "catalog", value: 5, unit: "mm/rev" } },
      modelBindings: [{
        id: "screw",
        modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
        mappings: [{ kind: "parameter", source: "lead", target: "leadMmPerRev" }],
      }],
    });
    const table = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "试验平台",
      model: "TABLE-5KG",
      revision: "1",
      source: { kind: "local", url: "", title: "滑台质量件", locator: "5 kg", excerpt: "总质量 5000 g" },
      ports: [],
      rules: [],
      parameters: { mass: { status: "catalog", value: 5000, unit: "g" } },
      modelBindings: [{
        id: "table",
        modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" },
        mappings: [{ kind: "parameter", source: "mass", target: "massKg" }],
      }],
    });
    const feedWs = upsertLinearAssembly({
      ...emptyWorkspace(),
      packages: [drive, resolvedMotor, screw, table],
      catalog: {
        models: [],
        materials: [
          { id: "D", name: "台达驱动", quantity: 1, binding: { kind: "device", key: packageKey(drive) } },
          { id: "M", name: "台达电机", quantity: 1, binding: { kind: "device", key: packageKey(resolvedMotor) } },
          { id: "S", name: "5 mm 丝杠", quantity: 1, binding: { kind: "device", key: packageKey(screw) } },
          { id: "T", name: "5 kg 滑台", quantity: 1, binding: { kind: "device", key: packageKey(table) } },
        ],
      },
    }, parseLinearAssembly({
      schemaVersion: 1,
      kind: "linear-axis-assembly",
      id: "delta-feed",
      name: "台达送料轴",
      modelRef: { id: "GouyuanLinear.FeedAxis", version: "1.0.0" },
      modules: [{ id: "m1", drive: "D", motor: "M", screw: "S", table: "T", leadMmPerRev: null }],
      axes: [{ id: "x", module: "m1", direction: [1, 0, 0], targetMm: 10 }],
    }));
    const runFeed = await loadFeedRuntime();
    const feedResult = await runFeed(feedWs, feedWs.assemblies![0]);
    expect(feedResult.settled).toBe(true);
    expect(feedResult.samples.at(-1)?.positionMm[0]).toBeCloseTo(10, 1);

    // 4. 缺参数按问题分级：保留几何能力，精准指出动力学缺项及单位
    const { rotorInertia: _omitted, ...withoutInertia } = resolvedMotor.parameters!;
    void _omitted;
    const geometryOnly = parseDevicePackage({
      ...resolvedMotor,
      revision: "no-inertia",
      parameters: withoutInertia,
      mechanics: {
        kind: "part",
        input: { positionMm: [0, 0, 0], quatWxyz: [1, 0, 0, 0] },
        joint: { type: "hinge", unit: "deg", axis: [0, 0, 1], range: [-360, 360] },
        outputs: [{ id: "shaft", positionMm: [0, 0, 40], quatWxyz: [1, 0, 0, 0] }],
      },
    });
    const capReport = capabilitiesForDevice(geometryOnly);
    expect(capReport.geometryAvailable).toBe(true);
    expect(capReport.availableTiers).toContain("geometry");
    expect(capReport.availableTiers).not.toContain("dynamics");
    expect(capReport.capabilities[0].missingParameters[0]).toMatchObject({
      key: "rotorInertiaKgM2",
      unit: "kg.m2",
      affectedTier: "dynamics",
    });
  });

  it("支持真机双驱反向极性映射与常闭接近开关传感器参数校验", () => {
    const mirroredMotor = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "Delta Electronics",
      model: "ASD-B2-Y1",
      revision: "1",
      source: { kind: "local", url: "", title: "7i95t_xyz2.ini", locator: "JOINT_1", excerpt: "ENCODER_SCALE = -10000" },
      ports: [],
      rules: [],
      parameters: {
        lead: { status: "catalog", value: 5, unit: "mm/rev" },
      },
      modelBindings: [{
        id: "mirrored-screw",
        modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
        mappings: [{ kind: "parameter", source: "lead", target: "leadMmPerRev", factor: -1 }],
      }],
    });
    const mirroredReadiness = evaluateBindingReadiness(mirroredMotor, "mirrored-screw");
    expect(mirroredReadiness.status).toBe("incomplete");
    expect(mirroredReadiness.missingParameters[0].reason).toMatch(/大于 0/);

    const encoderRatio = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "Delta Electronics",
      model: "Y1-AXIS-SCALE",
      revision: "1",
      source: { kind: "local", url: "", title: "7i95t_xyz2.ini", locator: "JOINT_1", excerpt: "ENCODER_SCALE = -10000" },
      ports: [],
      rules: [],
      parameters: {
        triggerPos: { status: "catalog", value: 500, unit: "mm" },
      },
      modelBindings: [{
        id: "mirrored-limit",
        modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" },
        mappings: [{ kind: "parameter", source: "triggerPos", target: "triggerPositionMm", factor: -1 }],
      }],
    });
    expect(evaluateBindingReadiness(encoderRatio, "mirrored-limit").values.triggerPositionMm).toBe(-500);

    const proximitySwitch = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "Generic",
      model: "LJ12A3-4-Z/AY",
      revision: "1",
      source: { kind: "local", url: "", title: "mesa_7i95t_config README", locator: "Hardware used", excerpt: "LJ12A3-4-Z/AY proximity switch (PNP NC 4mm 6-36VDC)" },
      ports: [],
      rules: [],
      parameters: {
        senseDist: { status: "catalog", value: 4, unit: "mm" },
        supplyV: { status: "assumed", value: 24, unit: "VDC" },
        nc: { status: "catalog", value: true },
      },
      modelBindings: [{
        id: "limit-switch",
        modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" },
        mappings: [
          { kind: "parameter", source: "senseDist", target: "senseDistanceMm" },
          { kind: "parameter", source: "supplyV", target: "supplyVoltageV" },
          { kind: "parameter", source: "nc", target: "normallyClosed" },
        ],
      }],
    });
    const switchReadiness = evaluateBindingReadiness(proximitySwitch, "limit-switch");
    expect(switchReadiness.status).toBe("ready_with_assumptions");
    expect(switchReadiness.values).toMatchObject({
      senseDistanceMm: 4,
      supplyVoltageV: 24,
      normallyClosed: true,
    });
  });
});
