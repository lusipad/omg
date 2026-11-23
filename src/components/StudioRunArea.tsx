import { lazy, Suspense, useMemo, useState } from "react";
import { ArrowLeft, Box, Cpu, Factory, FolderInput, Layers, LayoutGrid, Play, Plus, Upload, Workflow } from "lucide-react";
import { Link } from "react-router";
import { getStudioExample, studioHref, type MotorAxisLocation, type StudioExampleKind, type StudioRoute, type StudioTarget, type StudioTargetOption } from "@contracts/studio-navigation";
import { parseImportCatalog, type ModelRef } from "@contracts/import-catalog";
import { compileAssemblyToMujoco } from "@contracts/mujoco-compiler";
import { parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import type { FactoryLayout } from "@contracts/factory";
import type { LinearAssembly } from "@contracts/linear-assembly";
import { upsertMechanicalAssembly, type MechanicalAssembly, type MechanicalBundle } from "@contracts/mechanical-assembly";
import type { TwinSystemAssembly } from "@contracts/system-twin";
import { Button } from "@/components/ui/button";
import { describeModel, putModelBundle } from "@/lib/model-files";
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

type SolverDomain = "modelica" | "mujoco" | "factory";

const editorNames: Record<string, string> = {
  wiring: "24V 信号接线与 DI 滤波",
  servo: "伺服单轴阶跃",
  so101: "SO-101 机械臂与 BOM",
  milo: "Milo v1.5 数控切削",
};

const SOLVER_DOMAINS: readonly {
  id: SolverDomain;
  name: string;
  kernel: string;
  formats: string;
  summary: string;
  icon: typeof Cpu;
  examples: readonly { id: string; tag: string; title: string; desc: string }[];
}[] = [
  {
    id: "modelica",
    name: "Modelica 机电闭环",
    kernel: "OpenModelica WASM · 伺服/丝杠/限位同步核",
    formats: "支持 .twin.json 闭环系统、LinuxCNC .ini/.hal 与示波器 CSV 实测对标",
    summary: "针对真实机电进给与伺服系统进行连续时间方程求解，并与 24V 限位开关、DI 防抖滤波及实机录波波形联合校验。",
    icon: Cpu,
    examples: [
      {
        id: "closed-loop-feed-system",
        tag: "完整闭环与对标",
        title: "跨品牌机电控限位闭环与实测对标",
        desc: "台达伺服 + THK 丝杠 + 常闭限位 + GL10 防抖滤波联合求解，实时联动三维丝杠并支持示波器 CSV 对标。",
      },
      {
        id: "modelica-feed-axis",
        tag: "进给核",
        title: "丝杠直线进给轴",
        desc: "从 BOM 更换丝杠导程或负载工作台，定量分析进给速度、转矩响应与轴向推力。",
      },
      {
        id: "inovance-servo",
        tag: "位置环",
        title: "汇川伺服单轴阶跃",
        desc: "SV660N 驱动器与 MS1 电机匹配验证，调节目标角位移与负载转子惯量比。",
      },
    ],
  },
  {
    id: "mujoco",
    name: "MuJoCo 多体物理",
    kernel: "MuJoCo WASM · 刚体接触与三维机构核",
    formats: "支持 MJCF .xml / .urdf / .zip 机器人包、.stl/.glb 网格与分层三维机构装配",
    summary: "在浏览器独立线程内运行工业级刚体接触与动力学积分，或验证多分支可动机械装配与层级三维爆炸拆装关系。",
    icon: Box,
    examples: [
      {
        id: "ur5e-pick-place",
        tag: "组合工位",
        title: "UR5e + Robotiq 组合取放工位",
        desc: "从外部物理模型与夹爪构建独立多体工位，运行接触抓取与关节空间轨迹仿真。",
      },
      {
        id: "ur5e",
        tag: "工业机械臂",
        title: "UR5e 六轴工业机械臂",
        desc: "完整 MuJoCo XML + 网格资产物理加载与多自由度动力学交互运行。",
      },
      {
        id: "composable-milo-mill",
        tag: "三维可动 · 爆炸图",
        title: "基本件拼装三轴立式铣床",
        desc: "23 个标准化基本件与耦合滚珠丝杠，支持实时多轴联动、爆炸拆解与拓扑校验。",
      },
    ],
  },
  {
    id: "factory",
    name: "产线节拍与加工单元",
    kernel: "离散物流节拍 · 三轴轮廓插补核",
    formats: "支持多工位产线布局 JSON、电机轴配置与数控 .nc / G 代码加工程序",
    summary: "面向工厂产线上下料节拍规划、加工单元多轴协同以及三轴立铣圆槽 G 代码指令/反馈轮廓误差分析。",
    icon: Factory,
    examples: [
      {
        id: "cnc-factory",
        tag: "双产线 · CNC",
        title: "数控加工工厂（双产线）",
        desc: "回放双产线上下料与物流节拍，或进入 CNC-A 选配电机、运行三轴轮廓切削对比。",
      },
      {
        id: "milo-v1-5",
        tag: "G代码切削",
        title: "Milo v1.5 三轴铣削圆槽",
        desc: "核对三轴 DIY 开源铣床 BOM，并对比 G 代码刀尖轨迹与铝坯三维切深移除过程。",
      },
    ],
  },
];

function domainForTarget(target?: StudioTarget): SolverDomain {
  if (!target) return "modelica";
  if (target === "factory-new" || target.startsWith("factory:") || target === "milo") return "factory";
  if (
    target === "incoming" ||
    target === "so101" ||
    target === "mechanism-new" ||
    target.startsWith("model:") ||
    target.startsWith("mechanism:")
  ) {
    return "mujoco";
  }
  return "modelica";
}

function domainForExampleKind(kind: StudioExampleKind): SolverDomain {
  if (kind === "factory" || kind === "milo") return "factory";
  if (kind === "physics" || kind === "so101" || kind === "mechanism") return "mujoco";
  return "modelica";
}

function domainBadgeLabel(domain: SolverDomain): string {
  switch (domain) {
    case "modelica": return "Modelica 机电闭环核";
    case "mujoco": return "MuJoCo 多体物理核";
    case "factory": return "产线与加工单元核";
  }
}

export default function StudioRunArea({
  route,
  workspace,
  generation,
  openedProject,
  bomRevision,
  servoChoice,
  target,
  targets,
  incoming,
  onChange,
  onSaveAssembly,
  onSaveFactory,
  onSaveSystem,
  onOpenImport,
  onSaveMechanism,
  onInstallBundle,
  onNavigate,
  onApplyExample,
  onImportFile,
  onImportText,
}: Props) {
  const isExample = route?.exampleId !== undefined;
  const example = getStudioExample(route?.exampleId);
  const model = target?.startsWith("model:") ? workspace.catalog?.models.find(item => `model:${item.id}` === target) : undefined;
  const assembly = target?.startsWith("assembly:") ? workspace.assemblies?.find(item => `assembly:${item.id}` === target) : undefined;
  const mechanism = target?.startsWith("mechanism:") ? workspace.mechanisms?.find(item => `mechanism:${item.id}` === target) : undefined;
  const factory = target?.startsWith("factory:") ? workspace.factories?.find(item => `factory:${item.id}` === target) : undefined;
  const system = target?.startsWith("system:") ? workspace.systems?.find(item => `system:${item.id}` === target) : undefined;
  const creatingAssembly = target === "assembly-new" || target === "mechanism-new" || target === "factory-new" || target === "system-new";
  const missing = isExample && !example ? "没有找到这个算例。"
    : route?.unavailableTarget !== undefined || (target?.startsWith("model:") && !model) || (target?.startsWith("assembly:") && !assembly) || (target?.startsWith("mechanism:") && !mechanism) || (target?.startsWith("factory:") && !factory) || (target?.startsWith("system:") && !system) ? "当前工程中没有这个对象。"
    : target === "incoming" && !incoming ? "本次预览的模型文件已关闭，请重新选择文件。"
    : undefined;

  const [wiringRevision, setWiringRevision] = useState(0);
  const routeSignature = route ? `${route.view}:${route.exampleId ?? ""}:${route.target ?? ""}:${target ?? ""}` : "inactive";
  const [domainChoice, setDomainChoice] = useState<{ key: string; domain: SolverDomain } | null>(null);

  const options = useMemo(() => {
    const list = targets.filter(item => !["mechanism-new", "assembly-new", "factory-new", "system-new"].includes(item.id));
    if (target && !missing && !creatingAssembly && !list.some(item => item.id === target)) {
      if (target === "incoming") list.push({ id: target, name: "待安装的物理模型" });
      else if (target in editorNames) list.push({ id: target, name: editorNames[target] });
    }
    return list;
  }, [targets, target, missing, creatingAssembly]);

  const domainOptions = useMemo<Record<SolverDomain, StudioTargetOption[]>>(() => {
    const grouped: Record<SolverDomain, StudioTargetOption[]> = { modelica: [], mujoco: [], factory: [] };
    for (const item of options) grouped[domainForTarget(item.id)].push(item);
    return grouped;
  }, [options]);

  const targetDomain = domainForTarget(target);
  const activeOverride = domainChoice?.key === routeSignature ? domainChoice.domain : null;
  const activeDomain: SolverDomain = isExample && example
    ? domainForExampleKind(example.kind)
    : activeOverride ?? (target ? targetDomain : "modelica");
  const showLaunchpad = !isExample && !missing && (!target || (activeOverride !== null && activeOverride !== targetDomain));
  const domainItems = domainOptions[activeDomain];
  const domainMeta = SOLVER_DOMAINS.find((d) => d.id === activeDomain) ?? SOLVER_DOMAINS[0]!;

  function handleSelectDomain(nextDomain: SolverDomain) {
    const firstExisting = domainOptions[nextDomain][0];
    if (firstExisting) {
      setDomainChoice(null);
      if (firstExisting.id !== target) {
        onNavigate({ view: "workbench", target: firstExisting.id });
      }
      return;
    }
    setDomainChoice({ key: routeSignature, domain: nextDomain });
  }

  return (
    <section hidden={!route} aria-label="装配与仿真工作区" className="min-w-0 space-y-3.5">
      {/* Example Preview Header OR 3-Solver IDE Rail */}
      {route && isExample && (
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Button size="sm" variant="outline" className="h-8 gap-1 px-2.5 text-xs" asChild>
              <Link to={studioHref({ view: "examples" })}><ArrowLeft className="size-3.5" />返回标准算例库</Link>
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="display-title break-words text-xl font-semibold sm:text-2xl">{example?.name ?? "算例预览"}</h1>
                {example && (
                  <span className="rounded border border-primary/25 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {domainBadgeLabel(domainForExampleKind(example.kind))} · {example.category}
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>
      )}

      {route && !isExample && (
        <div className="surface space-y-3 p-3 sm:p-3.5">
          {/* 3-Solver Domain Switcher Rail */}
          <div role="tablist" aria-label="三大求解引擎切换" className="grid gap-2 md:grid-cols-3">
            {SOLVER_DOMAINS.map((engine) => {
              const Icon = engine.icon;
              const selected = activeDomain === engine.id;
              const count = domainOptions[engine.id].length;
              return (
                <button
                  key={engine.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => handleSelectDomain(engine.id)}
                  className={`flex items-start justify-between gap-2.5 rounded-md border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary/60 bg-primary/10 shadow-sm"
                      : "border-border/70 bg-background/50 hover:border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className={`mt-0.5 rounded p-1.5 ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className={`text-xs font-semibold sm:text-sm ${selected ? "text-foreground" : "text-foreground/85"}`}>
                        {engine.name}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{engine.kernel}</p>
                    </div>
                  </div>
                  <span className={`mono shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    count > 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground"
                  }`}>
                    {count > 0 ? `${count} 个对象` : "待创建"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Domain-Scoped Object Bar (shown when an active object or creation draft is open in this solver) */}
          {!missing && !showLaunchpad && target && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {!creatingAssembly && domainItems.length > 0 && (
                  domainItems.length <= 4 ? (
                    <div role="group" aria-label="切换当前引擎对象" className="flex flex-wrap items-center gap-1 rounded-md border bg-background/60 p-0.5">
                      {domainItems.map(item => (
                        <Button
                          key={item.id}
                          size="sm"
                          type="button"
                          variant={item.id === target ? "secondary" : "ghost"}
                          className="h-7 max-w-52 truncate px-2.5 text-xs"
                          onClick={() => {
                            setDomainChoice(null);
                            onNavigate({ view: "workbench", target: item.id });
                          }}
                        >
                          {item.name}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <label className="flex max-w-full items-center gap-2 text-xs text-muted-foreground">
                      <span>当前工程对象</span>
                      <select aria-label="当前工程对象" className="h-8 max-w-64 rounded-md border bg-background px-2 text-xs text-foreground"
                        value={target} onChange={event => {
                          const choice = domainItems.find(item => item.id === event.target.value);
                          if (choice) {
                            setDomainChoice(null);
                            onNavigate({ view: "workbench", target: choice.id });
                          }
                        }}>
                        {domainItems.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                  )
                )}
                {creatingAssembly && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-primary/15 px-2 py-0.5 font-medium text-primary">
                      正在新建：{target === "system-new" ? "机电控闭环系统" : target === "assembly-new" ? "直驱丝杠伺服轴" : target === "mechanism-new" ? "三维可动机械装配" : "工厂与生产线"}
                    </span>
                    {domainItems.length > 0 && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => {
                        setDomainChoice(null);
                        onNavigate({ view: "workbench", target: domainItems[0]!.id });
                      }}>
                        <ArrowLeft className="size-3" />返回已有对象
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Solver-Specific Create & Import Controls */}
              <div className="flex flex-wrap items-center gap-1.5">
                {activeDomain === "modelica" && (
                  <>
                    <Button size="sm" variant={target === "system-new" ? "secondary" : "outline"} className="h-7 px-2.5 text-xs"
                      onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "system-new" }); }}>
                      <Plus className="size-3.5" />新建闭环系统
                    </Button>
                    <Button size="sm" variant={target === "assembly-new" ? "secondary" : "outline"} className="h-7 px-2.5 text-xs"
                      onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "assembly-new" }); }}>
                      <Plus className="size-3.5" />新建丝杠进给轴
                    </Button>
                  </>
                )}
                {activeDomain === "mujoco" && (
                  <>
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={onOpenImport}>
                      <Upload className="size-3.5" />导入 XML / URDF / ZIP
                    </Button>
                    <Button size="sm" variant={target === "mechanism-new" ? "secondary" : "outline"} className="h-7 px-2.5 text-xs"
                      onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "mechanism-new" }); }}>
                      <Plus className="size-3.5" />新建三维机构
                    </Button>
                  </>
                )}
                {activeDomain === "factory" && (
                  <>
                    <Button size="sm" variant={target === "factory-new" ? "secondary" : "outline"} className="h-7 px-2.5 text-xs"
                      onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "factory-new" }); }}>
                      <Plus className="size-3.5" />新建产线布局
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={onOpenImport}>
                      <Upload className="size-3.5" />导入产线 / G 代码
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Missing Target State */}
      {route && missing && (
        <div className="surface space-y-3 p-5">
          <h2 className="text-base font-semibold">未能打开目标工程对象</h2>
          <p className="text-xs text-muted-foreground">{missing}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench" }); }}>返回求解工作台启动台</Button>
            <Button size="sm" variant="outline" asChild><Link to={studioHref({ view: "resources" })}><FolderInput />打开器件与模型库</Link></Button>
            <Button size="sm" variant="ghost" asChild><Link to={studioHref({ view: "examples" })}><LayoutGrid />浏览标准算例库</Link></Button>
          </div>
        </div>
      )}

      {/* Solver-Specific Engine Launchpad */}
      {route && showLaunchpad && (
        <div className="surface space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3.5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">{domainMeta.kernel}</span>
              </div>
              <h1 className="display-title text-lg font-semibold sm:text-xl">{domainMeta.name} · 引擎启动台</h1>
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{domainMeta.summary}</p>
              <p className="text-[11px] text-muted-foreground/90">{domainMeta.formats}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {activeDomain === "modelica" && (
                <>
                  <Button size="sm" onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "system-new" }); }}>
                    <Plus />新建闭环系统
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "assembly-new" }); }}>
                    <Workflow />新建丝杠进给轴
                  </Button>
                </>
              )}
              {activeDomain === "mujoco" && (
                <>
                  <Button size="sm" onClick={onOpenImport}>
                    <Upload />导入 MuJoCo XML / URDF / ZIP
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "mechanism-new" }); }}>
                    <Layers />新建三维机构装配
                  </Button>
                </>
              )}
              {activeDomain === "factory" && (
                <>
                  <Button size="sm" onClick={() => { setDomainChoice(null); onNavigate({ view: "workbench", target: "factory-new" }); }}>
                    <Plus />新建产线与单元布局
                  </Button>
                  <Button size="sm" variant="outline" onClick={onOpenImport}>
                    <Upload />导入产线或 G 代码
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" asChild>
                <Link to={studioHref({ view: "resources" })}><FolderInput />前往器件与模型库</Link>
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-muted-foreground">可直接试跑的本引擎标准算例：</span>
              <Link to={studioHref({ view: "examples" })} className="text-primary hover:underline">查看全部 16 个标准算例 →</Link>
            </div>
            <div className={`grid gap-3 ${domainMeta.examples.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
              {domainMeta.examples.map((ex) => (
                <Link
                  key={ex.id}
                  to={studioHref({ view: "workbench", exampleId: ex.id })}
                  className="group flex flex-col justify-between gap-2 rounded-lg border bg-background/60 p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
                >
                  <div className="space-y-1">
                    <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {ex.tag}
                    </span>
                    <p className="text-sm font-semibold group-hover:text-primary">{ex.title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{ex.desc}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    <Play className="size-3" />打开并运行算例 →
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active Bench Canvas */}
      {route && !missing && !showLaunchpad && (
        <Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在加载求解台…</p>}>
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
            initialPackageKey={route.target === "mechanism-new" ? route.part : undefined} onSave={onSaveMechanism} onInstallBundle={onInstallBundle}
            onSendToMujoco={async (mech) => {
              const baseWs = upsertMechanicalAssembly(parseWorkspace(workspace), mech);
              const compiled = compileAssemblyToMujoco(baseWs, mech);
              const baseRef = await describeModel(compiled.bundle);
              const ref: ModelRef = { ...baseRef, run: compiled.recommendedRun };
              await putModelBundle(ref, compiled.bundle);
              const existingCatalog = baseWs.catalog ?? { models: [], materials: [] };
              const nextWs: TwinWorkspace = {
                ...baseWs,
                catalog: parseImportCatalog(
                  { models: [...existingCatalog.models.filter((m) => m.id !== ref.id), ref], materials: existingCatalog.materials },
                  baseWs.packages,
                ),
              };
              onChange(nextWs);
              onNavigate(
                { view: "workbench", target: `model:${ref.id}` },
                `已将「${mech.name}」编译为 MuJoCo 多体物理模型并切换至仿真工作台。`,
              );
            }} />}
          {(target === "system-new" || system) && <SystemTwinBench key={`${openedProject}-${system?.id ?? "new"}`} workspace={workspace} system={system}
            onSave={onSaveSystem} />}
        </Suspense>
      )}
      <div hidden={target !== "wiring" || showLaunchpad}>
        <TwinSimulation key={`${generation}-${wiringRevision}`} workspace={workspace} onChange={onChange} />
      </div>
    </section>
  );
}
