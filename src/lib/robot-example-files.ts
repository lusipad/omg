import type { RobotExample } from "@contracts/robot-examples";
import { sha256Hex } from "./model-files";

export async function fetchRobotExample(example: RobotExample, signal?: AbortSignal): Promise<File> {
  const path = `${import.meta.env.BASE_URL}robots/${example.id}/model.zip?v=${example.sha256}`;
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`“${example.name}”模型下载失败（HTTP ${response.status}），请重试。`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength !== example.bytes || await sha256Hex(data) !== example.sha256) {
    throw new Error(`“${example.name}”模型包与目录版本不一致，请刷新页面后重试。`);
  }
  signal?.throwIfAborted();
  return new File([data], example.id + ".zip", { type: "application/zip" });
}
