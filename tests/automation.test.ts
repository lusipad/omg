import { describe, expect, it } from "vitest";
import { COMPONENT_SEED } from "../db/component-seed";
import {
  applyAutomationCandidates,
  autoProjectInputSchema,
  generateAutomationPlan,
  type AutomationCatalogEntry,
} from "../contracts/automation";

const catalog: AutomationCatalogEntry[] = COMPONENT_SEED.map((record, index) => ({
  id: index + 1,
  model: record.model,
  category: record.category,
  manufacturer: { name: record.manufacturer },
  revisions: [{ id: index + 101, verificationStatus: "source_recorded", parameters: record.parameters }],
}));

const project = { code: "AUTO-TEST", name: "自动方案测试" };

describe("整机需求自动分配", () => {
  it("把 CNC 整机需求分配到三个真实直线轴配置", () => {
    const plan = generateAutomationPlan({
      ...project,
      template: "cnc",
      requirements: { travelXMm: 600, travelYMm: 450, travelZMm: 280, movingMassKg: 90, maxSpeedMmS: 180, accelerationMss2: 1.2 },
    });
    expect(plan.modules).toHaveLength(3);
    expect(plan.modules.map((module) => module.configuration.travelMm)).toEqual([600, 450, 280]);
    expect(plan.modules.map((module) => module.configuration.inclineDeg)).toEqual([0, 0, 90]);
    expect(plan.modules.every((module) => module.configuration.accelerationMmS2 === 1200)).toBe(true);
    expect(plan.modules.every((module) => module.configuration.leadMm === 5)).toBe(true);
    expect(plan.modules.every((module) => module.result.steps.length > 0)).toBe(true);
    expect(plan.assumptions.join("\n")).toContain("不是最优选型");
  });

  it("高进给速度自动提高初始导程并保留转速校核", () => {
    const plan = generateAutomationPlan({
      ...project,
      template: "cnc",
      requirements: { travelXMm: 500, travelYMm: 400, travelZMm: 250, movingMassKg: 50, maxSpeedMmS: 500, accelerationMss2: 1 },
    });
    expect(plan.modules[0].configuration.leadMm).toBe(16);
    expect(plan.modules[0].result.metrics.screwSpeedRpm).toBe(1875);
  });

  it("机械臂生成六关节、J1 竖直轴和可追溯 m·r² 惯量", () => {
    const plan = generateAutomationPlan({
      ...project,
      template: "arm",
      requirements: { payloadKg: 8, reachMm: 1000, maxJointSpeedDegS: 45, jointAccelerationDegS2: 120 },
    });
    expect(plan.modules).toHaveLength(6);
    expect(plan.modules[0].configuration.gravityFactor).toBe(0);
    expect(plan.modules[1].configuration.gravityFactor).toBe(1);
    expect(plan.modules.every((module) => module.configuration.gearRatio === 100)).toBe(true);
    expect(plan.modules[1].configuration.centerOfMassM).toBe(0.8);
    expect(plan.modules[1].result.metrics.totalInertiaKgM2).toBeCloseTo(8 * 0.8 ** 2);
    expect(plan.warnings.join("\n")).toContain("不是完整机械臂逆动力学");
  });

  it("移动平台左右轮共享整车需求并均分牵引力", () => {
    const plan = generateAutomationPlan({
      ...project,
      template: "mobile",
      requirements: { totalMassKg: 60, maxSpeedMps: 0.8, accelerationMps2: 0.5, gradePercent: 5, wheelDiameterMm: 180 },
    });
    expect(plan.modules).toHaveLength(2);
    for (const module of plan.modules) {
      expect(module.configuration.vehicleMassKg).toBe(60);
      expect(module.configuration.wheelRadiusM).toBe(0.09);
      expect(module.configuration.wheelCount).toBe(2);
      expect(module.configuration.gearRatio).toBe(53);
    }
    expect(plan.modules[0].result.metrics).toEqual(plan.modules[1].result.metrics);
  });

  it("非法整机需求在创建项目前被拒绝", () => {
    expect(() => autoProjectInputSchema.parse({
      ...project,
      template: "mobile",
      requirements: { totalMassKg: -1, maxSpeedMps: 1, accelerationMps2: 0.5, gradePercent: 0, wheelDiameterMm: 200 },
    })).toThrow();
  });
});

describe("已溯源候选部件初筛", () => {
  it("CNC 保留系列级边界且不会虚构驱动器", () => {
    const base = generateAutomationPlan({
      ...project,
      template: "cnc",
      requirements: { travelXMm: 500, travelYMm: 400, travelZMm: 250, movingMassKg: 10, maxSpeedMmS: 100, accelerationMss2: 0.5 },
    });
    const plan = applyAutomationCandidates(base, catalog);
    const x = plan.modules[0];
    expect(x.selectedComponentRevisionIds.ball_screw).toBe(102);
    expect(x.selectedComponentRevisionIds.linear_guide).toBe(101);
    expect(x.selectedComponentRevisionIds.servo_motor).toBe(103);
    expect(x.selectedComponentRevisionIds.servo_drive).toBeUndefined();
    expect(x.candidateNotes.join("\n")).toContain("系列级候选");
    expect(plan.pendingConfirmations.join("\n")).toContain("伺服驱动器");
  });

  it("移动平台只保留同组且覆盖需求的电机减速器候选", () => {
    const base = generateAutomationPlan({
      ...project,
      template: "mobile",
      requirements: { totalMassKg: 20, maxSpeedMps: 0.5, accelerationMps2: 0.2, gradePercent: 0, wheelDiameterMm: 150 },
    });
    const plan = applyAutomationCandidates(base, catalog);
    for (const module of plan.modules) {
      expect(module.selectedComponentRevisionIds.servo_motor).toBe(107);
      expect(module.selectedComponentRevisionIds.gearbox).toBe(108);
      expect(module.selectedComponentRevisionIds.wheel).toBeUndefined();
      expect(module.selectedComponentRevisionIds.encoder).toBeUndefined();
    }
  });

  it("需求超过样本能力时不拼配其他系列，也不自动宣告选型完成", () => {
    const base = generateAutomationPlan({
      ...project,
      template: "mobile",
      requirements: { totalMassKg: 500, maxSpeedMps: 2, accelerationMps2: 1, gradePercent: 20, wheelDiameterMm: 300 },
    });
    const plan = applyAutomationCandidates(base, catalog);
    for (const module of plan.modules) {
      expect(module.selectedComponentRevisionIds.servo_motor).toBeUndefined();
      expect(module.selectedComponentRevisionIds.gearbox).toBeUndefined();
    }
    expect(plan.pendingConfirmations.join("\n")).toContain("未跨系列拼配");
  });

  it("机械臂不会把非 100:1 的减速器自动塞入 100:1 配置", () => {
    const base = generateAutomationPlan({
      ...project,
      template: "arm",
      requirements: { payloadKg: 50, reachMm: 2500, maxJointSpeedDegS: 60, jointAccelerationDegS2: 180 },
    });
    const plan = applyAutomationCandidates(base, catalog);
    const selectedGearboxIds = plan.modules.map((module) => module.selectedComponentRevisionIds.gearbox).filter(Boolean);
    expect(selectedGearboxIds).not.toContain(106);
    expect(plan.pendingConfirmations.join("\n")).toContain("未自动改配其他速比");
  });
});
