import { describe, expect, it } from "vitest";
import { solveArticulatedAssembly } from "../contracts/articulated-kinematics";
import { evaluateBindingReadiness } from "../contracts/device-model-binding";
import { inspectMechanicalAssembly } from "../contracts/mechanical-assembly";
import {
  convertSandboxToSystemTwin,
  createChallengeSolution,
  createChallengeStarter,
  evaluateChallengeProgress,
  extractSandboxBomSummary,
  removeSandboxNode,
  SANDBOX_CHALLENGES,
  sandboxBomToCsv,
  snapBlockOntoAssembly,
  updateSandboxNode,
} from "../contracts/sandbox-challenges";
import { readStudioRoute, studioHref } from "../contracts/studio-navigation";
import { evaluateSystemReadiness } from "../contracts/system-twin";
import { packageKey } from "../contracts/twin-device";

describe("构元 3D 积木吸附拼装、渐进关卡挑战与现实 BOM / Modelica 转译", () => {
  it("从单梁底座逐步吸附滑台、工作台板、自动耦合丝杠与限位开关并通关第 1 关", () => {
    const challenge = SANDBOX_CHALLENGES.find((c) => c.id === "level-1-axis")!;
    const starter = createChallengeStarter("level-1-axis");
    expect(inspectMechanicalAssembly(starter.workspace, starter.assembly)).toEqual([]);

    const step1 = snapBlockOntoAssembly(starter.workspace, starter.assembly, "slide_x", "axis_base", "top");
    const step2 = snapBlockOntoAssembly(step1.workspace, step1.assembly, "table_plate", step1.addedNodeId, "carriage_top");
    const step3 = snapBlockOntoAssembly(step2.workspace, step2.assembly, "ball_screw", "axis_base", "pos_y");
    const step4 = snapBlockOntoAssembly(step3.workspace, step3.assembly, "limit_switch", "axis_base", "neg_y");

    expect(inspectMechanicalAssembly(step4.workspace, step4.assembly)).toEqual([]);
    const screwNode = step4.assembly.nodes.find((n) => n.id === step3.addedNodeId)!;
    expect(screwNode.coupledTo?.path).toBe(step1.addedNodeId);

    const movedSolve = solveArticulatedAssembly(step4.workspace, step4.assembly, {
      commandOverrides: { [step1.addedNodeId]: 100 },
    });
    const evalRes = evaluateChallengeProgress(challenge, step4.workspace, step4.assembly, movedSolve, new Set());
    expect(evalRes.completed).toBe(true);
    expect(evalRes.hitCount).toBe(1);
    expect(movedSolve.coupledControls[0]?.value).toBeCloseTo(100 * 45, 5);
  });

  it("支持调整积木尺寸、旋转方向、替换为松下/汇川真实型号以及连带拆除下级子件", () => {
    const starter = createChallengeStarter("level-1-axis");
    const withMotor = snapBlockOntoAssembly(starter.workspace, starter.assembly, "servo_motor", "axis_base", "neg_x");
    const withArm = snapBlockOntoAssembly(withMotor.workspace, withMotor.assembly, "arm_link", withMotor.addedNodeId, "top");

    const updated = updateSandboxNode(withArm.workspace, withArm.assembly, withMotor.addedNodeId, {
      vendorPresetId: "motor-panasonic-400w",
      rotateZ90: true,
    });
    const motorNode = updated.assembly.nodes.find((n) => n.id === withMotor.addedNodeId)!;
    const motorPkg = updated.workspace.packages.find((p) => packageKey(p) === motorNode.packageKey)!;
    expect(motorPkg.manufacturer).toBe("Panasonic");
    expect(motorPkg.model).toBe("MSMF042L1V2M");

    const ready = evaluateBindingReadiness(motorPkg, { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" });
    expect(ready.status).toBe("ready");
    expect(ready.values.rotorInertiaKgM2).toBeCloseTo(0.000014, 10);

    // 拆除电机应连同子件 arm_link 一起干净清除
    const pruned = removeSandboxNode(updated.workspace, updated.assembly, withMotor.addedNodeId);
    expect(pruned.nodes.some((n) => n.id === withMotor.addedNodeId)).toBe(false);
    expect(pruned.nodes.some((n) => n.id === withArm.addedNodeId)).toBe(false);
    expect(inspectMechanicalAssembly(updated.workspace, pruned)).toEqual([]);
  });

  it("所有 4 个关卡的初始沙盘与参考答案结构零报错，运行演示路点后均可全部通关（涵盖三轴铣床与三自由度机械臂）", () => {
    for (const challenge of SANDBOX_CHALLENGES) {
      const starter = createChallengeStarter(challenge.id);
      expect(inspectMechanicalAssembly(starter.workspace, starter.assembly)).toEqual([]);

      const solution = createChallengeSolution(challenge.id);
      expect(inspectMechanicalAssembly(solution.workspace, solution.assembly)).toEqual([]);

      if (challenge.id === "free-sandbox") continue;

      const visited = new Set<string>();
      let lastEval = evaluateChallengeProgress(
        challenge,
        solution.workspace,
        solution.assembly,
        solveArticulatedAssembly(solution.workspace, solution.assembly),
        visited,
      );
      for (const hitId of lastEval.newlyHitIds) visited.add(hitId);

      for (const wp of challenge.demoSweep ?? []) {
        const solved = solveArticulatedAssembly(solution.workspace, solution.assembly, { commandOverrides: wp });
        lastEval = evaluateChallengeProgress(challenge, solution.workspace, solution.assembly, solved, visited);
        for (const hitId of lastEval.newlyHitIds) visited.add(hitId);
      }

      expect(lastEval.hitCount).toBe(challenge.targets.length);
      expect(lastEval.completed).toBe(true);
    }
  });

  it("自由/关卡拼装可实时汇总 BOM 并直接一键转换为可执行 Modelica 闭环系统", () => {
    const mill = createChallengeSolution("level-3-cnc-mill");
    const rows = extractSandboxBomSummary(mill.workspace, mill.assembly);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    const csv = sandboxBomToCsv(rows);
    expect(csv).toContain("品牌,型号,类别,包络尺寸,数量");
    expect(csv).toContain("滚珠丝杠");

    const { workspace, system } = convertSandboxToSystemTwin(mill.workspace, mill.assembly);
    const report = evaluateSystemReadiness(workspace, system);
    expect(report.blockingErrors).toEqual([]);
    expect(report.pendingItems).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("sandbox 路由参数支持 URL 往返且兼容既有空地址规则", () => {
    const route = { view: "sandbox", level: "level-3-cnc-mill" } as const;
    const href = studioHref(route);
    expect(href).toBe("?view=sandbox&level=level-3-cnc-mill");
    expect(readStudioRoute(href)).toEqual(route);
    expect(readStudioRoute("?view=sandbox")).toEqual({ view: "sandbox" });
  });
});
