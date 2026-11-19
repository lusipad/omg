/** Resolve the electrical time constant and mechanical rates before stepping the compiled equations. */
export function motorSubsteps(p, baseStepUs) {
  const radius = p.leadMmPerRev / (2000 * Math.PI);
  const inertia = p.rotorInertiaKgM2 + p.tableMassKg * radius * radius;
  const linkage = p.windingTurns * p.windingFactor * p.rotorFluxWb;
  const controllerFrequency = 24; // Gouyuan.PositionDrive 1.0.0, rad/s
  const rate = Math.max(
    (p.phaseResistanceOhm + p.currentGainOhm) / p.qInductanceH,
    p.bearingCount * p.bearingViscousNmS / inertia,
    Math.sqrt(1.5) * p.polePairs * linkage / Math.sqrt(p.qInductanceH * inertia),
    2 * controllerFrequency * p.driveReferenceInertiaKgM2 / inertia,
    controllerFrequency,
  );
  const steps = Math.max(1, Math.ceil(8 * rate * baseStepUs / 1_000_000));
  if (!Number.isFinite(steps) || steps > 64) throw new Error("这组参数需要更细的积分步长，请核对电感、惯量及单位，或导出后用原生 OpenModelica DASSL 复算。");
  return steps;
}
