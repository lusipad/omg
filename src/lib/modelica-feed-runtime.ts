import { MODELICA_FEED_REF, resolveModelicaFeedAxes, type LinearAssembly, type LinearAssemblyResult, type LinearAssemblySample, type ModelicaFeedParameters } from "@contracts/linear-assembly";
import { SERVO_AXIS_MODEL } from "@contracts/servo-axis";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import manifest from "../../public/modelica/runtime/feed-axis.json";
import { loadModelicaModule, sampleModelicaMotion } from "./modelica-runtime";

interface FeedAxis extends WebAssembly.Exports {
  reset(...parameters: number[]): void;
  step(seconds: number): void;
  positionMm(): number;
  velocityMmS(): number;
  motorTorqueNm(): number;
  axialForceN(): number;
  angleDeg(): number;
  speedRpm(): number;
}

export async function runModelicaLinearAssembly(workspace: TwinWorkspace, definition: LinearAssembly, signal?: AbortSignal): Promise<LinearAssemblyResult> {
  signal?.throwIfAborted();
  const inputs = resolveModelicaFeedAxes(workspace, definition);
  const module = await loadModelicaModule("feed-axis.wasm", manifest, MODELICA_FEED_REF, signal);
  signal?.throwIfAborted();
  const axes = inputs.map(({ id, direction, parameters }) => {
    const model = new WebAssembly.Instance(module).exports as FeedAxis;
    model.reset(...manifest.parameters.map(key => parameters[key as keyof ModelicaFeedParameters]));
    return { id, direction, model, targetDeg: parameters.targetMm / parameters.leadMmPerRev * 360 };
  });

  function sampleAt(timeMs: number) {
    const positionMm: number[] = [], velocityMmS: number[] = [], motorTorqueNm: number[] = [], axialForceN: number[] = [];
    const tipMm: LinearAssemblySample["tipMm"] = [0, 0, 0];
    let inTolerance = true;
    for (const { id, direction, model, targetDeg } of axes) {
      const position = model.positionMm(), velocity = model.velocityMmS();
      const torque = model.motorTorqueNm(), force = model.axialForceN();
      const angle = model.angleDeg(), speed = model.speedRpm();
      if (![position, velocity, torque, force, angle, speed].every(Number.isFinite)) {
        throw new Error(`轴 ${id} 的 Modelica 积分超出数值范围，请核对所选部件、单位和目标位移。`);
      }
      positionMm.push(position); velocityMmS.push(velocity); motorTorqueNm.push(torque); axialForceN.push(force);
      for (let i = 0; i < 3; i++) tipMm[i] += direction[i] * position;
      if (Math.abs(targetDeg - angle) > SERVO_AXIS_MODEL.positionToleranceDeg || Math.abs(speed) > SERVO_AXIS_MODEL.speedToleranceRpm) inTolerance = false;
    }
    if (!tipMm.every(Number.isFinite)) throw new Error("各轴合成的末端位置超出数值范围。");
    return { sample: { timeMs, positionMm, velocityMmS, motorTorqueNm, axialForceN, tipMm }, inTolerance };
  }
  return sampleModelicaMotion(manifest.integrator.stepUs, seconds => {
    for (const axis of axes) axis.model.step(seconds);
  }, sampleAt, signal);
}
