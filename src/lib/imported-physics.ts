import type { ModelBundle } from "@contracts/import-catalog";
import type { ImportedPhysics, ImportedWorkerRequest, ImportedWorkerResponse } from "@contracts/imported-physics";

export type { ImportedPhysics } from "@contracts/imported-physics";

export async function loadImportedPhysics(bundle: ModelBundle, signal?: AbortSignal): Promise<ImportedPhysics> {
  if (signal?.aborted) throw new Error("模型加载已取消。");
  const worker = new Worker(new URL("./imported-physics.worker.ts", import.meta.url), { type: "module" });
  let closed = false;
  let pending: { resolve(value: ImportedWorkerResponse): void; reject(error: Error): void; timer: number } | undefined;
  const onAbort = () => stop("模型计算已取消。");
  function stop(message: string) {
    if (closed) return;
    closed = true;
    // WASM 堆、编译后的模型和进行中的同步 mj_step 均由此 Dedicated Worker 独占。
    worker.terminate();
    signal?.removeEventListener("abort", onAbort);
    if (pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pending = undefined;
    }
  }
  worker.onerror = (event) => { event.preventDefault(); stop(event.message || "模型计算线程异常终止。"); };
  worker.onmessageerror = () => stop("无法读取模型计算线程的结果。");
  worker.onmessage = ({ data }: MessageEvent<ImportedWorkerResponse>) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    window.clearTimeout(current.timer);
    if (data.type === "error") current.reject(new Error(data.message));
    else current.resolve(data);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  function request(message: ImportedWorkerRequest, timeoutMs: number): Promise<ImportedWorkerResponse> {
    if (closed) return Promise.reject(new Error("计算线程已关闭，请重新打开模型。"));
    if (pending) return Promise.reject(new Error("已有模型计算正在进行。"));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => stop("模型计算超时，线程已释放。请缩小模型或缩短运行时间后重新打开。"), timeoutMs);
      pending = { resolve, reject, timer };
      try { worker.postMessage(message); } catch (error) { stop(error instanceof Error ? error.message : "模型传输失败。"); }
    });
  }
  try {
    const loaded = await request({ type: "open", bundle }, 60_000);
    if (loaded.type !== "loaded") throw new Error("计算线程未返回模型信息。");
    return {
      info: loaded.info,
      async previewKeyframe(name) {
        const result = await request({ type: "pose", name }, 20_000);
        if (result.type !== "pose") throw new Error("计算线程未返回初始关键帧。");
        return result.state;
      },
      async run(settings) {
        const result = await request({ type: "run", settings }, 20_000);
        if (result.type !== "ran") throw new Error("计算线程未返回仿真结果。");
        return result.samples;
      },
      dispose: onAbort,
    };
  } catch (error) {
    stop("模型加载失败。");
    throw error;
  }
}
