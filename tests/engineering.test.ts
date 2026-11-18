import { describe, expect, it } from "vitest";
import {
  calculateDriveWheel,
  calculateLinearAxis,
  calculateModule,
  calculateRotaryJoint,
  driveWheelInputSchema,
  GRAVITY_MPS2,
  linearAxisInputSchema,
  rotaryJointInputSchema,
  type CalculationResult,
  type DriveWheelInput,
  type LinearAxisInput,
  type RotaryJointInput,
} from "../contracts/engineering";

const G = GRAVITY_MPS2;

const linearBase: LinearAxisInput = {
  travelMm: 500,
  movingMassKg: 50,
  maxSpeedMmS: 200,
  accelerationMmS2: 1000,
  leadMm: 10,
  efficiency: 0.9,
  safetyFactor: 1.5,
  inclineDeg: 0,
  frictionCoefficient: 0.05,
  dutyCycle: 0.5,
};

const rotaryBase: RotaryJointInput = {
  loadKg: 20,
  centerOfMassM: 0.3,
  movingInertiaKgm2: 2,
  maxSpeedDegS: 90,
  accelerationDegS2: 180,
  gearRatio: 50,
  efficiency: 0.85,
  safetyFactor: 1.5,
  gravityFactor: 1,
  dutyCycle: 0.5,
};

const driveBase: DriveWheelInput = {
  vehicleMassKg: 1200,
  maxSpeedMS: 10,
  accelerationMS2: 1,
  gradePercent: 10,
  wheelRadiusM: 0.3,
  wheelCount: 4,
  gearRatio: 6,
  efficiency: 0.9,
  safetyFactor: 1.2,
  rollingResistanceCoefficient: 0.012,
  dutyCycle: 0.4,
};

const step = (r: CalculationResult, key: string) => {
  const s = r.steps.find((x) => x.key === key);
  if (!s) throw new Error(`step ${key} missing`);
  return s;
};

describe("linear_axis", () => {
  it("matches an independent hand calculation for the nominal case", () => {
    const r = calculateLinearAxis(linearBase);
    // hand calc: theta = 0 -> F_g = 0
    const fF = 0.05 * 50 * G * Math.cos(0); // 24.516625 N
    const fA = 50 * 1.0; // 50 N (1000 mm/s^2 = 1 m/s^2)
    const F = (0 + fF + fA) * 1.5;
    const T = (F * 0.01) / (2 * Math.PI * 0.9);
    const P = (F * 0.2) / 0.9;

    expect(r.status).toBe("ok");
    expect(r.warnings).toHaveLength(0);
    expect(r.metrics.designForceN).toBeCloseTo(F, 10);
    expect(r.metrics.screwTorqueNm).toBeCloseTo(T, 10);
    expect(r.metrics.screwSpeedRpm).toBeCloseTo(1200, 10);
    expect(r.metrics.peakPowerW).toBeCloseTo(P, 10);
    expect(r.metrics.averagePowerW).toBeCloseTo(P * 0.5, 10);
    expect(step(r, "gravity_force").value).toBeCloseTo(0, 12);
    expect(step(r, "friction_force").value).toBeCloseTo(fF, 10);
  });

  it("every step exposes auditable fields in order", () => {
    const r = calculateLinearAxis(linearBase);
    expect(r.steps.length).toBeGreaterThanOrEqual(8);
    r.steps.forEach((s, i) => {
      expect(s.order).toBe(i + 1);
      expect(typeof s.key).toBe("string");
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.formula).toMatch(/[=]/);
      expect(s.substitution).toMatch(/\d/);
      expect(Number.isFinite(s.value)).toBe(true);
      expect(s.unit.length).toBeGreaterThan(0);
      expect(s.basis.length).toBeGreaterThan(0);
    });
    // substitution embeds the actual input numbers for audit
    expect(step(r, "acceleration_force").substitution).toContain("50");
    expect(step(r, "screw_torque").formula).toBe("T = F * L / (2 * pi * eta)");
  });

  it("vertical axis (90 deg) carries full weight, zero friction", () => {
    const r = calculateLinearAxis({ ...linearBase, inclineDeg: 90 });
    expect(step(r, "gravity_force").value).toBeCloseTo(50 * G, 8);
    expect(step(r, "friction_force").value).toBeCloseTo(0, 8);
    const F = (50 * G + 0 + 50 * 1.0) * 1.5;
    expect(r.metrics.designForceN).toBeCloseTo(F, 8);
  });

  it("accepts a zero (ideal) friction coefficient", () => {
    const r = calculateLinearAxis({ ...linearBase, frictionCoefficient: 0 });
    expect(step(r, "friction_force").value).toBe(0);
    const F = (0 + 0 + 50 * 1.0) * 1.5;
    expect(r.metrics.designForceN).toBeCloseTo(F, 10);
  });

  it("blocks when required screw speed exceeds the absolute bound", () => {
    const r = calculateLinearAxis({ ...linearBase, leadMm: 5, maxSpeedMmS: 3000 });
    // n = 3 / 0.005 * 60 = 36000 rpm
    expect(r.metrics.screwSpeedRpm).toBeCloseTo(36000, 6);
    expect(r.status).toBe("blocked");
    expect(r.warnings.some((w) => w.code === "MOTOR_SPEED_EXCEEDED" && w.severity === "critical")).toBe(true);
    expect(r.warnings[0].requiredAction.length).toBeGreaterThan(0);
  });

  it("rejects non-positive mass and out-of-range efficiency", () => {
    expect(() => linearAxisInputSchema.parse({ ...linearBase, movingMassKg: 0 })).toThrow();
    expect(() => linearAxisInputSchema.parse({ ...linearBase, movingMassKg: -5 })).toThrow();
    expect(() => linearAxisInputSchema.parse({ ...linearBase, efficiency: 1.2 })).toThrow();
    expect(() => linearAxisInputSchema.parse({ ...linearBase, efficiency: 0 })).toThrow();
    expect(() => linearAxisInputSchema.parse({ ...linearBase, safetyFactor: 0.5 })).toThrow();
    expect(() => linearAxisInputSchema.parse({ ...linearBase, frictionCoefficient: -0.1 })).toThrow();
    expect(() => calculateLinearAxis({ ...linearBase, travelMm: -1 })).toThrow();
  });
});

describe("rotary_joint", () => {
  it("matches an independent hand calculation for the nominal case", () => {
    const r = calculateRotaryJoint(rotaryBase);
    // hand calc: J_total = m*r^2 + J_add = 20*0.09 + 2 = 3.8
    const Tg = 20 * G * 0.3 * 1; // 58.8399 N*m
    const jTotal = 20 * 0.3 * 0.3 + 2; // 3.8 kg*m^2
    const alpha = 180 * (Math.PI / 180); // pi rad/s^2
    const Ta = jTotal * alpha;
    const Tout = (Tg + Ta) * 1.5;
    const Tm = Tout / (50 * 0.85);
    const omega = 90 * (Math.PI / 180);
    const P = (Tout * omega) / 0.85;

    expect(r.status).toBe("ok");
    expect(r.metrics.gravityTorqueNm).toBeCloseTo(Tg, 10);
    expect(r.metrics.totalInertiaKgM2).toBeCloseTo(jTotal, 12);
    expect(r.metrics.inertiaTorqueNm).toBeCloseTo(Ta, 10);
    expect(r.metrics.outputTorqueNm).toBeCloseTo(Tout, 10);
    expect(r.metrics.motorTorqueNm).toBeCloseTo(Tm, 10);
    expect(r.metrics.motorSpeedRpm).toBeCloseTo(750, 10);
    expect(r.metrics.peakPowerW).toBeCloseTo(P, 10);
    expect(r.metrics.averagePowerW).toBeCloseTo(P * 0.5, 10);
    // auditable step for the total inertia
    expect(step(r, "total_inertia").formula).toBe("J_total = m * r^2 + J_add");
    expect(step(r, "inertia_torque").formula).toBe("T_a = J_total * alpha");
  });

  it("never omits the m*r^2 point-mass term, even when added inertia is zero", () => {
    const r = calculateRotaryJoint({ ...rotaryBase, movingInertiaKgm2: 0 });
    const jTotal = 20 * 0.3 * 0.3; // 1.8 kg*m^2 from m*r^2 alone
    expect(r.metrics.totalInertiaKgM2).toBeCloseTo(jTotal, 12);
    expect(step(r, "total_inertia").value).toBeCloseTo(jTotal, 12);
    const alpha = 180 * (Math.PI / 180);
    expect(r.metrics.inertiaTorqueNm).toBeCloseTo(jTotal * alpha, 10);
    // and when the arm is zero, only the added inertia remains
    const r2 = calculateRotaryJoint({ ...rotaryBase, centerOfMassM: 0 });
    expect(r2.metrics.totalInertiaKgM2).toBeCloseTo(2, 12);
  });

  it("gravityFactor = 0 (vertical joint axis) removes gravity torque", () => {
    const r = calculateRotaryJoint({ ...rotaryBase, gravityFactor: 0 });
    expect(r.metrics.gravityTorqueNm).toBe(0);
    expect(step(r, "gravity_torque").substitution).toContain("* 0");
  });

  it("warns above the high-speed guideline", () => {
    const r = calculateRotaryJoint({ ...rotaryBase, maxSpeedDegS: 360, gearRatio: 60 });
    // 360 deg/s = 60 rpm output -> 3600 rpm motor
    expect(r.metrics.motorSpeedRpm).toBeCloseTo(3600, 6);
    expect(r.status).toBe("warning");
    expect(r.warnings.some((w) => w.code === "HIGH_MOTOR_SPEED" && w.severity === "warning")).toBe(true);
  });

  it("blocks above the absolute speed bound", () => {
    const r = calculateRotaryJoint({ ...rotaryBase, maxSpeedDegS: 360, gearRatio: 150 });
    expect(r.metrics.motorSpeedRpm).toBeCloseTo(9000, 6);
    expect(r.status).toBe("blocked");
  });

  it("rejects invalid constraints", () => {
    expect(() => rotaryJointInputSchema.parse({ ...rotaryBase, gearRatio: 0.5 })).toThrow();
    expect(() => rotaryJointInputSchema.parse({ ...rotaryBase, movingInertiaKgm2: -0.1 })).toThrow();
    expect(() => rotaryJointInputSchema.parse({ ...rotaryBase, gravityFactor: 1.5 })).toThrow();
    expect(() => rotaryJointInputSchema.parse({ ...rotaryBase, efficiency: -0.1 })).toThrow();
  });
});

describe("drive_wheel", () => {
  it("matches an independent hand calculation for the nominal case", () => {
    const r = calculateDriveWheel(driveBase);
    // hand calc
    const theta = Math.atan(10 / 100);
    const Fg = 1200 * G * Math.sin(theta);
    const Fr = 0.012 * 1200 * G * Math.cos(theta);
    const Fa = 1200 * 1;
    const F = (Fg + Fr + Fa) * 1.2;
    const Tw = (F * 0.3) / 4;
    const Tm = Tw / (6 * 0.9);
    const nM = (10 / (2 * Math.PI * 0.3)) * 60 * 6;
    const P = (F * 10) / 0.9;

    expect(r.status).toBe("ok");
    expect(r.metrics.designTractiveForceN).toBeCloseTo(F, 8);
    expect(r.metrics.wheelTorqueNm).toBeCloseTo(Tw, 8);
    expect(r.metrics.motorTorqueNm).toBeCloseTo(Tm, 8);
    expect(r.metrics.motorSpeedRpm).toBeCloseTo(nM, 8);
    expect(r.metrics.peakPowerW).toBeCloseTo(P, 8);
    expect(r.metrics.averagePowerW).toBeCloseTo(P * 0.4, 8);
    expect(step(r, "grade_force").value).toBeCloseTo(Fg, 8);
    expect(step(r, "rolling_resistance_force").value).toBeCloseTo(Fr, 8);
  });

  it("zero grade yields zero grade force and flat-ground rolling resistance", () => {
    const r = calculateDriveWheel({ ...driveBase, gradePercent: 0 });
    expect(step(r, "grade_force").value).toBeCloseTo(0, 12);
    expect(step(r, "rolling_resistance_force").value).toBeCloseTo(0.012 * 1200 * G, 8);
    expect(r.status).toBe("ok");
  });

  it("accepts a zero (ideal) rolling resistance coefficient", () => {
    const r = calculateDriveWheel({ ...driveBase, gradePercent: 0, rollingResistanceCoefficient: 0 });
    expect(step(r, "rolling_resistance_force").value).toBe(0);
    const F = (0 + 0 + 1200 * 1) * 1.2;
    expect(r.metrics.designTractiveForceN).toBeCloseTo(F, 8);
  });

  it("warns on steep grade because traction is not verified", () => {
    const r = calculateDriveWheel({ ...driveBase, gradePercent: 25 });
    expect(r.status).toBe("warning");
    expect(r.warnings.some((w) => w.code === "STEEP_GRADE_TRACTION")).toBe(true);
  });

  it("warns on near-continuous duty cycle", () => {
    const r = calculateDriveWheel({ ...driveBase, dutyCycle: 0.95 });
    expect(r.status).toBe("warning");
    expect(r.warnings.some((w) => w.code === "HIGH_DUTY_CYCLE")).toBe(true);
  });

  it("warns on suspiciously low efficiency", () => {
    const r = calculateDriveWheel({ ...driveBase, efficiency: 0.4 });
    expect(r.warnings.some((w) => w.code === "LOW_EFFICIENCY")).toBe(true);
  });

  it("rejects non-integer wheel count and out-of-range values", () => {
    expect(() => driveWheelInputSchema.parse({ ...driveBase, wheelCount: 2.5 })).toThrow();
    expect(() => driveWheelInputSchema.parse({ ...driveBase, wheelRadiusM: 0 })).toThrow();
    expect(() => driveWheelInputSchema.parse({ ...driveBase, dutyCycle: 0 })).toThrow();
    expect(() => driveWheelInputSchema.parse({ ...driveBase, rollingResistanceCoefficient: 1.5 })).toThrow();
    expect(() => driveWheelInputSchema.parse({ ...driveBase, rollingResistanceCoefficient: -0.01 })).toThrow();
    expect(() => driveWheelInputSchema.parse({ ...driveBase, accelerationMS2: 31 })).toThrow();
    expect(driveWheelInputSchema.parse({ ...driveBase, accelerationMS2: 30 }).accelerationMS2).toBe(30);
  });
});

describe("calculateModule dispatcher", () => {
  it("dispatches to the matching calculator", () => {
    expect(calculateModule("linear_axis", linearBase)).toEqual(calculateLinearAxis(linearBase));
    expect(calculateModule("rotary_joint", rotaryBase)).toEqual(calculateRotaryJoint(rotaryBase));
    expect(calculateModule("drive_wheel", driveBase)).toEqual(calculateDriveWheel(driveBase));
  });

  it("propagates validation errors on bad input", () => {
    expect(() => calculateModule("linear_axis", { bogus: true })).toThrow();
  });
});

describe("result shape", () => {
  it("is JSON-serializable and survives a round trip unchanged", () => {
    for (const r of [
      calculateLinearAxis(linearBase),
      calculateRotaryJoint(rotaryBase),
      calculateDriveWheel(driveBase),
    ]) {
      const roundTrip = JSON.parse(JSON.stringify(r)) as CalculationResult;
      expect(roundTrip).toEqual(r);
      expect(["ok", "warning", "blocked"]).toContain(roundTrip.status);
      expect(Array.isArray(roundTrip.assumptions)).toBe(true);
    }
  });

  it("states the no-verification scope assumption explicitly (Chinese UI text)", () => {
    const r = calculateModule("linear_axis", linearBase);
    const joined = r.assumptions.join(" ");
    expect(joined).toContain("未校核");
    expect(joined).toContain("强度");
    expect(joined).toContain("热");
    expect(joined).toContain("临界转速");
    // user-facing step text is Chinese; keys/formulas stay symbolic
    expect(step(r, "screw_torque").title).toBe("丝杠所需输入转矩");
    expect(step(r, "screw_torque").formula).toContain("T = F * L");
  });
});
