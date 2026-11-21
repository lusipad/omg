import { lazy, Suspense, useState } from "react";
import { ArrowLeft, FolderInput, Plus } from "lucide-react";
import { Link } from "react-router";
import { getStudioExample, studioHref, type MotorAxisLocation, type StudioRoute, type StudioTarget, type StudioTargetOption } from "@contracts/studio-navigation";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { FactoryLayout } from "@contracts/factory";
import type { LinearAssembly } from "@contracts/linear-assembly";
import type { MechanicalAssembly, MechanicalBundle } from "@contracts/mechanical-assembly";
import type { TwinSystemAssembly } from "@contracts/system-twin";
import { Button } from "@/components/ui/button";
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
  onSaveMechanism: (assembly: MechanicalAssembly) => void;
  onInstallBundle: (bundle: MechanicalBundle) => void;
  onNavigate: (route: StudioRoute, message?: string, replace?: boolean) => void;
  onApplyExample: (next: TwinWorkspace, target: StudioTarget, name: string, focus?: MotorAxisLocation, contour?: string) => void;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
};

const editorNames = { wiring: "信号接线", servo: "伺服轴", so101: "SO-101 从臂", milo: "Milo v1.5 三轴铣床" };

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
  const options = targets.filter(item => !creatingAssembly || !["mechanism-new", "assembly-new", "factory-new", "system-new"].includes(item.id));
  if (target && !missing && !targets.some(item => item.id === target)) {
    if (target === "incoming") options.push({ id: target, name: "待安装的物理模型" });
    else if (target in editorNames) options.push({ id: target, name: editorNames[target as keyof typeof editorNames] });
  }

  return <section hidden={!route} aria-label="装配与仿真工作区" className="min-w-0 space-y-4">
    {route && <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {isExample && <Link to={studioHref({ view: "examples" })} className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />返回示例库
        </Link>}
        <h1 className="display-title break-words text-2xl font-semibold">{example?.name ?? (isExample ? "示例预览" : "装配与仿真")}</h1>
        {example && <p className="mt-1 text-xs text-muted-foreground">可在此试跑和调整，点“加入当前工程”后保存。</p>}
      </div>
      {!isExample && <div className="flex max-w-full flex-wrap items-center gap-3">
        {!missing && target && (!creatingAssembly || options.length > 0) && <label className="flex max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">
          当前工程对象
          <select aria-label="当前工程对象" className="h-9 max-w-full rounded border bg-background px-2 text-sm text-foreground"
            value={target} onChange={event => { const choice = options.find(item => item.id === event.target.value); if (choice) onNavigate({ view: "workbench", target: choice.id }); }}>
            {creatingAssembly && <option value={target}>新装配草稿</option>}
            {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        {creatingAssembly ? <label className="flex items-center gap-2 text-xs text-muted-foreground">
          装配方式
          <select aria-label="装配方式" className="h-9 rounded border bg-background px-2 text-sm text-foreground" value={target}
            onChange={event => onNavigate({ view: "workbench", target: event.target.value as "mechanism-new" | "assembly-new" | "factory-new" | "system-new" })}>
            <option value="system-new">机电控闭环系统（推荐主干）</option>
            <option value="assembly-new">直驱丝杠伺服轴</option>
            <option value="mechanism-new">安装点与关节</option>
            <option value="factory-new">工厂与生产线</option>
          </select>
        </label> : <Button size="sm" variant="outline" asChild><Link to={studioHref({ view: "workbench", target: factory ? "factory-new" : assembly ? "assembly-new" : "system-new" })}><Plus />新建装配</Link></Button>}
      </div>}
    </header>}
    {route && (missing || (!target && !isExample)) && <div className="surface space-y-3 p-5">
      <p className="text-sm">{missing ?? "当前工程还没有可装配或运行的对象。可先体验跨品牌闭环示例或新建闭环装配。"}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" asChild><Link to={studioHref({ view: "workbench", exampleId: "closed-loop-feed-system" })}>体验机电控闭环与实测对标</Link></Button>
        <Button size="sm" variant="secondary" asChild><Link to={studioHref({ view: "workbench", target: "system-new" })}><Plus />新建机电控闭环系统</Link></Button>
        <Button size="sm" variant="outline" asChild><Link to={studioHref({ view: "resources" })}><FolderInput />打开工程资源</Link></Button>
        <Button size="sm" variant="ghost" asChild><Link to={studioHref({ view: "examples" })}>浏览示例库</Link></Button>
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
