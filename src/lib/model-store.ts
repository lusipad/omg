import type { ModelBundle, ModelRef } from "@contracts/import-catalog";

export type StoredModel = { ref: ModelRef; bundle: ModelBundle };

async function openModels(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error("当前浏览器无法使用 IndexedDB 保存模型。");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gouyuan-model-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("models");
    request.onerror = () => reject(request.error ?? new Error("无法打开模型资源库。"));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function writeModels(records: StoredModel[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!records.length) return;
  const db = await openModels();
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("models", "readwrite");
      const cancel = () => {
        try { tx.abort(); } catch { /* 已提交的事务由 oncomplete 返回其真实结果。 */ }
      };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = () => {
        cleanup();
        reject(signal?.aborted ? signal.reason : tx.error ?? new Error("保存模型失败，请检查浏览器可用空间。"));
      };
      try {
        const store = tx.objectStore("models");
        for (const { ref, bundle } of records) {
          signal?.throwIfAborted();
          store.put(bundle, ref.id);
        }
      } catch (error) {
        cancel();
        cleanup();
        reject(error);
      }
    });
  } finally { db.close(); }
}

export async function readStoredModel(id: string): Promise<ModelBundle> {
  const db = await openModels();
  try {
    return await new Promise<ModelBundle>((resolve, reject) => {
      const tx = db.transaction("models");
      const request = tx.objectStore("models").get(id);
      tx.onabort = () => reject(tx.error ?? new Error("读取模型资源失败。"));
      tx.oncomplete = () => request.result ? resolve(request.result) : reject(new Error("当前浏览器中缺少模型资源，请导入完整工程包。"));
    });
  } finally { db.close(); }
}
