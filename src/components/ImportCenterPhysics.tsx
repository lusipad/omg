import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Box, Check, Download, FileUp, FolderOpen, Play } from "lucide-react";
import { parseImportCatalog, type ModelBundle, type ModelFile, type ModelRef } from "@contracts/import-catalog";
import type { ImportedRunSettings } from "@contracts/imported-physics";
import { PICK_PLACE_EXAMPLE, ROBOT_EXAMPLES, type RobotExample } from "@contracts/robot-examples";
import { makeStaticMeshBundle } from "@contracts/mesh-model";
import { makeUr5eWorkcellTrial } from "@contracts/ur5e-workcell";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { describeModel, exportModelBundle, getModelBundle, ProjectArchiveFileError, putModelBundle, readModelFiles } from "@/lib/model-files";
import { downloadFile } from "@/lib/download";
import { fetchRobotExample } from "@/lib/robot-example-files";
import { isUr5eWorkcell, loadWorkcellParts } from "@/lib/pick-place-assembly";
import { Button } from "@/components/ui/button";
import RobotExamples from "./RobotExamples";
import PickPlaceAssembly from "./PickPlaceAssembly";

const ImportedPhysicsWorkbench = lazy(() => import("./ImportedPhysicsWorkbench"));
type Selection = { files: ModelFile[]; entries: string[] };
type Candidate = { ref: ModelRef; bundle: ModelBundle; version: number; stored: boolean; example?: RobotExample; workcell?: "assembled" | "imported" };
type Props = {
  workspace: TwinWorkspace;
  onChange: (workspace: TwinWorkspace) => void;
  requested: ModelRef | null;
  robotId: string | null;
  onLocalChoice: () => void;
  onOpenProject: (file: File) => Promise<void>;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "模型操作失败，请重新选择文件。";

function importedWorkcell(ref: ModelRef, bundle: ModelBundle) {
  return ref.id === PICK_PLACE_EXAMPLE.modelId || isUr5eWorkcell(bundle) ? "imported" : undefined;
}

function withModel(current: TwinWorkspace, ref: ModelRef): TwinWorkspace {
  const catalog = current.catalog ?? { models: [], materials: [] };
  if (catalog.models.some((model) => model.id === ref.id)) return current;
  return { ...current, catalog: parseImportCatalog({ ...catalog, models: [...catalog.models, ref] }, current.packages) };
}

export default function ImportCenterPhysics({ workspace, onChange, requested, onOpenProject, robotId, onLocalChoice }: Props) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [entry, setEntry] = useState("");
  const [unit, setUnit] = useState<"" | "m" | "cm" | "mm">("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const file = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLElement>(null);
  const gallery = useRef<HTMLDivElement>(null);
  const positioned = useRef(0);
  const activeRobot = useRef<string | null>(null);
  const reading = useRef<AbortController | null>(null);
  const version = useRef(0);
  const lastRun = useRef<{ version: number; settings: ImportedRunSettings } | null>(null);
  const latest = useRef({ workspace, onChange, onOpenProject });
  useEffect(() => { latest.current = { workspace, onChange, onOpenProject }; }, [workspace, onChange, onOpenProject]);
  const models = workspace.catalog?.models ?? [];
  const installed = models.find((model) => model.id === candidate?.ref.id);
  const robot = ROBOT_EXAMPLES.find((example) => example.id === robotId);
  const recipe = robotId === PICK_PLACE_EXAMPLE.id;
  const recommendation = candidate?.example ?? (candidate?.stored && installed ? ROBOT_EXAMPLES.find((example) => example.modelId === installed.id) : undefined);
  const candidateRoute = candidate?.workcell === "assembled" ? PICK_PLACE_EXAMPLE.id : candidate?.example?.id ?? null;
  const showCandidate = candidateRoute === robotId;

  const start = useCallback((label: string) => {
    reading.current?.abort(); reading.current = null;
    setCandidate(null); setReady(false); setBusy(label); setError(""); setNotice("");
    return ++version.current;
  }, []);

  function localChoice() {
    activeRobot.current = null;
    onLocalChoice();
  }

  function focusPreview() {
    preview.current?.focus({ preventScroll: true });
    preview.current?.scrollIntoView({ block: "start" });
  }

  const openStored = useCallback(async (ref: ModelRef) => {
    const request = start("正在打开已安装模型…");
    setSelection(null); setEntry(ref.entry);
    try {
      const bundle = await getModelBundle(ref.id);
      if (!bundle) throw new Error("缺少本地模型文件，请重新导入原始模型或工程 ZIP。");
      if (version.current === request) setCandidate({ ref, bundle, version: request, stored: true, workcell: importedWorkcell(ref, bundle) });
    } catch (cause) {
      if (version.current === request) setError(errorText(cause));
    } finally { if (version.current === request) setBusy(""); }
  }, [start]);

  useEffect(() => {
    if (requested) void openStored(requested);
  }, [requested, openStored]);
  useEffect(() => () => { version.current++; reading.current?.abort(); }, []);

  const prepare = useCallback(async (bundle: ModelBundle, request: number, source?: RobotExample | "assembly") => {
    if (version.current !== request) return;
    const ref = await describeModel(bundle);
    if (version.current !== request) return;
    const example = source === "assembly" ? undefined : source;
    if (example && ref.id !== example.modelId) throw new Error("模型的入口或文件内容与机器人目录不一致，请刷新页面后重试。");
    const workcell = source === "assembly" ? "assembled" : example ? undefined : importedWorkcell(ref, bundle);
    const name = source === "assembly" ? PICK_PLACE_EXAMPLE.name : example?.name ?? ref.name;
    setCandidate({ ref: { ...ref, name }, bundle, version: request, stored: false, example, workcell });
  }, []);

  const selectFiles = useCallback(async (input: File[] | "sample" | RobotExample) => {
    const example = input !== "sample" && !Array.isArray(input) ? input : undefined;
    const localRef = example && latest.current.workspace.catalog?.models.find((model) => model.id === example.modelId);
    const request = start(localRef ? "正在校验本机模型文件…" : example ? `正在下载并校验 ${example.name}…` : "正在读取模型文件…");
    const controller = new AbortController();
    reading.current = controller;
    setSelection(null); setEntry(""); setUnit("");
    try {
      if (example && localRef) {
        const cached = await getModelBundle(localRef.id).catch(() => null);
        if (controller.signal.aborted || version.current !== request) return;
        if (cached?.entry === example.entry) {
          setEntry(cached.entry);
          setCandidate({ ref: localRef, bundle: cached, version: request, stored: true, example });
          return;
        }
        setBusy(`正在下载并校验 ${example.name}…`);
      }
      let files: File[];
      if (input === "sample") {
        const response = await fetch(`${import.meta.env.BASE_URL}examples/spring-carriage.xml`, { signal: controller.signal });
        if (!response.ok) throw new Error("未能读取弹簧滑台示例文件，请重试。");
        files = [new File([await response.blob()], "spring-carriage.xml", { type: "application/xml" })];
      } else if (Array.isArray(input)) files = input;
      else files = [await fetchRobotExample(input, controller.signal)];
      if (version.current !== request) return;
      let source: Selection;
      try { source = await readModelFiles(files); }
      catch (cause) {
        if (example || !(cause instanceof ProjectArchiveFileError) || files.length !== 1) throw cause;
        if (version.current === request) await latest.current.onOpenProject(files[0]);
        return;
      }
      if (version.current !== request) return;
      if (example) {
        if (!source.entries.includes(example.entry)) throw new Error(`模型包中缺少目录指定的入口 ${example.entry}。`);
        setEntry(example.entry); await prepare({ entry: example.entry, files: source.files }, request, example);
        return;
      }
      setSelection(source);
      if (!source.entries.length) {
        const meshes = source.files.filter((item) => /\.(stl|obj)$/i.test(item.path));
        if (!meshes.length) throw new Error("没有找到 MJCF、URDF 或 STL、OBJ 网格。");
        if (meshes.length === 1) setEntry(meshes[0].path);
      } else {
        let primary = source.entries.length === 1 ? source.entries[0] : undefined;
        if (!primary) {
          const roots = source.entries.filter((path) => !path.includes("/"));
          if (roots.length === 1 && isUr5eWorkcell({ entry: roots[0], files: source.files })) primary = roots[0];
        }
        if (primary) {
          setEntry(primary); await prepare({ entry: primary, files: source.files }, request);
        }
      }
    } catch (cause) { if (!controller.signal.aborted && version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) { setBusy(""); reading.current = null; } }
  }, [start, prepare]);

  useEffect(() => {
    let current = true;
    // 延迟到本轮挂载稳定，避免 StrictMode 的探测挂载也下载一份 ZIP。
    queueMicrotask(() => {
      if (!current) return;
      if (robotId === null) {
        if (activeRobot.current !== null) { activeRobot.current = null; start(""); setSelection(null); setEntry(""); }
        return;
      }
      activeRobot.current = robotId;
      if (robot) void selectFiles(robot);
      else {
        start(""); setSelection(null); setEntry("");
        if (!recipe) setError("目录中没有这个机器人，请从下方选择。");
      }
      focusPreview();
    });
    return () => { current = false; if (robotId !== null && activeRobot.current === robotId) reading.current?.abort(); };
  }, [robotId, robot, recipe, attempt, start, selectFiles]);

  async function assembleWorkcell(arm?: ModelRef, gripper?: ModelRef, part?: ModelRef) {
    const request = start("正在读取组件并组装取放工位…");
    const controller = new AbortController();
    reading.current = controller;
    setSelection(null); setEntry(""); setUnit(""); focusPreview();
    try {
      const bundle = await loadWorkcellParts(arm, gripper, part, controller.signal);
      if (controller.signal.aborted || version.current !== request) return;
      setEntry(bundle.entry);
      await prepare(bundle, request, "assembly");
    } catch (cause) {
      if (!controller.signal.aborted && version.current === request) setError(errorText(cause));
    } finally {
      if (version.current === request) { setBusy(""); reading.current = null; }
    }
  }

  function chooseLocal(input: File[] | "sample") {
    localChoice();
    void selectFiles(input);
  }

  function closeExample() {
    localChoice(); start(""); setSelection(null); setEntry("");
    requestAnimationFrame(() => gallery.current?.scrollIntoView({ block: "start" }));
  }

  async function selectEntry(path: string) {
    if (!selection) return;
    const request = start("正在读取模型入口…");
    setEntry(path);
    try { if (path) await prepare({ entry: path, files: selection.files }, request); }
    catch (cause) { if (version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) setBusy(""); }
  }

  async function previewMesh() {
    if (!selection || !entry || !unit) return;
    const request = start("正在读取网格…");
    try { await prepare(makeStaticMeshBundle(selection.files, entry, unit), request); }
    catch (cause) { if (version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) setBusy(""); }
  }

  const compiled = useCallback((ok: boolean) => {
    if (!candidate || version.current !== candidate.version) return;
    setReady(ok);
    if (ok && (candidate.example || candidate.workcell === "assembled") && positioned.current !== candidate.version) {
      positioned.current = candidate.version;
      requestAnimationFrame(() => {
        if (version.current === candidate.version && document.activeElement === preview.current) preview.current?.scrollIntoView({ block: "start" });
      });
    }
  }, [candidate]);

  function recordRun(settings: ImportedRunSettings) {
    if (!candidate || candidate.version !== version.current) return;
    lastRun.current = { version: candidate.version, settings };
    setCandidate((value) => value?.version === candidate.version ? { ...value, ref: { ...value.ref, run: settings } } : value);
    const current = latest.current.workspace, catalog = current.catalog;
    if (!catalog?.models.some((model) => model.id === candidate.ref.id)) return;
    const models = catalog.models.map((model) => model.id === candidate.ref.id ? { ...model, run: settings } : model);
    latest.current.onChange({ ...current, catalog: parseImportCatalog({ ...catalog, models }, current.packages) });
  }

  async function install() {
    if (!ready || !candidate || busy) return;
    const request = candidate.version;
    setBusy("正在保存模型资源…"); setError(""); setNotice("");
    try {
      const previous = latest.current.workspace;
      const pending = withModel(previous, candidate.ref);
      await putModelBundle(candidate.ref, candidate.bundle);
      if (version.current !== request) return;
      const current = latest.current.workspace;
      const recent = lastRun.current;
      const ref = recent?.version === request && recent.settings !== candidate.ref.run ? { ...candidate.ref, run: recent.settings } : candidate.ref;
      const next = previous === current && ref === candidate.ref ? pending : withModel(current, ref);
      if (next !== current) latest.current.onChange(next);
      setCandidate((value) => value?.version === request ? { ...value, stored: true } : value);
      setNotice(`已将“${candidate.ref.name}”安装到模型库。`);
    } catch (cause) { if (version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) setBusy(""); }
  }

  async function download(ref: ModelRef) {
    const request = version.current;
    setError("");
    try {
      const bundle = candidate?.ref.id === ref.id ? candidate.bundle : await getModelBundle(ref.id);
      if (!bundle) throw new Error("本机缺少模型原始文件。");
      const zip = await exportModelBundle(bundle);
      if (version.current !== request) return;
      downloadFile(zip, ref.name + ".zip");
    } catch (cause) { if (version.current === request) setError(errorText(cause)); }
  }

  return <div className="min-w-0 space-y-4">
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <section className="surface min-w-0 space-y-3 p-4 sm:p-5">
        <h3 className="text-base font-semibold">导入物理模型</h3>
        <p className="text-sm leading-6 text-muted-foreground">支持 MJCF、URDF，以及 STL、OBJ 网格。引用网格、纹理或其他 XML 时，请选择保留原目录结构的 ZIP 或文件夹。</p>
        <input ref={file} type="file" multiple accept=".xml,.mjcf,.urdf,.zip,.mjz,.stl,.obj,.msh,.mtl,.png,.jpg,.jpeg,.bmp,.bin,.ply" aria-label="选择物理模型文件" className="hidden" onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ""; if (chosen.length) chooseLocal(chosen);
        }} />
        <input ref={folder} type="file" multiple {...{ webkitdirectory: "" }} aria-label="选择模型目录" className="hidden" onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ""; if (chosen.length) chooseLocal(chosen);
        }} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => file.current?.click()}><FileUp />选择模型文件或 ZIP</Button>
          <Button variant="outline" onClick={() => folder.current?.click()}><FolderOpen />选择模型目录</Button>
          <Button variant="ghost" onClick={() => chooseLocal("sample")}>试用弹簧滑台文件</Button>
        </div>
        {selection && selection.entries.length > 1 && <label className="block"><span className="field-label">模型入口文件</span>
          <select aria-label="模型入口文件" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={entry} onChange={(event) => void selectEntry(event.target.value)}>
            <option value="">请选择需要编译的模型入口</option>{selection.entries.map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>}
        {selection && !selection.entries.length && <div className="surface-inset space-y-3 p-3">
          <p className="text-xs leading-5 text-muted-foreground">网格先作为固定几何查看。质量和关节由物理模型提供。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="field-label">网格文件</span><select aria-label="网格文件" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={entry} onChange={(event) => {
              start(""); setEntry(event.target.value); setUnit("");
            }}><option value="">选择网格</option>{selection.files.filter((item) => /\.(stl|obj)$/i.test(item.path)).map((item) => <option key={item.path}>{item.path}</option>)}</select></label>
            <label><span className="field-label">网格原始长度单位</span><select aria-label="网格原始长度单位" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={unit} onChange={(event) => {
              start(""); setUnit(event.target.value as typeof unit);
            }}><option value="">请选择原始单位</option><option value="m">米（m）</option><option value="cm">厘米（cm）</option><option value="mm">毫米（mm）</option></select></label>
          </div>
          <Button size="sm" variant="outline" disabled={!entry || !unit || Boolean(busy)} onClick={() => void previewMesh()}>预览固定几何</Button>
        </div>}
        {robotId === null && <>
          {busy && <p role="status" className="text-xs text-muted-foreground">{busy}</p>}
          {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
          {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
        </>}
      </section>
      <section className="surface min-w-0 p-4 sm:p-5">
        <h3 className="text-base font-semibold">已安装物理模型 <span className="mono text-sm text-muted-foreground">{models.length}</span></h3>
        {!models.length && <p className="mt-3 text-sm text-muted-foreground">通过编译的模型可以安装到此浏览器，之后可重开运行或下载原始模型。</p>}
        <ul className="mt-2 max-h-64 divide-y overflow-y-auto">{models.map((model) => <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0"><p className="break-all text-sm font-medium">{model.name}</p><p className="break-all text-xs text-muted-foreground" title={model.id}>{model.entry} · {model.id.slice(0, 10)}</p></div>
          <div className="flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={() => { localChoice(); void openStored(model); }}><Play />打开模型</Button>
            <Button variant="ghost" size="sm" onClick={() => void download(model)}><Download />下载模型 ZIP</Button>
          </div>
        </li>)}</ul>
      </section>
    </div>
    {(robotId !== null || candidate) && <section ref={preview} tabIndex={-1} aria-label="所选模型预览" className="surface min-w-0 scroll-mt-4 space-y-4 p-4 outline-none sm:p-5">
      {recipe && <PickPlaceAssembly models={models} busy={Boolean(busy)} assembled={candidate?.workcell === "assembled"}
        partUrl={`${import.meta.env.BASE_URL}workcells/${PICK_PLACE_EXAMPLE.id}/workpiece.xml`}
        onChange={() => { start(""); }} onAssemble={(arm, gripper, part) => void assembleWorkcell(arm, gripper, part)} />}
      {candidate && showCandidate ? <><div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h3 className="flex items-center gap-2 break-all text-base font-semibold"><Box className="size-4 shrink-0 text-primary" />{candidate.example?.name ?? installed?.name ?? candidate.ref.name}</h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">{candidate.bundle.entry} · {candidate.bundle.files.length} 个文件</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {robotId !== null && <Button size="sm" variant="ghost" onClick={closeExample}>返回机器人目录</Button>}
          {candidate.workcell && <Button size="sm" variant="outline" disabled={!ready || Boolean(busy)} onClick={() => void download(candidate.ref)}><Download />下载工位 ZIP</Button>}
          {installed && candidate.stored ? <span className="inline-flex items-center gap-1 text-xs text-primary"><Check className="size-4" />已安装</span> :
            <Button disabled={!ready || Boolean(busy)} onClick={() => void install()}>安装物理模型</Button>}
        </div>
      </div>
      <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载模型预览…</p>}>
        <ImportedPhysicsWorkbench key={candidate.version} bundle={candidate.bundle} onReady={compiled} initialSettings={installed?.run ?? candidate.ref.run ?? recommendation?.trial}
          createInitialSettings={candidate.workcell ? makeUr5eWorkcellTrial : undefined} preferredKeyframe={recommendation?.preferredKeyframe} onRun={recordRun} />
      </Suspense></> : !recipe && <h3 className="text-base font-semibold">{robot?.name ?? "机器人目录"}</h3>}
      {robotId !== null && <>
        {busy && <p role="status" className="text-sm text-muted-foreground">{busy}</p>}
        {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
        {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
        {(!candidate || !showCandidate) && <div className="flex flex-wrap gap-2">
          {error && robot && <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>重试下载</Button>}
          <Button size="sm" variant="ghost" onClick={closeExample}>返回机器人目录</Button>
        </div>}
      </>}
    </section>}
    <div ref={gallery} className="scroll-mt-4">
      <RobotExamples selectedId={robotId} onReselect={() => { if (robot && error && !candidate) setAttempt((value) => value + 1); focusPreview(); }} />
    </div>
  </div>;
}
