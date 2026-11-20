import { FEED_TRACKING_KERNEL_REF } from "@contracts/model-registry";
import {
  requireReadySystem,
  type AxisFrameState,
  type AxisRunSummary,
  type ResolvedDiRuntimeSpec,
  type ResolvedSensorRuntimeSpec,
  type ResolvedTwinSystem,
  type RuntimeSignalEvent,
  type RuntimeTrace,
  type RuntimeTraceFrame,
  type TwinSystemAssembly,
} from "@contracts/system-twin";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import manifest from "../../public/modelica/runtime/feed-tracking-axis.json";
import { loadModelicaModule } from "./modelica-runtime";

interface TrackingFeedWasmExports extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  stepReference(seconds: number, fromMm: number, toMm: number): void;
  positionMm(): number;
  velocityMmS(): number;
  motorTorqueNm(): number;
  axialForceN(): number;
  angleDeg(): number;
  speedRpm(): number;
}

function isSensorTriggered(sensor: ResolvedSensorRuntimeSpec, positionMm: number): boolean {
  if (sensor.triggerMode === "positive_overtravel") {
    return positionMm >= sensor.triggerPositionMm;
  }
  if (sensor.triggerMode === "negative_overtravel") {
    return positionMm <= sensor.triggerPositionMm;
  }
  return Math.abs(positionMm - sensor.triggerPositionMm) <= sensor.senseDistanceMm;
}

function sensorVoltage(sensor: ResolvedSensorRuntimeSpec, triggered: boolean): number {
  return sensor.normallyClosed
    ? (triggered ? 0 : sensor.supplyVoltageV)
    : (triggered ? sensor.supplyVoltageV : 0);
}

function stepToward(current: number, target: number, maxStep: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

export function integrateSystemTwin(
  resolved: ResolvedTwinSystem,
  module: WebAssembly.Module,
  signal?: AbortSignal,
): RuntimeTrace {
  signal?.throwIfAborted();
  const { system } = resolved;
  const commStepMs = system.commStepMs;
  const dtS = commStepMs / 1000;
  const stepUs = manifest.integrator.stepUs;
  const substepsPerMs = 1000 / stepUs;
  if (!Number.isInteger(substepsPerMs) || substepsPerMs <= 0) {
    throw new Error("TrackingFeedAxis WASM 工件积分步长无效。");
  }
  const substeps = commStepMs * substepsPerMs;
  const subH = dtS / substeps;
  const totalTicks = Math.round(system.durationMs / commStepMs);

  // 初始化每个轴的 Modelica WASM 实例及控制器状态
  const axisRuntimes = resolved.axes.map((spec) => {
    const model = new WebAssembly.Instance(module).exports as TrackingFeedWasmExports;
    const args = manifest.parameters.map(
      (key) => spec.parameters[key as keyof typeof spec.parameters],
    );
    if (!args.every(Number.isFinite)) {
      throw new Error(`轴“${spec.axis.name}”存在非有限物理参数。`);
    }
    model.reset(...args);
    return {
      spec,
      model,
      currentCmdMm: spec.controller.initialPositionMm,
      stopLatched: false,
      latchedCmdMm: spec.controller.initialPositionMm,
      stopTriggeredAtMs: null as number | null,
      stopTriggerPositionMm: null as number | null,
      peakSpeedMmS: 0,
      peakTorqueNm: 0,
      lastPosMm: spec.controller.initialPositionMm,
    };
  });

  const wireByTarget = new Map<string, (typeof system.wires)[number]>();
  for (const wire of system.wires) {
    wireByTarget.set(`${wire.to.kind}:${wire.to.nodeId}:${wire.to.portId}`, wire);
  }

  const diState = new Map<string, boolean>();
  const diPendingMs = new Map<string, number>();

  const evalSensors = (posByAxis: Map<string, number>) => {
    const triggered: Record<string, boolean> = {};
    const voltageV: Record<string, number> = {};
    for (const s of resolved.sensors) {
      const axisPos = posByAxis.get(s.sensor.axisId) ?? 0;
      const trig = isSensorTriggered(s, axisPos);
      triggered[s.sensor.id] = trig;
      voltageV[s.sensor.id] = sensorVoltage(s, trig);
    }
    return { triggered, voltageV };
  };

  const resolveDiInputVoltage = (
    di: ResolvedDiRuntimeSpec,
    sensorVoltages: Record<string, number>,
  ): number => {
    const w = wireByTarget.get(`di:${di.di.id}:voltageIn`);
    if (w && w.from.kind === "sensor" && w.from.portId === "voltageOut") {
      return sensorVoltages[w.from.nodeId] ?? 0;
    }
    return 0;
  };

  const resolveBoolWire = (
    ctrlId: string,
    portId: "posLimitIn" | "negLimitIn" | "homeSwitchIn",
    sensorTrig: Record<string, boolean>,
    diOutputs: Record<string, boolean>,
  ): boolean => {
    const w = wireByTarget.get(`controller:${ctrlId}:${portId}`);
    if (!w) return false;
    const raw = w.from.kind === "sensor"
      ? (sensorTrig[w.from.nodeId] ?? false)
      : (diOutputs[w.from.nodeId] ?? false);
    return w.invert ? !raw : raw;
  };

  const events: RuntimeSignalEvent[] = [];
  const prevBoolState = new Map<string, boolean>();
  const trackEvent = (timeMs: number, sourceId: string, channel: string, value: boolean, detail: string) => {
    const prev = prevBoolState.get(channel);
    if (prev === undefined) {
      prevBoolState.set(channel, value);
      if (value && channel.endsWith(".stopLatched")) {
        events.push({ timeMs, sourceId, channel, value, detail });
      }
      return;
    }
    if (prev !== value) {
      prevBoolState.set(channel, value);
      events.push({ timeMs, sourceId, channel, value, detail });
    }
  };

  const frames: RuntimeTraceFrame[] = [];

  const observeTick = (timeMs: number, isInitial: boolean) => {
    const posByAxis = new Map<string, number>();
    const tipPoseMm: [number, number, number] = [0, 0, 0];

    const axisSnapshots = axisRuntimes.map((rt) => {
      const rawPos = rt.model.positionMm();
      const rawVel = rt.model.velocityMmS();
      const torque = rt.model.motorTorqueNm();
      const force = rt.model.axialForceN();
      const angle = rt.model.angleDeg();
      const speed = rt.model.speedRpm();
      if (![rawPos, rawVel, torque, force, angle, speed].every(Number.isFinite)) {
        throw new Error(`轴“${rt.spec.axis.name}”在 ${timeMs} ms 积分超出数值范围，请检查参数与单位。`);
      }
      const posMm = rt.spec.controller.initialPositionMm + rt.spec.factor * rawPos;
      const velMmS = rt.spec.factor * rawVel;
      posByAxis.set(rt.spec.axis.id, posMm);
      rt.lastPosMm = posMm;
      rt.peakSpeedMmS = Math.max(rt.peakSpeedMmS, Math.abs(velMmS));
      rt.peakTorqueNm = Math.max(rt.peakTorqueNm, Math.abs(torque));

      const [ux, uy, uz] = rt.spec.unitDirection;
      const [ox, oy, oz] = rt.spec.originMm;
      const worldPoseMm: [number, number, number] = [
        ox + ux * posMm,
        oy + uy * posMm,
        oz + uz * posMm,
      ];
      tipPoseMm[0] += ux * posMm;
      tipPoseMm[1] += uy * posMm;
      tipPoseMm[2] += uz * posMm;

      return {
        rt,
        posMm,
        velMmS,
        torque,
        force,
        angle,
        speed,
        worldPoseMm,
      };
    });

    const { triggered: sensorTriggered, voltageV: sensorVoltageV } = evalSensors(posByAxis);
    for (const s of resolved.sensors) {
      trackEvent(
        timeMs,
        s.sensor.id,
        `sensor:${s.sensor.id}.triggered`,
        sensorTriggered[s.sensor.id],
        `${s.sensor.name} 在 ${posByAxis.get(s.sensor.axisId)!.toFixed(3)} mm ${sensorTriggered[s.sensor.id] ? "触发" : "复位"}`,
      );
    }

    const diOut: Record<string, boolean> = {};
    for (const d of resolved.diChannels) {
      const vIn = resolveDiInputVoltage(d, sensorVoltageV);
      if (isInitial) {
        const initOut = vIn > d.onAboveV;
        diState.set(d.di.id, initOut);
        diPendingMs.set(d.di.id, 0);
        diOut[d.di.id] = initOut;
      } else {
        const active = diState.get(d.di.id) === true;
        const changing = active ? vIn < d.offBelowV : vIn > d.onAboveV;
        const elapsed = changing ? (diPendingMs.get(d.di.id) ?? 0) + commStepMs : 0;
        const settled = changing && elapsed >= d.filterMs - 1e-9;
        const nextOut = settled ? !active : active;
        diState.set(d.di.id, nextOut);
        diPendingMs.set(d.di.id, changing && !settled ? elapsed : 0);
        diOut[d.di.id] = nextOut;
      }
      trackEvent(
        timeMs,
        d.di.id,
        `di:${d.di.id}.stateOut`,
        diOut[d.di.id],
        `${d.di.name} 滤波输出（filter ${d.filterMs} ms）切换为 ${diOut[d.di.id] ? "ON (1)" : "OFF (0)"}`,
      );
    }

    const controllerInputs: Record<string, { posLimitIn: boolean; negLimitIn: boolean; homeSwitchIn: boolean }> = {};
    const axesRecord: Record<string, AxisFrameState> = {};
    for (const snap of axisSnapshots) {
      const { rt } = snap;
      const ctrl = rt.spec.controller;
      const posLimitIn = resolveBoolWire(ctrl.id, "posLimitIn", sensorTriggered, diOut);
      const negLimitIn = resolveBoolWire(ctrl.id, "negLimitIn", sensorTriggered, diOut);
      const homeSwitchIn = resolveBoolWire(ctrl.id, "homeSwitchIn", sensorTriggered, diOut);
      controllerInputs[ctrl.id] = { posLimitIn, negLimitIn, homeSwitchIn };

      trackEvent(timeMs, ctrl.id, `ctrl:${ctrl.id}.posLimitIn`, posLimitIn, `${rt.spec.axis.name} 正限位输入 ${posLimitIn ? "触发" : "恢复"}`);
      trackEvent(timeMs, ctrl.id, `ctrl:${ctrl.id}.negLimitIn`, negLimitIn, `${rt.spec.axis.name} 负限位输入 ${negLimitIn ? "触发" : "恢复"}`);
      trackEvent(timeMs, ctrl.id, `ctrl:${ctrl.id}.homeSwitchIn`, homeSwitchIn, `${rt.spec.axis.name} 回零开关输入 ${homeSwitchIn ? "触发" : "恢复"}`);

      const stopNow =
        (ctrl.stopOnPosLimit && posLimitIn) ||
        (ctrl.stopOnNegLimit && negLimitIn) ||
        (ctrl.stopOnHome && homeSwitchIn);
      if (!rt.stopLatched && stopNow) {
        rt.stopLatched = true;
        rt.latchedCmdMm = snap.posMm;
        rt.stopTriggeredAtMs = timeMs;
        rt.stopTriggerPositionMm = snap.posMm;
      }
      trackEvent(
        timeMs,
        ctrl.id,
        `ctrl:${ctrl.id}.stopLatched`,
        rt.stopLatched,
        `${rt.spec.axis.name} 控制器在 ${snap.posMm.toFixed(3)} mm 触发急停锁存`,
      );

      axesRecord[rt.spec.axis.id] = {
        axisId: rt.spec.axis.id,
        commandMm: rt.currentCmdMm,
        positionMm: snap.posMm,
        velocityMmS: snap.velMmS,
        motorTorqueNm: snap.torque,
        axialForceN: snap.force,
        angleDeg: snap.angle,
        speedRpm: snap.speed,
        worldPoseMm: snap.worldPoseMm,
        stopLatched: rt.stopLatched,
      };
    }

    frames.push({
      timeMs,
      tipPoseMm,
      axes: axesRecord,
      sensorTriggered,
      sensorVoltageV,
      diState: diOut,
      controllerInputs,
    });
  };

  // t = 0 初始帧
  observeTick(0, true);

  for (let tick = 1; tick <= totalTicks; tick++) {
    signal?.throwIfAborted();
    for (const rt of axisRuntimes) {
      const cmdStartMm = rt.currentCmdMm;
      const cmdEndMm = rt.stopLatched
        ? rt.latchedCmdMm
        : stepToward(cmdStartMm, rt.spec.controller.targetMm, rt.spec.controller.cruiseVelocityMmS * dtS);
      rt.currentCmdMm = cmdEndMm;

      const initPos = rt.spec.controller.initialPositionMm;
      const fromRef = rt.spec.factor * (cmdStartMm - initPos);
      const toRef = rt.spec.factor * (cmdEndMm - initPos);
      const deltaRef = toRef - fromRef;
      let prevSubRef = fromRef;
      for (let j = 1; j <= substeps; j++) {
        const nextSubRef = j === substeps ? toRef : fromRef + (deltaRef * j) / substeps;
        rt.model.stepReference(subH, prevSubRef, nextSubRef);
        prevSubRef = nextSubRef;
      }
    }
    observeTick(tick * commStepMs, false);
  }

  const axisSummaries: AxisRunSummary[] = axisRuntimes.map((rt) => ({
    axisId: rt.spec.axis.id,
    axisName: rt.spec.axis.name,
    initialPositionMm: rt.spec.controller.initialPositionMm,
    commandedTargetMm: rt.spec.controller.targetMm,
    finalPositionMm: rt.lastPosMm,
    peakSpeedMmS: rt.peakSpeedMmS,
    peakTorqueNm: rt.peakTorqueNm,
    stopTriggeredAtMs: rt.stopTriggeredAtMs,
    stopTriggerPositionMm: rt.stopTriggerPositionMm,
    brakingDistanceMm:
      rt.stopTriggerPositionMm !== null
        ? Math.abs(rt.lastPosMm - rt.stopTriggerPositionMm)
        : null,
  }));

  return {
    schemaVersion: 1,
    kind: "system-runtime-trace",
    systemId: system.id,
    systemName: system.name,
    modelRef: FEED_TRACKING_KERNEL_REF,
    commStepMs,
    durationMs: totalTicks * commStepMs,
    frames,
    events,
    axisSummaries,
  };
}

export async function runSystemTwin(
  workspace: TwinWorkspace,
  system: TwinSystemAssembly,
  signal?: AbortSignal,
): Promise<RuntimeTrace> {
  signal?.throwIfAborted();
  const resolved = requireReadySystem(workspace, system);
  const module = await loadModelicaModule(
    "feed-tracking-axis.wasm",
    manifest,
    FEED_TRACKING_KERNEL_REF,
    signal,
  );
  return integrateSystemTwin(resolved, module, signal);
}
