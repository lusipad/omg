import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

async function runInWasm(compiled: ReturnType<typeof compileAssemblyToMujoco>) {
  const model = await compileImportedModel(mj, compiled.bundle);
  models.push(model);
  const engine = createImportedPhysics(mj, model);
  return { compiled, engine, frames: engine.run(compiled.recommendedRun) };
}

describe("数学物理模型推导与从零搭建真物理闭环测试", () => {
  it("空工作台 (0 件) 安全求解并给出初始坐标系建立引导；删除根零件可回到 0 件状态", () => {
    const blank = createZeroBlankSandbox();
    expect(blank.assembly.nodes.length).toBe(0);

    const blankModel = deriveAssemblyPhysicsModel(blank.workspace, blank.assembly);
    expect(blankModel.bodyCount).toBe(0);
    expect(blankModel.sections[0]?.id).toBe("empty-guide");
    expect(() => compileAssemblyToMujoco(blank.workspace, blank.assembly)).toThrow(/0 件/);

    const placed = placeRootBlockInSandbox(blank.workspace, blank.assembly, "tank_cylinder");
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
    expect(mFourBar.netDof).toBe(0); // 3 hinges - 3 positional connect constraints (planar 1-DOF loop)

    const spring = buildSpringSuspensionTemplate();
    const mSpring = deriveAssemblyPhysicsModel(spring.workspace, spring.assembly);
    const springSec = mSpring.sections.find((s) => s.id === "spring");
    expect(springSec?.equation).toContain("f_n");
    expect(springSec?.metrics.some((m) => m.label === "阻尼比 ζ" && m.value.includes("欠阻尼"))).toBe(true);

    const pearl = buildOrientalPearlTemplate();
    const mPearl = deriveAssemblyPhysicsModel(pearl.workspace, pearl.assembly);
    expect(mPearl.sections.some((s) => s.id === "mechanism-kinematics")).toBe(true);
  });

  it("实验 1（从零搭建四轮爬坡车）：从 0 件起步 → 放底盘 → 装 4 轮 → MuJoCo WASM 真实爬上 10° 坡道", async () => {
    const blank = createZeroBlankSandbox();
    const r1 = placeRootBlockInSandbox(blank.workspace, blank.assembly, "table_plate");
    let ws = r1.workspace;
    let asm = setAssemblyBaseMobility(r1.assembly, "free");

    // 调轻底盘至 1.2 kg 以获得轻巧敏捷爬坡比
    const tuned = updateSandboxNode(ws, asm, r1.addedNodeId, { massKg: 1.2, finish: "aluminum" });
    ws = tuned.workspace;
    asm = tuned.assembly;

    for (let i = 0; i < 4; i++) {
      const target = findBestSnapTarget(ws, asm, "drive_wheel");
      expect(target).not.toBeNull();
      const snap = snapBlockOntoAssembly(ws, asm, "drive_wheel", target!.parentNodeId, target!.parentMountId);
      ws = snap.workspace;
      asm = snap.assembly;
    }

    const model = deriveAssemblyPhysicsModel(ws, asm);
    const evalRes = evaluateFromZeroLab("lab-rover", ws, asm, model);
    expect(evalRes.readyForSim).toBe(true);

    const compiled = compileAssemblyToMujoco(ws, asm, { arena: "flat_ramp" });
    const { frames } = await runInWasm(compiled);
    const start = frames[0]!;
    const end = frames.at(-1)!;
    expect(end.pointM[0] - start.pointM[0]).toBeGreaterThan(0.38);
    expect(end.pointM[2] - start.pointM[2]).toBeGreaterThan(0.03);
  });

  it("实验 2（从零搭建单级矢量火箭）：0 件起步 → 贮箱 + 头锥 + 矢量喷管 → 推重比达标并垂直升空", async () => {
    const blank = createZeroBlankSandbox();
    const r1 = placeRootBlockInSandbox(blank.workspace, blank.assembly, "tank_cylinder");
    let ws = r1.workspace;
    let asm = setAssemblyBaseMobility(r1.assembly, "free");

    const noseTarget = findBestSnapTarget(ws, asm, "nose_cone");
    const noseSnap = snapBlockOntoAssembly(ws, asm, "nose_cone", noseTarget!.parentNodeId, noseTarget!.parentMountId);
    ws = noseSnap.workspace;
    asm = noseSnap.assembly;

    const thrTarget = findBestSnapTarget(ws, asm, "rocket_thruster");
    expect(thrTarget?.parentMountId).toBe("bottom");
    const thrSnap = snapBlockOntoAssembly(ws, asm, "rocket_thruster", thrTarget!.parentNodeId, thrTarget!.parentMountId);
    ws = thrSnap.workspace;
    asm = thrSnap.assembly;

    // 测试自定义参数化零件也可通过 attachCustomPackageToSandbox 加装到从零装配上
    const customFin = buildPrimitivePartPackage({
      model: "自定义尾翼安定片",
      primitive: { shape: "box", widthMm: 16, depthMm: 4, heightMm: 28, finish: "anodized_black" },
    });
    const finSnap = attachCustomPackageToSandbox(ws, asm, customFin, r1.addedNodeId, "rim_px");
    ws = finSnap.workspace;
    asm = finSnap.assembly;

    // 校验 updateSandboxNode 可直接调整偏移、耦合与推力
    const adjusted = updateSandboxNode(ws, asm, thrSnap.addedNodeId, { thrusterMaxForceN: 80 });
    ws = adjusted.workspace;
    asm = adjusted.assembly;

    const model = deriveAssemblyPhysicsModel(ws, asm);
    const evalRes = evaluateFromZeroLab("lab-rocket", ws, asm, model);
    expect(evalRes.readyForSim).toBe(true);

    const compiled = compileAssemblyToMujoco(ws, asm, { arena: "launch_complex" });
    const { frames } = await runInWasm(compiled);
    const peakZ = Math.max(...frames.map((f) => f.pointM[2]));
    expect(peakZ - frames[0]!.pointM[2]).toBeGreaterThan(0.5);
  });
});
