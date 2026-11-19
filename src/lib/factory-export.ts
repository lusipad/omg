import { resolveFactoryLayout, type FactoryLayout } from "@contracts/factory";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { MAX_PROJECT_JSON_BYTES } from "@contracts/import-catalog";
import { compositionRollupCsv } from "@contracts/device-composition";
import { factoryStructureSnapshot } from "@contracts/factory-structure";
import deviceManifest from "../../public/modelica/runtime/factory-models.json";
import scheduleManifest from "../../public/modelica/runtime/factory-scheduler.json";
import { factoryModelicaFiles } from "./factory-modelica";
import { runFactory } from "./factory-runtime";
import { archiveBlob, sha256Hex } from "./model-files";

export async function exportFactoryModelica(workspace: TwinWorkspace, layout: FactoryLayout, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const factory = resolveFactoryLayout(workspace, layout);
  const sources = [
    { path: "GouyuanFactory/package.mo", hash: deviceManifest.sourceSha256 },
    { path: "GouyuanFactory/Resources/Include/factory_schedule.h", hash: scheduleManifest.sourceSha256 },
  ];
  const [result, dependencies] = await Promise.all([runFactory(workspace, layout, signal), Promise.all(sources.map(async ({ path, hash }) => {
    const response = await fetch(import.meta.env.BASE_URL + "modelica/" + path + "?sha256=" + hash, { signal });
    if (!response.ok) throw new Error(`未能读取工厂源码 ${path}（HTTP ${response.status}）。`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (await sha256Hex(data) !== hash) throw new Error(`工厂源码 ${path} 的 SHA-256 与已发布模型不一致。`);
    return { path, data };
  }))]);
  signal?.throwIfAborted();
  const text = new TextEncoder();
  const snapshot = factoryStructureSnapshot(workspace, layout);
  const files = { ...factoryModelicaFiles(factory, result.makespanS),
    "layout.factory.json": JSON.stringify(layout, null, 2) + "\n",
    "factory.twin.json": JSON.stringify(snapshot.workspace) + "\n",
    "parts-bom.csv": "\uFEFF" + compositionRollupCsv(snapshot.report) };
  const documents = Object.entries(files).map(([path, body]) => ({ path, data: text.encode(body) }));
  if (documents.some(f => (f.path === "factory.twin.json" || f.path === "factory-map.json") && f.data.length > MAX_PROJECT_JSON_BYTES)) {
    throw new Error("工厂快照或参数映射超过 8 MiB，请核对设备资料的大小后再导出。");
  }
  return archiveBlob([...dependencies, ...documents]);
}
