import { readFile } from "node:fs/promises";
import loadMujoco, { type MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ROBOT_EXAMPLES } from "../contracts/robot-examples";
import { describeModel, readModelFiles, sha256Hex } from "../src/lib/model-files";
import { compileImportedModel } from "../src/lib/imported-physics-model";
import { createImportedPhysics } from "../src/lib/imported-physics-core";
import { fetchRobotExample } from "../src/lib/robot-example-files";

let mj: MainModule;
beforeAll(async () => {
  const wasm = await readFile(new URL(import.meta.resolve("@mujoco/mujoco/mujoco.wasm")));
  mj = await loadMujoco({ wasmBinary: wasm });
}, 60_000);

describe("开源机器人目录的可下载模型", () => {
  it("每条深链对应一个独立的固定版本", () => {
    expect(new Set(ROBOT_EXAMPLES.map(example => example.id)).size).toBe(ROBOT_EXAMPLES.length);
    for (const example of ROBOT_EXAMPLES) {
      expect(example.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(example.sourceUrl).toMatch(/^https:\/\/github\.com\/.+\/tree\/[0-9a-f]{40}\//);
    }
  });

  it("目录下载收到同长度的其他内容时拒绝打开", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    try {
      await expect(fetchRobotExample({ ...ROBOT_EXAMPLES[0], bytes: 3 })).rejects.toThrow("模型包与目录版本不一致");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(ROBOT_EXAMPLES)("$name 可通过通用导入器校验、编译和运行目录工况", async example => {
    const folder = new URL(`../public/robots/${example.id}/`, import.meta.url);
    const [zip, source, preview] = await Promise.all([
      readFile(new URL("model.zip", folder)),
      readFile(new URL("SOURCE.md", folder), "utf8"),
      readFile(new URL("preview.webp", folder)),
    ]);
    expect(zip.byteLength).toBe(example.bytes);
    expect(await sha256Hex(zip)).toBe(example.sha256);
    expect(source).toContain(example.sha256);
    expect(preview.toString("ascii", 8, 12)).toBe("WEBP");

    const { files, entries } = await readModelFiles([new File([new Uint8Array(zip)], `${example.id}.zip`)]);
    expect(entries).toContain(example.entry);
    const licenses = files.filter(file => /(?:^|\/)LICENSE(?:[-.][^/]*)?$/i.test(file.path))
      .map(file => new TextDecoder().decode(file.data)).join("\n");
    for (const spdx of example.license.split(" / ")) {
      if (spdx === "Apache-2.0") expect(licenses).toMatch(/Apache License\s+Version 2\.0/);
      else if (spdx === "MIT") expect(licenses).toContain("Permission is hereby granted, free of charge");
      else if (spdx === "BSD-2-Clause" || spdx === "BSD-3-Clause") {
        expect(licenses).toContain("Redistribution and use in source and binary forms");
        if (spdx === "BSD-3-Clause") expect(licenses).toMatch(/neither the name/i);
      } else throw new Error(`请核对新增模型的许可证 ${spdx}。`);
    }

    const bundle = { entry: example.entry, files };
    expect(await describeModel(bundle)).toMatchObject({ id: example.modelId, entry: example.entry });
    const model = await compileImportedModel(mj, bundle);
    try {
      const engine = createImportedPhysics(mj, model);
      const trial = example.trial ?? {
        keyframe: example.preferredKeyframe,
        durationS: 1,
        controls: example.preferredKeyframe ? engine.previewKeyframe(example.preferredKeyframe).controls : engine.info.actuators.map(a => a.initial),
        pointId: engine.info.points[0].id,
      };
      const samples = engine.run(trial), first = samples[0], last = samples.at(-1)!;
      expect(first.timeS).toBe(0);
      expect(last.timeS).toBeCloseTo(trial.durationS, 8);
      expect(samples.every(s => s.qpos.every(Number.isFinite) && s.qvel.every(Number.isFinite) && s.pointM.every(Number.isFinite))).toBe(true);
      if (example.id === "open-duck-mini-v2") {
        expect(engine.info.actuators).toHaveLength(16);
        const yaw = engine.info.positions.findIndex(channel => channel.name === "head_yaw");
        expect(last.qpos[yaw]).toBeCloseTo(0.246071, 4);
      } else if (example.id === "lekiwi") {
        expect(engine.info.joints).toHaveLength(9);
        expect(engine.info.actuators).toHaveLength(0);
        expect(last.pointM[2]).toBeCloseTo(0.119028, 4);
      } else if (example.id === "barkour-v0") {
        expect(engine.info.actuators).toHaveLength(12);
        expect(engine.previewKeyframe("standing").controls).toEqual(trial.controls);
        expect(first.pointM[2]).toBeCloseTo(0.21, 6);
        expect(last.pointM[2]).toBeCloseTo(0.174825, 4);
      } else if (example.id === "robotiq-2f85") {
        const padAt = (name: string, ctrl: number) => {
          const point = engine.info.points.find(p => p.name === name && p.kind === "body")!;
          return engine.run({ ...trial, pointId: point.id, controls: [ctrl] }).at(-1)!.pointM;
        };
        const spacing = (ctrl: number) => {
          const left = padAt("left_pad", ctrl), right = padAt("right_pad", ctrl);
          return 1000 * Math.hypot(...left.map((v, i) => v - right[i]));
        };
        expect(spacing(0) - spacing(255)).toBeCloseTo(37.9122, 2);
      } else if (example.id === "turtlebot3-burger") {
        expect(last.pointM[0] - first.pointM[0]).toBeCloseTo(0.097917, 4);
        const turn = engine.run({ ...trial, controls: [3, -3] }).at(-1)!;
        const [w, x, y, z] = turn.qpos.slice(3, 7);
        const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
        expect(yaw * 180 / Math.PI).toBeCloseTo(-69.374, 1);
      } else if (example.id === "ur5e") {
        expect(engine.info.actuators).toHaveLength(6);
        const held = engine.run({ ...trial, controls: engine.previewKeyframe("home").controls }).at(-1)!;
        expect(1000 * Math.hypot(...last.pointM.map((v, i) => v - held.pointM[i]))).toBeCloseTo(101.46, 1);
      }
    } finally {
      model.delete();
    }
  }, 120_000);
});
