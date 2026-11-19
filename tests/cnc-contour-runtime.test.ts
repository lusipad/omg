import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parseWorkspace } from "../contracts/twin-simulation";
import project from "../public/assemblies/cnc-factory/contour.twin.json";

const workspace = parseWorkspace(project), layout = workspace.factories![0];
const program = "G21 G17 G90\nG1 X2 F300\nG1 Y2\nG3 X0 Y2 I-1 J0\nG2 X2 Y2 I1 J0";
async function runtime(damaged = false) {
  const bytes = new Uint8Array(readFileSync(new URL("../public/modelica/runtime/contour-axis.wasm", import.meta.url)));
  if (damaged) bytes[bytes.length - 1] ^= 1;
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  return import("../src/lib/cnc-contour-runtime");
}
afterEach(() => vi.unstubAllGlobals());

it("三轴同刻记录进入下一块时的真实速度，保持期有反馈，CSV 与曲线相同", async () => {
  const { runCncContour, contourTraceCsv } = await runtime();
  const result = await runCncContour(workspace, layout, "cnc-a", program);
  const { samples, plan } = result;
  expect(samples[0].actualMm).toEqual([0, 0, 5]);
  const turn = samples.find(s => s.timeS === plan.plan.segments[0].endS)!;
  expect(turn.commandVelocityMmS).toEqual([0, 0, 0]);
  expect(turn.actualVelocityMmS[0]).toBeGreaterThan(0);
  expect(turn.actualMm[0]).toBeLessThan(turn.commandMm[0]);
  expect(turn.actualMm.slice(1)).toEqual([0, 5]);
  const last = samples.at(-1)!;
  expect(last.line).toBeNull();
  expect(last.commandMm).toEqual([2, 2, 5]);
  expect(last.errorMm).toBeLessThan(0.001);
  expect(result.maxErrorMm).toBeGreaterThan(result.rmsErrorMm);
  expect(Math.hypot(...turn.followingErrorMm)).toBe(turn.errorMm);
  const [columns, ...rows] = contourTraceCsv(result).trim().split("\r\n");
  expect(rows.length).toBe(samples.length);
  const row = rows[samples.indexOf(turn)].split(",");
  for (const [column, value] of [["x_actual_mm_s", turn.actualVelocityMmS[0]], ["z_command_mm", 5], ["tip_error_mm", turn.errorMm]] as const) {
    expect(Number(row[columns.split(",").indexOf(column)])).toBe(value);
  }
});

it("已取消的程序及损坏的轮廓工件不会产出反馈", async () => {
  const { runCncContour } = await runtime(true);
  await expect(runCncContour(workspace, layout, "cnc-a", program, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(runCncContour(workspace, layout, "cnc-a", program)).rejects.toThrow(/SHA-256/);
});
