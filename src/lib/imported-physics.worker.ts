import loadMujoco from "@mujoco/mujoco";
import wasmUrl from "@mujoco/mujoco/mujoco.wasm?url";
import type { ImportedWorkerRequest, ImportedWorkerResponse } from "@contracts/imported-physics";
import { createImportedPhysics } from "./imported-physics-core";
import { compileImportedModel } from "./imported-physics-model";

let physics: ReturnType<typeof createImportedPhysics> | undefined;
const port = self as unknown as {
  onmessage: ((event: MessageEvent<ImportedWorkerRequest>) => void) | null;
  postMessage(value: ImportedWorkerResponse, transfer?: Transferable[]): void;
};

port.onmessage = async ({ data }) => {
  try {
    if (data.type === "open") {
      if (physics) throw new Error("此计算线程已绑定模型。");
      const mj = await loadMujoco({ locateFile: () => wasmUrl });
      const model = await compileImportedModel(mj, data.bundle);
      try { physics = createImportedPhysics(mj, model); } catch (error) { model.delete(); throw error; }
      const { info } = physics;
      const buffers = info.geometry.meshes.flatMap((mesh) => [mesh.vertices.buffer, mesh.indices.buffer] as ArrayBuffer[]);
      port.postMessage({ type: "loaded", info }, buffers);
    } else if (data.type === "pose") {
      if (!physics) throw new Error("请先编译模型。");
      const state = physics.previewKeyframe(data.name);
      port.postMessage({ type: "pose", state }, [state.initial.geomPoses.buffer as ArrayBuffer]);
    } else {
      if (!physics) throw new Error("请先编译模型。");
      const samples = physics.run(data.settings);
      port.postMessage({ type: "ran", samples }, samples.map((s) => s.geomPoses.buffer as ArrayBuffer));
    }
  } catch (error) {
    port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
