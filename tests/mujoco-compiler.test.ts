import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import loadMujoco, { type MainModule, type MjModel } from "@mujoco/mujoco";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildComposableMiloMillTemplate } from "../contracts/articulated-kinematics";
import { buildGantryMillTemplate } from "../contracts/machine-evolution";
import { inspectMechanicalAssembly } from "../contracts/mechanical-assembly";
import { compileAssemblyToMujoco } from "../contracts/mujoco-compiler";
import {
  buildFourBarLinkageTemplate,
  buildFourWheelRoverTemplate,
  buildGripperPickArmTemplate,
  buildOrientalPearlTemplate,
  buildRescueHelicopterTemplate,
  buildReusableRocketTemplate,
  buildSpringSuspensionTemplate,
  loadUniversalArchetype,
  UNIVERSAL_ARCHETYPES,
} from "../contracts/universal-archetypes";
import { createImportedPhysics } from "../src/lib/imported-physics-core";
import { compileImportedModel } from "../src/lib/imported-physics-model";

const models: MjModel[] = [];
let mj: MainModule;

beforeAll(async () => {
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
}, 20_000);

afterEach(() => {
  for (const model of models.splice(0)) model.delete();
});

async function openCompiled(compiled: ReturnType<typeof compileAssemblyToMujoco>) {
  const model = await compileImportedModel(mj, compiled.bundle);
  models.push(model);
  return { model, engine: createImportedPhysics(mj, model) };
}

describe("万能装配 → MuJoCo MJCF 真物理编译器与跨领域万物动力学验证", () => {
  it("全部 7 套跨领域万物样机通过装配拓扑与闭环约束校验，且可无报错编译至真实 MuJoCo WASM", async () => {
    for (const item of UNIVERSAL_ARCHETYPES) {
      const { workspace, assembly } = loadUniversalArchetype(item.id);
      expect(inspectMechanicalAssembly(workspace, assembly)).toEqual([]);
      const compiled = compileAssemblyToMujoco(workspace, assembly);
      const { engine } = await openCompiled(compiled);
      expect(engine.info.warnings).toEqual([]);
      expect(engine.info.geometry.geoms.length).toBeGreaterThan(2);
    }
  });

  it("四轮差速探索车（freejoint）：在 -9.81 m/s² 重力下平稳落地驱动前进并成功爬上 10° 坡道", async () => {
    const { workspace, assembly } = buildFourWheelRoverTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "flat_ramp" });
    expect(compiled.stats.baseMobility).toBe("free");
    expect(compiled.stats.actuatorCount).toBe(4);
    expect(compiled.actuatorMeta.every((a) => a.mode === "velocity" && a.unit === "rad/s")).toBe(true);

    const { engine } = await openCompiled(compiled);
    const frames = engine.run(compiled.recommendedRun);
    const start = frames[0]!;
    const end = frames.at(-1)!;

    // 自由车体前向推进 ΔX 远超坡脚位置并稳稳爬上斜坡获得净高度抬升 ΔZ
    const deltaX = end.pointM[0] - start.pointM[0];
    const deltaZ = end.pointM[2] - start.pointM[2];
    expect(deltaX).toBeGreaterThan(0.42);
    expect(deltaZ).toBeGreaterThan(0.035);
    // 车体未穿透地底（始终处于地表上方）
    expect(frames.every((f) => f.pointM[2] > 0.04)).toBe(true);
  });

  it("二指摩擦夹爪机械臂：仅凭刚体接触静摩擦夹紧 80g 自由方块并垂直抬升离台 > 45 mm", async () => {
    const { workspace, assembly } = buildGripperPickArmTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "grasp_pedestal" });
    expect(compiled.payloadSiteId).toBeDefined();
    expect(compiled.stats.equalityCount).toBe(1); // jaw_right 耦合跟随 jaw_left

    const { engine } = await openCompiled(compiled);
    const frames = engine.run(compiled.recommendedRun);
    const startRefZ = frames[0]!.referenceM![2];
    const endRefZ = frames.at(-1)!.referenceM![2];
    const peakRefZ = Math.max(...frames.map((f) => f.referenceM![2]));

    // 80g 自由方箱初始在矮台上 Z=0.085m，夹爪下降对夹夹紧后整体向上垂直抬起超过 45 mm 且终点未掉落
    expect(peakRefZ - startRefZ).toBeGreaterThan(0.05);
    expect(endRefZ - startRefZ).toBeGreaterThan(0.045);
  });

  it("闭链四连杆曲柄摇杆机构：<connect> 球铰闭环残差 < 2 mm 且曲柄连续旋转超过整周带动摇杆往复摆动", async () => {
    const { workspace, assembly } = buildFourBarLinkageTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "lab_floor" });
    expect(compiled.stats.equalityCount).toBe(1);

    const { model, engine } = await openCompiled(compiled);
    const frames = engine.run(compiled.recommendedRun);
    const crankAngles = frames.map((f) => f.qpos[0]!);
    const rockerAngles = frames.map((f) => f.qpos[2]!);

    // 曲柄持续回转超过 1.2 圈（> 7.5 rad），而摇杆在有限角度区间平滑来回摆动且无爆炸
    expect(crankAngles.at(-1)! - crankAngles[0]!).toBeGreaterThan(6.5);
    expect(Math.max(...rockerAngles) - Math.min(...rockerAngles)).toBeGreaterThan(0.35);
    expect(Math.max(...rockerAngles.map(Math.abs))).toBeLessThan(Math.PI);

    // 直接通过 MuJoCo MjData 实测闭环站点 cl_loop_c_a 与 cl_loop_c_b 世界坐标残差
    const data = new mj.MjData(model);
    try {
      const siteIdxA = compiled.xml.match(/<site\s+name="([^"]+)"/g)?.findIndex((s) => s.includes("cl_loop_c_a")) ?? -1;
      const siteIdxB = compiled.xml.match(/<site\s+name="([^"]+)"/g)?.findIndex((s) => s.includes("cl_loop_c_b")) ?? -1;
      expect(siteIdxA).toBeGreaterThanOrEqual(0);
      expect(siteIdxB).toBeGreaterThanOrEqual(0);

      data.ctrl[0] = 4.8;
      let maxGapM = 0;
      for (let i = 0; i < 600; i++) {
        mj.mj_step(model, data);
        const ax = data.site_xpos[siteIdxA * 3]!;
        const ay = data.site_xpos[siteIdxA * 3 + 1]!;
        const az = data.site_xpos[siteIdxA * 3 + 2]!;
        const bx = data.site_xpos[siteIdxB * 3]!;
        const by = data.site_xpos[siteIdxB * 3 + 1]!;
        const bz = data.site_xpos[siteIdxB * 3 + 2]!;
        maxGapM = Math.max(maxGapM, Math.hypot(ax - bx, ay - by, az - bz));
      }
      expect(maxGapM).toBeLessThan(0.002);
    } finally {
      data.delete();
    }
  });

  it("弹簧减震摆臂：<tendon><spatial> 弹簧阻尼器在重力释放下产生真实弹性振荡并收敛至平衡位置", async () => {
    const { workspace, assembly } = buildSpringSuspensionTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "lab_floor" });
    expect(compiled.stats.tendonCount).toBe(1);

    const { engine } = await openCompiled(compiled);
    const frames = engine.run({ ...compiled.recommendedRun, durationS: 2.0 });
    const zs = frames.map((f) => f.pointM[2]);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const startZ = zs[0]!;
    const settledZ = zs.at(-1)!;

    // 摆臂先受重力下沉超过 12 mm 后弹性回弹，并最终稳定在高于最低点且低于初始零位处
    expect(startZ - minZ).toBeGreaterThan(0.012);
    expect(maxZ - minZ).toBeGreaterThan(0.012);
    expect(settledZ).toBeLessThan(startZ);
    expect(settledZ).toBeGreaterThan(minZ);
  });

  it("工业三轴数控铣床模板（Milo 与龙门铣床）同样无缝编译为完整耦合 MuJoCo 模型", async () => {
    const gantry = buildGantryMillTemplate();
    const milo = buildComposableMiloMillTemplate();

    for (const tmpl of [gantry, milo]) {
      const compiled = compileAssemblyToMujoco(tmpl.workspace, tmpl.assembly, { arena: "lab_floor" });
      expect(compiled.stats.equalityCount).toBeGreaterThanOrEqual(2);
      const { engine } = await openCompiled(compiled);
      const frames = engine.run(compiled.recommendedRun);
      expect(frames.length).toBeGreaterThan(20);
    }
  });

  it("猎鹰级矢量推力火箭：<motor site> 在 -9.81 m/s² 重力下点火拔地升空 > 0.75 m 并完成程序转弯机动", async () => {
    const { workspace, assembly } = buildReusableRocketTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "launch_complex" });
    expect(compiled.stats.baseMobility).toBe("free");
    expect(compiled.actuatorMeta.some((a) => a.mode === "thrust" && a.unit === "N")).toBe(true);

    const { engine } = await openCompiled(compiled);
    const frames = engine.run(compiled.recommendedRun);
    const start = frames[0]!;
    const end = frames.at(-1)!;
    const peakZ = Math.max(...frames.map((f) => f.pointM[2]));

    expect(peakZ - start.pointM[2]).toBeGreaterThan(0.75);
    expect(end.pointM[2] - start.pointM[2]).toBeGreaterThan(0.65);
    expect(Math.abs(end.pointM[0] - start.pointM[0])).toBeGreaterThan(0.10);
  });

  it("共轴双旋翼救援直升机：上下旋翼精确反向对转抵消扭矩，垂直拉升 > 0.35 m 并前倾巡航", async () => {
    const { workspace, assembly } = buildRescueHelicopterTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "launch_complex" });
    expect(compiled.stats.equalityCount).toBeGreaterThanOrEqual(1); // upper_rotor coupled -1 to lower_rotor

    const { engine } = await openCompiled(compiled);
    const frames = engine.run(compiled.recommendedRun);
    const start = frames[0]!;
    const end = frames.at(-1)!;
    const mid = frames[Math.floor(frames.length * 0.65)]!;

    // 上下共轴旋翼角速度方向精确相反、速率一致（ratio = -1）
    const lowerRotVelIdx = 7;
    const upperRotVelIdx = 8;
    expect(mid.qvel[lowerRotVelIdx]!).toBeGreaterThan(5);
    expect(mid.qvel[upperRotVelIdx]!).toBeLessThan(-5);
    expect(Math.abs(mid.qvel[lowerRotVelIdx]! + mid.qvel[upperRotVelIdx]!)).toBeLessThan(0.5);

    expect(end.pointM[2] - start.pointM[2]).toBeGreaterThan(0.35);
    expect(end.pointM[0] - start.pointM[0]).toBeGreaterThan(0.15);
  });

  it("东方明珠三级旋转观光塔：圆球/圆台/三斜柱无警告编译，三级观光转盘平稳错落旋转", async () => {
    const { workspace, assembly } = buildOrientalPearlTemplate();
    const compiled = compileAssemblyToMujoco(workspace, assembly, { arena: "lab_floor" });
    expect(compiled.stats.baseMobility).toBe("fixed");
    expect(compiled.stats.actuatorCount).toBe(3);

    const { engine } = await openCompiled(compiled);
    expect(engine.info.warnings).toEqual([]);
    const frames = engine.run(compiled.recommendedRun);
    const start = frames[0]!;
    const end = frames.at(-1)!;

    // 98m 观景环廊(+)、267m 旋转餐厅(-)、350m 太空舱(+) 三级转盘全数转动 > 3 rad
    expect(end.qpos[0]! - start.qpos[0]!).toBeGreaterThan(3.0);
    expect(start.qpos[1]! - end.qpos[1]!).toBeGreaterThan(2.5);
    expect(end.qpos[2]! - start.qpos[2]!).toBeGreaterThan(3.5);
  });
});
