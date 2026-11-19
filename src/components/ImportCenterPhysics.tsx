import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Check, Download } from "lucide-react";
import { parseImportCatalog, type ModelBundle, type ModelRef } from "@contracts/import-catalog";
import type { ImportedRunSettings } from "@contracts/imported-physics";
import { PICK_PLACE_EXAMPLE, ROBOT_EXAMPLES, type RobotExample } from "@contracts/robot-examples";
import { getStudioExample, type StudioExample } from "@contracts/studio-navigation";
import { makeStaticMeshBundle } from "@contracts/mesh-model";
import { makeUr5eWorkcellTrial } from "@contracts/ur5e-workcell";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { describeModel, exportModelBundle, getModelBundle, putModelBundle, readWorkbenchBundle, type ModelSelection } from "@/lib/model-files";
import { downloadFile } from "@/lib/download";
import { fetchRobotExample } from "@/lib/robot-example-files";
import { isUr5eWorkcell, loadWorkcellParts } from "@/lib/pick-place-assembly";
import { useCancelOnNewImport } from "@/hooks/useWorkbenchImport";
import type { IncomingWorkbenchModel } from "@/lib/workbench-import";
import { Button } from "@/components/ui/button";
import PickPlaceAssembly from "./PickPlaceAssembly";

const ImportedPhysicsWorkbench = lazy(() => import("./ImportedPhysicsWorkbench"));
type Candidate = { ref: ModelRef; bundle: ModelBundle; source: string; version: number; stored: boolean; workcell: boolean };
type Request = { version: number; signal: AbortSignal };
type Props = {
  workspace: TwinWorkspace;
  onChange: (workspace: TwinWorkspace) => void;
  requested: ModelRef | null;
  exampleId: string | null;
  onClose: () => void;
  onInstalled?: (ref: ModelRef) => void;
  incoming?: IncomingWorkbenchModel;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "模型操作失败，请重试。";

function withModel(current: TwinWorkspace, ref: ModelRef, preserveExisting = false): TwinWorkspace {
  const catalog = current.catalog ?? { models: [], materials: [] };
  const existing = catalog.models.find((model) => model.id === ref.id);
  if (existing && (preserveExisting || !ref.run || existing.run === ref.run)) return current;
  const models = existing ? catalog.models.map((model) => model === existing ? { ...model, run: ref.run } : model) : [...catalog.models, ref];
  return { ...current, catalog: parseImportCatalog({ ...catalog, models }, current.packages) };
}

export default function ImportCenterPhysics({ workspace, onChange, requested, incoming, exampleId, onClose, onInstalled }: Props) {
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [entry, setEntry] = useState("");
  const [unit, setUnit] = useState<"" | "m" | "cm" | "mm">("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const reading = useRef<AbortController | null>(null);
  const installing = useRef<AbortController | null>(null);
  const version = useRef(0), importGeneration = useRef(0);
  const lastRun = useRef<{ version: number; settings: ImportedRunSettings } | null>(null);
  const latest = useRef({ workspace, onChange, requested, incoming });
  useLayoutEffect(() => { latest.current = { workspace, onChange, requested, incoming }; }, [workspace, onChange, requested, incoming]);
  useLayoutEffect(() => {
    if (installing.current) {
      installing.current.abort();
      setNotice("工程已更新，请重新确认加入模型。");
    }
  }, [workspace]);

  const robot = ROBOT_EXAMPLES.find((example) => example.id === exampleId);
  const catalogueEntry = getStudioExample(exampleId), recipe = exampleId === PICK_PLACE_EXAMPLE.id;
  const catalogue = exampleId !== null;
  const source = catalogue ? "example/" + exampleId : requested ? "model/" + requested.id : incoming ? "file/" + incoming.token : "";
  const shown = candidate?.source === source ? candidate : null;
  const models = workspace.catalog?.models ?? [], installed = models.find((model) => model.id === shown?.ref.id);
  const recommendation = catalogue ? robot : shown?.stored ? ROBOT_EXAMPLES.find((example) => example.modelId === shown.ref.id) : undefined;

  const abortRequest = useCallback(() => {
    reading.current?.abort(); reading.current = null;
    return ++version.current;
  }, []);
  const resetCandidate = useCallback((label = "") => {
    const request = abortRequest();
    setCandidate(null); setReady(false); setBusy(label); setNotice(""); setError("");
    return request;
  }, [abortRequest]);
  const discard = useCallback(() => {
    resetCandidate(); setSelection(null); setEntry(""); setUnit("");
  }, [resetCandidate]);
  useCancelOnNewImport(() => { importGeneration.current++; discard(); });

  const load = useCallback(async (label: string, action: (job: Request) => Promise<void>) => {
    const request = resetCandidate(label), controller = new AbortController();
    reading.current = controller;
    try { await action({ version: request, signal: controller.signal }); }
    catch (cause) { if (!controller.signal.aborted && version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) { setBusy(""); reading.current = null; } }
  }, [resetCandidate]);

  const prepare = useCallback(async (bundle: ModelBundle, job: Request, origin: string, name?: string, expectedId?: string) => {
    job.signal.throwIfAborted();
    const ref = await describeModel(bundle);
    job.signal.throwIfAborted();
    if (expectedId && ref.id !== expectedId) throw new Error("模型的入口或文件内容与示例目录不一致，请刷新后重试。");
    setCandidate({ bundle, ref: { ...ref, name: name ?? ref.name }, source: origin, version: job.version, stored: false,
      workcell: ref.id === PICK_PLACE_EXAMPLE.modelId || isUr5eWorkcell(bundle) });
  }, []);

  const loadExample = useCallback(async (job: Request, origin: string, item: StudioExample, example?: RobotExample) => {
    const entryPath = item.entry ?? example?.entry;
    if (!entryPath || (example && entryPath !== example.entry)) throw new Error("示例目录缺少有效的模型入口。");
    const name = item.name;
    if (example && latest.current.workspace.catalog?.models.some((m) => m.id === example.modelId)) {
      const cached = await getModelBundle(example.modelId).catch(() => null);
      job.signal.throwIfAborted();
      if (cached?.entry === example.entry) {
        // 目录可复用已校验的本机文件。试跑从目录工况开始，工程名称和保存的参数由工程资产持有。
        const ref = { id: example.modelId, name, entry: entryPath };
        setCandidate({ ref, bundle: cached, source: origin, version: job.version, stored: false, workcell: false });
        return;
      }
    }
    let file: File;
    if (example) file = await fetchRobotExample(example, job.signal);
    else {
      if (!item.download) throw new Error("示例目录缺少模型下载地址。");
      const url = new URL(import.meta.env.BASE_URL + item.download, document.baseURI);
      const filename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      if (!filename) throw new Error("模型下载地址缺少文件名。");
      const response = await fetch(url, { signal: job.signal });
      if (!response.ok) throw new Error("“" + name + "”模型下载失败（HTTP " + response.status + "）。");
      file = new File([await response.blob()], filename);
    }
    const opened = await readWorkbenchBundle([file], job.signal);
    if (opened.kind !== "model" || !opened.selection.entries.includes(entryPath)) throw new Error("示例包缺少指定的模型入口 " + entryPath + "。");
    await prepare({ entry: entryPath, files: opened.selection.files }, job, origin, name, example?.modelId);
  }, [prepare]);

  useEffect(() => {
    let active = true;
    const generation = importGeneration.current;
    // StrictMode 会探测挂载。选定目标稳定后再开始下载或读取 IndexedDB。
    queueMicrotask(() => {
      if (!active || generation !== importGeneration.current) return;
      const target = latest.current;
      discard();
      if (recipe || !source) return;
      if (catalogue) {
        if (catalogueEntry?.kind !== "physics") { setError("找不到指定的物理模型示例。"); return; }
        void load("正在读取并校验示例…", (job) => loadExample(job, source, catalogueEntry, robot));
      } else if (target.requested) {
        const ref = target.requested;
        void load("正在打开工程模型…", async (job) => {
          const bundle = await getModelBundle(ref.id);
          job.signal.throwIfAborted();
          if (bundle.entry !== ref.entry) throw new Error("工程记录与模型资源入口不一致。");
          setCandidate({ ref, bundle, source, version: job.version, stored: true, workcell: isUr5eWorkcell(bundle) });
        });
      } else if (target.incoming) {
        const picked = target.incoming.selection;
        void load("正在准备本地模型…", async (job) => {
          setSelection(picked);
          if (!picked.entries.length) {
            const meshes = picked.files.filter((f) => /\.(stl|obj)$/i.test(f.path));
            if (meshes.length === 1) setEntry(meshes[0].path);
            return;
          }
          const roots = picked.entries.filter((path) => !path.includes("/"));
          const primary = picked.entries.length === 1 ? picked.entries[0] :
            roots.length === 1 && isUr5eWorkcell({ entry: roots[0], files: picked.files }) ? roots[0] : "";
          setEntry(primary);
          if (primary) await prepare({ entry: primary, files: picked.files }, job, source);
        });
      }
    });
    return () => { active = false; abortRequest(); };
  }, [source, robot, catalogueEntry, recipe, catalogue, attempt, abortRequest, discard, load, loadExample, prepare]);

  function assemble(arm?: ModelRef, gripper?: ModelRef, part?: ModelRef) {
    void load("正在读取组件并组装取放工位…", async (job) => {
      if (!arm && !gripper && !part && models.some((model) => model.id === PICK_PLACE_EXAMPLE.modelId)) {
        const cached = await getModelBundle(PICK_PLACE_EXAMPLE.modelId).catch(() => null);
        job.signal.throwIfAborted();
        if (cached) {
          setCandidate({ ref: { id: PICK_PLACE_EXAMPLE.modelId, name: PICK_PLACE_EXAMPLE.name, entry: cached.entry }, bundle: cached,
            source, version: job.version, stored: false, workcell: true });
          return;
        }
      }
      const bundle = await loadWorkcellParts(arm, gripper, part, job.signal);
      await prepare(bundle, job, source, PICK_PLACE_EXAMPLE.name);
    });
  }

  function selectEntry(path: string) {
    setEntry(path);
    if (selection) void load(path ? "正在读取模型入口…" : "", async (job) => {
      if (path) await prepare({ entry: path, files: selection.files }, job, source);
    });
  }

  function previewMesh() {
    if (selection && unit && entry) void load("正在读取网格…", (job) => prepare(makeStaticMeshBundle(selection.files, entry, unit), job, source));
  }

  function recordRun(settings: ImportedRunSettings) {
    if (!shown || shown.version !== version.current) return;
    lastRun.current = { version: shown.version, settings };
    setCandidate((value) => value?.version === shown.version ? { ...value, ref: { ...value.ref, run: settings } } : value);
    const current = latest.current.workspace;
    if (!catalogue && shown.stored && current.catalog?.models.some((model) => model.id === shown.ref.id)) {
      latest.current.onChange(withModel(current, { ...shown.ref, run: settings }));
    }
  }

  async function install() {
    if (!ready || !shown || busy || shown.stored || reading.current) return;
    const request = shown.version, controller = new AbortController();
    reading.current = installing.current = controller;
    setBusy("正在保存模型资源…"); setError(""); setNotice("");
    try {
      let ref = shown.ref;
      const previous = latest.current.workspace, pending = withModel(previous, ref, catalogue);
      await putModelBundle(ref, shown.bundle, controller.signal);
      controller.signal.throwIfAborted();
      if (version.current !== request) return;
      const current = latest.current.workspace;
      const recent = lastRun.current;
      if (recent?.version === request && recent.settings !== ref.run) ref = { ...ref, run: recent.settings };
      const next = current === previous && ref === shown.ref ? pending : withModel(current, ref, catalogue);
      if (next !== current) latest.current.onChange(next);
      setCandidate((value) => value?.version === request ? { ...value, stored: true } : value);
      if (!catalogue && incoming?.selection === selection) incoming?.onInstalled?.();
      setNotice(catalogue && previous.catalog?.models.some((model) => model.id === ref.id)
        ? "当前工程已有此模型，已保留原来的运行工况。" : "已将“" + ref.name + "”加入当前工程。");
      onInstalled?.(next.catalog?.models.find((model) => model.id === ref.id) ?? ref);
    } catch (cause) { if (!controller.signal.aborted && version.current === request) setError(errorText(cause)); }
    finally {
      if (installing.current === controller) installing.current = null;
      if (version.current === request) { setBusy(""); reading.current = null; }
    }
  }

  function close() { importGeneration.current++; discard(); onClose(); }
  function retry() {
    if (selection && entry && (selection.entries.length || unit)) {
      if (selection.entries.length) selectEntry(entry); else previewMesh();
    } else setAttempt((n) => n + 1);
  }
  function download() {
    if (!shown) return;
    try { downloadFile(exportModelBundle(shown.bundle), shown.ref.name + ".zip"); }
    catch (cause) { setError(errorText(cause)); }
  }
  if (!source) return null;
  return <section aria-label="所选模型预览" className="surface min-w-0 space-y-4 p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {!catalogue && <h2 className="flex items-center gap-2 break-all text-base font-semibold"><Box className="size-4 shrink-0 text-primary" />{shown?.ref.name ?? requested?.name ?? "物理模型"}</h2>}
        {shown && <p className="mt-1 break-all text-xs text-muted-foreground">{shown.bundle.entry} · {shown.bundle.files.length} 个文件</p>}
        {catalogue && installed && shown && !shown.stored && <p className="mt-1 text-xs text-muted-foreground">当前工程已有此模型，加入时会保留工程中已保存的工况。</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {incoming && !catalogue && !shown?.stored && <Button size="sm" variant="ghost" onClick={close}>取消本次导入</Button>}
        {!incoming && busy && <Button size="sm" variant="ghost" onClick={close}>取消操作</Button>}
        {shown && <>
          <Button size="sm" variant="outline" onClick={download}><Download />{shown.workcell ? "下载工位 ZIP" : "下载模型 ZIP"}</Button>
          {shown.stored ? <span className="inline-flex items-center gap-1 text-xs text-primary"><Check />{catalogue ? "已加入当前工程" : "已安装"}</span> :
            <Button size="sm" disabled={!ready || Boolean(busy)} onClick={() => void install()}>加入当前工程</Button>}
        </>}
      </div>
    </header>
    {selection && selection.entries.length > 1 && <label className="block"><span className="field-label">模型入口文件</span>
      <select aria-label="模型入口文件" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={entry} onChange={(event) => selectEntry(event.target.value)}>
        <option value="">请选择需要编译的模型入口</option>{selection.entries.map((path) => <option key={path} value={path}>{path}</option>)}
      </select>
    </label>}
    {selection && !selection.entries.length && <div className="surface-inset space-y-3 p-3">
      <p className="text-xs leading-5 text-muted-foreground">网格作为固定几何预览，请指定原文件的长度单位。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label><span className="field-label">网格文件</span><select aria-label="网格文件" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={entry} onChange={(event) => {
          resetCandidate(); setEntry(event.target.value); setUnit("");
        }}><option value="">选择网格</option>{selection.files.filter((item) => /\.(stl|obj)$/i.test(item.path)).map((item) => <option key={item.path}>{item.path}</option>)}</select></label>
        <label><span className="field-label">网格原始长度单位</span><select aria-label="网格原始长度单位" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={unit} onChange={(event) => {
          resetCandidate(); setUnit(event.target.value as typeof unit);
        }}><option value="">请选择原始单位</option><option value="m">米（m）</option><option value="cm">厘米（cm）</option><option value="mm">毫米（mm）</option></select></label>
      </div>
      <Button size="sm" variant="outline" disabled={!entry || !unit || Boolean(busy)} onClick={previewMesh}>预览固定几何</Button>
    </div>}
    {recipe && <PickPlaceAssembly models={models} busy={Boolean(busy)} assembled={!!shown} partUrl={import.meta.env.BASE_URL + "workcells/" + PICK_PLACE_EXAMPLE.id + "/workpiece.xml"}
      onChange={() => discard()} onAssemble={assemble} />}
    {busy && <p role="status" className="text-sm text-muted-foreground">{busy}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
    {!shown && !busy && !recipe && (error || !selection) && <Button size="sm" variant="outline" onClick={retry}>重新打开模型</Button>}
    {shown && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载模型预览…</p>}>
      <ImportedPhysicsWorkbench key={shown.version} bundle={shown.bundle} onReady={(ok) => { if (shown.version === version.current) setReady(ok); }}
        initialSettings={catalogue ? recommendation?.trial : installed?.run ?? shown.ref.run ?? recommendation?.trial}
        createInitialSettings={shown.workcell ? makeUr5eWorkcellTrial : undefined} preferredKeyframe={recommendation?.preferredKeyframe} onRun={recordRun} />
    </Suspense>}
  </section>;
}
