/** Prepare closed-loop electromechanical + discrete signal verification cases from real catalog devices. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  appendSubsystemInstance,
  packageAxisAsSubsystem,
  parseTwinSystemAssembly,
  requireReadySystem,
  runtimeTraceToCsv,
} from "../../contracts/system-twin";
import { packageKey } from "../../contracts/twin-device";
import { emptyWorkspace, installPackage, parseWorkspace } from "../../contracts/twin-simulation";
import { exportSystemTwinArchive } from "../../src/lib/system-twin-export";
import { integrateSystemTwin } from "../../src/lib/system-twin-runtime";
import manifest from "../../public/modelica/runtime/feed-tracking-axis.json";

if (!process.argv[2]) {
  throw new Error("Usage: tsx scripts/modelica/prepare-closed-loop-cases.ts <verification-directory>");
}
const out = resolve(process.argv[2], "closed-loop");
const rootDir = new URL("../../", import.meta.url);
const readFile = (rel: string) => readFileSync(new URL(rel, rootDir));
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

const drive = JSON.parse(readFile("examples/SV660NS2R8I-FS-INT.device.json").toString("utf8"));
const motor = JSON.parse(readFile("examples/MS1H1-40B30CB-A331R-INT.device.json").toString("utf8"));
const gl10 = JSON.parse(readFile("examples/GL10-1600END-A03.device.json").toString("utf8"));
const screw5 = JSON.parse(readFile("public/assemblies/feed-axis/screw-5.device.json").toString("utf8"));
const screw10 = JSON.parse(readFile("public/assemblies/feed-axis/screw-10.device.json").toString("utf8"));
const table5 = JSON.parse(readFile("public/assemblies/feed-axis/table-5.device.json").toString("utf8"));

const baseWorkspace = parseWorkspace(
  [drive, motor, gl10, screw5, screw10, table5].reduce(installPackage, emptyWorkspace()),
);

const wasm = readFile("public/modelica/runtime/feed-tracking-axis.wasm");
assert.equal(digest(wasm), manifest.wasmSha256);
const kernel = new WebAssembly.Module(wasm);

globalThis.fetch = async (input) => {
  const path = new URL(String(input), "https://studio.local").pathname;
  if (path !== "/modelica/Gouyuan.mo" && path !== "/modelica/GouyuanFeedTracking.mo") {
    throw new Error("Unexpected source fetch: " + path);
  }
  return new Response(Uint8Array.from(readFile("public/" + path.slice(1))));
};

const makeBaseline = (id: string, name: string, filterMs: number) =>
  parseTwinSystemAssembly({
    schemaVersion: 1,
    kind: "system-twin-assembly",
    id,
    name,
    commStepMs: 1,
    durationMs: 600,
    axes: [
      {
        id: "axis-x",
        name: "X 轴滚珠丝杠单元",
        direction: [1, 0, 0],
        originMm: [0, 0, 0],
        factor: 1,
        driveKey: packageKey(drive),
        motorKey: packageKey(motor),
        screwKey: packageKey(screw5),
        tableKey: packageKey(table5),
        provenance: "confirmed",
      },
    ],
    sensors: [
      {
        id: "sw-x-pos",
        name: "LJ12A3-4-Z/AY PNP NC 限位",
        axisId: "axis-x",
        triggerPositionMm: 16,
        senseDistanceMm: 4,
        triggerMode: "positive_overtravel",
        normallyClosed: true,
        supplyVoltageV: 24,
        provenance: "confirmed",
      },
    ],
    diChannels: [
      {
        id: "di-x",
        name: "GL10-1600END CH0",
        packageKey: packageKey(gl10),
        filterMs,
        provenance: "confirmed",
      },
    ],
    wires: [
      {
        id: "w-v",
        from: { kind: "sensor", nodeId: "sw-x-pos", portId: "voltageOut" },
        to: { kind: "di", nodeId: "di-x", portId: "voltageIn" },
        provenance: "confirmed",
      },
      {
        id: "w-pos",
        from: { kind: "di", nodeId: "di-x", portId: "stateOut" },
        to: { kind: "controller", nodeId: "ctrl-x", portId: "posLimitIn" },
        invert: true,
        provenance: "confirmed",
      },
      {
        id: "w-home",
        from: { kind: "di", nodeId: "di-x", portId: "stateOut" },
        to: { kind: "controller", nodeId: "ctrl-x", portId: "homeSwitchIn" },
        invert: true,
        provenance: "confirmed",
      },
    ],
    controllers: [
      {
        id: "ctrl-x",
        axisId: "axis-x",
        mode: "move_with_limit_stop",
        targetMm: 35,
        cruiseVelocityMmS: 80,
        initialPositionMm: 0,
        stopOnPosLimit: true,
        stopOnNegLimit: true,
        stopOnHome: true,
      },
    ],
  });

const baseline = makeBaseline("baseline-10ms", "标准 10ms DI 滤波限位急停", 10);
const fastFilter = makeBaseline("fast-filter-2ms", "2ms DI 滤波限位急停", 2);

const xTemplate = packageAxisAsSubsystem(baseline, "axis-x");
let dualGantry = appendSubsystemInstance(
  { ...baseline, id: "dual-axis-gantry-reverse", name: "双轴极性反转协同限位系统" },
  xTemplate,
  {
    axisId: "axis-y",
    axisName: "Y 轴反向龙门丝杠",
    direction: [0, 1, 0],
    originMm: [0, 50, 0],
    factor: -1,
    targetMm: -35,
    triggerPositionMm: -16,
  },
);
dualGantry = {
  ...dualGantry,
  axes: dualGantry.axes.map((a) =>
    a.id === "axis-y" ? { ...a, screwKey: packageKey(screw10) } : a,
  ),
  sensors: dualGantry.sensors.map((s) =>
    s.axisId === "axis-y" ? { ...s, triggerMode: "negative_overtravel" as const } : s,
  ),
};

for (const sys of [baseline, fastFilter, dualGantry]) {
  const ws = { ...baseWorkspace, systems: [sys] };
  const resolved = requireReadySystem(ws, sys);
  const trace = integrateSystemTwin(resolved, kernel);
  const archive = new Uint8Array(await (await exportSystemTwinArchive(ws, sys)).arrayBuffer());
  const csv = runtimeTraceToCsv(trace);
  const dir = join(out, sys.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "experiment.zip"), archive);
  writeFileSync(join(dir, "browser.csv"), csv);
  writeFileSync(
    join(dir, "expected.json"),
    JSON.stringify(
      {
        case: sys.id,
        commStepMs: sys.commStepMs,
        durationMs: sys.durationMs,
        axisSummaries: trace.axisSummaries,
        events: trace.events,
        wasmSha256: manifest.wasmSha256,
        browserCsvSha256: digest(csv),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${sys.id}: ${trace.axisSummaries.map((a) => `${a.axisId} stop=${a.stopTriggeredAtMs}ms final=${a.finalPositionMm.toFixed(4)}mm`).join("; ")}`,
  );
}
