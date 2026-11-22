import { describe, expect, it } from "vitest";
import {
  buildComposableFeedModuleTemplate,
  buildComposableMiloMillTemplate,
  mapSystemTraceFrameToCommands,
  solveArticulatedAssembly,
} from "../contracts/articulated-kinematics";
import { evaluateBindingReadiness } from "../contracts/device-model-binding";
import { inspectMechanicalAssembly, mechanicalSubassembly } from "../contracts/mechanical-assembly";
import { primitiveBoundingBoxMm, type PrimitivePartSpec } from "../contracts/primitive-parts";
import { STUDIO_EXAMPLES } from "../contracts/studio-navigation";
import { buildPrimitivePartPackage, packageKey, parseDevicePackage } from "../contracts/twin-device";
import { emptyWorkspace } from "../contracts/twin-simulation";
import { loadStudioExample, prepareStudioExampleJoin } from "../src/lib/studio-example-workspace";

const DUMMY_HASH = "a".repeat(64);

const ALL_PRIMITIVE_SPECS: readonly PrimitivePartSpec[] = [
  { shape: "box", widthMm: 100, depthMm: 80, heightMm: 40, finish: "aluminum" },
  { shape: "cylinder", radiusMm: 12, lengthMm: 120, axis: "x", finish: "steel" },
  { shape: "tube", outerRadiusMm: 20, innerRadiusMm: 14, lengthMm: 160, axis: "z", finish: "steel" },
  { shape: "plate", widthMm: 220, depthMm: 140, thicknessMm: 14, holeDiameterMm: 6, holeInsetMm: 12 },
  { shape: "angle_bracket", widthMm: 28, legAMm: 70, legBMm: 90, thicknessMm: 10 },
  { shape: "extrusion_profile", series: "2080", lengthMm: 400, axis: "y", finish: "anodized_black" },
  {
    shape: "linear_rail_block",
    railLengthMm: 300,
    railWidthMm: 15,
    blockLengthMm: 60,
    blockWidthMm: 42,
    heightMm: 22,
    axis: "x",
  },
  { shape: "lead_screw", diameterMm: 12, lengthMm: 300, leadMm: 8, axis: "x" },
  { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x" },
  { shape: "spindle_cutter", bodyDiameterMm: 62, bodyLengthMm: 135, toolDiameterMm: 10, toolStickoutMm: 38 },
  { shape: "bearing_pillow", widthMm: 24, depthMm: 42, heightMm: 36, boreDiameterMm: 12, axis: "x" },
  {
    shape: "external_mesh",
    modelId: DUMMY_HASH,
    meshPath: "bracket.stl",
    unitScaleMm: 1,
    approxBoundsMm: [80, 60, 45],
  },
];

describe("标准化三维基本件、多分支可动机构与层级爆炸视图", () => {
  it("全部 12 种基础几何体与工业基元均可通过设备包校验并生成包络尺寸、标准安装点与可选行为模型", () => {
    for (const spec of ALL_PRIMITIVE_SPECS) {
      const bounds = primitiveBoundingBoxMm(spec);
      expect(bounds.every((dim) => dim > 0 && Number.isFinite(dim))).toBe(true);

      const pkg = buildPrimitivePartPackage({
        model: `基本件-${spec.shape}`,
        primitive: spec,
        joint: spec.shape === "plate" ? { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-100, 100] } : undefined,
        behavior:
          spec.shape === "lead_screw"
            ? { kind: "lead_screw", leadMmPerRev: spec.leadMm }
            : spec.shape === "servo_motor_body"
              ? { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 }
              : spec.shape === "plate"
                ? { kind: "moving_table", massKg: 6 }
                : undefined,
      });

      const reparsed = parseDevicePackage(JSON.parse(JSON.stringify(pkg)));
      expect(reparsed.primitive).toEqual(spec);
      expect(reparsed.mechanics?.kind).toBe("part");
      if (reparsed.mechanics?.kind === "part") {
        expect(reparsed.mechanics.outputs.some((o) => o.id === "center")).toBe(true);
        if (spec.shape === "spindle_cutter") {
          expect(reparsed.mechanics.outputs.some((o) => o.id === "tool_tip")).toBe(true);
        }
        if (spec.shape === "linear_rail_block") {
          expect(reparsed.mechanics.outputs.some((o) => o.id === "carriage_top")).toBe(true);
        }
      }

      if (spec.shape === "lead_screw") {
        const ready = evaluateBindingReadiness(reparsed, { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" });
        expect(ready.status).toBe("ready");
        expect(ready.values.leadMmPerRev).toBe(8);
      } else if (spec.shape === "servo_motor_body") {
        const ready = evaluateBindingReadiness(reparsed, { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" });
        expect(ready.status).toBe("ready");
        expect(ready.values.ratedTorqueNm).toBe(1.27);
      } else if (spec.shape === "plate") {
        const ready = evaluateBindingReadiness(reparsed, {
          id: "Modelica.Mechanics.Translational.Components.Mass",
          version: "4.0.0",
        });
        expect(ready.status).toBe("ready");
        expect(ready.values.massKg).toBe(6);
      }
    }
  });

  it("拼装式三轴铣床样板无装配拓扑缺陷，多轴联动与耦合滚珠丝杠转角严格符合导程关系", () => {
    const { workspace, assembly } = buildComposableMiloMillTemplate();
    expect(inspectMechanicalAssembly(workspace, assembly)).toEqual([]);

    const zeroSolve = solveArticulatedAssembly(workspace, assembly);
    const movedSolve = solveArticulatedAssembly(workspace, assembly, {
      commandOverrides: {
        x_table: 50,
        y_saddle: -30,
        z_carriage: -25,
        spindle_unit: 90,
      },
    });

    const nodeZero = new Map(zeroSolve.nodes.map((n) => [n.path, n]));
    const nodeMoved = new Map(movedSolve.nodes.map((n) => [n.path, n]));

    const stockZero = nodeZero.get("workpiece")!.assembledPosMm;
    const stockMoved = nodeMoved.get("workpiece")!.assembledPosMm;
    expect(stockMoved[0] - stockZero[0]).toBeCloseTo(50, 6);
    expect(stockMoved[1] - stockZero[1]).toBeCloseTo(-30, 6);
    expect(stockMoved[2] - stockZero[2]).toBeCloseTo(0, 6);

    expect(movedSolve.observationPointMm[2] - zeroSolve.observationPointMm[2]).toBeCloseTo(-25, 6);

    const coupledByPath = new Map(movedSolve.coupledControls.map((c) => [c.path, c]));
    expect(coupledByPath.get("x_screw")?.value).toBeCloseTo(50 * 45, 6);
    expect(coupledByPath.get("y_screw")?.value).toBeCloseTo(-30 * 45, 6);
    expect(coupledByPath.get("z_screw")?.value).toBeCloseTo(-25 * 45, 6);
  });

  it("支持层级三维爆炸视图、拆装引导线、局部子分支拆解以及“边爆炸边试动”", () => {
    const { workspace, assembly } = buildComposableMiloMillTemplate();

    const collapsed = solveArticulatedAssembly(workspace, assembly, { explodeFactor: 0 });
    expect(collapsed.leaderLines).toHaveLength(0);
    for (const node of collapsed.nodes) {
      expect(node.explodeDeltaMm).toEqual([0, 0, 0]);
      expect(node.explodedPosMm).toEqual(node.assembledPosMm);
    }

    const fullExploded = solveArticulatedAssembly(workspace, assembly, { explodeFactor: 1 });
    expect(fullExploded.leaderLines.length).toBeGreaterThan(10);
    const fullMap = new Map(fullExploded.nodes.map((n) => [n.path, n]));
    expect(fullMap.get("base_center")!.explodeDeltaMm).toEqual([0, 0, 0]);
    expect(fullMap.get("workpiece")!.explodeDeltaMm[2]).toBeGreaterThan(250);
    expect(fullMap.get("spindle_unit")!.explodeDeltaMm[1]).toBeLessThan(-200);

    // 仅炸开 Z 轴滑板及主轴分支，床身与 X/Y 工作台保持收拢
    const zBranchOnly = solveArticulatedAssembly(workspace, assembly, {
      explodeFactor: 1,
      explodeSubtreeRoot: "z_carriage",
    });
    const branchMap = new Map(zBranchOnly.nodes.map((n) => [n.path, n]));
    expect(branchMap.get("x_table")!.explodeDeltaMm).toEqual([0, 0, 0]);
    expect(branchMap.get("workpiece")!.explodeDeltaMm).toEqual([0, 0, 0]);
    expect(branchMap.get("column_pillar")!.explodeDeltaMm).toEqual([0, 0, 0]);
    expect(Math.hypot(...branchMap.get("z_carriage")!.explodeDeltaMm)).toBeGreaterThan(50);
    expect(Math.hypot(...branchMap.get("spindle_unit")!.explodeDeltaMm)).toBeGreaterThan(150);

    // 边爆炸边联动：50% 爆炸状态下移动 x_table +40mm，工作台和毛坯应精准同步平移 +40mm
    const halfZero = solveArticulatedAssembly(workspace, assembly, { explodeFactor: 0.5 });
    const halfMoved = solveArticulatedAssembly(workspace, assembly, {
      explodeFactor: 0.5,
      commandOverrides: { x_table: 40 },
    });
    const halfZeroMap = new Map(halfZero.nodes.map((n) => [n.path, n]));
    const halfMovedMap = new Map(halfMoved.nodes.map((n) => [n.path, n]));
    expect(halfMovedMap.get("workpiece")!.explodedPosMm[0] - halfZeroMap.get("workpiece")!.explodedPosMm[0]).toBeCloseTo(
      40,
      6,
    );
  });

  it("闭环仿真轨迹帧可直接驱动单轴基本件模组并同步旋转耦合滚珠丝杠", () => {
    const { workspace, assembly } = buildComposableFeedModuleTemplate();
    expect(inspectMechanicalAssembly(workspace, assembly)).toEqual([]);

    const cmds = mapSystemTraceFrameToCommands(assembly, {
      timeMs: 500,
      tipPoseMm: [88.5, 0, 0],
      axes: {
        axis_x: {
          axisId: "axis_x",
          commandMm: 120,
          positionMm: 88.5,
          velocityMmS: 100,
          motorTorqueNm: 0.4,
          axialForceN: 251,
          angleDeg: 3186,
          speedRpm: 600,
          worldPoseMm: [88.5, 0, 0],
          stopLatched: false,
        },
      },
      sensorTriggered: {},
      sensorVoltageV: {},
      diState: {},
      controllerInputs: {},
    });
    expect(cmds.axis_x).toBe(88.5);

    const baseSolve = solveArticulatedAssembly(workspace, assembly);
    const drivenSolve = solveArticulatedAssembly(workspace, assembly, { commandOverrides: cmds });
    const baseCarriage = baseSolve.nodes.find((n) => n.id === "axis_x")!;
    const drivenCarriage = drivenSolve.nodes.find((n) => n.id === "axis_x")!;
    expect(drivenCarriage.assembledPosMm[0] - baseCarriage.assembledPosMm[0]).toBeCloseTo(88.5, 6);
    expect(drivenSolve.coupledControls.find((c) => c.path === "axis_screw")?.value).toBeCloseTo(88.5 * 36, 6);
  });

  it("子装配提取会剥离跨子树耦合，并完整接入示例库机制加载与工程加入", async () => {
    const { workspace, assembly } = buildComposableMiloMillTemplate();
    const pkgMap = new Map(workspace.packages.map((p) => [packageKey(p), p]));
    expect(pkgMap.size).toBeGreaterThanOrEqual(18);

    // 提取不包含 x_table 的单颗 x_screw 节点时不会残留悬空 coupledTo 引用
    const screwOnly = mechanicalSubassembly({ ...assembly, output: { node: "x_screw", mount: "center" } }, "x_screw");
    expect(screwOnly.nodes[0]?.coupledTo).toBeUndefined();

    expect(STUDIO_EXAMPLES.some((e) => e.id === "composable-milo-mill" && e.kind === "mechanism")).toBe(true);
    const loaded = await loadStudioExample("mechanism", new AbortController().signal);
    expect(loaded.workspace.mechanisms?.[0]?.id).toBe("composable-milo-mill");

    const joined = prepareStudioExampleJoin("mechanism", emptyWorkspace(), loaded.workspace);
    expect(joined.replacement).toBeUndefined();
    expect(joined.next.mechanisms).toHaveLength(1);
    expect(inspectMechanicalAssembly(joined.next, joined.next.mechanisms![0]!)).toEqual([]);
  });
});
