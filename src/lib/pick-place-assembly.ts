import type { ModelBundle, ModelRef } from "@contracts/import-catalog";
import { ROBOT_EXAMPLES } from "@contracts/robot-examples";
import { composeUr5eWorkcell } from "@contracts/ur5e-workcell";
import { getModelBundle, readModelFiles } from "./model-files";
import { fetchRobotExample } from "./robot-example-files";

export { isUr5eWorkcell } from "@contracts/ur5e-workcell";

async function loadPart(role: string, id: "ur5e" | "robotiq-2f85" | "cube", installed?: ModelRef, signal?: AbortSignal): Promise<ModelBundle> {
  try {
    signal?.throwIfAborted();
    if (installed) {
      const bundle = await getModelBundle(installed.id);
      if (bundle.entry !== installed.entry) throw new Error("工程记录与组件文件入口不一致。");
      return bundle;
    }
    if (id === "cube") {
      const entry = "workpiece.xml";
      const response = await fetch(`${import.meta.env.BASE_URL}workcells/ur5e-pick-place/${entry}`, { signal });
      if (!response.ok) throw new Error(`下载示例工件失败（HTTP ${response.status}）。`);
      return { entry, files: [{ path: entry, data: new Uint8Array(await response.arrayBuffer()) }] };
    }
    const example = ROBOT_EXAMPLES.find(item => item.id === id);
    if (!example) throw new Error("目录中找不到此组件。");
    const { files, entries } = await readModelFiles([await fetchRobotExample(example, signal)]);
    if (!entries.includes(example.entry)) throw new Error("模型包缺少目录指定的入口文件。");
    return { entry: example.entry, files };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`${role}读取失败。${error instanceof Error ? error.message : "请重新选择组件。"}`);
  }
}

export async function loadWorkcellParts(arm?: ModelRef, gripper?: ModelRef, part?: ModelRef, signal?: AbortSignal): Promise<ModelBundle> {
  const [robot, tool, workpiece] = await Promise.all([
    loadPart("机械臂", "ur5e", arm, signal),
    loadPart("夹爪", "robotiq-2f85", gripper, signal),
    loadPart("工件", "cube", part, signal),
  ]);
  signal?.throwIfAborted();
  return composeUr5eWorkcell(robot, tool, workpiece);
}
