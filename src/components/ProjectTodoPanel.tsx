import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ClipboardCheck, PackageSearch, WandSparkles } from "lucide-react";
import type { CalculationResult, ModuleKey } from "@contracts/engineering";
import { MODULE_COMPONENT_ROLES } from "@contracts/module-catalog";
import { cn } from "@/lib/utils";

const roleNames: Record<string, string> = {
  ball_screw: "滚珠丝杠",
  linear_guide: "直线导向",
  servo_motor: "伺服电机",
  servo_drive: "伺服驱动器",
  gearbox: "精密减速器",
  encoder: "编码器",
  wheel: "轮体",
};

type TodoModule = {
  id: number;
  instanceName: string;
  selectedComponentRevisionIds: Record<string, number>;
  moduleVersion: { definition: { key: string } };
  calculationRuns: Array<{ status: "ok" | "warning" | "blocked"; resultSnapshot: CalculationResult }>;
};

type Todo = {
  key: string;
  moduleId: number;
  moduleName: string;
  kind: "blocked" | "warning" | "component";
  detail: string;
};

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export default function ProjectTodoPanel({
  modules,
  automationMetadata,
  onSelect,
}: {
  modules: TodoModule[];
  automationMetadata?: unknown;
  onSelect: (moduleId: number, tab: "calculation" | "components") => void;
}) {
  const [expanded, setExpanded] = useState(Boolean(automationMetadata));
  const metadata = typeof automationMetadata === "object" && automationMetadata !== null
    ? automationMetadata as Record<string, unknown>
    : undefined;
  const assumptions = stringArray(metadata?.assumptions);
  const globalWarnings = stringArray(metadata?.warnings);

  const todos = useMemo(() => modules.flatMap<Todo>((module) => {
    const items: Todo[] = [];
    const latest = module.calculationRuns[0];
    if (latest?.status === "blocked") items.push({ key: `${module.id}-blocked`, moduleId: module.id, moduleName: module.instanceName, kind: "blocked", detail: "初算存在阻断项，请查看代入值并调整需求。" });
    for (const [index, warning] of (latest?.resultSnapshot.warnings ?? []).entries()) {
      items.push({ key: `${module.id}-warning-${index}`, moduleId: module.id, moduleName: module.instanceName, kind: "warning", detail: `${warning.message} ${warning.requiredAction}` });
    }
    const key = module.moduleVersion.definition.key as ModuleKey;
    for (const role of MODULE_COMPONENT_ROLES[key] ?? []) {
      if (!module.selectedComponentRevisionIds[role]) items.push({ key: `${module.id}-${role}`, moduleId: module.id, moduleName: module.instanceName, kind: "component", detail: `${roleNames[role] ?? role}：尚无候选或仍需补充具体资料。` });
    }
    return items;
  }), [modules]);

  const blocked = todos.filter((todo) => todo.kind === "blocked").length;
  const warnings = todos.filter((todo) => todo.kind === "warning").length + globalWarnings.length;
  const missing = todos.filter((todo) => todo.kind === "component").length;

  return (
    <section className="mb-4 overflow-hidden rounded-md border bg-card">
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/[.06] text-primary"><ClipboardCheck className="h-4 w-4" /></span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium">方案待办</h2>{metadata && <span className="inline-flex items-center gap-1 rounded border border-primary/20 bg-primary/[.05] px-1.5 py-0.5 text-[9px] text-primary"><WandSparkles className="h-2.5 w-2.5" />首版自动草案 · V1 已冻结</span>}</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">先集中处理阻断、警告和缺失部件，再进入高级参数调整。</p></div></div>
        <button onClick={() => setExpanded((value) => !value)} className="flex items-center gap-1.5 self-end text-[11px] text-muted-foreground hover:text-foreground sm:self-auto">{expanded ? "收起待办" : `展开 ${todos.length} 项`}<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} /></button>
      </div>
      <div className="grid grid-cols-3 border-y bg-background/30">
        {[{ label: "阻断项", value: blocked, tone: "text-red-300" }, { label: "计算警告", value: warnings, tone: "text-amber-300" }, { label: "待补部件", value: missing, tone: "text-sky-300" }].map((item) => <div key={item.label} className="border-r px-4 py-3 last:border-r-0"><div className="eyebrow">{item.label}</div><div className={cn("mono mt-1.5 text-lg", item.tone)}>{item.value}</div></div>)}
      </div>
      {expanded && <div>
        {todos.length === 0 ? <div className="flex items-center gap-2 p-4 text-xs text-primary"><CheckCircle2 className="h-4 w-4" />当前没有自动识别的阻断、警告或缺失部件；工程复核仍不可省略。</div> : <div className="max-h-72 overflow-y-auto p-2 thin-scrollbar">{todos.map((todo) => <button key={todo.key} onClick={() => onSelect(todo.moduleId, todo.kind === "component" ? "components" : "calculation")} className="flex w-full items-start gap-3 rounded px-3 py-2.5 text-left transition-colors hover:bg-accent/45"><span className={cn("mt-0.5", todo.kind === "blocked" ? "text-red-300" : todo.kind === "warning" ? "text-amber-300" : "text-sky-300")}>{todo.kind === "component" ? <PackageSearch className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className="block text-[11px] font-medium">{todo.moduleName}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{todo.detail}</span></span><span className="mt-0.5 text-[10px] text-muted-foreground">处理</span></button>)}</div>}
        {(assumptions.length > 0 || globalWarnings.length > 0) && <details className="border-t px-4 py-3"><summary className="cursor-pointer text-[11px] text-muted-foreground">查看自动分配假设与整机级边界</summary><div className="mt-3 grid gap-4 lg:grid-cols-2"><div><div className="eyebrow mb-2">工程假设</div><ul className="space-y-2">{assumptions.map((item) => <li key={item} className="flex gap-2 text-[10px] leading-5 text-muted-foreground"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />{item}</li>)}</ul></div><div><div className="eyebrow mb-2">整机级警告</div><ul className="space-y-2">{globalWarnings.map((item) => <li key={item} className="flex gap-2 text-[10px] leading-5 text-amber-200/70"><AlertTriangle className="mt-1 h-3 w-3 shrink-0" />{item}</li>)}</ul></div></div></details>}
      </div>}
    </section>
  );
}
