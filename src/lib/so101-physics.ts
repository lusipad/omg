import loadMujoco from "@mujoco/mujoco";
import wasmUrl from "@mujoco/mujoco/mujoco.wasm?url";
import { compileSo101Model, createSo101Physics, type So101Physics } from "./so101-physics-core";

export type { So101Physics } from "./so101-physics-core";
let loading: Promise<So101Physics> | undefined;
let release: (() => void) | undefined;

async function initialize(): Promise<So101Physics> {
  const mj = await loadMujoco({ locateFile: () => wasmUrl });
  const model = await compileSo101Model(mj, async (path) => {
    const response = await fetch(`${import.meta.env.BASE_URL}models/so101/${path}`);
    if (!response.ok) throw new Error(`SO-101 模型资源读取失败（${response.status}）${path}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  try {
    const physics = createSo101Physics(mj, model);
    release = () => model.delete();
    return physics;
  } catch (error) {
    model.delete();
    throw error;
  }
}

export function loadSo101Physics(): Promise<So101Physics> {
  loading ??= initialize().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => { void loading?.then(() => release?.(), () => {}); });
}
