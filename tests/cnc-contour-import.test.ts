import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { beforeAll, expect, it, vi } from "vitest";
import { resolveContourAxes } from "../contracts/cnc-contour";
import { parseWorkspace } from "../contracts/twin-simulation";
import source from "../public/assemblies/cnc-factory/contour.twin.json";
import { exportCncContour } from "../src/lib/cnc-contour-export";
import { readProjectArchive } from "../src/lib/model-files";
import { inspectWorkbenchFiles } from "../src/lib/workbench-import";

const fixture = parseWorkspace(source), layout = fixture.factories![0], program = "; 试验圆弧\nG21 G17 G90\nG1 X2 F240\nG3 X0 Y0 I-1 J0\n";
const encode = (v: string) => new TextEncoder().encode(v);
let files: ReturnType<typeof unzipSync>;
const file = (members = files) => new File([zipSync(members, { level: 0 })], "机床三轴-Modelica.zip");
const json = (path: string) => JSON.parse(new TextDecoder().decode(files[path]));

beforeAll(async () => {
  const fetchSource = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = new URL(String(input), "https://studio.local").pathname.slice(1);
    return new Response(Uint8Array.from(readFileSync(new URL("../public/" + path, import.meta.url))));
  });
  try {
    const archive = await exportCncContour(fixture, layout, "cnc-a", program);
    files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  } finally { fetchSource.mockRestore(); }
});

it("普通导入识别原生三轴 ZIP，返回实际加工机床并还原独立槽位和原始程序", async () => {
  const opened = await inspectWorkbenchFiles([file()]);
  if (opened.kind !== "project") throw new Error("应通过普通入口恢复三轴工程");
  expect(opened.contourFocus).toBe("cnc-a");
  expect(opened.motorFocus).toBeUndefined();
  const machine = resolveContourAxes(opened.workspace, opened.workspace.factories![0], opened.contourFocus!);
  expect(machine.resource.contourRun?.program).toBe(program);
  expect(machine.axes.map(a => a.installedPath)).toEqual(["x", "y", "z"].map(id => ["feed", id, "motor"]));
  const map = json("contour-map.json");
  map.axes[0] = Object.fromEntries(Object.entries(map.axes[0]).reverse());
  expect((await readProjectArchive(file({ ...files, "contour-map.json": encode(JSON.stringify(map)) }))).contourFocus).toBe("cnc-a");
});

it("核对工厂、机床、三轴映射、轴参数与部件来源，拒绝冒用相同样例名的快照", async () => {
  const original = json("contour-map.json"), [x, y, z] = original.axes;
  const maps = [
    { ...original, schemaVersion: 2 }, { ...original, layoutId: "other" }, { ...original, resourceId: "cnc-b" },
    { ...original, rootKey: x.axisKey }, { ...original, motorKey: x.axisKey },
    { ...original, profile: { ...original.profile, initialWorkMm: [0, 0, 0] } },
    { ...original, axes: [y, x, z] }, { ...original, axes: [x, y] },
    ...[{ axisId: y.axisId }, { axisPath: y.axisPath }, { axisKey: original.rootKey }, { motorSlot: "spindle" },
      { motorKey: y.axisKey }, { parameters: { ...x.parameters, leadMmPerRev: 100 } },
      { parameterSources: y.parameterSources }].map(change => ({ ...original, axes: [{ ...x, ...change }, y, z] })),
  ];
  for (const map of maps) {
    await expect(inspectWorkbenchFiles([file({ ...files, "contour-map.json": encode(JSON.stringify(map)) })])).rejects.toThrow(/三轴|工程快照/);
  }
});

it("program.nc、快照程序和程序摘要须同时匹配", async () => {
  const snapshot = json("contour.twin.json"), map = json("contour-map.json");
  snapshot.factories[0].resources.find((r: { id: string }) => r.id === "cnc-a").contourRun.program = program.replace("X2", "X3");
  map.program.sha256 = "0".repeat(64);
  const missingProgram = { ...files };
  delete missingProgram["program.nc"];
  for (const altered of [missingProgram, { ...files, "program.nc": encode(program.replace("X2", "X3")) },
    { ...files, "contour-map.json": encode(JSON.stringify(map)) },
    { ...files, "contour.twin.json": encode(JSON.stringify(snapshot)) }]) {
    await expect(inspectWorkbenchFiles([file(altered)])).rejects.toThrow(/program.nc|程序/);
  }
});
