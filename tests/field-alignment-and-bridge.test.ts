import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyFieldCalibrationRevision,
  compareRuntimeWithFieldTrace,
  evaluateSystemVerificationStatus,
  parseFieldTraceCsv,
  parseOpenPnpStepTrace,
} from "../contracts/field-alignment";
import { convertProjectToTwinWorkspace } from "../contracts/project-to-twin";
import { draftSystemFromWorkspace } from "../contracts/system-draft";
import { requireReadySystem } from "../contracts/system-twin";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { integrateSystemTwin } from "../src/lib/system-twin-runtime";
import { COMPONENT_SEED } from "../db/component-seed";

const readAsset = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url));
const trackingWasm = new WebAssembly.Module(Uint8Array.from(readAsset("public/modelica/runtime/feed-tracking-axis.wasm")));

const drive = JSON.parse(readAsset("examples/SV660NS2R8I-FS-INT.device.json").toString("utf8"));
const motor = JSON.parse(readAsset("examples/MS1H1-40B30CB-A331R-INT.device.json").toString("utf8"));
const gl10 = JSON.parse(readAsset("examples/GL10-1600END-A03.device.json").toString("utf8"));
const screw5 = JSON.parse(readAsset("public/assemblies/feed-axis/screw-5.device.json").toString("utf8"));
const table5 = JSON.parse(readAsset("public/assemblies/feed-axis/table-5.device.json").toString("utf8"));

const baseWs = parseWorkspace(
  [drive, motor, gl10, screw5, table5].reduce(installPackage, emptyWorkspace()),
);

describe("Milestone 4 · 实机录波对标、版本化标定与早期选型项目桥接", () => {
  it("支持多单位 CSV 与 OpenPnP step XML 录波映射，未接实测明确停留在离线仿真态", () => {
    const offStatus = evaluateSystemVerificationStatus();
    expect(offStatus.status).toBe("offline_simulation_only");
    expect(offStatus.passed).toBe(false);
    expect(offStatus.label).toContain("待实测对标");

    const csv = [
      "t_s,pos_um,vel_mms,lim_sw",
      "0.000,1000,0,0",
      "0.100,-3000,-40,0",
      "0.250,-11000,-40,1",
    ].join("\n");
    const parsed = parseFieldTraceCsv(
      csv,
      {
        timeColumn: "t_s",
        timeUnit: "s",
        positionColumn: "pos_um",
        positionUnit: "um",
        velocityColumn: "vel_mms",
        velocityUnit: "mm/s",
        limitSignalColumn: "lim_sw",
        positionZeroOffsetMm: 1,
        polarityFactor: -1,
      },
      { id: "meas-1", label: "单位与极性测试", axisId: "axis-0", profileRole: "primary_calibration" },
    );
    expect(parsed.samples.map((s) => s.timeMs)).toEqual([0, 100, 250]);
    expect(parsed.samples.map((s) => s.positionMm)).toEqual([0, 4, 12]);
    expect(parsed.samples[2].limitTriggered).toBe(true);

    const openPnpXml = `<openpnp-test>
      <data-point time="0.00" value="0.0"/>
      <data-point time="0.10" value="8.5"/>
      <data-point time="0.20" value="16.2"/>
    </openpnp-test>`;
    const pnpParsed = parseOpenPnpStepTrace(openPnpXml, {
      id: "lumen-step",
      label: "LumenPnP 阶跃样本",
      axisId: "axis-x",
    });
    expect(pnpParsed.samples).toHaveLength(3);
    expect(pnpParsed.samples[1].timeMs).toBe(100);
    expect(pnpParsed.samples[2].positionMm).toBe(16.2);
  });

  it("实测偏差超差 -> 保存版本化 measured 标定修订 -> 同工况对标通过 -> 独立第二工况复验通过", () => {
    const sysInit = draftSystemFromWorkspace(baseWs, {
      id: "calib-sys",
      name: "待实测标定送料轴",
      defaultTriggerPositionMm: 16,
      defaultTargetMm: 35,
      defaultCruiseVelocityMmS: 80,
      durationMs: 600,
    });
    const axisId = sysInit.axes[0].id;

    // 假设现场实测开关装在 13.5 mm、滑台实重 6.5 kg（与草案 16 mm 有显著偏差）
    const truePhysicalSys = {
      ...sysInit,
      axes: [{ ...sysInit.axes[0], overrideTableMassKg: 6.5 }],
      sensors: [{ ...sysInit.sensors[0], triggerPositionMm: 13.5 }],
    };
    const measTrace = integrateSystemTwin(requireReadySystem(baseWs, truePhysicalSys), trackingWasm);
    const measCsv = [
      "timeMs,positionMm,velocityMmS,limitTriggered",
      ...measTrace.frames
        .filter((_, i) => i % 5 === 0 || i === measTrace.frames.length - 1)
        .map((f) => {
          const a = f.axes[axisId];
          return `${f.timeMs},${a.positionMm.toFixed(6)},${a.velocityMmS.toFixed(4)},${a.stopLatched ? 1 : 0}`;
        }),
    ].join("\n");
    const measDataset = parseFieldTraceCsv(
      measCsv,
      { timeColumn: "timeMs", timeUnit: "ms", positionColumn: "positionMm", positionUnit: "mm", velocityColumn: "velocityMmS", velocityUnit: "mm/s", limitSignalColumn: "limitTriggered" },
      { id: "meas-primary", label: "现场首次实测", axisId, profileRole: "primary_calibration" },
    );

    // 1. 先跑未标定名义仿真，应当判为实测偏差超差
    const simBefore = integrateSystemTwin(requireReadySystem(baseWs, sysInit), trackingWasm);
    const beforeCompare = compareRuntimeWithFieldTrace(simBefore, measDataset);
    expect(beforeCompare.withinTolerance).toBe(false);
    expect(evaluateSystemVerificationStatus(beforeCompare).status).toBe("deviation_exceeded");

    // 2. 应用版本化标定（原 table5 设备包不准改写，新增 cal-v1 measured 修订 + 绑定资产序列号）
    const originalTableKey = sysInit.axes[0].tableKey;
    const calibrated = applyFieldCalibrationRevision(baseWs, sysInit, {
      axisId,
      serialNumber: "ASSET-XZ-2026-009",
      calibrationVersion: "cal-v1",
      measuredTableMassKg: 6.5,
      measuredTriggerPositionMm: 13.5,
      note: "现场称重 6.5 kg 且实测限位触发位于 13.5 mm",
    });
    expect(calibrated.workspace.packages.length).toBe(baseWs.packages.length + 1);
    const newTablePkg = calibrated.workspace.packages.find((p) => packageKey(p) === calibrated.system.axes[0].tableKey)!;
    expect(packageKey(newTablePkg)).not.toBe(originalTableKey);
    expect(newTablePkg.parameters?.massKg?.status).toBe("measured");
    expect(calibrated.system.assetBindings?.[0].serialNumber).toBe("ASSET-XZ-2026-009");

    // 验证持久化往返与首段工况对标通过（仍提示待第二工况复验）
    const savedCalWs = parseWorkspace(JSON.parse(JSON.stringify(calibrated.workspace)));
    const simAfter = integrateSystemTwin(requireReadySystem(savedCalWs, calibrated.system), trackingWasm);
    const afterCompare = compareRuntimeWithFieldTrace(simAfter, measDataset);
    expect(afterCompare.withinTolerance).toBe(true);
    expect(afterCompare.rmsPositionErrorMm).toBeLessThan(0.01);
    expect(evaluateSystemVerificationStatus(afterCompare).status).toBe("primary_aligned_pending_reverify");

    // 3. 用另一组独立工况（更低巡航速度 50 mm/s）做盲测交叉复验 -> field_verified
    const secondProfileSys = {
      ...calibrated.system,
      controllers: [{ ...calibrated.system.controllers[0], cruiseVelocityMmS: 50 }],
    };
    const simReverify = integrateSystemTwin(requireReadySystem(savedCalWs, secondProfileSys), trackingWasm);
    const measReverifyTrace = integrateSystemTwin(
      requireReadySystem(baseWs, { ...truePhysicalSys, controllers: [{ ...truePhysicalSys.controllers[0], cruiseVelocityMmS: 50 }] }),
      trackingWasm,
    );
    const reverifyCsv = [
      "timeMs,positionMm,limitTriggered",
      ...measReverifyTrace.frames.filter((_, i) => i % 5 === 0).map((f) => `${f.timeMs},${f.axes[axisId].positionMm.toFixed(6)},${f.axes[axisId].stopLatched ? 1 : 0}`),
    ].join("\n");
    const reverifyDataset = parseFieldTraceCsv(
      reverifyCsv,
      { timeColumn: "timeMs", timeUnit: "ms", positionColumn: "positionMm", positionUnit: "mm", limitSignalColumn: "limitTriggered" },
      { id: "meas-reverify", label: "第二速度工况复验", axisId, profileRole: "independent_reverify" },
    );
    const reverifyCompare = compareRuntimeWithFieldTrace(simReverify, reverifyDataset);
    const finalStatus = evaluateSystemVerificationStatus(afterCompare, reverifyCompare);
    expect(finalStatus.status).toBe("field_verified");
    expect(finalStatus.passed).toBe(true);
  });

  it("将客户试点项目直线轴与 COMPONENT_SEED 官方部件修订一键转为可仿真孪生工作区", () => {
    const panasonicIdx = COMPONENT_SEED.findIndex((r) => r.model === "MSMF012L1T1");
    const deltaIdx = COMPONENT_SEED.findIndex((r) => r.model.startsWith("ECMA-C"));
    const hiwinIdx = COMPONENT_SEED.findIndex((r) => r.model === "Super S 系列");
    expect(panasonicIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(hiwinIdx).toBeGreaterThanOrEqual(0);

    const revisions = [panasonicIdx, deltaIdx, hiwinIdx].map((idx) => {
      const seed = COMPONENT_SEED[idx];
      return {
        id: idx + 1,
        manufacturer: seed.manufacturer,
        model: seed.model,
        category: seed.category,
        revisionLabel: seed.revisionLabel,
        sourceTitle: seed.sourceTitle,
        sourceUrl: seed.sourceUrl,
        sourceVersion: seed.sourceVersion,
        sourceLocator: seed.sourceLocator,
        sourceEvidence: seed.sourceEvidence,
        parameters: seed.parameters,
      };
    });

    // 场景 A：选用完整型号级 Panasonic MSMF012L1T1 的直线轴项目
    const resPanasonic = convertProjectToTwinWorkspace({
      projectCode: "PRJ-PANA-01",
      projectName: "松下电机直线送料项目",
      componentRevisions: revisions,
      modules: [
        {
          id: 11,
          moduleKey: "linear_axis",
          instanceName: "送料 X 轴",
          configuration: {
            travelMm: 45,
            movingMassKg: 4,
            maxSpeedMmS: 100,
            accelerationMmS2: 800,
            leadMm: 5,
            efficiency: 0.9,
            safetyFactor: 1.5,
            inclineDeg: 0,
            frictionCoefficient: 0.01,
            dutyCycle: 0.6,
          },
          selectedComponentRevisionIds: { servo_motor: panasonicIdx + 1 },
        },
      ],
    });
    expect(resPanasonic.convertedPackages).toBe(2);
    expect(resPanasonic.primaryTarget).toBe("system:proj-prj-pana-01");
    expect(resPanasonic.assumedRoles).toContain("送料 X 轴 · 伺服驱动器");
    const panaSys = resPanasonic.workspace.systems![0];
    const simPana = integrateSystemTwin(requireReadySystem(resPanasonic.workspace, panaSys), trackingWasm);
    expect(simPana.axisSummaries[0].finalPositionMm).toBeGreaterThan(35);

    // 场景 B：选用带通配符订货字符的台达型号及系列级 HIWIN 丝杠时，捕获具体诊断且不静默篡改目录事实
    const resAmbiguous = convertProjectToTwinWorkspace({
      projectCode: "PRJ-AMB-02",
      projectName: "歧义部件检测项目",
      componentRevisions: revisions,
      modules: [
        {
          id: 12,
          moduleKey: "linear_axis",
          instanceName: "歧义测试轴",
          configuration: {
            travelMm: 45,
            movingMassKg: 4,
            maxSpeedMmS: 100,
            accelerationMmS2: 800,
            leadMm: 5,
            efficiency: 0.9,
            safetyFactor: 1.5,
            inclineDeg: 0,
            frictionCoefficient: 0.01,
            dutyCycle: 0.6,
          },
          selectedComponentRevisionIds: {
            servo_motor: deltaIdx + 1,
            ball_screw: hiwinIdx + 1,
          },
        },
      ],
    });
    expect(resAmbiguous.pendingDiagnostics.some((d) => d.includes("ECMA-C") && d.includes("完整型号"))).toBe(true);
    expect(resAmbiguous.pendingDiagnostics.some((d) => d.includes("丝杠导程"))).toBe(true);
  });
});
