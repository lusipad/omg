import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Activity, ArrowLeft, Bot, ChevronDown, CircuitBoard, Download, Drill, FileInput, FilePlus2, FolderOpen, Github, Link2, Monitor, Package, Upload, Workflow } from "lucide-react";
import { IS_PAGES } from "@/const";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { MAX_PROJECT_JSON_BYTES, parseImportCatalog, type MaterialRow } from "@contracts/import-catalog";
import { matchMaterials } from "@contracts/material-import";
import { applyMiloBomImport, applySo101BomImport, importedServoPair, mergeImportedMaterials } from "@contracts/import-apply";
import { initialMiloWorkspace } from "@contracts/milo-workspace";
import { deviceSourceFromMaterial, type DeviceSourceInput } from "@contracts/twin-extract";
import { createServoDemo, createTwinDemo } from "@contracts/twin-demo";
import { addInstance, emptyWorkspace, installPackage, nextInstanceName, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import TwinDeviceLibrary from "@/components/TwinDeviceLibrary";
import TwinSimulation from "@/components/TwinSimulation";
import ServoPairImport from "@/components/ServoPairImport";
import { downloadBlob, downloadFile, downloadJson } from "@/lib/download";
import { importMaterialRows, prepareProjectResources, WORKBENCH_FILE_ACCEPT, type DeviceDraftPatch, type ImportOverrides, type IncomingWorkbenchModel, type WorkbenchImportOptions } from "@/lib/workbench-import";
import { ImportStartContext, useWorkbenchImport } from "@/hooks/useWorkbenchImport";
import WorkbenchImportPreview from "@/components/WorkbenchImportPreview";

const storageKey = "gouyuan.twin.workspace.v1";
const defaultTab = "import";
const ImportCenter = lazy(() => import("@/components/ImportCenter"));
const ServoAxisBench = lazy(() => import("@/components/ServoAxisBench"));
const So101Workbench = lazy(() => import("@/components/So101Workbench"));
const MiloWorkbench = lazy(() => import("@/components/MiloWorkbench"));

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
  const tab = view === "servo" || view === "simulation" || view === "so101" || view === "milo" || view === "library" ? view : defaultTab;
  const [showSources, setShowSources] = useState(!session.workspace.servoAxis);
  const [selection, setSelection] = useState<{ driveKey?: string; motorKey?: string; version: number }>({ version: 0 });
  const [generation, setGeneration] = useState(0);
  const [sourceDraft, setSourceDraft] = useState<{ value: Partial<DeviceSourceInput>; key: number }>();
  const [incomingSource, setIncomingSource] = useState<DeviceDraftPatch>();
  const sourceToken = useRef(0);
  const [notice, setNotice] = useState("");
  const [bomRevision, setBomRevision] = useState(0);
  const [incomingModel, setIncomingModel] = useState<IncomingWorkbenchModel | null>(null);
  const modelToken = useRef(0);
  const importInput = useRef<HTMLInputElement>(null);
  const { workspace } = session;
  const intake = useWorkbenchImport((model, onInstalled) => {
    setTab("import");
    setIncomingModel({ selection: model, token: ++modelToken.current, onInstalled });
    setNotice("");
  });
  const cancelImport = intake.cancel;
  const routeKey = useLocation().key;
  const previousRoute = useRef(routeKey);
  useLayoutEffect(() => {
    if (previousRoute.current === routeKey) return;
    previousRoute.current = routeKey;
    cancelImport();
    if (tab !== "import" || search.has("robot") || search.has("section")) setIncomingModel(null);
  }, [routeKey, tab, search, cancelImport]);

  function setTab(value: string, section?: "device" | "material") {
    cancelImport();
    setIncomingModel(null);
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("robot");
      if (section) next.set("section", section);
      else next.delete("section");
      if (value === defaultTab) next.delete("view");
      else next.set("view", value);
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
      cancelImport();
      setIncomingModel(null);
      setSession(readLocalWorkspace());
      setSourceDraft(undefined);
      setIncomingSource(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      setNotice("已载入其他标签页保存的工程。");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [cancelImport]);

  function persist(next: TwinWorkspace, replaceDamaged = false) {
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
      cancelImport();
      setIncomingModel(null);
      setSession(readLocalWorkspace());
      setSourceDraft(undefined);
      setIncomingSource(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      const message = "其他标签页已更新工程。已载入最新存档，请重试本次操作。";
      setNotice(message);
      throw new Error(message);
    }
    if (!replaceDamaged && raw === current && !session.warning) return;
    try {
      localStorage.setItem(storageKey, raw);
      setSession({ workspace: next, raw, damaged: false, warning: "" });
    } catch {
      setSession({ workspace: next, raw: current, damaged: false, warning: "浏览器写入失败。当前工程仍可导出，请保存备份。" });
    }
  }

  function save(next: TwinWorkspace) {
    cancelImport();
    persist(next);
  }

  function confirmOpen(label: string) {
    const occupied = workspace.packages.length || workspace.so101 || workspace.milo || workspace.catalog?.models.length || workspace.catalog?.materials.length || session.damaged;
    return !occupied || window.confirm(`用“${label}”替换当前本机工程？如需保留当前工程，请先取消并导出备份。`);
  }

  function showProject(next: TwinWorkspace, message: string) {
    persist(next, true);
    setSourceDraft(undefined);
    setIncomingSource(undefined);
    setGeneration((value) => value + 1);
    setSelection({ version: 0 });
    setShowSources(!next.servoAxis);
    setTab(next.milo ? "milo" : next.catalog?.models.length || next.catalog?.materials.length ? "import" : next.so101 ? "so101" : next.servoAxis ? "servo" : next.instances.length ? "simulation" : next.packages.length ? "library" : "import");
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

  function importFiles(files: File[], options?: WorkbenchImportOptions) {
    setNotice(""); intake.files(files, options);
  }

  function importFile(file: File, hint?: WorkbenchImportOptions["hint"]) {
    importFiles([file], { hint });
  }

  function importText(text: string, name: string, options?: WorkbenchImportOptions, onCommitted?: () => void) {
    setNotice(""); intake.text(text, name, options, onCommitted);
  }

  function confirmImport(overrides?: ImportOverrides, useManualAsSource = false) {
    void intake.confirm(async (item, signal) => {
      switch (item.kind) {
        case "project":
          await prepareProjectResources(item, signal);
          signal.throwIfAborted();
          showProject(item.workspace, `已导入工程“${item.name}”。`);
          break;
        case "device":
          persist(installPackage(workspace, item.device));
          setNotice(`已安装 ${item.device.model}。`);
          break;
        case "devices": {
          const pair = importedServoPair(item.devices);
          if (pair) { installServoPair(pair.drive, pair.motor); break; }
          persist(item.devices.reduce(installPackage, workspace));
          setTab("import", "device");
          setNotice(`已核对并安装 ${item.devices.length} 个设备修订。`);
          break;
        }
        case "milo-bom":
          persist(applyMiloBomImport(workspace, item.bom, item.source || item.name));
          setBomRevision(v => v + 1); setTab("milo");
          setNotice(`已导入 ${item.bom.length} 行 Milo 物料，可逐轴核料装配。`);
          break;
        case "so101-bom":
          persist(applySo101BomImport(workspace, item.bom));
          setBomRevision(v => v + 1); setTab("so101");
          setNotice(`已导入 ${item.bom.length} 行采购物料，并绑定 SO-101 官方从臂模型。`);
          break;
        case "gcode":
          persist({ ...workspace, milo: { ...(workspace.milo ?? initialMiloWorkspace), program: item.program } });
          setBomRevision(v => v + 1); setTab("milo");
          setNotice(`已载入 G 代码“${item.name}”。${workspace.milo?.assembled.length === 3 ? "可在编辑器中核对后运行。" : "完成三轴装配后可运行。"}`);
          break;
        case "materials":
        case "manual": {
          const rows = importMaterialRows(item, overrides);
          if (item.kind === "manual" && useManualAsSource) {
            setIncomingSource({ kind: "manual", id: ++sourceToken.current, row: rows[0], filename: item.name });
            setTab("library");
            break;
          }
          const next = mergeImportedMaterials(workspace, rows);
          const added = (next.catalog?.materials.length ?? 0) - (workspace.catalog?.materials.length ?? 0);
          persist(next); setTab("import", "material");
          setNotice(`已核对 ${rows.length} 条资料，新增 ${added} 条。`);
          break;
        }
        case "source-link":
          setIncomingSource({ kind: "link", id: ++sourceToken.current, url: item.url, title: item.title, locator: item.source });
          setTab("library"); setNotice("已带入官网资料链接，可核对来源并生成设备草案。");
          break;
      }
    });
  }

  async function exportWorkspace() {
    if (!workspace.catalog?.models.length) {
      downloadJson(workspace, "构元_设备仿真工程.json");
      return;
    }
    const { exportProjectArchive } = await import("@/lib/model-files");
    downloadFile(await exportProjectArchive(workspace), "构元_完整仿真工程.zip");
  }

  function openMaterialDraft(row: MaterialRow) {
    setIncomingSource(undefined);
    setSourceDraft(previous => ({
      key: (previous?.key ?? 0) + 1,
      value: deviceSourceFromMaterial(row),
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
    persist([drive, motor].reduce(installPackage, workspace));
    setTab("servo");
    setSelection((previous) => ({ driveKey: packageKey(drive), motorKey: packageKey(motor), version: previous.version + 1 }));
    setShowSources(false);
    setNotice("驱动器和电机均已安装。确认下方选中的设备，组轴后即可运行目标位置。");
  }

  return (
    <ImportStartContext.Provider value={intake.events}><div className="min-h-screen bg-background">
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
            <p className="mt-2 text-[13px] text-muted-foreground">{tab === "import" ? "导入自己的物理模型、设备包或物料清单，在浏览器中建模和仿真。" : tab === "so101" ? "从官方物料清单装配机械臂，在浏览器中运行 MuJoCo 物理仿真。" : tab === "milo" ? "从官方 BOM 装配铣床三轴，在工件坐标系中回放 G 代码。" : "从厂商资料生成设备包，连接设备端口，逐步观察信号。"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {tab !== "import" && <Button variant="outline" onClick={() => importInput.current?.click()}><Upload />导入文件</Button>}
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
            <input ref={importInput} className="hidden" aria-label="工作台统一导入文件" type="file" multiple accept={WORKBENCH_FILE_ACCEPT} onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) importFiles(files);
            }} />
          </div>
        </div>
        {session.warning && <div role="alert" className="mt-4 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {session.warning}
          {session.damaged && session.raw !== null && <Button className="ml-2" variant="outline" size="sm" onClick={() => downloadBlob(session.raw!, "构元_原始存档.txt", "text/plain;charset=utf-8")}>下载原存档</Button>}
        </div>}
        {(intake.state.phase === "reading" || intake.state.phase === "failed") && <Dialog open onOpenChange={open => { if (!open) cancelImport(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{intake.state.phase === "reading" ? "正在识别导入内容" : "无法导入这份资料"}</DialogTitle>
              <DialogDescription className="break-words" role={intake.state.phase === "reading" ? "status" : "alert"}>{intake.state.phase === "reading" ? intake.state.name : intake.state.error}</DialogDescription>
            </DialogHeader>
            <Button variant="outline" onClick={cancelImport}>{intake.state.phase === "reading" ? "取消读取" : "关闭"}</Button>
          </DialogContent>
        </Dialog>}
        {intake.state.phase === "preview" && <WorkbenchImportPreview key={intake.state.candidate.name} candidate={intake.state.candidate} workspace={workspace}
          confirmed={intake.state.confirmed} busy={intake.state.busy} error={intake.state.error} onClose={cancelImport}
          onConfirm={confirmImport} onUseManual={overrides => confirmImport(overrides, true)} onAssemble={device => run(() => assemble(device))} />}
        <Tabs value={tab} onValueChange={setTab} className="mt-6 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <TabsList aria-label="设备工作台" className="h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="import"><FileInput />导入中心</TabsTrigger>
              <TabsTrigger value="library"><Package />设备库<span className="mono text-xs text-muted-foreground">{workspace.packages.length}</span></TabsTrigger>
              <TabsTrigger value="simulation"><Workflow />仿真装配<span className="mono text-xs text-muted-foreground">{workspace.instances.length}</span></TabsTrigger>
              <TabsTrigger value="servo"><Activity />伺服轴</TabsTrigger>
              <TabsTrigger value="so101"><Bot />SO-101</TabsTrigger>
              <TabsTrigger value="milo"><Drill />Milo v1.5 铣床</TabsTrigger>
            </TabsList>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Monitor className="h-3.5 w-3.5" />{session.warning ? "会话工作区" : "工程保存在此浏览器"}</span>
          </div>
          {notice && <div role="status" className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span>{notice}</span><button type="button" className="shrink-0 text-muted-foreground hover:underline" onClick={() => setNotice("")}>关闭提示</button>
          </div>}
          <TabsContent value="import">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开导入中心…</p>}>
              <ImportCenter key={generation} workspace={workspace} onChange={save} onOpenDevice={assemble} onUseSource={openMaterialDraft}
                onImportFiles={importFiles} onImportText={importText} onPreviewDevice={intake.previewDevice} incomingModel={incomingModel} />
            </Suspense>
          </TabsContent>
          <TabsContent forceMount value="library" className="data-[state=inactive]:hidden">
            <TwinDeviceLibrary key={`${generation}-${sourceDraft?.key ?? 0}`} initialSource={sourceDraft?.value} incomingSource={incomingSource} packages={workspace.packages}
              active={tab === "library"} onImportFile={importFile} onImportText={importText} onPreviewDevice={intake.previewDevice} onAssemble={assemble} />
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
              <So101Workbench key={`${generation}-${bomRevision}`} workspace={workspace} onChange={save} onImportFile={importFile} />
            </Suspense>
          </TabsContent>
          <TabsContent value="milo">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开 Milo 三轴铣床…</p>}>
              <MiloWorkbench key={`${generation}-${bomRevision}`} workspace={workspace} onChange={save} onImportFile={importFile} />
            </Suspense>
          </TabsContent>
        </Tabs>
      </main>
    </div></ImportStartContext.Provider>
  );
}
