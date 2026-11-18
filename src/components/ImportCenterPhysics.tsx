import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Box, Check, Download, FileUp, FolderOpen, Play } from "lucide-react";
import { parseImportCatalog, type ModelBundle, type ModelFile, type ModelRef } from "@contracts/import-catalog";
import type { ImportedRunSettings } from "@contracts/imported-physics";
import { makeStaticMeshBundle } from "@contracts/mesh-model";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { describeModel, exportModelBundle, getModelBundle, ProjectArchiveFileError, putModelBundle, readModelFiles } from "@/lib/model-files";
import { downloadFile } from "@/lib/download";
import { Button } from "@/components/ui/button";

const ImportedPhysicsWorkbench = lazy(() => import("./ImportedPhysicsWorkbench"));
type Selection = { files: ModelFile[]; entries: string[] };
type Candidate = { ref: ModelRef; bundle: ModelBundle; version: number; stored: boolean };
type Props = {
  workspace: TwinWorkspace;
  onChange: (workspace: TwinWorkspace) => void;
  requested: ModelRef | null;
  onOpenProject: (file: File) => Promise<void>;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "模型操作失败，请重新选择文件。";

function withModel(current: TwinWorkspace, ref: ModelRef): TwinWorkspace {
  const catalog = current.catalog ?? { models: [], materials: [] };
  if (catalog.models.some((model) => model.id === ref.id)) return current;
  return { ...current, catalog: parseImportCatalog({ ...catalog, models: [...catalog.models, ref] }, current.packages) };
}

export default function ImportCenterPhysics({ workspace, onChange, requested, onOpenProject }: Props) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [entry, setEntry] = useState("");
  const [unit, setUnit] = useState<"" | "m" | "cm" | "mm">("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const lastRun = useRef<{ version: number; settings: ImportedRunSettings } | null>(null);
  const latest = useRef({ workspace, onChange });
  useEffect(() => { latest.current = { workspace, onChange }; }, [workspace, onChange]);
  const models = workspace.catalog?.models ?? [];
  const installed = models.find((model) => model.id === candidate?.ref.id);

  function start(label: string) {
    setCandidate(null); setReady(false); setBusy(label); setError(""); setNotice("");
    return ++version.current;
  }

  const openStored = useCallback(async (ref: ModelRef) => {
    const request = ++version.current;
    setSelection(null); setEntry(ref.entry); setCandidate(null); setReady(false); setError(""); setNotice(""); setBusy("正在打开已安装模型…");
    try {
      const bundle = await getModelBundle(ref.id);
      if (!bundle) throw new Error("缺少本地模型文件，请重新导入原始模型或工程 ZIP。");
      if (version.current === request) setCandidate({ ref, bundle, version: request, stored: true });
    } catch (cause) {
      if (version.current === request) setError(errorText(cause));
    } finally { if (version.current === request) setBusy(""); }
  }, []);

  useEffect(() => {
    if (requested) void openStored(requested);
  }, [requested, openStored]);
  useEffect(() => () => { version.current++; }, []);

  async function prepare(bundle: ModelBundle, request: number) {
    if (version.current !== request) return;
    const ref = await describeModel(bundle);
    if (version.current === request) setCandidate({ ref, bundle, version: request, stored: false });
  }

  async function selectFiles(files: File[] | "sample") {
    const request = start("正在读取模型文件…");
    setSelection(null); setEntry(""); setUnit("");
    try {
      if (files === "sample") {
        const response = await fetch(`${import.meta.env.BASE_URL}examples/spring-carriage.xml`);
        if (!response.ok) throw new Error("未能读取弹簧滑台示例文件，请重试。");
        files = [new File([await response.blob()], "spring-carriage.xml", { type: "application/xml" })];
      }
      if (version.current !== request) return;
      let source: Selection;
      try { source = await readModelFiles(files); }
      catch (cause) {
        if (!(cause instanceof ProjectArchiveFileError) || files.length !== 1) throw cause;
        if (version.current === request) await onOpenProject(files[0]);
        return;
      }
      if (version.current !== request) return;
      setSelection(source);
      if (!source.entries.length) {
        const meshes = source.files.filter((item) => /\.(stl|obj)$/i.test(item.path));
        if (!meshes.length) throw new Error("没有找到 MJCF、URDF 或 STL、OBJ 网格。");
        if (meshes.length === 1) setEntry(meshes[0].path);
      } else if (source.entries.length === 1) {
        setEntry(source.entries[0]); await prepare({ entry: source.entries[0], files: source.files }, request);
      }
    } catch (cause) { if (version.current === request) setError(errorText(cause)); }
    finally { if (version.current === request) setBusy(""); }
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
    if (candidate && version.current === candidate.version) setReady(ok);
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
          const chosen = Array.from(event.target.files ?? []); event.target.value = ""; if (chosen.length) void selectFiles(chosen);
        }} />
        <input ref={folder} type="file" multiple {...{ webkitdirectory: "" }} aria-label="选择模型目录" className="hidden" onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ""; if (chosen.length) void selectFiles(chosen);
        }} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => file.current?.click()}><FileUp />选择模型文件或 ZIP</Button>
          <Button variant="outline" onClick={() => folder.current?.click()}><FolderOpen />选择模型目录</Button>
          <Button variant="ghost" onClick={() => void selectFiles("sample")}>试用弹簧滑台文件</Button>
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
        {busy && <p role="status" className="text-xs text-muted-foreground">{busy}</p>}
        {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
        {error && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{error}</p>}
      </section>
      <section className="surface min-w-0 p-4 sm:p-5">
        <h3 className="text-base font-semibold">已安装物理模型 <span className="mono text-sm text-muted-foreground">{models.length}</span></h3>
        {!models.length && <p className="mt-3 text-sm text-muted-foreground">通过编译的模型可以安装到此浏览器，之后可重开运行或下载原始模型。</p>}
        <ul className="mt-2 max-h-64 divide-y overflow-y-auto">{models.map((model) => <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0"><p className="break-all text-sm font-medium">{model.name}</p><p className="break-all text-xs text-muted-foreground" title={model.id}>{model.entry} · {model.id.slice(0, 10)}</p></div>
          <div className="flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={() => void openStored(model)}><Play />打开模型</Button>
            <Button variant="ghost" size="sm" onClick={() => void download(model)}><Download />下载模型 ZIP</Button>
          </div>
        </li>)}</ul>
      </section>
    </div>
    {candidate && <section className="surface min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h3 className="flex items-center gap-2 break-all text-base font-semibold"><Box className="size-4 shrink-0 text-primary" />{installed?.name ?? candidate.ref.name}</h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">{candidate.bundle.entry} · {candidate.bundle.files.length} 个文件</p>
        </div>
        {installed && candidate.stored ? <span className="inline-flex items-center gap-1 text-xs text-primary"><Check className="size-4" />已安装</span> :
          <Button disabled={!ready || Boolean(busy)} onClick={() => void install()}>安装物理模型</Button>}
      </div>
      <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载模型预览…</p>}>
        <ImportedPhysicsWorkbench key={candidate.version} bundle={candidate.bundle} onReady={compiled} initialSettings={installed?.run ?? candidate.ref.run} onRun={recordRun} />
      </Suspense>
    </section>}
  </div>;
}
