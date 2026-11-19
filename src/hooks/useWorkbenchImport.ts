import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DevicePackage } from "@contracts/twin-device";
import type { ModelSelection } from "@/lib/model-files";
import { inspectWorkbenchFiles, inspectWorkbenchText, type WorkbenchImportCandidate, type WorkbenchImportOptions, type WorkbenchImportResult } from "@/lib/workbench-import";

type ImportState =
  | { phase: "idle" }
  | { phase: "reading"; name: string }
  | { phase: "failed"; error: string }
  | { phase: "preview"; candidate: WorkbenchImportCandidate; confirmed: boolean; busy: boolean; error: string };

type Job = { controller: AbortController; applying: boolean; candidate?: WorkbenchImportCandidate; done?: boolean; onCommitted?: () => void };

export const ImportStartContext = createContext<EventTarget | null>(null);

/** Interrupt a pending catalogue download or generation before a newer import can be previewed. */
export function useCancelOnNewImport(cancel: () => void) {
  const events = useContext(ImportStartContext);
  useLayoutEffect(() => {
    events?.addEventListener("start", cancel);
    return () => events?.removeEventListener("start", cancel);
  }, [events, cancel]);
}

export function useWorkbenchImport(onModel: (selection: ModelSelection, onInstalled?: () => void) => void) {
  const [state, setState] = useState<ImportState>({ phase: "idle" });
  const [events] = useState(() => new EventTarget());
  const active = useRef<Job | null>(null);
  const cancel = useCallback(() => {
    if (!active.current) return;
    active.current.controller.abort();
    active.current = null;
    setState({ phase: "idle" });
  }, []);
  useEffect(() => () => active.current?.controller.abort(), []);

  function begin() {
    active.current?.controller.abort();
    events.dispatchEvent(new Event("start"));
    const job: Job = { controller: new AbortController(), applying: false };
    active.current = job;
    return job;
  }

  async function inspect(name: string, read: (signal: AbortSignal) => Promise<WorkbenchImportResult>, onCommitted?: () => void) {
    const job = begin(), { controller } = job;
    job.onCommitted = onCommitted;
    setState({ phase: "reading", name });
    try {
      const item = await read(controller.signal);
      if (controller.signal.aborted) return;
      if (item.kind === "model") {
        cancel();
        onModel(item.selection, onCommitted);
      } else {
        job.candidate = item;
        setState({ phase: "preview", candidate: item, confirmed: false, busy: false, error: "" });
      }
    } catch (cause) {
      if (!controller.signal.aborted) setState({ phase: "failed", error: cause instanceof Error ? cause.message : "导入资料读取失败。" });
    }
  }

  function previewDevice(device: DevicePackage, confirmed = false) {
    const job = begin();
    job.candidate = { kind: "device", device, name: device.model };
    job.done = confirmed;
    setState({ phase: "preview", candidate: job.candidate, confirmed, busy: false, error: "" });
  }

  async function confirm(apply: (candidate: WorkbenchImportCandidate, signal: AbortSignal) => void | Promise<void>) {
    const job = active.current;
    if (state.phase !== "preview" || !job || job.done || job.applying || job.controller.signal.aborted || job.candidate !== state.candidate) return;
    job.applying = true;
    setState({ ...state, busy: true, error: "" });
    try {
      await apply(state.candidate, job.controller.signal);
      job.onCommitted?.();
      if (job.controller.signal.aborted) return;
      job.done = true;
      if (state.candidate.kind === "device") setState({ ...state, confirmed: true, busy: false, error: "" });
      else cancel();
    } catch (cause) {
      if (!job.controller.signal.aborted) setState({ ...state, busy: false, error: cause instanceof Error ? cause.message : "导入失败。" });
    } finally {
      job.applying = false;
    }
  }

  return {
    state, events, cancel, confirm, previewDevice,
    files: (files: File[], options?: WorkbenchImportOptions) => {
      if (files.length) void inspect(files[0].name, signal => inspectWorkbenchFiles(files, options, signal));
    },
    text: (content: string, name: string, options?: WorkbenchImportOptions, onCommitted?: () => void) => {
      void inspect(name, signal => inspectWorkbenchText(content, name, options, signal), onCommitted);
    },
  };
}
