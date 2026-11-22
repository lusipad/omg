import { describe, expect, it } from "vitest";
import {
  analyzeMachinePhysics,
  createCommissionReferenceSolution,
  createCommissionStarter,
  encapsulateUserModule,
  EVOLUTION_COMMISSIONS,
  loadShowroomExhibit,
  MODULE_BLUEPRINTS,
  SHOWROOM_EXHIBITS,
  simulateMachineTrial,
  snapModuleOntoAssembly,
} from "../contracts/machine-evolution";
import { inspectMechanicalAssembly } from "../contracts/mechanical-assembly";
import { buildPrimitivePartPackage, packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";

describe("数字机械造物台：原理透视展馆、破坏对比物理规律与模块化演进委托", () => {
  it("全部 3 套旗舰展品结构零报错，且两台铣床可在默认工况下真切出三维铝坯圆槽", () => {
    for (const ex of SHOWROOM_EXHIBITS) {
      const { workspace, assembly } = loadShowroomExhibit(ex.id);
      expect(inspectMechanicalAssembly(workspace, assembly)).toEqual([]);

      const sim = simulateMachineTrial(workspace, assembly, ex.simMode, {
        payloadMassKg: 0,
        screwLeadOverrideMm: 8,
        feedRateMmS: 28,
      });
      expect(sim.frames.length).toBeGreaterThan(20);
      expect(sim.verdict.passed).toBe(true);

      if (ex.simMode === "milling-pocket") {
        const finalStock = sim.stockStates.at(-1);
        expect(finalStock).toBeDefined();
        expect(finalStock!.removedVolumeMm3).toBeGreaterThan(400);
        expect(finalStock!.maxDepthMm).toBeGreaterThan(1.0);
      }
    }
  });

  it("破坏实验物理规律成立：加重失圆、大导程过载、龙门双柱明显抑制悬臂让刀变形", () => {
    const cMill = loadShowroomExhibit("c-frame-mill");
    const gantry = loadShowroomExhibit("gantry-mill");

    const baseRun = simulateMachineTrial(cMill.workspace, cMill.assembly, "milling-pocket", {
      payloadMassKg: 0,
      screwLeadOverrideMm: 8,
      feedRateMmS: 65,
    });
    const heavyRun = simulateMachineTrial(cMill.workspace, cMill.assembly, "milling-pocket", {
      payloadMassKg: 42,
      screwLeadOverrideMm: 8,
      feedRateMmS: 65,
    });
    expect(heavyRun.physics.maxInertiaRatio).toBeGreaterThan(baseRun.physics.maxInertiaRatio);
    expect(heavyRun.verdict.maxContourErrorMm).toBeGreaterThan(baseRun.verdict.maxContourErrorMm);

    const highLeadOverload = analyzeMachinePhysics(cMill.workspace, cMill.assembly, {
      payloadMassKg: 14,
      screwLeadOverrideMm: 24,
      feedRateMmS: 92,
    });
    expect(highLeadOverload.peakTorquePct).toBeGreaterThan(100);
    expect(highLeadOverload.overloadedNodeIds.length).toBeGreaterThan(0);

    const cStiff = analyzeMachinePhysics(cMill.workspace, cMill.assembly, { cuttingForceN: 80 });
    const gStiff = analyzeMachinePhysics(gantry.workspace, gantry.assembly, { cuttingForceN: 80 });
    expect(gStiff.columnCount).toBe(2);
    expect(gStiff.columnDeflectionUm).toBeLessThan(cStiff.columnDeflectionUm * 0.65);
  });

  it("Modular 《图灵完备》封装复用：用两套直线模组拼出十字台可通过委托二画圆，且支持自定义封装复插", () => {
    const basePkg = buildPrimitivePartPackage({
      model: "实验台基座平板",
      revision: "T1",
      primitive: { shape: "plate", widthMm: 360, depthMm: 360, thicknessMm: 20, finish: "anodized_black" },
    });
    const initAsm = {
      schemaVersion: 1 as const,
      kind: "mechanical-assembly" as const,
      id: "modular-xy-test",
      name: "模块化XY组装",
      nodes: [{ id: "root_plate", label: "基座平板", packageKey: packageKey(basePkg), parent: null, explodeStep: 0 }],
      output: { node: "root_plate", mount: "top" },
      commands: {},
    };
    const hostWs = installPackage(emptyWorkspace(), basePkg);

    const modY = MODULE_BLUEPRINTS.find((m) => m.id === "mod_feed_y")!.buildFn();
    const modX = MODULE_BLUEPRINTS.find((m) => m.id === "mod_feed_x")!.buildFn();

    const step1 = snapModuleOntoAssembly(hostWs, initAsm, modY, "root_plate", "top");
    const step2 = snapModuleOntoAssembly(step1.workspace, step1.assembly, modX, step1.outputNodeId, "top");

    expect(inspectMechanicalAssembly(step2.workspace, step2.assembly)).toEqual([]);

    const circleRun = simulateMachineTrial(step2.workspace, step2.assembly, "xy-circle");
    expect(circleRun.verdict.passed).toBe(true);
    expect(circleRun.verdict.grade).not.toBe("FAIL");

    // 将其封装为自定义模块再嫁接到全新基座
    const customRec = encapsulateUserModule(step2.workspace, step2.assembly, "我的十字总成");
    expect(customRec.nodeCount).toBe(step2.assembly.nodes.length);

    const secondStage = snapModuleOntoAssembly(
      hostWs,
      initAsm,
      { workspace: customRec.workspace, assembly: customRec.assembly },
      "root_plate",
      "top",
    );
    expect(inspectMechanicalAssembly(secondStage.workspace, secondStage.assembly)).toEqual([]);
    expect(secondStage.assembly.nodes.length).toBe(1 + customRec.nodeCount);
  });

  it("4 个演进委托的初始起步结构零报错，且所有参考样机均通过物理验收评测", () => {
    for (const comm of EVOLUTION_COMMISSIONS) {
      const starter = createCommissionStarter(comm.id);
      expect(inspectMechanicalAssembly(starter.workspace, starter.assembly)).toEqual([]);

      const sol = createCommissionReferenceSolution(comm.id);
      expect(inspectMechanicalAssembly(sol.workspace, sol.assembly)).toEqual([]);

      const sim = simulateMachineTrial(sol.workspace, sol.assembly, comm.trialMode);
      expect(sim.verdict.passed).toBe(true);
      expect(sim.verdict.grade).not.toBe("FAIL");
    }
  });
});
