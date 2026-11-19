import type { ResolvedFactoryLayout } from "@contracts/factory";
import library from "../../public/modelica/factory-library.json";
import { factoryTopology } from "./factory-kernel";

const moString = (value: string) => '"' + value.replace(/\p{Cc}/gu, " ").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const moArray = (values: ArrayLike<number>) => "{" + Array.from(values).join(", ") + "}";

// A slot selects a Modelica implementation. Its default modifiers belong to the
// replaceable class, so changing a timed CNC to a feed-based CNC needs no old parameters.
export function factoryModelicaFiles(factory: ResolvedFactoryLayout, makespanS: number): Record<string, string> {
  const { resources, stages, jobs } = factory, { nr, ns, nj, releases, mask } = factoryTopology(factory);
  const slots = resources.map(({ resource, model, parameters }, i) => {
    const bindings = model.parameters.map(spec => `${spec.key} = ${parameters[spec.key]}`).join(", ");
    return `  replaceable model Device${i + 1} = ${model.id}(${bindings}) constrainedby ${model.interface};\n  Device${i + 1} unit${i + 1} ${moString(resource.name)};`;
  });
  const ports = resources.map(({ model, resource }, i) => [`unit${i + 1}.${model.role}Role`, ...resource.positionM,
    ...library.outputs.map(output => `unit${i + 1}.${output}`)].join(", "));
  // Include the final delivery even if another native math library rounds its time up by a few ULPs.
  const end = makespanS + Math.max(0.000001, makespanS * 1e-9);
  if (!Number.isFinite(end)) throw new Error("工厂完工时间超出 Modelica 实验时间范围。");
  const model = `within ;
model FactoryRun "工厂设备、工艺路线与工件回放"
${slots.join("\n")}
  output Integer status(start=0, fixed=true);
  discrete output Real trace[${nj * ns * 11}](each start=0, each fixed=true);
  output Real completed "已完工件数";
  output Real inProcess "已投放且未完工件数";
  output Real makespan(unit="s") "最后一件的完成时刻";
  output Real deviceState[${nr}] "0 空闲，1 预占待料，2 作业或运输";
protected
  constant Integer nr=${nr}, ns=${ns}, nj=${nj};
  constant Real jobs[${releases.length}] = ${moArray(releases)};
  constant Integer mask[${mask.length}] = ${moArray(mask)};
  Real equipment[${nr * 8}] = {\n    ${ports.join(",\n    ")}};

  function observe
    input Real t; input Integer nr; input Integer ns; input Integer nj;
    input Real jobs[:]; input Real logRows[:];
    output Real done; output Real wip; output Real endS; output Real state[nr];
  protected
    Integer row; Integer r; Integer carrier; Integer first; Integer last;
    Real finish;
  algorithm
    done := 0; wip := 0; endS := 0; state := zeros(nr);
    for j in 1:nj loop
      first := integer(jobs[3*j-2]); last := integer(jobs[3*j-1]);
      finish := logRows[11*((j-1)*ns + last)];
      endS := max(endS,finish);
      if t >= finish then done := done + 1;
      elseif t >= jobs[3*j] then wip := wip + 1; end if;
      for s in first:last loop
        row := 11*((j-1)*ns + s-1); r := integer(logRows[row+1]); carrier := integer(logRows[row+2]);
        if r > 0 and t >= logRows[row+6] and t < logRows[row+11] then
          state[r] := if t < logRows[row+10] then 1 else 2;
          if carrier > 0 and t < logRows[row+10] then state[carrier] := 2; end if;
        end if;
      end for;
    end for;
  end observe;
algorithm
  when initial() then
    (status,trace) := GouyuanFactory.schedule(nr,ns,nj,jobs,equipment,mask);
    assert(status == 0, "Invalid factory routing or numerical parameters");
  end when;
equation
  (completed,inProcess,makespan,deviceState) = observe(time,nr,ns,nj,jobs,trace);
  annotation(experiment(StartTime=0,StopTime=${end}),uses(GouyuanFactory(version="${library.version}"),Modelica(version="${library.uses.Modelica}")));
end FactoryRun;
`;
  const mos = `if not loadModel(Modelica, {"${library.uses.Modelica}"}, requireExactVersion=true) then print(getErrorString()); exit(1); end if;
if not loadFile("GouyuanFactory/package.mo") then print(getErrorString()); exit(1); end if;
if not loadFile("FactoryRun.mo") then print(getErrorString()); exit(1); end if;
checkModel(FactoryRun); getErrorString();
// Read the batch duration again in case the native user changed a component or its parameters.
simulate(FactoryRun, startTime=0, stopTime=0.001, numberOfIntervals=1, fileNamePrefix="FactoryHorizon", outputFormat="mat", variableFilter="makespan");
getErrorString();
if not regularFileExists("FactoryHorizon_res.mat") then exit(1); end if;
duration := val(makespan,0.0,"FactoryHorizon_res.mat");
if not (duration > 0) then print("Invalid native factory duration"); exit(1); end if;
horizon := duration + max(0.000001, duration * 1e-9);
simulate(FactoryRun, startTime=0, stopTime=horizon, numberOfIntervals=120, outputFormat="csv", variableFilter="status|trace.*|completed|inProcess|makespan|deviceState.*");
getErrorString();
if not regularFileExists("FactoryRun_res.csv") then exit(1); end if;
`;
  const map = {
    kind: "factory-modelica-map", schemaVersion: 1,
    resources: resources.map(({ resource, device, model, parameterSources }, i) => ({ slot: `Device${i + 1}`, id: resource.id, name: resource.name,
      packageKey: resource.packageKey, model: model.id, version: device.factory!.modelRef.version, parameterSources })),
    stages: stages.map(({ line, stage }, i) => ({ index: i + 1, lineId: line.id, id: stage.id, name: stage.name })),
    jobs: jobs.map(({ line, serial, releaseS }, i) => ({ index: i + 1, lineId: line.id, serial, releaseS })),
    traceColumns: ["station", "carrier", "fromStation", "carrierOrigin", "readyS", "dispatchS", "pickupStartS", "loadedStartS", "dropStartS", "serviceStartS", "finishS"],
  };
  return { "FactoryRun.mo": model, "run.mos": mos, "factory-map.json": JSON.stringify(map, null, 2) + "\n" };
}
