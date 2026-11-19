import type { ContourPlan } from "@contracts/contour-plan";
import type { MotorAxisParameters } from "@contracts/motor-assembly";
import { integrateContour } from "./cnc-contour-kernel";

self.onmessage = (event: MessageEvent<{ parameters: MotorAxisParameters[]; plan: ContourPlan; module: WebAssembly.Module }>) => {
  try {
    const { parameters, plan, module } = event.data;
    self.postMessage({ result: integrateContour(parameters, plan, module) });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : "三轴联动求解失败。" });
  }
};
