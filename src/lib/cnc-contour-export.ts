import { resolveContourAxes, setContourProgram } from "@contracts/cnc-contour";
import { planContourProgram, sampleContourCommand, type ContourPlan } from "@contracts/contour-plan";
import type { FactoryLayout } from "@contracts/factory";
import { factoryStructureSnapshot } from "@contracts/factory-structure";
import { MAX_PROJECT_JSON_BYTES, MODEL_LIMITS } from "@contracts/import-catalog";
import type { MotorAxisParameters } from "@contracts/motor-assembly";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import registry from "../../public/modelica/contour-library.json";
import manifest from "../../public/modelica/runtime/contour-axis.json";
import { archiveBlob, sha256Hex } from "./model-files";
import { assembledMotorSource } from "./motor-axis-export";

const axes = ["X", "Y", "Z"] as const;
const outputs = ["commandX", "commandY", "commandZ", "actualX", "actualY", "actualZ", "commandVX", "commandVY",
  "commandVZ", "actualVX", "actualVY", "actualVZ", "errorX", "errorY", "errorZ", "errorMm", "segmentEvent"];
const parameterKeys = Object.keys(registry.assembly.parameters) as (keyof Omit<MotorAxisParameters, "targetMm">)[];
const encode = new TextEncoder();

async function referenceTable(contour: ContourPlan, signal?: AbortSignal) {
  const { timesS, referenceMm } = contour;
  const chunks = ["#1\n", `double command(${timesS.length},7)\n`];
  // Native and browser consume identical FOH positions. Velocity columns are planner diagnostics at the same knots.
  for (let offset = 0; offset < timesS.length; offset += 2048) {
    signal?.throwIfAborted();
    const lines: string[] = [];
    for (let i = offset; i < Math.min(offset + 2048, timesS.length); i++) {
      const t = timesS[i], pos = i * 3;
      lines.push([t, referenceMm[pos], referenceMm[pos + 1], referenceMm[pos + 2], ...sampleContourCommand(contour, t).velocityMmS].join(" "));
    }
    chunks.push(lines.join("\n") + "\n");
    if (offset + 2048 < timesS.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const data = encode.encode(chunks.join(""));
  if (data.length > MODEL_LIMITS.maxFileBytes) throw new Error("插补参考表超过单文件容量，请缩短本次程序。");
  return data;
}

export async function exportCncContour(workspace: TwinWorkspace, layout: FactoryLayout, resourceId: string, program: string,
  signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const experiment = setContourProgram(layout, resourceId, program);
  const mounted = resolveContourAxes(workspace, experiment, resourceId);
  const contour = planContourProgram(program, mounted.contour);
  const sources = { [registry.source]: manifest.sourceSha256, ...manifest.dependencySha256 };
  const [reference, libraries] = await Promise.all([referenceTable(contour, signal), Promise.all(Object.entries(sources).map(async ([path, hash]) => {
    const response = await fetch((import.meta.env?.BASE_URL ?? "/") + "modelica/" + path + "?sha256=" + hash, { signal });
    if (!response.ok) throw new Error(`读取 ${path} 失败（HTTP ${response.status}）。`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (await sha256Hex(data) !== hash) throw new Error(`三轴源码 ${path} 的 SHA-256 与运行工件不一致。`);
    return { path, data };
  }))]);
  signal?.throwIfAborted();
  const { motor, motorReferences } = assembledMotorSource(mounted.axes[0].parameters);
  const declarations = axes.map((axis, i) => {
    const params = mounted.axes[i].parameters;
    const bindings = parameterKeys.map(key => {
      const ref = motorReferences.get(key);
      return `${key}=${ref ? "AssembledMotor." + ref : params[key]}`;
    });
    return `  ${registry.assembly.id} axis${axis}(redeclare model MotorModel=AssembledMotor,\n    ${bindings.join(",\n    ")});`;
  });
  const observables = axes.map((axis, i) => `  output Real command${axis}(unit="mm") = ref.y[${i + 1}];
  output Real actual${axis}(unit="mm") = origin[${i + 1}] + axis${axis}.positionMm;
  output Real commandV${axis}(unit="mm/s") = ref.y[${i + 4}];
  output Real actualV${axis}(unit="mm/s") = axis${axis}.velocityMmS;
  output Real error${axis}(unit="mm") = actual${axis} - command${axis};`).join("\n");
  const endTimes = [...new Set([...contour.plan.segments.map(s => s.endS), contour.endS])].filter(t => t > 0);
  const intervals = Math.max(1, Math.ceil(contour.endS * 100)), stop = intervals / 100;
  const model = `within ;
model ContourRun "同一电机修订在三根轴上的连续轮廓跟踪"
  constant Real origin[3](each unit="mm") = {${contour.initialWorkMm.join(",")}};
  Modelica.Blocks.Sources.CombiTimeTable ref(tableOnFile=true, tableName="command",
    fileName="reference.txt",columns={2,3,4,5,6,7},verboseRead=false,
    smoothness=Modelica.Blocks.Types.Smoothness.LinearSegments,
    timeEvents=Modelica.Blocks.Types.TimeEvents.NoTimeEvents,
    extrapolation=Modelica.Blocks.Types.Extrapolation.HoldLastPoint);
${declarations.join("\n")}
${observables}
  output Real errorMm(unit="mm") = sqrt(errorX^2 + errorY^2 + errorZ^2);
  output Integer segmentEvent(start=0,fixed=true) "在精确程序块边界与保持终点输出原生观测";
equation
${axes.map((axis, i) => `  axis${axis}.referenceMm = ref.y[${i + 1}] - origin[${i + 1}];`).join("\n")}
  when {${endTimes.map(t => `time >= ${t}`).join(",\n        ")}} then
    segmentEvent = pre(segmentEvent) + 1;
  end when;
  annotation(experiment(StartTime=0,StopTime=${stop},Interval=0.01,Tolerance=1e-8),
    uses(GouyuanContour(version="${registry.version}"),GouyuanMotor(version="${registry.uses.GouyuanMotor}"),Gouyuan(version="${registry.uses.Gouyuan}"),Modelica(version="${registry.uses.Modelica}")));
end ContourRun;
`;
  const versions = { Gouyuan: registry.uses.Gouyuan, GouyuanMotor: registry.uses.GouyuanMotor, GouyuanContour: registry.version };
  const script = `if not loadModel(Modelica,{"${manifest.msl}"},requireExactVersion=true) then print(getErrorString()); exit(1); end if;
${Object.entries(versions).map(([name, version]) => `if not loadFile("${name}.mo") then print(getErrorString()); exit(1); end if;
if getVersion(${name}) <> "${version}" then print("Unexpected ${name} version"); exit(1); end if;`).join("\n")}
if not loadFile("AssembledMotor.mo") then print(getErrorString()); exit(1); end if;
if not loadFile("ContourRun.mo") then print(getErrorString()); exit(1); end if;
result := simulate(ContourRun,startTime=0,stopTime=${stop},numberOfIntervals=${intervals},tolerance=1e-8,
  method="dassl",outputFormat="csv",variableFilter="${outputs.join("|")}",simflags="-maxStepSize=0.001");
getErrorString();
csvFile := result.resultFile;
if csvFile == "" then exit(1); end if;
`;
  const command = encode.encode(program);
  const [referenceHash, programHash] = await Promise.all([sha256Hex(reference), sha256Hex(command)]);
  const snapshot = factoryStructureSnapshot(workspace, experiment).workspace;
  const mapping = {
    schemaVersion: 1, kind: "cnc-contour-map", layoutId: layout.id, resourceId, rootKey: packageKey(mounted.root),
    motorKey: mounted.motorKey, motorModel: mounted.motor.motorPhysics!.modelRef,
    profile: mounted.contour, program: { file: "program.nc", sha256: programHash },
    reference: { file: "reference.txt", sha256: referenceHash, columns: ["timeS", "commandX", "commandY", "commandZ", "commandVX", "commandVY", "commandVZ"],
      knots: contour.timesS.length, nominalPeriodS: 0.001, initialWorkMm: contour.initialWorkMm, programEndS: contour.programEndS, endS: contour.endS,
      segments: contour.plan.segments },
    axes: mounted.axes.map((a, i) => ({ coordinate: axes[i], axisId: a.port.id, axisKey: packageKey(a.axis), axisPath: a.port.path,
      motorSlot: a.port.motorSlot, motorKey: a.motorKey, fixtureSource: a.port.source,
      parameters: Object.fromEntries(parameterKeys.map(k => [k, a.parameters[k]])),
      parameterSources: Object.fromEntries(parameterKeys.map(k => [k, a.sources[k]])) })),
    native: { compiler: manifest.compiler, msl: manifest.msl, solver: "dassl", tolerance: 1e-8, maximumStepS: 0.001, outputPeriodS: 0.01 },
    outputs, sourceSha256: sources, wasmSha256: manifest.wasmSha256,
  };
  const documents = { "AssembledMotor.mo": motor, "ContourRun.mo": model, "run.mos": script,
    "contour-map.json": JSON.stringify(mapping) + "\n", "contour.twin.json": JSON.stringify(snapshot) + "\n" };
  const files = Object.entries(documents).map(([path, value]) => ({ path, data: encode.encode(value) }));
  if (files.some(f => f.path.endsWith(".json") && f.data.length > MAX_PROJECT_JSON_BYTES)) {
    throw new Error("三轴工程快照或参数映射超过 8 MiB，请缩短程序或精简设备资料。");
  }
  signal?.throwIfAborted();
  return archiveBlob([...libraries, ...files, { path: "reference.txt", data: reference }, { path: "program.nc", data: command }]);
}
