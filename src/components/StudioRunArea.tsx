import { lazy, Suspense, useState } from "react";
import { ArrowLeft, ChevronDown, FolderInput, Layers, LayoutGrid, Plus, Sparkles, Workflow } from "lucide-react";
import { Link } from "react-router";
import { getStudioExample, studioHref, type MotorAxisLocation, type StudioRoute, type StudioTarget, type StudioTargetOption } from "@contracts/studio-navigation";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { FactoryLayout } from "@contracts/factory";
import type { LinearAssembly } from "@contracts/linear-assembly";
import type { MechanicalAssembly, MechanicalBundle } from "@contracts/mechanical-assembly";
import type { TwinSystemAssembly } from "@contracts/system-twin";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { IncomingWorkbenchModel, WorkbenchImportOptions } from "@/lib/workbench-import";
import TwinSimulation from "./TwinSimulation";

const Physics = lazy(() => import("./ImportCenterPhysics"));
const Servo = lazy(() => import("./ServoAxisBench"));
const Follower = lazy(() => import("./So101Workbench"));
const Mill = lazy(() => import("./MiloWorkbench"));
const ExampleBench = lazy(() => import("./StudioExampleBench"));
const FactoryBench = lazy(() => import("./FactoryBench"));
const LinearAssemblyBench = lazy(() => import("./LinearAssemblyBench"));
const MechanicalAssemblyBench = lazy(() => import("./MechanicalAssemblyBench"));
const SystemTwinBench = lazy(() => import("./SystemTwinBench"));

type Props = {
  route: Extract<StudioRoute, { view: "workbench" }> | null;
  workspace: TwinWorkspace;
  generation: number;
  openedProject: number;
  bomRevision: number;
  servoChoice: { version: number; driveKey?: string; motorKey?: string };
  target?: StudioTarget;
  targets: StudioTargetOption[];
  incoming: IncomingWorkbenchModel | null;
  onChange: (next: TwinWorkspace) => void;
  onSaveAssembly: (assembly: LinearAssembly) => void;
  onSaveFactory: (layout: FactoryLayout, revised?: TwinWorkspace) => void;
  onSaveSystem: (system: TwinSystemAssembly, revised?: TwinWorkspace) => void;
  onOpenImport: () => void;
  onSaveMechanism: (assembly: MechanicalAssembly, revised?: TwinWorkspace) => void;
  onInstallBundle: (bundle: MechanicalBundle) => void;
  onNavigate: (route: StudioRoute, message?: string, replace?: boolean) => void;
  onApplyExample: (next: TwinWorkspace, target: StudioTarget, name: string, focus?: MotorAxisLocation, contour?: string) => void;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
};

const editorNames = { wiring: "信号接线", servo: "伺服轴", so101: "SO-101 从臂", milo: "Milo v1.5 三轴铣床" };
const createModes = [
  { target: "system-new", label: "机电控闭环系统（推荐主干）" },
  { target: "mechanism-new", label: "三维基本件可动与爆炸装配" },
  { target: "assembly-new", label: "直驱丝杠伺服轴" },
  { target: "factory-new", label: "工厂与生产线" },
] as const;

export default function StudioRunArea({ route, workspace, generation, openedProject, bomRevision, servoChoice, target, targets, incoming, onChange, onSaveAssembly, onSaveFactory, onSaveSystem, onOpenImport, onSaveMechanism, onInstallBundle, onNavigate, onApplyExample, onImportFile, onImportText }: Props) {
  const isExample = route?.exampleId !== undefined;
  const example = getStudioExample(route?.exampleId);
  const model = target?.startsWith("model:") ? workspace.catalog?.models.find(item => `model:${item.id}` === target) : undefined;
  const assembly = target?.startsWith("assembly:") ? workspace.assemblies?.find(item => `assembly:${item.id}` === target) : undefined;
  const mechanism = target?.startsWith("mechanism:") ? workspace.mechanisms?.find(item => `mechanism:${item.id}` === target) : undefined;
  const factory = target?.startsWith("factory:") ? workspace.factories?.find(item => `factory:${item.id}` === target) : undefined;
  const system = target?.startsWith("system:") ? workspace.systems?.find(item => `system:${item.id}` === target) : undefined;
  const creatingAssembly = target === "assembly-new" || target === "mechanism-new" || target === "factory-new" || target === "system-new";
  const missing = isExample && !example ? "没有找到这个示例。"
    : route?.unavailableTarget !== undefined || (target?.startsWith("model:") && !model) || (target?.startsWith("assembly:") && !assembly) || (target?.startsWith("mechanism:") && !mechanism) || (target?.startsWith("factory:") && !factory) || (target?.startsWith("system:") && !system) ? "当前工程中没有这个对象。"
    : target === "incoming" && !incoming ? "本次预览的模型文件已关闭，请重新选择文件。"
    : undefined;
  const [wiringRevision, setWiringRevision] = useState(0);
  const options = targets.filter(item => !["mechanism-new", "assembly-new", "factory-new", "system-new"].includes(item.id));
  if (target && !missing && !creatingAssembly && !options.some(item => item.id === target)) {
    if (target === "incoming") options.push({ id: target, name: "待安装的物理模型" });
    else if (target in editorNames) options.push({ id: target, name: editorNames[target as keyof typeof editorNames] });
  }

  return <section hidden={!route} aria-label="装配与仿真工作区" className="min-w-0 space-y-3.5">
    {route && <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        {isExample && (
          <Button size="sm" variant="outline" className="h-8 gap-1 px-2.5 text-xs" asChild>
            <Link to={studioHref({ view: "examples" })}><ArrowLeft className="size-3.5" />返回模板库</Link>
          </Button>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display-title break-words text-xl font-semibold sm:text-2xl">{example?.name ?? (isExample ? "示例预览" : "装配与仿真工作台")}</h1>
            {example && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">{example.category}</span>}
          </div>
          {!isExample && !missing && target && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {creatingAssembly ? "选择装配模式并搭建当前工程对象" : `当前工作区共 ${options.length} 个对象，可随时切换或新建装配`}
            </p>
          )}
        </div>
      </div>
      {!isExample && !missing && target && <div className="flex max-w-full flex-wrap items-center gap-2">
        {!creatingAssembly && options.length > 0 && (
          options.length <= 4 ? (
            <div role="group" aria-label="切换工程对象" className="flex flex-wrap items-center gap-1 rounded-md border bg-background/60 p-0.5">
              {options.map(item => (
                <Button
                  key={item.id}
                  size="sm"
                  type="button"
                  variant={item.id === target ? "secondary" : "ghost"}
                  className="h-7 max-w-48 truncate px-2.5 text-xs"
                  onClick={() => onNavigate({ view: "workbench", target: item.id })}
                >
                  {item.name}
                </Button>
              ))}
            </div>
          ) : (
            <label className="flex max-w-full items-center gap-2 text-xs text-muted-foreground">
              <span>当前对象</span>
              <select aria-label="当前工程对象" className="h-8 max-w-64 rounded-md border bg-background px-2 text-xs text-foreground"
                value={target} onChange={event => { const choice = options.find(item => item.id === event.target.value); if (choice) onNavigate({ view: "workbench", target: choice.id }); }}>
                {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )
        )}
        {creatingAssembly && (
          <div role="group" aria-label="新建装配类型" className="flex flex-wrap items-center gap-1 rounded-md border bg-background/60 p-0.5">
            {createModes.map(m => (
              <Button
                key={m.target}
                size="sm"
                type="button"
                variant={target === m.target ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => onNavigate({ view: "workbench", target: m.target })}
              >
                {m.label}
              </Button>
            ))}
          </div>
        )}
        {creatingAssembly && options.length > 0 && (
          <Button size="sm" variant="ghost" className="h-8 px-2.5 text-xs" onClick={() => onNavigate({ view: "workbench", target: options[0]!.id })}>
            <ArrowLeft className="size-3.5" />返回已有对象
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 gap-1 px-2.5 text-xs"><Plus className="size-3.5" />新建装配<ChevronDown className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>选择装配建模范式</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {createModes.map(m => (
              <DropdownMenuItem key={m.target} onSelect={() => onNavigate({ view: "workbench", target: m.target })}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
    </header>}
    {route && (missing || (!target && !isExample)) && <div className="surface space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{missing ? "未能打开目标工程对象" : "开始装配与闭环仿真"}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {missing ?? "当前工程还没有已保存的对象，可直接体验核心参考样板，或基于设备库开始搭建。"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><Link to={studioHref({ view: "resources" })}><FolderInput />进入设备与资料库</Link></Button>
          <Button size="sm" variant="ghost" asChild><Link to={studioHref({ view: "examples" })}><LayoutGrid />浏览全部 16 个模板</Link></Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Link to={studioHref({ view: "workbench", exampleId: "closed-loop-feed-system" })}
          className="group flex flex-col justify-between gap-2 rounded-lg border bg-background/60 p-4 transition-colors hover:border-primary/50 hover:bg-accent/40">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"><Workflow className="size-3" />Modelica WASM 闭环</span>
            <p className="text-sm font-semibold group-hover:text-primary">跨品牌机电控闭环与实测对标</p>
            <p className="text-xs leading-relaxed text-muted-foreground">台达伺服 + THK 丝杠 + 常闭限位 + GL10 滤波联合求解，联动 3D 丝杠与录波对比。</p>
          </div>
          <span className="text-xs font-medium text-primary">立即试跑样板 →</span>
        </Link>
        <Link to={studioHref({ view: "workbench", exampleId: "composable-milo-mill" })}
          className="group flex flex-col justify-between gap-2 rounded-lg border bg-background/60 p-4 transition-colors hover:border-primary/50 hover:bg-accent/40">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"><Layers className="size-3" />三维可动与爆炸图</span>
            <p className="text-sm font-semibold group-hover:text-primary">基本件拼装三轴立式铣床</p>
            <p className="text-xs leading-relaxed text-muted-foreground">23 个标准化型材、导轨、滚珠丝杠与电主轴，支持实时关节运动与层级爆炸透视。</p>
          </div>
          <span className="text-xs font-medium text-primary">立即试跑样板 →</span>
        </Link>
        <Link to={studioHref({ view: "workbench", target: "system-new" })}
          className="group flex flex-col justify-between gap-2 rounded-lg border bg-background/60 p-4 transition-colors hover:border-primary/50 hover:bg-accent/40">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"><Sparkles className="size-3" />从零/本机搭建</span>
            <p className="text-sm font-semibold group-hover:text-primary">新建机电控闭环系统</p>
            <p className="text-xs leading-relaxed text-muted-foreground">从当前工程资源、LinuxCNC .ini/.hal 或跨品牌标准套件一键组装您的新闭环系统。</p>
          </div>
          <span className="text-xs font-medium text-primary">进入系统构建 →</span>
        </Link>
      </div>
    </div>}
    {route && !missing && <Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开运行台…</p>}>
      {example && example.kind !== "physics" && <ExampleBench key={example.id} example={example} workspace={workspace}
        initialStructureId={route.exampleId !== undefined ? route.structure : undefined}
        initialContourId={route.exampleId !== undefined ? route.contour : undefined}
        initialMotorResourceId={route.exampleId !== undefined ? route.motorAxis : undefined} initialMotorAxisId={route.exampleId !== undefined ? route.axis : undefined}
        onApply={(next, destination, focus, contour) => {
        onApplyExample(next, destination, example.name, focus, contour);
        if (destination === "wiring") setWiringRevision(revision => revision + 1);
      }} />}
      {(example?.kind === "physics" || model || (target === "incoming" && incoming)) && <Physics
        key={example ? `example:${example.id}` : `${generation}-${model?.id ?? incoming?.token}`} workspace={workspace} onChange={onChange}
        exampleId={example?.id ?? null} requested={model ?? null} incoming={target === "incoming" ? incoming ?? undefined : undefined}
        onClose={() => onNavigate(example ? { view: "examples" } : { view: "resources", section: "physics" })}
        onInstalled={ref => onNavigate({ view: "workbench", target: `model:${ref.id}` }, `已将“${ref.name}”加入当前工程。`, target === "incoming")} />}
      {target === "servo" && <Servo key={`${generation}-${servoChoice.version}`} workspace={workspace} onChange={onChange} preferred={servoChoice} />}
      {target === "so101" && <Follower key={`${generation}-${bomRevision}`} workspace={workspace} onChange={onChange} onImportFile={onImportFile} onImportText={onImportText} />}
      {target === "milo" && <Mill key={`${generation}-${bomRevision}`} workspace={workspace} onChange={onChange} onImportFile={onImportFile} onImportText={onImportText} />}
      {(target === "assembly-new" || assembly) && <LinearAssemblyBench key={openedProject}
        workspace={workspace} assembly={assembly} onSave={onSaveAssembly} initialPackageKey={route.target === "assembly-new" ? route.part : undefined} />}
      {(target === "factory-new" || factory) && <FactoryBench key={JSON.stringify([openedProject, route.target?.startsWith("factory:") ? route.motorAxis : null,
        route.target?.startsWith("factory:") ? route.axis : null, route.target?.startsWith("factory:") ? route.motorKey : null,
        route.target?.startsWith("factory:") ? route.contour : null])} workspace={workspace} layout={factory} onSave={onSaveFactory} onUpdateLibrary={onChange}
        initialContourId={route.target?.startsWith("factory:") ? route.contour : undefined}
        initialMotorResourceId={route.target?.startsWith("factory:") ? route.motorAxis : undefined}
        initialMotorAxisId={route.target?.startsWith("factory:") ? route.axis : undefined}
        initialMotorKey={route.target?.startsWith("factory:") ? route.motorKey : undefined}
        onImport={onOpenImport} initialPackageKey={route.target === "factory-new" ? route.part : undefined} />}
      {(target === "mechanism-new" || mechanism) && <MechanicalAssemblyBench key={openedProject} workspace={workspace} assembly={mechanism}
        initialPackageKey={route.target === "mechanism-new" ? route.part : undefined} onSave={onSaveMechanism} onInstallBundle={onInstallBundle} />}
      {(target === "system-new" || system) && <SystemTwinBench key={`${openedProject}-${system?.id ?? "new"}`} workspace={workspace} system={system}
        onSave={onSaveSystem} />}
    </Suspense>}
    <div hidden={target !== "wiring"}>
      <TwinSimulation key={`${generation}-${wiringRevision}`} workspace={workspace} onChange={onChange} />
    </div>
  </section>;
}
