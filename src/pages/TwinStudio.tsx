import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { nanoid } from "nanoid";
import { ArrowLeft, Blocks, ChevronDown, CircuitBoard, Download, FilePlus2, FolderOpen, Github, LayoutGrid, Package, Upload, Workflow } from "lucide-react";
import { IS_PAGES } from "@/const";
import { hasFeedRole, hasServoRole } from "@contracts/device-model-binding";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import { MAX_PROJECT_JSON_BYTES, parseImportCatalog, type MaterialRow } from "@contracts/import-catalog";
import { matchMaterials } from "@contracts/material-import";
import { applyMiloBomImport, applySo101BomImport, importedServoPair, mergeImportedMaterials } from "@contracts/import-apply";
import { initialMiloWorkspace } from "@contracts/milo-workspace";
import { upsertLinearAssembly, type LinearAssembly } from "@contracts/linear-assembly";
import { upsertFactoryLayout, type FactoryLayout } from "@contracts/factory";
import { installMechanicalBundle, upsertMechanicalAssembly, type MechanicalAssembly } from "@contracts/mechanical-assembly";
import { upsertTwinSystem, type TwinSystemAssembly } from "@contracts/system-twin";
import { deviceSourceFromMaterial, type DeviceSourceInput } from "@contracts/twin-extract";
import { getWorkbenchTargets, publishedStudioFile, readStudioRoute, studioHref, type MotorAxisLocation, type StudioRoute, type StudioTarget } from "@contracts/studio-navigation";
import { addInstance, emptyWorkspace, installDeviceDependencies, installPackage, nextInstanceName, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import TwinDeviceLibrary from "@/components/TwinDeviceLibrary";
import ServoPairImport from "@/components/ServoPairImport";
import StudioRunArea from "@/components/StudioRunArea";
import { downloadBlob, downloadFile, downloadJson } from "@/lib/download";
import { importMaterialRows, prepareProjectResources, WORKBENCH_FILE_ACCEPT, type DeviceDraftPatch, type ImportOverrides, type IncomingWorkbenchModel, type WorkbenchImportOptions } from "@/lib/workbench-import";
import { ImportStartContext, useWorkbenchImport } from "@/hooks/useWorkbenchImport";
import { CncProgramImportContext, type CncProgramReceiver } from "@/hooks/useCncProgramImport";
import WorkbenchImportPreview from "@/components/WorkbenchImportPreview";

const storageKey = "gouyuan.twin.workspace.v1";
const openedProjectKey = storageKey + ".opened";
const ImportCenter = lazy(() => import("@/components/ImportCenter"));
const StudioExamples = lazy(() => import("@/components/StudioExamples"));
const SandboxBuilderStudio = lazy(() => import("@/components/SandboxBuilderStudio"));
const destinations = [
  { route: { view: "resources" }, label: "① 设备与资料", icon: Package },
  { route: { view: "workbench" }, label: "② 装配与仿真", icon: Workflow },
  { route: { view: "examples" }, label: "③ 参考模板", icon: LayoutGrid },
] as const;

function readLocalWorkspace() {
  let raw: string | null = null;
  let epoch: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
    epoch = localStorage.getItem(openedProjectKey);
    const workspace = raw === null ? emptyWorkspace() : parseWorkspace(JSON.parse(raw));
    return { workspace, raw, epoch, damaged: false, warning: "" };
  } catch {
    return {
      workspace: emptyWorkspace(), raw, epoch, damaged: raw !== null,
      warning: raw === null
        ? "浏览器存储不可用。请在关闭页面前导出工程。"
        : "已有存档未能读取。可下载原存档，再从工程文件菜单导入备份或新建工程。",
    };
  }
}

export default function TwinStudio() {
  const [session, setSession] = useState(readLocalWorkspace);
  const location = useLocation(), navigate = useNavigate();
  const rawRoute = readStudioRoute(location.search, location.hash);
  const showSandbox = rawRoute.view === "sandbox" || (!location.search && !location.hash);
  const route: StudioRoute = showSandbox && rawRoute.view !== "sandbox" ? { view: "sandbox" } : rawRoute;
  const authoring = route.view === "resources" && route.section === "author";
  const browsingResources = route.view === "resources" && !authoring;
  const [showPairSource, setShowPairSource] = useState(false);
  const [motorToMount, setMotorToMount] = useState<string>();
  const [lastTarget, setLastTarget] = useState<StudioTarget | undefined>(() =>
    route.view === "workbench" && route.target !== "incoming" ? route.target : undefined);
  const [selection, setSelection] = useState<{ driveKey?: string; motorKey?: string; version: number }>({ version: 0 });
  const [generation, setGeneration] = useState(0);
  const [openedProject, setOpenedProject] = useState(0);
  const observedEpoch = useRef(session.epoch);
  const [sourceDraft, setSourceDraft] = useState<{ value: Partial<DeviceSourceInput>; key: number }>();
  const [incomingSource, setIncomingSource] = useState<DeviceDraftPatch>();
  const sourceToken = useRef(0);
  const [notice, setNotice] = useState("");
  const [bomRevision, setBomRevision] = useState(0);
  const [incomingModel, setIncomingModel] = useState<IncomingWorkbenchModel | null>(null);
  const modelToken = useRef(0);
  const importInput = useRef<HTMLInputElement>(null);
  const { workspace } = session;
  const selectedMotor = motorToMount ? workspace.packages.find(p => packageKey(p) === motorToMount) : undefined;
  const motorDestinations = useMemo(() => {
    if (selectedMotor?.motorPhysics?.kind !== "motor") return [];
    const catalog = new Map(workspace.packages.map(p => [packageKey(p), p]));
    return (workspace.factories ?? []).flatMap(layout => layout.resources.flatMap(resource => {
      const ports = catalog.get(resource.packageKey)?.axisPorts?.filter(port => port.fit === selectedMotor.motorPhysics!.fit);
      return ports?.length ? [{ layout, resource, ports }] : [];
    }));
  }, [workspace, selectedMotor]);
  const targets = useMemo(() => getWorkbenchTargets(workspace), [workspace]);
  const remembered = targets.find(item => item.id === lastTarget)?.id;
  const workbenchTarget = route.view === "workbench" && route.exampleId === undefined && route.unavailableTarget === undefined
    ? route.target ?? remembered ?? targets[0]?.id : undefined;
  const editingAssembly = workbenchTarget === "assembly-new" || workbenchTarget === "mechanism-new" || workbenchTarget === "factory-new" || workbenchTarget === "system-new" ||
    ((workbenchTarget?.startsWith("assembly:") || workbenchTarget?.startsWith("mechanism:") || workbenchTarget?.startsWith("factory:") || workbenchTarget?.startsWith("system:")) && targets.some(item => item.id === workbenchTarget));
  const [cncReceiver, setCncReceiver] = useState<CncProgramReceiver | null>(null);
  const intake = useWorkbenchImport((model, onInstalled) => {
    setIncomingModel({ selection: model, token: ++modelToken.current, onInstalled });
    go({ view: "workbench", target: "incoming" });
  });
  const cancelImport = intake.cancel;
  const routeKey = location.key;
  const previousRoute = useRef(routeKey);
  const pendingHref = useRef("");
  const previewedLink = useRef<string | null>(null);
  const sharedSource = route.view === "resources" ? route.source : undefined;
  const openImportText = intake.text;
  useEffect(() => {
    if (!sharedSource || previewedLink.current === routeKey) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      previewedLink.current = routeKey;
      try {
        const base = new URL(import.meta.env.BASE_URL, window.location.origin);
        openImportText(publishedStudioFile(sharedSource, base.href), sharedSource.split("/").at(-1) ?? sharedSource);
      } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法打开分享的资料。"); }
    });
    return () => { active = false; };
  }, [sharedSource, routeKey, openImportText]);
  const target = route.view === "workbench" ? route.target : undefined;
  useLayoutEffect(() => {
    if (previousRoute.current === routeKey) return;
    previousRoute.current = routeKey;
    cancelImport();
    if (target !== "incoming") setIncomingModel(null);
    if (target && target !== "incoming") setLastTarget(target);
    if (pendingHref.current !== location.search + location.hash) setNotice("");
    pendingHref.current = "";
  }, [routeKey, target, location.search, location.hash, cancelImport]);

  function go(next: StudioRoute, message = "", replace = false) {
    cancelImport();
    if (next.view !== "workbench" || next.target !== "incoming") setIncomingModel(null);
    setNotice(message);
    const href = studioHref(next);
    if (href === location.search + location.hash) return;
    pendingHref.current = href;
    navigate(href, { replace });
  }

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== openedProjectKey && event.key !== null)) return;
      const latest = readLocalWorkspace();
      const reopened = latest.epoch !== observedEpoch.current || event.key === null;
      if (reopened) {
        observedEpoch.current = latest.epoch;
        setOpenedProject(n => n + 1);
      } else if (event.key === openedProjectKey) return;
      cancelImport();
      setIncomingModel(null);
      setSession(latest);
      setSourceDraft(undefined);
      setIncomingSource(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      setLastTarget(undefined);
      setNotice(reopened ? "已切换到其他标签页打开的完整工程。" : "已载入其他标签页保存的工程。");
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
    if ((next.catalog || next.assemblies?.length || next.mechanisms?.length || next.factories?.length || next.systems?.length || next.packages.some(p => p.mechanics || p.factory || p.composition)) &&
      new TextEncoder().encode(raw).byteLength > MAX_PROJECT_JSON_BYTES) {
      throw new Error("工程文字资料超过 8 MiB，请将本次清单拆分到单独工程。");
    }
    let current: string | null, epoch: string | null;
    try {
      current = localStorage.getItem(storageKey);
      epoch = localStorage.getItem(openedProjectKey);
    } catch {
      setSession({ ...session, workspace: next, warning: "当前修改仅保存在本次会话中，请导出工程备份。" });
      return;
    }
    if (current !== session.raw || epoch !== session.epoch) {
      if (epoch !== observedEpoch.current) {
        observedEpoch.current = epoch;
        setOpenedProject(n => n + 1);
      }
      cancelImport();
      setIncomingModel(null);
      setSession(readLocalWorkspace());
      setSourceDraft(undefined);
      setIncomingSource(undefined);
      setGeneration((value) => value + 1);
      setSelection({ version: 0 });
      setLastTarget(undefined);
      const message = "其他标签页已更新工程。已载入最新存档，请重试本次操作。";
      setNotice(message);
      throw new Error(message);
    }
    if (!replaceDamaged && raw === current && !session.warning) return;
    try {
      localStorage.setItem(storageKey, raw);
    } catch {
      setSession({ workspace: next, raw: current, epoch, damaged: false, warning: "浏览器写入失败。当前工程仍可导出，请保存备份。" });
      return;
    }
    let warning = "";
    if (replaceDamaged) {
      // 整档恢复与普通改动可以生成完全相同的 JSON，其他标签页仍须抛弃旧工程的草稿。
      try {
        const nextEpoch = nanoid();
        localStorage.setItem(openedProjectKey, nextEpoch);
        observedEpoch.current = epoch = nextEpoch;
      } catch { warning = "工程已保存，浏览器未能同步此次工程切换。请在其他打开的标签页重新载入。"; }
    }
    setSession({ workspace: next, raw, epoch, damaged: false, warning });
  }

  function save(next: TwinWorkspace) {
    cancelImport();
    persist(next);
    if (workspace.servoAxis !== next.servoAxis) setSelection(previous => ({ version: previous.version }));
  }

  function confirmOpen(label: string) {
    const occupied = workspace.packages.length || workspace.so101 || workspace.milo || workspace.assemblies?.length || workspace.mechanisms?.length || workspace.factories?.length || workspace.systems?.length || workspace.catalog?.models.length || workspace.catalog?.materials.length || session.damaged;
    return !occupied || window.confirm(`用“${label}”替换当前本机工程？如需保留当前工程，请先取消并导出备份。`);
  }

  function showProject(next: TwinWorkspace, message: string, motorFocus?: MotorAxisLocation, contourFocus?: string) {
    persist(next, true);
    setSourceDraft(undefined);
    setIncomingSource(undefined);
    setGeneration((value) => value + 1);
    setOpenedProject((value) => value + 1);
    setSelection({ version: 0 });
    setLastTarget(undefined); setShowPairSource(false);
    if ((next.mechanisms?.length ?? 0) + (next.assemblies?.length ?? 0) + (next.factories?.length ?? 0) + (next.systems?.length ?? 0) > 1) go({ view: "resources", section: "system" }, message);
    else if (next.factories?.length) {
      const factory = next.factories[0], runs = factory.resources.filter(r => r.contourRun);
      const contour = contourFocus ?? (!motorFocus && runs.length === 1 ? runs[0].id : undefined);
      go({ view: "workbench", target: `factory:${factory.id}`,
        ...(contour ? { contour } : motorFocus && { motorAxis: motorFocus.resourceId, axis: motorFocus.axisId }) }, message);
    }
    else if (next.systems?.length) go({ view: "workbench", target: `system:${next.systems[0].id}` }, message);
    else if (next.mechanisms?.length) go({ view: "workbench", target: `mechanism:${next.mechanisms[0].id}` }, message);
    else if (next.assemblies?.length) go({ view: "workbench", target: `assembly:${next.assemblies[0].id}` }, message);
    else if (next.milo) go({ view: "workbench", target: "milo" }, message);
    else if (next.catalog?.models.length || next.catalog?.materials.length) go({ view: "resources" }, message);
    else if (next.so101) go({ view: "workbench", target: "so101" }, message);
    else if (next.servoAxis) go({ view: "workbench", target: "servo" }, message);
    else if (next.instances.length) go({ view: "workbench", target: "wiring" }, message);
    else go({ view: "resources" }, message);
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
          showProject(item.workspace, `已导入工程“${item.name}”。`, item.motorFocus, item.contourFocus);
          break;
        case "device":
          persist(installPackage(workspace, item.device));
          setNotice(`已安装 ${item.device.model}。`);
          if (editingAssembly) cancelImport();
          break;
        case "devices": {
          const pair = importedServoPair(item.devices);
          if (pair && !editingAssembly) { installServoPair(pair.drive, pair.motor); break; }
          persist(item.devices.reduce(installPackage, workspace));
          const message = `已核对并安装 ${item.devices.length} 个设备修订。`;
          if (editingAssembly) setNotice(message);
          else go({ view: "resources", section: "device" }, message);
          break;
        }
        case "factory":
          persist(upsertFactoryLayout(workspace, item.layout));
          go({ view: "workbench", target: `factory:${item.layout.id}` }, `已导入工厂布局“${item.layout.name}”。`);
          break;
        case "assembly":
          persist(upsertLinearAssembly(workspace, item.assembly));
          go({ view: "workbench", target: `assembly:${item.assembly.id}` }, `已导入装配“${item.assembly.name}”。`);
          break;
        case "mechanism":
          persist(upsertMechanicalAssembly(workspace, item.assembly));
          go({ view: "workbench", target: `mechanism:${item.assembly.id}` }, `已导入装配“${item.assembly.name}”。`);
          break;
        case "mechanical-bundle": {
          const next = installMechanicalBundle(workspace, item.bundle);
          persist(next);
          const message = "已安装子装配及其引用的设备修订。";
          if (editingAssembly) setNotice(message);
          else go({ view: "resources", section: "device" }, message);
          break;
        }
        case "milo-bom":
          persist(applyMiloBomImport(workspace, item.bom, item.source || item.name));
          setBomRevision(v => v + 1);
          go({ view: "workbench", target: "milo" }, `已导入 ${item.bom.length} 行 Milo 物料，可逐轴核料装配。`);
          break;
        case "so101-bom":
          persist(applySo101BomImport(workspace, item.bom));
          setBomRevision(v => v + 1);
          go({ view: "workbench", target: "so101" }, `已导入 ${item.bom.length} 行采购物料，并绑定 SO-101 官方从臂模型。`);
          break;
        case "gcode":
          if (cncReceiver) {
            cncReceiver.accept(item.program);
            setNotice(`已载入 ${cncReceiver.name} 的加工草稿“${item.name}”，可核对后运行。`);
            break;
          }
          persist({ ...workspace, milo: { ...(workspace.milo ?? initialMiloWorkspace), program: item.program } });
          setBomRevision(v => v + 1);
          go({ view: "workbench", target: "milo" }, `已载入 G 代码“${item.name}”。${workspace.milo?.assembled.length === 3 ? "可在编辑器中核对后运行。" : "完成三轴装配后可运行。"}`);
          break;
        case "materials":
        case "manual": {
          const rows = importMaterialRows(item, overrides);
          if (item.kind === "manual" && useManualAsSource) {
            setIncomingSource({ kind: "manual", id: ++sourceToken.current, row: rows[0], filename: item.name });
            go({ view: "resources", section: "author" });
            break;
          }
          const next = mergeImportedMaterials(workspace, rows);
          const added = (next.catalog?.materials.length ?? 0) - (workspace.catalog?.materials.length ?? 0);
          persist(next);
          const message = `已核对 ${rows.length} 条资料，新增 ${added} 条。`;
          if (editingAssembly && item.kind === "materials") setNotice(message);
          else go({ view: "resources", section: "material" }, message);
          break;
        }
        case "source-link":
          setIncomingSource({ kind: "link", id: ++sourceToken.current, url: item.url, title: item.title, locator: item.source });
          go({ view: "resources", section: "author" }, "已带入官网资料链接，可核对来源并生成设备草案。");
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
    go({ view: "resources", section: "author" }, `已带入“${row.name}”的资料。请核对身份、定位和规格后生成草案。`);
  }

  function assemble(pkg: DevicePackage, mode?: "factory" | "motor") {
    const isServo = hasServoRole(pkg, "drive") || hasServoRole(pkg, "motor");
    const isFeed = hasFeedRole(pkg, "screw") || hasFeedRole(pkg, "table");
    if (pkg.motorPhysics && (mode === "motor" || (!isServo && !pkg.factory && !isFeed && !pkg.mechanics))) {
      if (pkg.motorPhysics.kind === "motor") {
        cancelImport();
        setMotorToMount(packageKey(pkg));
      } else go({ view: "resources", section: "author", motorPart: packageKey(pkg) });
      return;
    }
    if (pkg.factory && (mode === "factory" || (!isFeed && !pkg.mechanics && !isServo))) {
      go({ view: "workbench", target: "factory-new", part: packageKey(pkg) });
      return;
    }
    if (isFeed) {
      go({ view: "workbench", target: "assembly-new", part: packageKey(pkg) });
      return;
    }
    if (pkg.mechanics) {
      go({ view: "workbench", target: "mechanism-new", part: packageKey(pkg) });
      return;
    }
    if (isServo) {
      const key = packageKey(pkg);
      const role = hasServoRole(pkg, "drive") ? "drive" : "motor";
      setSelection((previous) => ({ version: previous.version + 1, ...(role === "drive" ? { driveKey: key } : { motorKey: key }) }));
      go({ view: "workbench", target: "servo" }, `已选中 ${pkg.model}，可在伺服轴中核对配套型号。`);
      return;
    }
    if (pkg.composition && !pkg.ports.length) {
      intake.previewDevice(pkg, true);
      return;
    }
    const name = nextInstanceName(workspace, pkg.model);
    save(addInstance(workspace, packageKey(pkg), name));
    go({ view: "workbench", target: "wiring" }, `已将“${name}”加入信号接线装配。`);
  }

  function installServoPair(drive: DevicePackage, motor: DevicePackage) {
    persist([drive, motor].reduce(installPackage, workspace));
    setSelection((previous) => ({ driveKey: packageKey(drive), motorKey: packageKey(motor), version: previous.version + 1 }));
    setShowPairSource(false);
    go({ view: "workbench", target: "servo" }, "驱动器和电机均已安装，组轴后即可运行目标位置。");
  }

  function applyExample(next: TwinWorkspace, target: StudioTarget, name: string, focus?: MotorAxisLocation, contour?: string) {
    save(next);
    if (target === "servo") setSelection(previous => ({ version: previous.version + 1 }));
    go({ view: "workbench", target, ...(contour ? { contour } : focus && { motorAxis: focus.resourceId, axis: focus.axisId }) }, `已将“${name}”加入当前工程。`);
  }

  function saveAssembly(assembly: LinearAssembly) {
    save(upsertLinearAssembly(workspace, assembly));
    go({ view: "workbench", target: `assembly:${assembly.id}` }, "", target === "assembly-new");
  }

  function saveFactory(layout: FactoryLayout, revised?: TwinWorkspace) {
    save(upsertFactoryLayout(revised ?? workspace, layout));
    if (target !== `factory:${layout.id}`) go({ view: "workbench", target: `factory:${layout.id}` }, "", target === "factory-new");
  }

  function saveDeviceRevision(revised: TwinWorkspace, key: string) {
    const next = installDeviceDependencies(workspace, revised.packages, [key]);
    const device = next.packages.find(pkg => packageKey(pkg) === key)!;
    persist(next);
    intake.previewDevice(device, true);
  }

  function saveMechanism(assembly: MechanicalAssembly, revised?: TwinWorkspace) {
    save(upsertMechanicalAssembly(revised ?? workspace, assembly));
    go({ view: "workbench", target: `mechanism:${assembly.id}` }, "", target === "mechanism-new");
  }

  function saveSystem(sys: TwinSystemAssembly, revised?: TwinWorkspace) {
    save(upsertTwinSystem(revised ?? workspace, sys));
    go({ view: "workbench", target: `system:${sys.id}` }, `已保存机电控系统“${sys.name}”。`, target === "system-new");
  }

  return (
    <ImportStartContext.Provider value={intake.events}><CncProgramImportContext.Provider value={setCncReceiver}><div className={showSandbox ? "flex h-[100dvh] flex-col overflow-hidden bg-background" : "min-h-screen bg-background"}>
      {!showSandbox && <header className="border-b bg-card/65">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-8 lg:gap-x-8">
          <div className="flex shrink-0 items-center gap-2">
            <CircuitBoard className="size-6 text-primary" strokeWidth={1.7} /><span className="text-base font-semibold tracking-wide">构元</span>
            <span className="sr-only text-sm text-muted-foreground min-[430px]:not-sr-only min-[430px]:ml-1 min-[430px]:border-l min-[430px]:pl-3">专业工程模式</span>
          </div>
          <nav aria-label="工作台主导航" className="order-last flex w-full min-w-0 items-center gap-0.5 lg:order-none lg:w-auto lg:gap-1">
            {destinations.map(({ route: destination, label, icon: Icon }) => <Link key={destination.view} to={studioHref(destination.view === "workbench" && remembered ? { view: "workbench", target: remembered } : destination)}
              aria-current={route.view === destination.view ? "page" : undefined}
              className={`inline-flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1.5 py-2 text-sm font-medium sm:flex-none sm:gap-1.5 sm:px-3 ${route.view === destination.view ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              <Icon className="size-4" />{label}
            </Link>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="secondary" asChild>
              <Link to={studioHref({ view: "sandbox" })}><Blocks />返回积木工坊</Link>
            </Button>
            {!browsingResources && <Button size="sm" variant="outline" onClick={() => importInput.current?.click()}><Upload />导入文件</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline"><FolderOpen />工程文件<ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{session.warning ? "当前会话的工程" : "当前工程 · 本机保存"}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => importInput.current?.click()}><Upload />导入工程文件</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportWorkspace().catch(error => setNotice(error instanceof Error ? error.message : "工程导出失败。"))}><Download />{workspace.catalog?.models.length ? "导出完整工程 ZIP" : "导出工程 JSON"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run(() => open(emptyWorkspace(), "空白工程", "已新建空白工程。"))}><FilePlus2 />新建空白工程</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {IS_PAGES
              ? <a href="https://github.com/lusipad/omg" aria-label="项目源码" title="项目源码" className="rounded p-1.5 text-muted-foreground hover:text-foreground"><Github className="size-4" /></a>
              : <Link to="/" aria-label="返回客户项目" title="返回客户项目" className="rounded p-1.5 text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /></Link>}
            <input ref={importInput} className="hidden" aria-label="工作台统一导入文件" type="file" multiple accept={WORKBENCH_FILE_ACCEPT} onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) importFiles(files);
            }} />
          </div>
        </div>
      </header>}
      <main className={showSandbox ? "page-enter flex min-h-0 flex-1 flex-col overflow-hidden p-2 sm:p-2.5" : "page-enter mx-auto max-w-[1440px] space-y-4 px-4 pb-12 pt-5 sm:px-8 sm:pt-7"}>
        {showSandbox && (
          <Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">正在加载构元积木工坊…</p>}>
            <SandboxBuilderStudio
              workspace={workspace}
              initialChallengeId={route.view === "sandbox" ? route.level : undefined}
              onSaveWorkspace={save}
              onNavigate={go}
            />
          </Suspense>
        )}
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
        {intake.state.phase === "preview" && <WorkbenchImportPreview key={intake.state.candidate.name} candidate={intake.state.candidate} workspace={workspace} gcodeTarget={cncReceiver?.name}
          confirmed={intake.state.confirmed} busy={intake.state.busy} error={intake.state.error} onClose={cancelImport}
          onConfirm={confirmImport} onUseManual={overrides => confirmImport(overrides, true)} onAssemble={(device, mode) => run(() => assemble(device, mode))}
          onApplyDeviceRevision={saveDeviceRevision} />}
        {notice && <div role="status" className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span>{notice}</span><button type="button" className="shrink-0 text-muted-foreground hover:underline" onClick={() => setNotice("")}>关闭提示</button>
        </div>}
        <div hidden={!browsingResources}>
          <Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开工程资源…</p>}>
            <ImportCenter key={generation} active={browsingResources} workspace={workspace} onChange={save} onOpenDevice={assemble}
              onUseSource={openMaterialDraft} onImportFiles={importFiles} onImportText={importText} onPreviewDevice={intake.previewDevice}
              onOpenModel={ref => go({ view: "workbench", target: `model:${ref.id}` })} onOpenSystem={target => go({ view: "workbench", target })}
              onCreateDevice={() => go({ view: "resources", section: "author" })} onBrowseExamples={() => go({ view: "examples" })} />
          </Suspense>
        </div>
        <section hidden={!authoring} aria-label="创建设备" className="space-y-4">
          <Link to={studioHref({ view: "resources" })} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />返回工程资源</Link>
          <TwinDeviceLibrary key={JSON.stringify([generation, sourceDraft?.key ?? 0, route.view === "resources" ? route.motorPart : undefined])}
            workspace={workspace} initialMotorPartKey={route.view === "resources" ? route.motorPart : undefined} initialSource={sourceDraft?.value} incomingSource={incomingSource}
            active={authoring} onImportFile={importFile} onImportText={importText} onPreviewDevice={intake.previewDevice} />
          {authoring && !IS_PAGES && <section className="surface">
            <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium" aria-expanded={showPairSource} aria-controls="servo-sources" onClick={() => setShowPairSource(!showPairSource)}>
              从官网创建配套伺服设备<ChevronDown className={`size-4 ${showPairSource ? "rotate-180" : ""}`} />
            </button>
            {showPairSource && <div id="servo-sources" className="border-t p-4"><ServoPairImport onInstall={installServoPair} /></div>}
          </section>}
        </section>
        <StudioRunArea route={route.view === "workbench" ? route : null} workspace={workspace} generation={generation} openedProject={openedProject}
          bomRevision={bomRevision} servoChoice={selection} targets={targets} target={workbenchTarget} incoming={incomingModel}
          onChange={save} onSaveAssembly={saveAssembly} onSaveFactory={saveFactory} onSaveSystem={saveSystem} onOpenImport={() => importInput.current?.click()} onSaveMechanism={saveMechanism}
          onInstallBundle={bundle => save(installMechanicalBundle(workspace, bundle))} onNavigate={go}
          onApplyExample={applyExample} onImportFile={importFile} onImportText={importText} />
        <Dialog open={motorToMount !== undefined} onOpenChange={open => { if (!open) setMotorToMount(undefined); }}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader><DialogTitle>选择电机的安装机床</DialogTitle><DialogDescription className="break-all">
              {selectedMotor?.model} · {selectedMotor?.revision}
            </DialogDescription></DialogHeader>
            {motorDestinations.length ? motorDestinations.map(({ layout, resource, ports }) =>
              <Button key={JSON.stringify([layout.id, resource.id])} variant="outline" className="h-auto whitespace-normal py-2" onClick={() => {
                setMotorToMount(undefined);
                go({ view: "workbench", target: `factory:${layout.id}`, motorAxis: resource.id, motorKey: motorToMount });
              }}>{layout.name} · {resource.name} · {ports.map(port => port.name).join("、")}</Button>)
              : <div className="space-y-3"><p className="text-sm">当前工程缺少与这台电机配合的轴安装位。可以导入带轴工况的机床，或从示例库将数控工厂加入工程，再选用这台电机。</p>
                <Button variant="outline" onClick={() => { setMotorToMount(undefined); go({ view: "examples" }); }}>浏览示例库</Button></div>}
          </DialogContent>
        </Dialog>
        {route.view === "examples" && <Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开示例库…</p>}>
          <StudioExamples />
        </Suspense>}
      </main>
    </div></CncProgramImportContext.Provider></ImportStartContext.Provider>
  );
}
