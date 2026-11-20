import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEED_TRACKING_KERNEL_REF, requireRegisteredModel } from "../contracts/model-registry";
import { getWorkbenchTargets, readStudioRoute, studioHref } from "../contracts/studio-navigation";
import { draftSystemFromWorkspace, parseLinuxCncConfig } from "../contracts/system-draft";
import {
  appendSubsystemInstance,
  confirmSystemProvenance,
  evaluateSystemReadiness,
  packageAxisAsSubsystem,
  parseTwinSystemAssembly,
  requireReadySystem,
  runtimeTraceToCsv,
  upsertTwinSystem,
} from "../contracts/system-twin";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../contracts/twin-simulation";
import { buildClosedLoopModelicaPackage } from "../src/lib/system-twin-export";
import { integrateSystemTwin } from "../src/lib/system-twin-runtime";
import feedTrackingManifest from "../public/modelica/runtime/feed-tracking-axis.json";
import feedManifest from "../public/modelica/runtime/feed-axis.json";

const readAsset = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const drive = JSON.parse(readAsset("examples/SV660NS2R8I-FS-INT.device.json").toString("utf8"));
const motor = JSON.parse(readAsset("examples/MS1H1-40B30CB-A331R-INT.device.json").toString("utf8"));
const gl10 = JSON.parse(readAsset("examples/GL10-1600END-A03.device.json").toString("utf8"));
const screw5 = JSON.parse(readAsset("public/assemblies/feed-axis/screw-5.device.json").toString("utf8"));
const screw10 = JSON.parse(readAsset("public/assemblies/feed-axis/screw-10.device.json").toString("utf8"));
const table5 = JSON.parse(readAsset("public/assemblies/feed-axis/table-5.device.json").toString("utf8"));

const trackingWasmBytes = readAsset("public/modelica/runtime/feed-tracking-axis.wasm");
const feedWasmBytes = readAsset("public/modelica/runtime/feed-axis.wasm");

const baseWs = parseWorkspace(
  [drive, motor, gl10, screw5, table5].reduce(installPackage, emptyWorkspace()),
);

describe("Milestone 3 · Modelica 连续追踪内核与机电控闭环系统", () => {
  it("注册 GouyuanFeedTracking.TrackingFeedAxis 并与 FeedAxis 纯阶跃响应一致", () => {
    const registered = requireRegisteredModel(FEED_TRACKING_KERNEL_REF);
    expect(registered.solver.wasmSha256).toBe(feedTrackingManifest.wasmSha256);
    expect(sha256(trackingWasmBytes)).toBe(feedTrackingManifest.wasmSha256);

    const trackMod = new WebAssembly.Module(Uint8Array.from(trackingWasmBytes));
    const feedMod = new WebAssembly.Module(Uint8Array.from(feedWasmBytes));
    const trackInst = new WebAssembly.Instance(trackMod).exports as {
      reset(...args: number[]): void;
      stepReference(h: number, a: number, b: number): void;
      positionMm(): number;
      velocityMmS(): number;
      motorTorqueNm(): number;
    };
    const feedInst = new WebAssembly.Instance(feedMod).exports as {
      reset(...args: number[]): void;
      step(h: number): void;
      positionMm(): number;
      velocityMmS(): number;
      motorTorqueNm(): number;
    };
    const physicalArgs = [5, 5, 0.0000145, 1.27, 400, 3000, 2.8, 2.8];
    trackInst.reset(...physicalArgs);
    feedInst.reset(10, ...physicalArgs);

    const h = feedTrackingManifest.integrator.stepUs / 1_000_000;
    const steps200ms = Math.round(0.2 / h);
    expect(feedManifest.integrator.stepUs).toBe(feedTrackingManifest.integrator.stepUs);
    for (let i = 0; i < steps200ms; i++) {
      trackInst.stepReference(h, 10, 10);
      feedInst.step(h);
    }
    expect(trackInst.positionMm()).toBeCloseTo(feedInst.positionMm(), 9);
    expect(trackInst.velocityMmS()).toBeCloseTo(feedInst.velocityMmS(), 9);
    expect(trackInst.motorTorqueNm()).toBeCloseTo(feedInst.motorTorqueNm(), 9);
  });

  it("在单一 RuntimeTrace 中联动运行 WASM 动力学、限位+DI 滤波与三维位姿，且改件/改参显式生效", () => {
    const trackMod = new WebAssembly.Module(Uint8Array.from(trackingWasmBytes));
    const sysBase = draftSystemFromWorkspace(baseWs, {
      id: "bench-axis",
      name: "丝杠限位急停系统",
      defaultTriggerPositionMm: 16,
      defaultTargetMm: 35,
      defaultCruiseVelocityMmS: 80,
      durationMs: 600,
    });

    const resBase = requireReadySystem(baseWs, sysBase);
    const traceBase = integrateSystemTwin(resBase, trackMod);
    const sumBase = traceBase.axisSummaries[0];
    expect(sumBase.stopTriggeredAtMs).toBeGreaterThan(200);
    expect(sumBase.finalPositionMm).toBeGreaterThan(16);
    expect(sumBase.finalPositionMm).toBeLessThan(20);
    expect(traceBase.frames[traceBase.frames.length - 1].tipPoseMm[0]).toBeCloseTo(sumBase.finalPositionMm, 6);
    expect(traceBase.events.some((e) => e.channel.endsWith(".stopLatched") && e.value)).toBe(true);
    expect(traceBase.events.some((e) => e.channel.endsWith(".stateOut") && !e.value)).toBe(true);

    // 验证修改 GL10 DI 滤波时间（10 ms -> 2 ms）可提前 8 ms 触发并缩小停机冲程
    const sysFastDi: typeof sysBase = {
      ...sysBase,
      diChannels: [{ ...sysBase.diChannels[0], filterMs: 2 }],
    };
    const traceFastDi = integrateSystemTwin(requireReadySystem(baseWs, sysFastDi), trackMod);
    const sumFastDi = traceFastDi.axisSummaries[0];
    expect(sumBase.stopTriggeredAtMs! - sumFastDi.stopTriggeredAtMs!).toBe(8);
    expect(sumFastDi.finalPositionMm).toBeLessThan(sumBase.finalPositionMm);

    // 验证修改限位安装坐标（16 mm -> 10 mm）提前触发急停
    const sysEarlySwitch: typeof sysBase = {
      ...sysBase,
      sensors: [{ ...sysBase.sensors[0], triggerPositionMm: 10 }],
    };
    const traceEarly = integrateSystemTwin(requireReadySystem(baseWs, sysEarlySwitch), trackMod);
    expect(traceEarly.axisSummaries[0].stopTriggeredAtMs!).toBeLessThan(sumBase.stopTriggeredAtMs!);
    expect(traceEarly.axisSummaries[0].finalPositionMm).toBeLessThan(12);

    // 验证更换丝杠设备包（导程 5 -> 10 mm/rev）显著改变动态超调/急停冲程与转矩曲线
    const ws10 = parseWorkspace(installPackage(baseWs, screw10));
    const sys10: typeof sysBase = {
      ...sysBase,
      axes: [{ ...sysBase.axes[0], screwKey: packageKey(screw10) }],
    };
    const trace10 = integrateSystemTwin(requireReadySystem(ws10, sys10), trackMod);
    expect(trace10.axisSummaries[0].peakTorqueNm).not.toBeCloseTo(sumBase.peakTorqueNm, 2);

    const csv = runtimeTraceToCsv(traceBase);
    expect(csv.split("\n")[0]).toContain("tipXMm,tipYMm,tipZMm");
  });

  it("系统草案清晰区分已确认/自动推断/待确认来源，未补全开关坐标时严格阻断并支持工作区持久化", () => {
    const draft = draftSystemFromWorkspace(baseWs, { id: "incomplete-sys", name: "待补全系统" });
    const pendingReport = evaluateSystemReadiness(baseWs, draft);
    expect(pendingReport.ready).toBe(false);
    expect(pendingReport.pendingItems.some((m) => m.includes("triggerPositionMm"))).toBe(true);
    expect(() => requireReadySystem(baseWs, draft)).toThrow(/triggerPositionMm/);

    const filled = confirmSystemProvenance({
      ...draft,
      sensors: [{ ...draft.sensors[0], triggerPositionMm: 16 }],
    });
    const savedWs = parseWorkspace(
      JSON.parse(JSON.stringify(upsertTwinSystem(baseWs, filled))),
    );
    expect(savedWs.systems).toHaveLength(1);
    expect(getWorkbenchTargets(savedWs)).toContainEqual({ id: "system:incomplete-sys", name: "待补全系统" });
    expect(readStudioRoute(studioHref({ view: "workbench", target: "system:incomplete-sys" }))).toEqual({
      view: "workbench",
      target: "system:incomplete-sys",
    });
  });

  it("直接解析真实 LinuxCNC .ini/.hal 的负编码器极性、debounce 滤波、-not 反相与 1->N 扇出接线", () => {
    const iniText = `
[EMCMOT]
SERVO_PERIOD = 1000000
[TRAJ]
COORDINATES = XY
[JOINT_0]
ENCODER_SCALE = 10000
MAX_LIMIT = 25.0
MAX_VELOCITY = 80.0
[JOINT_1]
ENCODER_SCALE = -10000
MIN_LIMIT = -30.0
MAX_VELOCITY = 60.0
`;
    const halText = `
loadrt debounce cfg=2
setp debounce.0.delay 10
net plus-home-joint-0 hm2_7i95.0.inmux.00.input-02-not => joint.0.pos-lim-sw-in joint.0.home-sw-in
net neg-limit-joint-1 hm2_7i95.0.inmux.00.input-05-not => joint.1.neg-lim-sw-in
`;
    const parsed = parseLinuxCncConfig(iniText, halText);
    expect(parsed.commStepMs).toBe(1);
    expect(parsed.joints[0].factor).toBe(1);
    expect(parsed.joints[1].factor).toBe(-1);
    expect(parsed.debounceDelaysMs["debounce.0"]).toBe(10);
    expect(parsed.halWires[0].invert).toBe(true);
    expect(parsed.halWires[0].targets.map((t) => t.portId)).toEqual(["posLimitIn", "homeSwitchIn"]);

    const drafted = draftSystemFromWorkspace(baseWs, { id: "gantry-hal", iniText, halText });
    expect(drafted.axes).toHaveLength(2);
    expect(drafted.axes[1].factor).toBe(-1);
    expect(drafted.wires.filter((w) => w.from.kind === "di" && w.to.kind === "controller")).toHaveLength(3);
    expect(drafted.wires.filter((w) => w.invert && w.provenance === "confirmed")).toHaveLength(3);
  });

  it("支持将单轴封装为可复用子系统扩展为双轴正交平台并导出合规 Modelica 闭环模型", () => {
    const trackMod = new WebAssembly.Module(Uint8Array.from(trackingWasmBytes));
    const single = draftSystemFromWorkspace(baseWs, {
      id: "xy-stage",
      name: "XY 双轴正交限位台",
      defaultTriggerPositionMm: 16,
      defaultTargetMm: 35,
      defaultCruiseVelocityMmS: 80,
      durationMs: 500,
    });
    const xId = single.axes[0].id;
    const tpl = packageAxisAsSubsystem(single, xId);
    const xy = appendSubsystemInstance(single, tpl, {
      axisId: "axis-y",
      axisName: "Y 轴复用模组",
      direction: [0, 1, 0],
      originMm: [0, 40, 0],
      factor: -1,
      targetMm: -35,
      triggerPositionMm: -16,
    });
    const xyFixed = parseTwinSystemAssembly({
      ...xy,
      sensors: xy.sensors.map((s) =>
        s.axisId === "axis-y" ? { ...s, triggerMode: "negative_overtravel" as const } : s,
      ),
    });

    const trace = integrateSystemTwin(requireReadySystem(baseWs, xyFixed), trackMod);
    const last = trace.frames[trace.frames.length - 1];
    expect(last.tipPoseMm[0]).toBeGreaterThan(16);
    expect(last.tipPoseMm[1]).toBeLessThan(-16);

    const exported = buildClosedLoopModelicaPackage(baseWs, xyFixed);
    expect(exported.modelMo).toContain("GouyuanFeedTracking.TrackingFeedAxis axis_0");
    expect(exported.modelMo).toContain("GouyuanFeedTracking.TrackingFeedAxis axis_1");
    expect(exported.modelMo).toContain("(-1.0) * axis_1.positionMm");
    expect(exported.modelMo).toContain("elsewhen sample(stepS, stepS) then");
  });
});
