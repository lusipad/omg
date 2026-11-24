import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  encapsulateUserModule,
  MODULE_BLUEPRINTS,
  snapModuleOntoAssembly,
} from "../contracts/machine-evolution";
import { compileAssemblyToMujoco } from "../contracts/mujoco-compiler";
import { deriveAssemblyPhysicsModel, evaluateFromZeroLab } from "../contracts/physics-explainer";
import {
  attachCustomPackageToSandbox,
  createZeroBlankSandbox,
  findBestSnapTarget,
  placeRootBlockInSandbox,
  removeSandboxNode,
  setAssemblyBaseMobility,
  snapBlockOntoAssembly,
  updateSandboxNode,
} from "../contracts/sandbox-challenges";
import { buildPrimitivePartPackage } from "../contracts/twin-device";
import {
  buildFourBarLinkageTemplate,
  buildFourWheelRoverTemplate,
  buildOrientalPearlTemplate,
  buildRescueHelicopterTemplate,
  buildReusableRocketTemplate,
  buildSpringSuspensionTemplate,
} from "../contracts/universal-archetypes";
import { createImportedPhysics } from "../src/lib/imported-physics-core";
import { compileImportedModel } from "../src/lib/imported-physics-model";

let mj: MainModule;
const models: MjModel[] = [];

beforeAll(async () => {
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
}, 20_000);

afterEach(() => {
  for (const m of models.splice(0)) m.delete();
});

async function runInWasm(
  compiled: ReturnType<typeof compileAssemblyToMujoco>,
  overrideRun?: ReturnType<typeof compileAssemblyToMujoco>["recommendedRun"],
) {
  const model = await compileImportedModel(mj, compiled.bundle);
  models.push(model);
  const engine = createImportedPhysics(mj, model);
  return { compiled, engine, frames: engine.run(overrideRun ?? compiled.recommendedRun) };
}

describe("数学物理模型推导、原子机电因果链与子总成从零闭环测试", () => {
  it("空工作台 (0 件) 安全求解并给出初始坐标系建立引导；删除根零件可回到 0 件状态", () => {
    const blank = createZeroBlankSandbox();
    expect(blank.assembly.nodes.length).toBe(0);

    const blankModel = deriveAssemblyPhysicsModel(blank.workspace, blank.assembly);
    expect(blankModel.bodyCount).toBe(0);
    expect(blankModel.sections[0]?.id).toBe("empty-guide");
    expect(() => compileAssemblyToMujoco(blank.workspace, blank.assembly)).toThrow(/0 件/);

    const placed = placeRootBlockInSandbox(blank.workspace, blank.assembly, "bldc_motor");
    expect(placed.assembly.nodes.length).toBe(1);

    const cleared = removeSandboxNode(placed.workspace, placed.assembly, placed.addedNodeId);
    expect(cleared.nodes.length).toBe(0);
  });

  it("跨领域典型机构均能实时推导出正确的物理控制方程与数值指标", () => {
    const rocket = buildReusableRocketTemplate();
    const mRocket = deriveAssemblyPhysicsModel(rocket.workspace, rocket.assembly, "tvc_nozzle");
    expect(mRocket.baseDof).toBe(6);
    expect(mRocket.thrusterCount).toBe(1);
    expect(mRocket.sections.some((s) => s.id === "thrust" && s.status === "pass")).toBe(true);
    expect(mRocket.selectedNodeMath?.thrusterText).toContain("95 N");

    const heli = buildRescueHelicopterTemplate();
    const mHeli = deriveAssemblyPhysicsModel(heli.workspace, heli.assembly, "upper_rotor");
    expect(mHeli.sections.some((s) => s.id === "coaxial" && s.status === "pass")).toBe(true);
    expect(mHeli.selectedNodeMath?.coupledText).toContain("-1");

    const rover = buildFourWheelRoverTemplate();
    const mRover = deriveAssemblyPhysicsModel(rover.workspace, rover.assembly);
    expect(mRover.sections.some((s) => s.id === "wheels" && s.status === "pass")).toBe(true);

    const fourBar = buildFourBarLinkageTemplate();
    const mFourBar = deriveAssemblyPhysicsModel(fourBar.workspace, fourBar.assembly);
    expect(mFourBar.sections.some((s) => s.id === "closure" && s.status === "pass")).toBe(true);
    expect(mFourBar.netDof).toBe(0);

    const spring = buildSpringSuspensionTemplate();
    const mSpring = deriveAssemblyPhysicsModel(spring.workspace, spring.assembly);
    const springSec = mSpring.sections.find((s) => s.id === "spring");
    expect(springSec?.equation).toContain("f_n");
    expect(springSec?.metrics.some((m) => m.label === "阻尼比 ζ" && m.value.includes("欠阻尼"))).toBe(true);

    const pearl = buildOrientalPearlTemplate();
    const mPearl = deriveAssemblyPhysicsModel(pearl.workspace, pearl.assembly);
    expect(mPearl.sections.some((s) => s.id === "mechanism-kinematics")).toBe(true);
  });

  it("火箭真物理因果：纯喷管 0 推力不升空 → 从电机/叶轮/舵机/喷管封装发动机子总成 → 装箭点火升空并支持多发并联", async () => {
    // 1. 仅放贮箱 + 头锥 + 无电机电泵的纯拉瓦尔喷管 -> 物理上 0 推力，无法起飞
    const blank0 = createZeroBlankSandbox();
    const t0 = placeRootBlockInSandbox(blank0.workspace, blank0.assembly, "tank_cylinder");
    let bareWs = t0.workspace;
    let bareAsm = setAssemblyBaseMobility(t0.assembly, "free");
    const nose0 = snapBlockOntoAssembly(bareWs, bareAsm, "nose_cone", t0.addedNodeId, "top");
    const bareNoz = snapBlockOntoAssembly(nose0.workspace, nose0.assembly, "laval_nozzle", t0.addedNodeId, "bottom");
    bareWs = bareNoz.workspace;
    bareAsm = bareNoz.assembly;

    const barePhysics = deriveAssemblyPhysicsModel(bareWs, bareAsm);
    expect(barePhysics.sections.find((s) => s.id === "thrust")?.status).toBe("warn");
    const bareCompiled = compileAssemblyToMujoco(bareWs, bareAsm, { arena: "launch_complex" });
    expect(bareCompiled.motorCouplings[0]?.active).toBe(false);
    const { frames: bareFrames } = await runInWasm(bareCompiled);
    const barePeakLiftM = Math.max(...bareFrames.map((f) => f.pointM[2])) - bareFrames[0]!.pointM[2];
    expect(barePeakLiftM).toBeLessThan(0.02);

    // 2. 第 1 阶段：从 0 件用「承力环 + 高速无刷电机 + 离心泵叶轮 + 位置伺服舵机 + 纯拉瓦尔喷管」搭建发动机并封装
    const engZero = createZeroBlankSandbox();
    const yoke = placeRootBlockInSandbox(engZero.workspace, engZero.assembly, "gimbal_yoke");
    const motor = snapBlockOntoAssembly(yoke.workspace, yoke.assembly, "bldc_motor", yoke.addedNodeId, "pump_bay");
    const imp = snapBlockOntoAssembly(motor.workspace, motor.assembly, "pump_impeller", motor.addedNodeId, "shaft_tip");
    const servo = snapBlockOntoAssembly(imp.workspace, imp.assembly, "gimbal_servo", yoke.addedNodeId, "bottom");
    const noz = snapBlockOntoAssembly(servo.workspace, servo.assembly, "laval_nozzle", servo.addedNodeId, "bottom");
    const engineModule = encapsulateUserModule(noz.workspace, noz.assembly, "自造电泵矢量发动机");

    // 3. 第 2 阶段：回到 0 件，搭建贮箱 + 头锥 + 自定义尾翼 + 挂载自造发动机子总成
    const airZero = createZeroBlankSandbox();
    const rTank = placeRootBlockInSandbox(airZero.workspace, airZero.assembly, "tank_cylinder");
    let ws = rTank.workspace;
    let asm = setAssemblyBaseMobility(rTank.assembly, "free");

    const noseTarget = findBestSnapTarget(ws, asm, "nose_cone");
    const rNose = snapBlockOntoAssembly(ws, asm, "nose_cone", noseTarget!.parentNodeId, noseTarget!.parentMountId);
    ws = rNose.workspace;
    asm = rNose.assembly;

    const customFin = buildPrimitivePartPackage({
      model: "自定轻质尾翼",
      primitive: { shape: "plate", widthMm: 18, depthMm: 14, thicknessMm: 3, finish: "anodized_black" },
    });
    const rFin = attachCustomPackageToSandbox(ws, asm, customFin, rTank.addedNodeId, "rim_px");
    ws = rFin.workspace;
    asm = rFin.assembly;

    const grafted = snapModuleOntoAssembly(
      ws,
      asm,
      { workspace: engineModule.workspace, assembly: engineModule.assembly },
      rTank.addedNodeId,
      "bottom",
    );
    ws = grafted.workspace;
    asm = grafted.assembly;

    const model = deriveAssemblyPhysicsModel(ws, asm);
    const evalRes = evaluateFromZeroLab("lab-rocket", ws, asm, model, {
      engineModuleSaved: true,
      engineModuleId: engineModule.id,
    });
    expect(evalRes.readyForSim).toBe(true);

    const compiled = compileAssemblyToMujoco(ws, asm, { arena: "launch_complex" });
    expect(compiled.motorCouplings.length).toBe(1);
    expect(compiled.motorCouplings[0]?.active).toBe(true);
    expect(compiled.actuatorMeta.every((a) => a.mode !== "thrust")).toBe(true);

    // 3A. 若电机转速给定为 0 rad/s -> 离心泵不供流 -> 依然 0 推力不起飞
    const idleRun = await runInWasm(compiled, {
      ...compiled.recommendedRun,
      controls: compiled.actuatorMeta.map(() => 0),
      sequence: undefined,
    });
    const idlePeakLiftM = Math.max(...idleRun.frames.map((f) => f.pointM[2])) - idleRun.frames[0]!.pointM[2];
    expect(idlePeakLiftM).toBeLessThan(0.02);

    // 3B. 电泵起转 + TVC 舵机矢量控制 -> 在 MuJoCo 中真实拔地升空 + 程序转弯！
    const { frames } = await runInWasm(compiled);
    const peakZ = Math.max(...frames.map((f) => f.pointM[2]));
    expect(peakZ - frames[0]!.pointM[2]).toBeGreaterThan(0.6);
    expect(Math.abs(frames.at(-1)!.pointM[0] - frames[0]!.pointM[0])).toBeGreaterThan(0.08);

    // 4. 在圆周对称位并联加挂第 2、第 3 台同一发动机子总成 -> 3 套独立电机→喷管耦合同时生效
    const g2 = snapModuleOntoAssembly(ws, asm, { workspace: engineModule.workspace, assembly: engineModule.assembly }, rTank.addedNodeId, "rim_nx");
    const g3 = snapModuleOntoAssembly(g2.workspace, g2.assembly, { workspace: engineModule.workspace, assembly: engineModule.assembly }, rTank.addedNodeId, "rim_py");
    const clusterCompiled = compileAssemblyToMujoco(g3.workspace, g3.assembly, { arena: "launch_complex" });
    expect(clusterCompiled.motorCouplings.length).toBe(3);
    expect(clusterCompiled.motorCouplings.every((c) => c.active)).toBe(true);
    expect(new Set(clusterCompiled.motorCouplings.map((c) => c.motorPath)).size).toBe(3);
  });

  it("实验 2（电机+纯胶胎爬坡车）：无动力纯轮胎报警 → 4 套轮毂电机+纯橡胶胎子总成爬上 10° 斜坡", async () => {
    const blank = createZeroBlankSandbox();
    const r1 = placeRootBlockInSandbox(blank.workspace, blank.assembly, "table_plate");
    let ws = r1.workspace;
    let asm = setAssemblyBaseMobility(r1.assembly, "free");

    // 纯轮胎直接钉在车架上无电机 -> 报警
    const bareWheel = snapBlockOntoAssembly(ws, asm, "passive_wheel", r1.addedNodeId, "pos_y_front");
    const barePhysics = deriveAssemblyPhysicsModel(bareWheel.workspace, bareWheel.assembly);
    expect(barePhysics.sections.find((s) => s.id === "wheels")?.status).toBe("warn");

    const tuned = updateSandboxNode(ws, asm, r1.addedNodeId, { massKg: 1.5, finish: "aluminum" });
    ws = tuned.workspace;
    asm = tuned.assembly;

    const wheelPod = MODULE_BLUEPRINTS.find((m) => m.id === "mod_wheel_drive_pod")!.buildFn();
    for (let i = 0; i < 4; i++) {
      const target = findBestSnapTarget(ws, asm, "hub_motor_y");
      expect(target).not.toBeNull();
      const snap = snapModuleOntoAssembly(ws, asm, wheelPod, target!.parentNodeId, target!.parentMountId);
      ws = snap.workspace;
      asm = snap.assembly;
    }

    const model = deriveAssemblyPhysicsModel(ws, asm);
    const evalRes = evaluateFromZeroLab("lab-rover", ws, asm, model);
    expect(evalRes.readyForSim).toBe(true);

    const compiled = compileAssemblyToMujoco(ws, asm, { arena: "flat_ramp" });
    const { frames } = await runInWasm(compiled);
    expect(frames.at(-1)!.pointM[0] - frames[0]!.pointM[0]).toBeGreaterThan(0.35);
    expect(frames.at(-1)!.pointM[2] - frames[0]!.pointM[2]).toBeGreaterThan(0.03);
  });

  it("实验 3（无刷电机+纯桨叶旋翼机）：单旋翼反扭急剧自旋偏航 vs 共轴 ratio=-1 稳定垂直爬升", async () => {
    // 1. 同机身（tank_cylinder 自由浮基）+ 单无刷电机 + 单副无源桨叶（无反扭抵消）
    const singleZero = createZeroBlankSandbox();
    const sTank = placeRootBlockInSandbox(singleZero.workspace, singleZero.assembly, "tank_cylinder");
    const sBase = setAssemblyBaseMobility(sTank.assembly, "free");
    const sMot = snapBlockOntoAssembly(sTank.workspace, sBase, "bldc_motor", sTank.addedNodeId, "top");
    const sBlade = snapBlockOntoAssembly(sMot.workspace, sMot.assembly, "passive_blade", sMot.addedNodeId, "shaft_tip");
    const singleModel = deriveAssemblyPhysicsModel(sBlade.workspace, sBlade.assembly);
    expect(singleModel.sections.find((s) => s.id === "thrust")?.status).toBe("warn");

    const singleCompiled = compileAssemblyToMujoco(sBlade.workspace, sBlade.assembly, { arena: "launch_complex" });
    const singleRun = await runInWasm(singleCompiled);
    const singlePeakYawRate = Math.max(...singleRun.frames.map((f) => Math.abs(f.qvel[5] ?? 0)));
    expect(singlePeakYawRate).toBeGreaterThan(4.0);

    // 2. 同机身（tank_cylinder）+ 挂载共轴双旋翼子总成 (ratio = -1 反扭抵消)
    const coaxZero = createZeroBlankSandbox();
    const cTank = placeRootBlockInSandbox(coaxZero.workspace, coaxZero.assembly, "tank_cylinder");
    const cBase = setAssemblyBaseMobility(cTank.assembly, "free");
    const coaxHead = MODULE_BLUEPRINTS.find((m) => m.id === "mod_coaxial_rotor_head")!.buildFn();
    const mounted = snapModuleOntoAssembly(cTank.workspace, cBase, coaxHead, cTank.addedNodeId, "top");
    const coaxModel = deriveAssemblyPhysicsModel(mounted.workspace, mounted.assembly);
    const evalCoax = evaluateFromZeroLab("lab-coaxial", mounted.workspace, mounted.assembly, coaxModel);
    expect(evalCoax.readyForSim).toBe(true);

    const coaxCompiled = compileAssemblyToMujoco(mounted.workspace, mounted.assembly, { arena: "launch_complex" });
    expect(coaxCompiled.motorCouplings.filter((c) => c.kind === "rotor_aero" && c.active).length).toBe(2);
    const coaxRun = await runInWasm(coaxCompiled);
    const climbM = coaxRun.frames.at(-1)!.pointM[2] - coaxRun.frames[0]!.pointM[2];
    const endYawRate = Math.abs(coaxRun.frames.at(-1)!.qvel[5] ?? 0);
    expect(climbM).toBeGreaterThan(0.5);
    expect(endYawRate).toBeLessThan(0.8);
    expect(endYawRate).toBeLessThan(singlePeakYawRate * 0.15);
  });
});
