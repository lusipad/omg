import { mountContourMotors, resolveContourAxes, setContourProgram } from "../../contracts/cnc-contour";
import { upsertFactoryLayout } from "../../contracts/factory";
import { applyFactoryStructureRevision } from "../../contracts/factory-structure";
import { buildServoMotor } from "../../contracts/motor-assembly";
import { packageKey, parseDevicePackage } from "../../contracts/twin-device";
import { installPackage, parseWorkspace } from "../../contracts/twin-simulation";
import originalFile from "../../public/assemblies/cnc-factory/contour.twin.json";
import pocket from "../../public/assemblies/cnc-factory/circular-pocket.nc?raw";
import manifest from "../../public/modelica/runtime/contour-axis.json";
import { exportCncContour } from "../../src/lib/cnc-contour-export";
import { contourTraceCsv, runCncContour } from "../../src/lib/cnc-contour-runtime";
import { sha256Hex } from "../../src/lib/model-files";

async function capture() {
  if (typeof Worker !== "function") throw new Error("A real Web Worker is required for browser verification");
  const original = parseWorkspace(originalFile), resourceId = "cnc-a";
  const helix = "G21 G90 G17 G94\nG0 X18 Y15\nG1 Z0 F180\nG3 X18 Y15 Z-2 I-4 J0 F600\nG2 X18 Y15 Z-1 I-4 J0\nG0 Z5\n";
  for (const kind of ["pocket", "heavy-rotor", "helical"]) {
    let ws = original, layout = ws.factories![0];
    const program = kind === "helical" ? helix : pocket;
    if (kind === "heavy-rotor") {
      const base = resolveContourAxes(ws, layout, resourceId).axes[0];
      const rotor = ws.packages.find(part => part.model === "R40-HI" && part.motorPhysics?.kind === "rotor")!;
      const motor = buildServoMotor(ws, { manufacturer: "工况核验", model: "三轴高惯量电机", revision: "1",
        statorKey: packageKey(base.stator), rotorKey: packageKey(rotor), bearingKey: packageKey(base.bearing) });
      const mounted = mountContourMotors(installPackage(ws, motor), layout, resourceId, packageKey(motor), "rotor-comparison");
      ws = mounted.workspace;
      layout = mounted.layout;
    } else if (kind === "helical") {
      const { root, contour } = resolveContourAxes(ws, layout, resourceId);
      const fixture = parseDevicePackage({ ...root, revision: "helix-offset", contour: { ...contour, initialWorkMm: [9, 8, 4] } });
      const mounted = applyFactoryStructureRevision(ws, layout, resourceId, packageKey(root), installPackage(ws, fixture), packageKey(fixture));
      ws = mounted.workspace;
      layout = mounted.layout;
    }
    layout = setContourProgram(layout, resourceId, program);
    ws = parseWorkspace(JSON.parse(JSON.stringify(upsertFactoryLayout(ws, layout))));
    layout = ws.factories!.find(f => f.id === layout.id)!;
    const result = await runCncContour(ws, layout, resourceId, program);
    const form = new FormData();
    form.set("csv", new Blob([contourTraceCsv(result)], { type: "text/csv" }), "browser.csv");
    form.set("archive", await exportCncContour(ws, layout, resourceId, program), "contour.zip");
    form.set("expected", JSON.stringify({ kind, resourceId, motorKey: resolveContourAxes(ws, layout, resourceId).motorKey,
      browser: navigator.userAgent, wasmSha256: manifest.wasmSha256, programSha256: await sha256Hex(new TextEncoder().encode(program)),
      samples: result.samples.length, programEndS: result.programEndS, endS: result.endS, maxErrorMm: result.maxErrorMm,
      rmsErrorMm: result.rmsErrorMm }));
    const response = await fetch("/capture-result", { method: "POST", body: form });
    if (!response.ok) throw new Error("Saving the browser evidence failed");
  }
}
capture().catch(error => {
  const form = new FormData();
  form.set("error", error instanceof Error ? error.stack ?? error.message : String(error));
  return fetch("/capture-result", { method: "POST", body: form });
});
