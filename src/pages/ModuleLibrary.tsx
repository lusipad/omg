import { Bot, MoveHorizontal, RotateCw, ShieldCheck } from "lucide-react";
import ProductLayout from "@/components/ProductLayout";
import PageHeader from "@/components/PageHeader";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/providers/trpc";
import type { ModuleField } from "@contracts/module-catalog";

const icons = { linear_axis: MoveHorizontal, rotary_joint: RotateCw, drive_wheel: Bot };

export default function ModuleLibrary() {
  const modules = trpc.catalog.modules.useQuery();
  return (
    <ProductLayout>
      <div className="page-enter mx-auto max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8">
        <PageHeader eyebrow="MODULE CATALOG / 通用模块" title="一套模块定义，多次组成实例" description="模块版本保存输入字段与工程规则版本；项目实例保存自己的配置和部件选择。修改一个实例不会污染模块模板或其他项目。" />
        <div className="mb-5 grid gap-3 rounded-md border border-primary/15 bg-primary/[.045] p-4 sm:grid-cols-3">
          {[{ n: "01", t: "定义", d: "名称、输入单位和规则版本" }, { n: "02", t: "组成", d: "在 CNC、机械臂或移动平台中实例化" }, { n: "03", t: "追溯", d: "配置、计算和部件修订共同冻结" }].map((item) => <div key={item.n} className="flex gap-3"><span className="mono text-xs text-primary">{item.n}</span><div><div className="text-xs font-medium">{item.t}</div><div className="mt-1 text-[11px] text-muted-foreground">{item.d}</div></div></div>)}
        </div>
        {modules.isLoading ? <div className="grid gap-4 lg:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="h-80 animate-pulse rounded-md bg-muted/40" />)}</div> : modules.error ? <div className="surface p-8 text-center text-destructive">{modules.error.message}</div> : (
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {modules.data?.map((definition) => {
              const Icon = icons[definition.key as keyof typeof icons] ?? MoveHorizontal;
              const version = [...definition.versions].sort((a, b) => b.id - a.id)[0];
              const fields = version ? (version.inputSchema as { fields?: ModuleField[] }).fields ?? [] : [];
              return <article key={definition.id} className="surface overflow-hidden">
                <div className="border-b p-5"><div className="flex items-start justify-between gap-3"><div className="rounded-md border border-primary/20 bg-primary/10 p-2.5"><Icon className="h-5 w-5 text-primary" strokeWidth={1.4} /></div>{version && <StatusBadge status={version.status} />}</div><div className="eyebrow mt-5">{definition.family}</div><h2 className="display-title mt-2 text-xl font-medium">{definition.name}</h2><p className="mt-3 text-xs leading-6 text-muted-foreground">{definition.description}</p></div>
                <div className="grid grid-cols-2 border-b text-center"><div className="border-r p-3"><div className="eyebrow">模块版本</div><div className="mono mt-1.5 text-xs">V{version?.version ?? "—"}</div></div><div className="p-3"><div className="eyebrow">规则版本</div><div className="mono mt-1.5 text-xs">{version?.ruleVersion ?? "—"}</div></div></div>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-medium hover:bg-accent/30"><span>输入字段与单位</span><span className="mono text-[10px] text-muted-foreground group-open:hidden">展开 +</span><span className="mono hidden text-[10px] text-muted-foreground group-open:inline">收起 −</span></summary>
                  <div className="border-t">{fields.map((field) => <div key={field.key} className="border-b px-5 py-3 last:border-0"><div className="flex items-center justify-between gap-3"><span className="text-xs">{field.label}</span><span className="mono text-[10px] text-primary">{field.unit}</span></div><div className="mono mt-1 text-[10px] text-muted-foreground">{field.key}</div><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{field.description}</p></div>)}</div>
                </details>
                <div className="flex gap-2 border-t bg-muted/20 px-5 py-3 text-[11px] leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />初算输出不自动等同于合格选型，警告与假设随每次计算保存。</div>
              </article>;
            })}
          </div>
        )}
      </div>
    </ProductLayout>
  );
}
