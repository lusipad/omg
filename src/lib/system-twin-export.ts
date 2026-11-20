import {
  requireReadySystem,
  type ResolvedTwinSystem,
  type TwinSystemAssembly,
} from "@contracts/system-twin";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import registry from "../../public/modelica/feed-tracking-library.json";
import manifest from "../../public/modelica/runtime/feed-tracking-axis.json";
import { archiveBlob, sha256Hex } from "./model-files";

const encode = new TextEncoder();

export interface ClosedLoopModelicaPackage {
  readonly modelName: string;
  readonly modelMo: string;
  readonly runMos: string;
  readonly outputs: readonly string[];
  readonly resolved: ResolvedTwinSystem;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function stepTowardExpr(curExpr: string, target: number, maxStep: number): string {
  const tStr = fmt(target);
  const sStr = fmt(maxStep);
  return `(if abs(${tStr} - (${curExpr})) <= ${sStr} then ${tStr} else (${curExpr}) + (if ${tStr} > (${curExpr}) then ${sStr} else -${sStr}))`;
}

export function buildClosedLoopModelicaPackage(
  workspace: TwinWorkspace,
  system: TwinSystemAssembly,
): ClosedLoopModelicaPackage {
  const resolved = requireReadySystem(workspace, system);
  const stepS = system.commStepMs / 1000;
  const maxStepMs = system.commStepMs;
  const stopS = system.durationMs / 1000;
  const intervals = Math.max(1, Math.round(system.durationMs / system.commStepMs));

  const axisIdx = new Map(resolved.axes.map((a, i) => [a.axis.id, i]));
  const sensorIdx = new Map(resolved.sensors.map((s, i) => [s.sensor.id, i]));
  const diIdx = new Map(resolved.diChannels.map((d, i) => [d.di.id, i]));

  const wireByTarget = new Map<string, (typeof system.wires)[number]>();
  for (const w of system.wires) {
    wireByTarget.set(`${w.to.kind}:${w.to.nodeId}:${w.to.portId}`, w);
  }

  const declarations: string[] = [
    `  constant Real commStepMs = ${fmt(maxStepMs)};`,
    `  constant Real stepS = ${fmt(stepS)};`,
    `  discrete Real tickStartS(start=0.0, fixed=true);`,
  ];
  const outputs: string[] = [];
  const initAssigns: string[] = ["    tickStartS = 0.0;"];
  const sampleAssigns: string[] = ["    tickStartS = time;"];
  const continuousEqs: string[] = [];

  for (const [i, a] of resolved.axes.entries()) {
    const p = a.parameters;
    const initPos = a.controller.initialPositionMm;
    declarations.push(
      `  GouyuanFeedTracking.TrackingFeedAxis axis_${i}(`,
      `    leadMmPerRev=${fmt(p.leadMmPerRev)},`,
      `    tableMassKg=${fmt(p.tableMassKg)},`,
      `    rotorInertiaKgM2=${fmt(p.rotorInertiaKgM2)},`,
      `    ratedTorqueNm=${fmt(p.ratedTorqueNm)},`,
      `    ratedPowerW=${fmt(p.ratedPowerW)},`,
      `    ratedSpeedRpm=${fmt(p.ratedSpeedRpm)},`,
      `    driveRatedCurrentA=${fmt(p.driveRatedCurrentA)},`,
      `    motorRatedCurrentA=${fmt(p.motorRatedCurrentA)});`,
      `  discrete Real cmdStart_${i}(start=${fmt(initPos)}, fixed=true);`,
      `  discrete Real cmdEnd_${i}(start=${fmt(initPos)}, fixed=true);`,
      `  discrete Boolean stopLatched_${i}(start=false, fixed=true);`,
      `  discrete Real latchedCmd_${i}(start=${fmt(initPos)}, fixed=true);`,
      `  Real interpCmd_${i};`,
      `  output Real cmdMm_${i}(unit="mm");`,
      `  output Real posMm_${i}(unit="mm");`,
      `  output Real velMmS_${i}(unit="mm/s");`,
      `  output Real torqueNm_${i}(unit="N.m");`,
      `  output Boolean stopOut_${i};`,
    );
    outputs.push(`cmdMm_${i}`, `posMm_${i}`, `velMmS_${i}`, `torqueNm_${i}`, `stopOut_${i}`);
    continuousEqs.push(
      `  interpCmd_${i} = cmdStart_${i} + (cmdEnd_${i} - cmdStart_${i}) * noEvent(min(1.0, max(0.0, (time - tickStartS) / stepS)));`,
      `  axis_${i}.referenceMm = (${a.factor}.0) * (interpCmd_${i} - (${fmt(initPos)}));`,
      `  cmdMm_${i} = cmdStart_${i};`,
      `  posMm_${i} = (${fmt(initPos)}) + (${a.factor}.0) * axis_${i}.positionMm;`,
      `  velMmS_${i} = (${a.factor}.0) * axis_${i}.velocityMmS;`,
      `  torqueNm_${i} = axis_${i}.motorTorqueNm;`,
      `  stopOut_${i} = stopLatched_${i};`,
    );
  }

  for (const [i, s] of resolved.sensors.entries()) {
    const aIdx = axisIdx.get(s.sensor.axisId)!;
    declarations.push(
      `  Boolean swTriggered_${i};`,
      `  Real swVoltageV_${i};`,
      `  output Boolean swOut_${i};`,
    );
    outputs.push(`swOut_${i}`);
    const posVar = `posMm_${aIdx}`;
    const trigExpr =
      s.triggerMode === "positive_overtravel"
        ? `noEvent(${posVar} >= ${fmt(s.triggerPositionMm)})`
        : s.triggerMode === "negative_overtravel"
          ? `noEvent(${posVar} <= ${fmt(s.triggerPositionMm)})`
          : `noEvent(abs(${posVar} - (${fmt(s.triggerPositionMm)})) <= ${fmt(s.senseDistanceMm)})`;
    const voltExpr = s.normallyClosed
      ? `if swTriggered_${i} then 0.0 else ${fmt(s.supplyVoltageV)}`
      : `if swTriggered_${i} then ${fmt(s.supplyVoltageV)} else 0.0`;
    continuousEqs.push(
      `  swTriggered_${i} = ${trigExpr};`,
      `  swVoltageV_${i} = ${voltExpr};`,
      `  swOut_${i} = swTriggered_${i};`,
    );
  }

  for (const [i, d] of resolved.diChannels.entries()) {
    const w = wireByTarget.get(`di:${d.di.id}:voltageIn`);
    const vInExpr =
      w && w.from.kind === "sensor" && w.from.portId === "voltageOut"
        ? `swVoltageV_${sensorIdx.get(w.from.nodeId)!}`
        : "0.0";
    declarations.push(
      `  Real diInV_${i};`,
      `  Boolean diChanging_${i};`,
      `  Real diElapsed_${i};`,
      `  Boolean diSettled_${i};`,
      `  Boolean diCandidate_${i};`,
      `  Boolean diEff_${i};`,
      `  discrete Boolean diState_${i}(start=false, fixed=true);`,
      `  discrete Real diPendingMs_${i}(start=0.0, fixed=true);`,
      `  output Boolean diOut_${i};`,
    );
    outputs.push(`diOut_${i}`);
    continuousEqs.push(
      `  diInV_${i} = ${vInExpr};`,
      `  diChanging_${i} = if pre(diState_${i}) then noEvent(diInV_${i} < ${fmt(d.offBelowV)}) else noEvent(diInV_${i} > ${fmt(d.onAboveV)});`,
      `  diElapsed_${i} = if diChanging_${i} then pre(diPendingMs_${i}) + commStepMs else 0.0;`,
      `  diSettled_${i} = diChanging_${i} and (diElapsed_${i} >= ${fmt(d.filterMs)} - 1.0e-9);`,
      `  diCandidate_${i} = if diSettled_${i} then (not pre(diState_${i})) else pre(diState_${i});`,
      `  diEff_${i} = if initial() then noEvent(diInV_${i} > ${fmt(d.onAboveV)}) else diCandidate_${i};`,
      `  diOut_${i} = diState_${i};`,
    );
    initAssigns.push(
      `    diState_${i} = noEvent(diInV_${i} > ${fmt(d.onAboveV)});`,
      `    diPendingMs_${i} = 0.0;`,
    );
    sampleAssigns.push(
      `    diState_${i} = diCandidate_${i};`,
      `    diPendingMs_${i} = if diChanging_${i} and (not diSettled_${i}) then diElapsed_${i} else 0.0;`,
    );
  }

  for (const [i, a] of resolved.axes.entries()) {
    const ctrl = a.controller;
    const boolWireExpr = (portId: "posLimitIn" | "negLimitIn" | "homeSwitchIn"): string => {
      const w = wireByTarget.get(`controller:${ctrl.id}:${portId}`);
      if (!w) return "false";
      const raw =
        w.from.kind === "sensor"
          ? `swTriggered_${sensorIdx.get(w.from.nodeId)!}`
          : `diEff_${diIdx.get(w.from.nodeId)!}`;
      return w.invert ? `(not ${raw})` : raw;
    };

    const stopConds: string[] = [];
    if (ctrl.stopOnPosLimit) stopConds.push(boolWireExpr("posLimitIn"));
    if (ctrl.stopOnNegLimit) stopConds.push(boolWireExpr("negLimitIn"));
    if (ctrl.stopOnHome) stopConds.push(boolWireExpr("homeSwitchIn"));
    const stopNowExpr = stopConds.length ? stopConds.join(" or ") : "false";

    declarations.push(`  Boolean stopNow_${i};`);
    continuousEqs.push(`  stopNow_${i} = ${stopNowExpr};`);

    const stepMax = ctrl.cruiseVelocityMmS * stepS;
    const nextInitCmd = stepTowardExpr(fmt(ctrl.initialPositionMm), ctrl.targetMm, stepMax);
    const nextSampleCmd = stepTowardExpr(`pre(cmdEnd_${i})`, ctrl.targetMm, stepMax);

    initAssigns.push(
      `    stopLatched_${i} = stopNow_${i};`,
      `    latchedCmd_${i} = posMm_${i};`,
      `    cmdStart_${i} = ${fmt(ctrl.initialPositionMm)};`,
      `    cmdEnd_${i} = if stopNow_${i} then posMm_${i} else ${nextInitCmd};`,
    );
    sampleAssigns.push(
      `    stopLatched_${i} = pre(stopLatched_${i}) or stopNow_${i};`,
      `    latchedCmd_${i} = if (not pre(stopLatched_${i})) and stopNow_${i} then posMm_${i} else pre(latchedCmd_${i});`,
      `    cmdStart_${i} = pre(cmdEnd_${i});`,
      `    cmdEnd_${i} = if (pre(stopLatched_${i}) or stopNow_${i}) then (if (not pre(stopLatched_${i})) and stopNow_${i} then posMm_${i} else pre(latchedCmd_${i})) else ${nextSampleCmd};`,
    );
  }

  const modelName = "ClosedLoopSystemRun";
  const modelMo = [
    "within ;",
    `model ${modelName} "${system.name.replaceAll('"', "")} · 机电与离散信号闭环校核模型"`,
    ...declarations,
    "equation",
    ...continuousEqs,
    "  when initial() then",
    ...initAssigns,
    "  elsewhen sample(stepS, stepS) then",
    ...sampleAssigns,
    "  end when;",
    `  annotation(experiment(StartTime=0, StopTime=${fmt(stopS)}, Interval=${fmt(stepS)}, Tolerance=1e-8),`,
    `    uses(GouyuanFeedTracking(version="${registry.version}"), Gouyuan(version="${registry.uses.Gouyuan}"), Modelica(version="${registry.uses.Modelica}")));`,
    `end ${modelName};`,
    "",
  ].join("\n");

  const runMos = [
    `if not loadModel(Modelica,{"${manifest.msl}"},requireExactVersion=true) then print(getErrorString()); exit(1); end if;`,
    `if not loadFile("Gouyuan.mo") then print(getErrorString()); exit(1); end if;`,
    `if getVersion(Gouyuan) <> "${registry.uses.Gouyuan}" then print("Unexpected Gouyuan version"); exit(1); end if;`,
    `if not loadFile("GouyuanFeedTracking.mo") then print(getErrorString()); exit(1); end if;`,
    `if getVersion(GouyuanFeedTracking) <> "${registry.version}" then print("Unexpected GouyuanFeedTracking version"); exit(1); end if;`,
    `if not loadFile("${modelName}.mo") then print(getErrorString()); exit(1); end if;`,
    `result := simulate(${modelName},startTime=0,stopTime=${fmt(stopS)},numberOfIntervals=${intervals},tolerance=1e-8,`,
    `  method="dassl",outputFormat="csv",variableFilter="${outputs.join("|")}",simflags="-maxStepSize=${fmt(stepS)}");`,
    "getErrorString();",
    "csvFile := result.resultFile;",
    'if csvFile == "" then exit(1); end if;',
    "",
  ].join("\n");

  return { modelName, modelMo, runMos, outputs, resolved };
}

export async function exportSystemTwinArchive(
  workspace: TwinWorkspace,
  system: TwinSystemAssembly,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const pkg = buildClosedLoopModelicaPackage(workspace, system);
  const sources: Record<string, string> = {
    [registry.source]: manifest.sourceSha256,
    ...manifest.dependencySha256,
  };
  const libraries = await Promise.all(
    Object.entries(sources).map(async ([path, hash]) => {
      const response = await fetch(
        (import.meta.env?.BASE_URL ?? "/") + "modelica/" + path + "?sha256=" + hash,
        { signal },
      );
      if (!response.ok) throw new Error(`读取 ${path} 失败（HTTP ${response.status}）。`);
      const data = new Uint8Array(await response.arrayBuffer());
      if ((await sha256Hex(data)) !== hash) {
        throw new Error(`Modelica 源码 ${path} 的 SHA-256 与运行工件不一致。`);
      }
      return { path, data };
    }),
  );

  const mapDoc = {
    schemaVersion: 1,
    kind: "closed-loop-system-map",
    systemId: system.id,
    systemName: system.name,
    commStepMs: system.commStepMs,
    durationMs: system.durationMs,
    native: {
      compiler: manifest.compiler,
      msl: manifest.msl,
      solver: "dassl",
      tolerance: 1e-8,
      stepS: system.commStepMs / 1000,
    },
    outputs: pkg.outputs,
    sourceSha256: sources,
    wasmSha256: manifest.wasmSha256,
  };

  const docs = {
    [`${pkg.modelName}.mo`]: pkg.modelMo,
    "run.mos": pkg.runMos,
    "system-map.json": JSON.stringify(mapDoc, null, 2) + "\n",
    "system.twin.json": JSON.stringify(workspace, null, 2) + "\n",
  };
  const files = Object.entries(docs).map(([path, text]) => ({ path, data: encode.encode(text) }));
  return archiveBlob([...libraries, ...files]);
}
