import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Activity, ArrowLeft, Bot, ChevronDown, CircuitBoard, Download, FileInput, FilePlus2, FolderOpen, Github, Link2, Monitor, Package, Upload, Workflow } from "lucide-react";
import { IS_PAGES } from "@/const";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { MAX_PROJECT_JSON_BYTES, parseImportCatalog, type MaterialRow } from "@contracts/import-catalog";
import { matchMaterials } from "@contracts/material-import";
import { suggestSourceMetadata, type DeviceSourceInput } from "@contracts/twin-extract";
import { createServoDemo, createTwinDemo } from "@contracts/twin-demo";
import { addInstance, emptyWorkspace, installPackage, nextInstanceName, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import TwinDeviceLibrary from "@/components/TwinDeviceLibrary";
import TwinSimulation from "@/components/TwinSimulation";
import ServoPairImport from "@/components/ServoPairImport";
import { downloadBlob, downloadFile, downloadJson } from "@/lib/download";

const storageKey = "gouyuan.twin.workspace.v1";
const defaultTab = "import";
const ImportCenter = lazy(() => import("@/components/ImportCenter"));
const ServoAxisBench = lazy(() => import("@/components/ServoAxisBench"));
const So101Workbench = lazy(() => import("@/components/So101Workbench"));

function readLocalWorkspace() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
    const workspace = raw === null ? emptyWorkspace() : parseWorkspace(JSON.parse(raw));
    return { workspace, raw, damaged: false, warning: "" };
  } catch {
    return {
      workspace: emptyWorkspace(), raw, damaged: raw !== null,
      warning: raw === null
        ? "浏览器存储不可用。请在关闭页面前导出工程。"
        : "已有存档未能读取。可下载原存档，再从工程文件菜单导入备份或新建工程。",
    };
  }
}

export default function TwinStudio() {
  const [session, setSession] = useState(readLocalWorkspace);
  const [search, setSearch] = useSearchParams();
  const view = search.get("view");
  const tab = view === "servo" || view === "simulation" || view === "so101" || view === "library" ? view : defaultTab;
  const [showSources, setShowSources] = useState(!session.workspace.servoAxis);
  const [selection, setSelection] = useState<{ driveKey?: string; motorKey?: string; version: number }>({ version: 0 });
  const [generation, setGeneration] = useState(0);
  const [sourceDraft, setSourceDraft] = useState<{ value: Partial<DeviceSourceInput>; key: number }>();
  const [notice, setNotice] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const { workspace } = session;

  function setTab(value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("robot");
      if (value === defaultTab) next.delete("view");
      else next.set("view", value);
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
      setSession(readLocalWorkspace());
      setSourceDraft(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      setNotice("已载入其他标签页保存的工程。");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function save(next: TwinWorkspace, replaceDamaged = false) {
    if (session.damaged && !replaceDamaged) throw new Error("请先下载原存档，再新建工程或导入备份。");
    if (next.catalog && (next.catalog !== workspace.catalog || next.packages !== workspace.packages)) {
      let catalog = next.catalog;
      const installed = next.packages.length > workspace.packages.length ||
        catalog.models.some(ref => !workspace.catalog?.models.some(current => current.id === ref.id));
      if (installed && !replaceDamaged) catalog = { ...catalog, materials: matchMaterials(catalog.materials, next) };
      next = { ...next, catalog: parseImportCatalog(catalog, next.packages) };
    }
    const raw = JSON.stringify(next);
    if (next.catalog && new TextEncoder().encode(raw).byteLength > MAX_PROJECT_JSON_BYTES) {
      throw new Error("工程文字资料超过 8 MiB，请将本次清单拆分到单独工程。");
    }
    let current: string | null;
    try {
      current = localStorage.getItem(storageKey);
    } catch {
      setSession({ ...session, workspace: next, warning: "当前修改仅保存在本次会话中，请导出工程备份。" });
      return;
    }
    if (current !== session.raw) {
      setSession(readLocalWorkspace());
      setSourceDraft(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      throw new Error("其他标签页已更新工程。已载入最新存档，请重试本次操作。");
    }
    try {
      localStorage.setItem(storageKey, raw);
      setSession({ workspace: next, raw, damaged: false, warning: "" });
    } catch {
      setSession({ workspace: next, raw: current, damaged: false, warning: "浏览器写入失败。当前工程仍可导出，请保存备份。" });
    }
  }

  function confirmOpen(label: string) {
    const occupied = workspace.packages.length || workspace.so101 || workspace.catalog?.models.length || workspace.catalog?.materials.length || session.damaged;
    return !occupied || window.confirm(`用“${label}”替换当前本机工程？如需保留当前工程，请先取消并导出备份。`);
  }

  function showProject(next: TwinWorkspace, message: string) {
    save(next, true);
    setSourceDraft(undefined);
    setGeneration((value) => value + 1);
    setSelection({ version: 0 });
    setShowSources(!next.servoAxis);
    setTab(next.catalog?.models.length || next.catalog?.materials.length ? "import" : next.so101 ? "so101" : next.servoAxis ? "servo" : next.instances.length ? "simulation" : next.packages.length ? "library" : "import");
    setNotice(message);
  }

  function open(next: TwinWorkspace, label: string, message: string) {
    if (confirmOpen(label)) showProject(next, message);
  }

  function run(action: () => void) {
    try {
      action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "工程操作失败。");
    }
  }

  async function importWorkspace(file: File) {
    if (/\.zip$/i.test(file.name)) {
      const { readProjectArchive, putProjectModels } = await import("@/lib/model-files");
      const { workspace: project, models } = await readProjectArchive(file);
      if (!confirmOpen(file.name)) return;
      await putProjectModels(models);
      showProject(project, `已导入 ${file.name} 及 ${models.length} 个物理模型。`);
      return;
    }
    if (file.size > MAX_PROJECT_JSON_BYTES) throw new Error("请选择 8 MiB 以内的工程 JSON，含模型资源的工程请使用 ZIP。");
    let raw: unknown;
    try { raw = JSON.parse(await file.text()); }
    catch { throw new Error("文件不是有效的工程 JSON。"); }
    const next = parseWorkspace(raw);
    if (next.catalog?.models.length) {
      const { getModelBundle } = await import("@/lib/model-files");
      for (const ref of next.catalog.models) {
        try {
          const bundle = await getModelBundle(ref.id);
          if (bundle.entry !== ref.entry) throw new Error("模型入口不一致。");
        }
        catch { throw new Error(`本机缺少与“${ref.name}”入口匹配的资源。请选择包含资源的完整工程 ZIP。`); }
      }
    }
    open(next, file.name, `已导入 ${file.name}，可从零时刻重新运行。`);
  }

  async function exportWorkspace() {
    if (!workspace.catalog?.models.length) {
      downloadJson(workspace, "构元_设备仿真工程.json");
      return;
    }
    const { exportProjectArchive } = await import("@/lib/model-files");
    downloadFile(await exportProjectArchive(workspace), "构元_完整仿真工程.zip");
  }

  function useMaterialSource(row: MaterialRow) {
    const text = row.notes ?? "";
    const suggested = suggestSourceMetadata(text);
    const source = row.source ?? "";
    const url = /^https?:\/\//i.test(source) ? source : "";
    setSourceDraft(previous => ({
      key: (previous?.key ?? 0) + 1,
      value: { ...suggested, title: suggested.title ?? row.name, manufacturer: row.manufacturer ?? suggested.manufacturer ?? "",
        model: row.model ?? suggested.model ?? "", url, locator: suggested.locator ?? (url ? "" : source), text },
    }));
    setTab("library");
    setNotice(`已带入“${row.name}”的资料。请核对身份、定位和规格后生成草案。`);
  }

  function assemble(pkg: DevicePackage) {
    if (pkg.servo) {
      const key = packageKey(pkg);
      const role = pkg.servo.kind;
      setSelection((previous) => ({ version: previous.version + 1, ...(role === "drive" ? { driveKey: key } : { motorKey: key }) }));
      setShowSources(false);
      setTab("servo");
      setNotice(`已选中 ${pkg.model}，可在伺服轴中核对配套型号。`);
      return;
    }
    const name = nextInstanceName(workspace, pkg.model);
    save(addInstance(workspace, packageKey(pkg), name));
    setTab("simulation");
    setNotice(`已将“${name}”加入仿真装配。`);
  }

  function installServoPair(drive: DevicePackage, motor: DevicePackage) {
    save(installPackage(installPackage(workspace, drive), motor));
    setSelection((previous) => ({ driveKey: packageKey(drive), motorKey: packageKey(motor), version: previous.version + 1 }));
    setShowSources(false);
    setNotice("驱动器和电机均已安装。确认下方选中的设备，组轴后即可运行目标位置。");
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/65">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-8">
          <div className="flex items-center gap-3"><CircuitBoard className="h-6 w-6 text-primary" strokeWidth={1.7} /><span className="text-base font-semibold tracking-wide">构元</span><span className="border-l pl-3 text-xs text-muted-foreground">本机工作区</span></div>
          {IS_PAGES
            ? <a href="https://github.com/lusipad/omg" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><Github className="h-3.5 w-3.5" />项目源码</a>
            : <Link to="/" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />客户项目</Link>}
        </div>
      </header>
      <main className="page-enter mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-8 sm:pt-9">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="display-title text-2xl font-semibold sm:text-3xl">设备仿真工作台</h1>
            <p className="mt-2 text-[13px] text-muted-foreground">{tab === "import" ? "导入自己的物理模型、设备包或物料清单，在浏览器中建模和仿真。" : tab === "so101" ? "从官方物料清单装配机械臂，在浏览器中运行 MuJoCo 物理仿真。" : "从厂商资料生成设备包，连接设备端口，逐步观察信号。"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {tab === "servo"
              ? <Button variant="outline" onClick={() => run(() => open(createServoDemo(), "汇川伺服轴示例", "示例轴已装配，目标位置为 90°，负载惯量等于转子惯量。"))}><Activity />打开伺服轴示例</Button>
              : (tab === "library" || tab === "simulation") && <Button variant="outline" onClick={() => run(() => open(createTwinDemo(), "汇川接线示例", "测试电压源已向第 1 路输入 24 V。步进 10 ms，观察该路数字量输出。"))}><Workflow />打开接线示例</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="secondary"><FolderOpen />工程文件<ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => importInput.current?.click()}><Upload />导入工程文件</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportWorkspace().catch(error => setNotice(error instanceof Error ? error.message : "工程导出失败。"))}><Download />{workspace.catalog?.models.length ? "导出完整工程 ZIP" : "导出工程 JSON"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => open(emptyWorkspace(), "空白工程", "已新建空白工程。"))}><FilePlus2 />新建空白工程</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input ref={importInput} className="hidden" aria-label="选择工程 JSON 文件或完整 ZIP" type="file" accept=".json,.zip,application/json,application/zip" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importWorkspace(file).catch(error => setNotice(error instanceof Error ? error.message : "工程导入失败。"));
            }} />
          </div>
        </div>
        {session.warning && <div role="alert" className="mt-4 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {session.warning}
          {session.damaged && session.raw !== null && <Button className="ml-2" variant="outline" size="sm" onClick={() => downloadBlob(session.raw!, "构元_原始存档.txt", "text/plain;charset=utf-8")}>下载原存档</Button>}
        </div>}
        <Tabs value={tab} onValueChange={setTab} className="mt-6 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <TabsList aria-label="设备工作台" className="h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="import"><FileInput />导入中心</TabsTrigger>
              <TabsTrigger value="library"><Package />设备库<span className="mono text-xs text-muted-foreground">{workspace.packages.length}</span></TabsTrigger>
              <TabsTrigger value="simulation"><Workflow />仿真装配<span className="mono text-xs text-muted-foreground">{workspace.instances.length}</span></TabsTrigger>
              <TabsTrigger value="servo"><Activity />伺服轴</TabsTrigger>
              <TabsTrigger value="so101"><Bot />SO-101</TabsTrigger>
            </TabsList>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Monitor className="h-3.5 w-3.5" />{session.warning ? "会话工作区" : "工程保存在此浏览器"}</span>
          </div>
          {notice && <div role="status" className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span>{notice}</span><button type="button" className="shrink-0 text-muted-foreground hover:underline" onClick={() => setNotice("")}>关闭提示</button>
          </div>}
          <TabsContent value="import">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开导入中心…</p>}>
              <ImportCenter key={generation} workspace={workspace} onChange={save} onOpenDevice={assemble} onUseSource={useMaterialSource} onOpenProject={importWorkspace} />
            </Suspense>
          </TabsContent>
          <TabsContent forceMount value="library" className="data-[state=inactive]:hidden">
            <TwinDeviceLibrary key={`${generation}-${sourceDraft?.key ?? 0}`} initialSource={sourceDraft?.value} packages={workspace.packages} onInstall={(pkg) => save(installPackage(workspace, pkg))} onAssemble={assemble} />
          </TabsContent>
          <TabsContent forceMount value="simulation" className="data-[state=inactive]:hidden">
            <TwinSimulation key={generation} workspace={workspace} onChange={save} />
          </TabsContent>
          <TabsContent value="servo" className="space-y-4">
            <section className="surface">
              <button type="button" className="flex w-full items-center gap-2 px-4 py-3.5 text-left text-sm font-medium" aria-expanded={showSources} aria-controls="servo-sources" onClick={() => setShowSources(!showSources)}>
                <Link2 className="size-4 text-primary" />{IS_PAGES ? "导入伺服设备示例" : "从官网生成伺服设备包"}<ChevronDown className={`ml-auto size-4 ${showSources ? "rotate-180" : ""}`} />
              </button>
              {showSources && <div id="servo-sources" className="border-t p-4"><ServoPairImport onInstall={installServoPair} /></div>}
            </section>
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开伺服轴…</p>}>
              <ServoAxisBench key={`${generation}-${selection.version}`} workspace={workspace} onChange={(next) => {
                save(next);
                setSelection((previous) => ({ version: previous.version }));
              }} preferred={selection} />
            </Suspense>
          </TabsContent>
          <TabsContent value="so101">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开 SO-101 从臂…</p>}>
              <So101Workbench key={generation} workspace={workspace} onChange={save} />
            </Suspense>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
