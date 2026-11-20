import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilitiesForDevice } from "../contracts/device-model-binding";
import {
  applyFieldCalibrationRevision,
  compareRuntimeWithFieldTrace,
  evaluateSystemVerificationStatus,
  parseFieldTraceCsv,
} from "../contracts/field-alignment";
import { verifyAndBuildExtractedDevice } from "../contracts/model-extraction";
import { buildSourceArtifact } from "../contracts/source-artifact";
import { draftSystemFromWorkspace } from "../contracts/system-draft";
import {
  appendSubsystemInstance,
  confirmSystemProvenance,
  packageAxisAsSubsystem,
  parseTwinSystemAssembly,
  requireReadySystem,
} from "../contracts/system-twin";
import { packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { buildClosedLoopModelicaPackage } from "../src/lib/system-twin-export";
import { integrateSystemTwin } from "../src/lib/system-twin-runtime";

const readAsset = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url));
const trackingWasm = new WebAssembly.Module(Uint8Array.from(readAsset("public/modelica/runtime/feed-tracking-axis.wasm")));

describe("Milestone 4 · 第三方陌生品牌设备零硬编码全链路盲测验收", () => {
  it("平台核心契约与求解代码中不含任何厂商型号专属解析分支或写死型号字符串", () => {
    const coreFiles = [
      "contracts/units.ts",
      "contracts/model-registry.ts",
      "contracts/device-model-binding.ts",
      "contracts/source-artifact.ts",
      "contracts/model-extraction.ts",
      "contracts/system-twin.ts",
      "contracts/system-draft.ts",
      "contracts/field-alignment.ts",
      "contracts/project-to-twin.ts",
      "src/lib/system-twin-runtime.ts",
      "src/lib/system-twin-export.ts",
    ];
    const forbiddenVendorModels = [
      "MSMF012L1T1",
      "MADLN05SE",
      "BNK1005",
      "BNK1010",
      "E2E-X4B2L12",
      "NX-ID5442",
      "ASD-B3",
      "ECM-B3M",
      "SV660N",
      "MS1H1",
      "GL10-1600END",
    ];
    for (const rel of coreFiles) {
      const src = readFileSync(new URL("../" + rel, import.meta.url), "utf8");
      for (const token of forbiddenVendorModels) {
        // 允许文档或注释之外的程序分支零出现这些品牌型号；甚至注释里我们也检查是否被当成逻辑常量
        expect(src.includes(`"${token}"`)).toBe(false);
      }
    }
  });

  it("用 Panasonic + THK + Omron 陌生资料完成从提取校验、缺参分级、闭环换件、子系统复用到双工况实测验收", () => {
    // 1. 准备第三厂商（Panasonic / THK / Omron）原始手册分页文本工件
    const panasonicMotorText = [
      "MINAS A6 Series Servo Motor Specifications - Model MSMF012L1T1",
      "Rated output: 100 W | Rated torque: 0.32 N·m | Rated speed: 3000 r/min",
      "Rotor inertia: 0.051 ×10^-4 kg·m² | Rated current: 1.1 A",
      "Matched driver: MADLN05SE",
    ].join("\n");
    const motorArtifact = buildSourceArtifact({
      sha256: "b".repeat(64),
      format: "pdf",
      title: "Panasonic MINAS A6 MSMF012L1T1 Datasheet",
      sourceUrl: "https://industry.panasonic.com/global/en/products/motor/fa-motor/ac-servo/number/msmf012l1t1",
      rawText: panasonicMotorText,
    });

    const motorExtraction = verifyAndBuildExtractedDevice(
      {
        manufacturer: "Panasonic Industry",
        model: "MSMF012L1T1",
        revision: "blind-1",
        modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
        compatiblePeerModels: ["MADLN05SE"],
        artifact: {
          sha256: motorArtifact.sha256,
          title: motorArtifact.title,
          sourceUrl: motorArtifact.sourceUrl,
          pages: [...motorArtifact.pages],
          text: motorArtifact.text,
        },
      },
      {
        fields: {
          ratedPowerW: { status: "confirmed", value: 100, rawUnit: "W", page: 1, excerpt: "Rated output: 100 W" },
          ratedTorqueNm: { status: "confirmed", value: 0.32, rawUnit: "N·m", page: 1, excerpt: "Rated torque: 0.32 N·m" },
          ratedSpeedRpm: { status: "confirmed", value: 3000, rawUnit: "r/min", page: 1, excerpt: "Rated speed: 3000 r/min" },
          rotorInertiaKgM2: { status: "confirmed", value: 0.051, rawUnit: "10^-4 kg.m2", page: 1, excerpt: "Rotor inertia: 0.051 ×10^-4 kg·m²" },
          motorRatedCurrentA: { status: "confirmed", value: 1.1, rawUnit: "A", page: 1, excerpt: "Rated current: 1.1 A" },
        },
        compatiblePeerModels: { models: ["MADLN05SE"], page: 1, excerpt: "Matched driver: MADLN05SE" },
      },
    );
    expect(motorExtraction.readiness.status).toBe("ready");
    expect(motorExtraction.readiness.values.rotorInertiaKgM2).toBeCloseTo(0.0000051, 10);

    const driveArtifactText = "MADLN05SE Servo Driver Rated output current: 1.4 Arms | Peak current: 4.5 Arms";
    const driveExtraction = verifyAndBuildExtractedDevice(
      {
        manufacturer: "Panasonic Industry",
        model: "MADLN05SE",
        revision: "blind-1",
        modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
        artifact: {
          title: "Panasonic MADLN05SE Datasheet",
          sourceUrl: "https://industry.panasonic.com/global/en/products/motor/fa-motor/ac-servo/madln05se",
          text: driveArtifactText,
        },
      },
      {
        fields: {
          driveRatedCurrentA: { status: "confirmed", value: 1.4, rawUnit: "Arms", tableLocation: "Spec Row 1", excerpt: "Rated output current: 1.4 Arms" },
          drivePeakCurrentA: { status: "confirmed", value: 4.5, rawUnit: "Arms", tableLocation: "Spec Row 1", excerpt: "Peak current: 4.5 Arms" },
        },
      },
    );

    const thkText5 = "THK BNK1005-3RRG0+300LC5 Lead: 5 mm/rev";
    const screw5 = verifyAndBuildExtractedDevice(
      {
        manufacturer: "THK",
        model: "BNK1005",
        revision: "blind-1",
        modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
        artifact: { title: "THK BNK Catalog", sourceUrl: "https://tech.thk.com/bnk1005.pdf", text: thkText5 },
      },
      { fields: { leadMmPerRev: { status: "confirmed", value: 5, rawUnit: "mm/rev", excerpt: "Lead: 5 mm/rev" } } },
    ).device;

    const screw10 = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "THK",
      model: "BNK1010",
      revision: "blind-1",
      source: { kind: "local", url: "", title: "THK BNK1010", locator: "p.12", excerpt: "Lead 10 mm/rev" },
      ports: [],
      rules: [],
      parameters: { leadMmPerRev: { status: "catalog", value: 10, unit: "mm/rev", label: "导程", locator: "p.12" } },
      modelBindings: [{ id: "b-screw", modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" }, mappings: [{ kind: "parameter", source: "leadMmPerRev", target: "leadMmPerRev" }] }],
    });

    const tablePkg = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "Custom Stage",
      model: "PG-SLIDE-08",
      revision: "blind-1",
      source: { kind: "local", url: "", title: "Stage CAD", locator: "BOM", excerpt: "Moving mass 0.8 kg" },
      ports: [],
      rules: [],
      parameters: { massKg: { status: "catalog", value: 0.8, unit: "kg", label: "滑台质量", locator: "BOM" } },
      modelBindings: [{ id: "b-table", modelRef: { id: "Modelica.Mechanics.Translational.Components.Mass", version: "4.0.0" }, mappings: [{ kind: "parameter", source: "massKg", target: "massKg" }] }],
    });

    const omronDi = verifyAndBuildExtractedDevice(
      {
        manufacturer: "Omron",
        model: "NX-ID5442",
        revision: "blind-1",
        modelRef: { id: "GouyuanSignal.DigitalInputChannel", version: "1.0.0" },
        artifact: {
          title: "Omron NX-ID5442 Manual",
          sourceUrl: "https://assets.omron.eu/downloads/nx-id5442.pdf",
          text: "ON voltage: 15 VDC min\nOFF voltage: 5 VDC max\nInput filter time: 8 ms",
        },
      },
      {
        fields: {
          onAbove: { status: "confirmed", value: 15, rawUnit: "VDC", excerpt: "ON voltage: 15 VDC min" },
          offBelow: { status: "confirmed", value: 5, rawUnit: "VDC", excerpt: "OFF voltage: 5 VDC max" },
          filterMs: { status: "confirmed", value: 8, rawUnit: "ms", excerpt: "Input filter time: 8 ms" },
        },
      },
    ).device;

    const omronLimit = parseDevicePackage({
      schemaVersion: 1,
      manufacturer: "Omron",
      model: "E2E-X4B2L12",
      revision: "blind-1",
      source: { kind: "local", url: "", title: "Omron E2E", locator: "p.4", excerpt: "Sensing distance 4 mm PNP NC 24 VDC" },
      ports: [],
      rules: [],
      parameters: {
        senseDistanceMm: { status: "catalog", value: 4, unit: "mm", label: "感应距离", locator: "p.4" },
        supplyVoltageV: { status: "catalog", value: 24, unit: "V", label: "供电电压", locator: "p.4" },
        normallyClosed: { status: "catalog", value: true, unit: "1", label: "NC 常闭", locator: "p.4" },
      },
      modelBindings: [{ id: "b-sw", modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" }, mappings: [{ kind: "parameter", source: "senseDistanceMm", target: "senseDistanceMm" }, { kind: "parameter", source: "supplyVoltageV", target: "supplyVoltageV" }, { kind: "parameter", source: "normallyClosed", target: "normallyClosed" }] }],
    });

    // 2. 缺资料分级降级检查：若故意省略电机惯量，动力学明确受阻但不破坏其他部件能力识别
    const partialMotor = parseDevicePackage({
      ...motorExtraction.device,
      revision: "missing-inertia",
      parameters: Object.fromEntries(Object.entries(motorExtraction.device.parameters ?? {}).filter(([k]) => k !== "rotorInertiaKgM2")),
    });
    const capPartialMotor = capabilitiesForDevice(partialMotor);
    expect(capPartialMotor.availableTiers).toEqual([]);
    expect(capPartialMotor.blockedReasons.some((r) => r.includes("rotorInertiaKgM2"))).toBe(true);
    expect(capabilitiesForDevice(screw5).availableTiers).toContain("kinematics");

    // 3. 组合成可运行闭环系统：未填 triggerPositionMm 时拦截，补齐确认后运行
    const ws = parseWorkspace(
      [driveExtraction.device, motorExtraction.device, screw5, screw10, tablePkg, omronDi, omronLimit].reduce(
        installPackage,
        emptyWorkspace(),
      ),
    );
    const pendingDraft = draftSystemFromWorkspace(ws, {
      id: "blind-feed-x",
      name: "松下+THK+欧姆龙盲测送料轴",
      defaultTargetMm: 30,
      defaultCruiseVelocityMmS: 70,
      durationMs: 600,
    });
    expect(() => requireReadySystem(ws, pendingDraft)).toThrow(/triggerPositionMm/);

    const readySingle = confirmSystemProvenance({
      ...pendingDraft,
      axes: [{ ...pendingDraft.axes[0], screwKey: packageKey(screw5), provenance: "confirmed" }],
      sensors: [{ ...pendingDraft.sensors[0], triggerPositionMm: 14 }],
    });
    const trace5 = integrateSystemTwin(requireReadySystem(ws, readySingle), trackingWasm);
    expect(trace5.axisSummaries[0].stopTriggeredAtMs).toBeGreaterThan(150);

    // 4. 换件（导程 5 -> 10 mm/rev）与改参（DI 8 ms -> 2 ms）可观察变化
    const sys10 = {
      ...readySingle,
      axes: [{ ...readySingle.axes[0], screwKey: packageKey(screw10) }],
      diChannels: [{ ...readySingle.diChannels[0], filterMs: 2 }],
    };
    const trace10 = integrateSystemTwin(requireReadySystem(ws, sys10), trackingWasm);
    expect(trace10.axisSummaries[0].stopTriggeredAtMs!).toBeLessThan(trace5.axisSummaries[0].stopTriggeredAtMs!);
    expect(trace10.axisSummaries[0].peakTorqueNm).not.toBeCloseTo(trace5.axisSummaries[0].peakTorqueNm, 2);

    // 5. 复用子系统接入双轴正交机器，并导出可独立的 Modelica .mo 验证源码
    const tpl = packageAxisAsSubsystem(readySingle, readySingle.axes[0].id);
    const xySys = parseTwinSystemAssembly({
      ...appendSubsystemInstance(readySingle, tpl, {
        axisId: "axis-y-reused",
        axisName: "Y 轴复用单元",
        direction: [0, 1, 0],
        factor: -1,
        targetMm: -30,
        triggerPositionMm: -14,
      }),
      sensors: [
        readySingle.sensors[0],
        {
          ...readySingle.sensors[0],
          id: "axis-y-reused-sw-1",
          name: "Y 轴限位",
          axisId: "axis-y-reused",
          triggerPositionMm: -14,
          triggerMode: "negative_overtravel",
        },
      ],
    });
    const xyTrace = integrateSystemTwin(requireReadySystem(ws, xySys), trackingWasm);
    expect(xyTrace.frames[xyTrace.frames.length - 1].tipPoseMm[0]).toBeGreaterThan(14);
    expect(xyTrace.frames[xyTrace.frames.length - 1].tipPoseMm[1]).toBeLessThan(-14);
    expect(buildClosedLoopModelicaPackage(ws, xySys).modelMo).toContain("GouyuanFeedTracking.TrackingFeedAxis axis_1");

    // 6. 实机资产绑定 + 双工况实测录波对标与标定
    const axisId = readySingle.axes[0].id;
    const cal = applyFieldCalibrationRevision(ws, readySingle, {
      axisId,
      serialNumber: "BLIND-SN-042",
      calibrationVersion: "rev-m1",
      measuredTableMassKg: 0.9,
      note: "盲测台实测质量 0.9 kg",
    });
    const meas1 = integrateSystemTwin(requireReadySystem(cal.workspace, cal.system), trackingWasm);
    const meas2 = integrateSystemTwin(
      requireReadySystem(cal.workspace, { ...cal.system, controllers: [{ ...cal.system.controllers[0], cruiseVelocityMmS: 45 }] }),
      trackingWasm,
    );
    const csvOf = (tr: typeof meas1, id: string, role: "primary_calibration" | "independent_reverify") =>
      parseFieldTraceCsv(
        [
          "timeMs,positionMm,limitTriggered",
          ...tr.frames.filter((_, i) => i % 5 === 0).map((f) => `${f.timeMs},${f.axes[id].positionMm.toFixed(6)},${f.axes[id].stopLatched ? 1 : 0}`),
        ].join("\n"),
        { timeColumn: "timeMs", timeUnit: "ms", positionColumn: "positionMm", positionUnit: "mm", limitSignalColumn: "limitTriggered" },
        { id: role, label: role, axisId, profileRole: role },
      );

    const sim1 = integrateSystemTwin(requireReadySystem(cal.workspace, cal.system), trackingWasm);
    const sim2 = integrateSystemTwin(
      requireReadySystem(cal.workspace, { ...cal.system, controllers: [{ ...cal.system.controllers[0], cruiseVelocityMmS: 45 }] }),
      trackingWasm,
    );
    const verStatus = evaluateSystemVerificationStatus(
      compareRuntimeWithFieldTrace(sim1, csvOf(meas1, axisId, "primary_calibration")),
      compareRuntimeWithFieldTrace(sim2, csvOf(meas2, axisId, "independent_reverify")),
    );
    expect(verStatus.status).toBe("field_verified");
    expect(verStatus.passed).toBe(true);
  });
});
