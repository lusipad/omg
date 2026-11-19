import { MAX_PROJECT_JSON_BYTES } from "@contracts/import-catalog";
import { factoryStructureSnapshot } from "@contracts/factory-structure";
import type { FactoryLayout } from "@contracts/factory";
import { resolveMotorAxis, setMotorAxisTarget, type MotorAxisParameters } from "@contracts/motor-assembly";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import registry from "../../public/modelica/motor-library.json";
import manifest from "../../public/modelica/runtime/motor-axis.json";
import { exportDeviceLibrary } from "./device-library";
import { archiveBlob, sha256Hex } from "./model-files";

const motorGroups = {
  StatorData: ["phaseResistanceOhm", "qInductanceH", "windingTurns", "windingFactor", "windingCurrentLimitA", "polePairs"],
  RotorData: ["rotorFluxWb", "rotorInertiaKgM2"],
  BearingData: ["bearingViscousNmS", "bearingCount"],
} as const;

/** One native motor type carries its installed winding, rotor and bearing data in either kind of experiment. */
export function assembledMotorSource(parameters: MotorAxisParameters) {
  const motorReferences = new Map<string, string>();
  const declarations = Object.entries(motorGroups).map(([group, fields]) => {
    const constants = fields.map(key => {
      motorReferences.set(key, `${group}.${key}`);
      const unit = registry.assembly.parameters[key].unit;
      return `    constant Real ${key}(unit="${unit}")=${parameters[key]};`;
    });
    return `  package ${group}\n${constants.join("\n")}\n  end ${group};`;
  });
  // windingCurrentLimitA bounds the drive command and is not an electromechanical parameter of PMServoMotor.
  const motorBindings = [...motorReferences].filter(([name]) => name !== "windingCurrentLimitA")
    .map(([name, ref]) => `${name}=${ref}`).join(",\n    ");
  const motor = `within ;
model AssembledMotor "自组电机的定子、转子和轴承参数"
${declarations.join("\n")}
  extends ${registry.components.motor.id}(
    ${motorBindings});
  annotation(uses(GouyuanMotor(version="${registry.version}")));
end AssembledMotor;
`;
  return { motor, motorReferences };
}

function documents(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string, targetMm: number) {
  const experiment = setMotorAxisTarget(layout, resourceId, axisId, targetMm);
  const r = resolveMotorAxis(workspace, experiment, resourceId, axisId, targetMm);
  const { motor, motorReferences } = assembledMotorSource(r.parameters);
  const axisBindings = manifest.parameters.map(name => {
    const ref = motorReferences.get(name);
    return `${name}=${ref ? "AssembledMotor." + ref : r.parameters[name as keyof MotorAxisParameters]}`;
  }).join(",\n    ");
  const axis = `within ;
model MotorAxisRun "已装电机的直线轴位置试验"
  extends ${registry.assembly.id}(
    redeclare model MotorModel = AssembledMotor,
    ${axisBindings});
  annotation(experiment(StartTime=0,StopTime=8,Interval=0.001,Tolerance=1e-8),
    uses(GouyuanMotor(version="${registry.version}"),Gouyuan(version="${registry.uses.Gouyuan}"),Modelica(version="${registry.uses.Modelica}")));
end MotorAxisRun;
`;
  const script = `if not loadModel(Modelica, {"${registry.uses.Modelica}"}, requireExactVersion=true) then print(getErrorString()); exit(1); end if;
if not loadFile("Gouyuan.mo") then print(getErrorString()); exit(1); end if;
if not loadFile("GouyuanMotor.mo") then print(getErrorString()); exit(1); end if;
if getVersion(Gouyuan) <> "${registry.uses.Gouyuan}" or getVersion(GouyuanMotor) <> "${registry.version}" then print("Model library version mismatch"); exit(1); end if;
if not loadFile("AssembledMotor.mo") then print(getErrorString()); exit(1); end if;
if not loadFile("MotorAxisRun.mo") then print(getErrorString()); exit(1); end if;
result := simulate(MotorAxisRun, startTime=0, stopTime=8, numberOfIntervals=8000, tolerance=1e-8, method="dassl", outputFormat="csv", variableFilter="${manifest.outputs.join("|")}", simflags="-noEventEmit");
getErrorString();
csvFile := result.resultFile;
if csvFile == "" then exit(1); end if;
`;
  const describe = (device: DevicePackage) => ({ packageKey: packageKey(device), modelRef: device.motorPhysics!.modelRef });
  const map = {
    schemaVersion: 1, kind: "motor-axis-map", layoutId: layout.id, resourceId, axisId,
    rootKey: packageKey(r.root), axisKey: packageKey(r.axis), axisPath: r.port.path, motorSlot: r.port.motorSlot,
    axisModel: r.port.modelRef, fixtureSource: r.port.source, motor: describe(r.motor),
    parts: { stator: describe(r.stator), rotor: describe(r.rotor), bearing: describe(r.bearing) },
    parameters: r.parameters, parameterSources: r.sources, outputs: registry.assembly.outputs,
    native: { compiler: manifest.compiler, msl: manifest.msl, solver: "dassl", tolerance: 1e-8, outputIntervalS: 0.001 },
    sourceSha256: { [registry.source]: manifest.sourceSha256, ...manifest.dependencySha256 }, wasmSha256: manifest.wasmSha256,
  };
  const installed = factoryStructureSnapshot(workspace, experiment).workspace;
  return { "AssembledMotor.mo": motor, "MotorAxisRun.mo": axis, "run.mos": script,
    "motor-map.json": JSON.stringify(map, null, 2) + "\n",
    "motor.library.json": JSON.stringify(exportDeviceLibrary(workspace.packages, r.motorKey)) + "\n",
    "installed.twin.json": JSON.stringify(installed) + "\n" };
}

export async function exportMotorAxis(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, axisId: string, targetMm: number,
  signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const draft = documents(workspace, layout, resourceId, axisId, targetMm);
  const encoder = new TextEncoder();
  const files = Object.entries(draft).map(([path, body]) => ({ path, data: encoder.encode(body) }));
  if (files.some(file => file.path.endsWith(".json") && file.data.length > MAX_PROJECT_JSON_BYTES)) {
    throw new Error("电机参数或装机快照超过 8 MiB，请核对设备资料的大小后重新导出。");
  }
  const sources = { [registry.source]: manifest.sourceSha256, ...manifest.dependencySha256 };
  const models = await Promise.all(Object.entries(sources).map(async ([path, hash]) => {
    const response = await fetch((import.meta.env?.BASE_URL ?? "/") + "modelica/" + path + "?sha256=" + hash, { signal });
    if (!response.ok) throw new Error(`读取 ${path} 失败（HTTP ${response.status}）。`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (await sha256Hex(data) !== hash) throw new Error(`电机轴源码 ${path} 的 SHA-256 与运行工件不一致。`);
    return { path, data };
  }));
  signal?.throwIfAborted();
  return archiveBlob([...models, ...files]);
}
