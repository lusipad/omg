import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Bot, CirclePlus, Factory, FolderKanban, GitCommitHorizontal, Layers3, SlidersHorizontal, Truck, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import ProductLayout from "@/components/ProductLayout";
import AutomationWizard from "@/components/AutomationWizard";
import PageHeader from "@/components/PageHeader";
import StatusBadge from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/providers/trpc";
import { RELEASE_MANIFEST } from "@contracts/release-manifest";
import { cn } from "@/lib/utils";

const templates = [
  { key: "blank" as const, name: "空白项目", detail: "从模块库逐个组成", icon: FolderKanban },
  { key: "cnc" as const, name: "三轴 CNC", detail: "X / Y / Z 直线轴", icon: Factory },
  { key: "arm" as const, name: "六轴机械臂", detail: "J1—J6 旋转关节", icon: Bot },
  { key: "mobile" as const, name: "差速移动平台", detail: "左右独立驱动轮", icon: Truck },
];

function nextProjectCode() {
  const date = new Date();
  return `PRJ-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function Home() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery();
  const [open, setOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [form, setForm] = useState({ name: "", code: nextProjectCode(), description: "", template: "cnc" as "blank" | "cnc" | "arm" | "mobile" });
  const create = trpc.project.create.useMutation({
    onSuccess: async (result) => {
      await utils.project.list.invalidate();
      setOpen(false);
      toast.success(`项目已创建，包含 ${result.moduleCount} 个组成模块`);
      navigate(`/projects/${result.projectId}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const stats = useMemo(() => {
    const rows = projects.data ?? [];
    return {
      projects: rows.length,
      modules: rows.reduce((sum, project) => sum + project.modules.length, 0),
      review: rows.filter((project) => project.status === "in_review").length,
      versions: rows.reduce((sum, project) => sum + project.currentVersionNo, 0),
    };
  }, [projects.data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ ...form, description: form.description || undefined });
  }

  return (
    <ProductLayout>
      <div className="page-enter mx-auto max-w-[1500px] px-4 py-7 sm:px-6 lg:px-8">
        <PageHeader
          eyebrow="PROJECT PORTFOLIO / 客户项目"
          title="把设备需求，组织成可追溯的工程方案"
          description="整机由模块实例组成；每次参数保存都会生成可重读的计算记录。项目快照冻结输入、规则版本与部件修订，便于试点复核。"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}><SlidersHorizontal className="h-4 w-4" />高级模式</Button>
              <Button className="gap-2" onClick={() => setAutoOpen(true)}><WandSparkles className="h-4 w-4" />自动生成方案</Button>
            </div>
          }
        />
        <AutomationWizard open={autoOpen} onOpenChange={setAutoOpen} />
        <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
                <form onSubmit={submit}>
                  <DialogHeader>
                    <DialogTitle>高级模式 · 手动组成项目</DialogTitle>
                    <DialogDescription>适合非标准结构或需要自行决定模块组成的场景。模板只创建同级实例和默认初算，不会自动分配整机需求。</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-5 sm:grid-cols-2">
                    <div className="space-y-2"><Label htmlFor="project-name">项目名称</Label><Input id="project-name" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：华东客户上下料单元" /></div>
                    <div className="space-y-2"><Label htmlFor="project-code">项目编号</Label><Input id="project-code" required pattern="[A-Za-z0-9][A-Za-z0-9_-]+" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className="mono" /></div>
                    <div className="space-y-2 sm:col-span-2"><Label htmlFor="project-description">需求摘要</Label><Textarea id="project-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="客户现场、工件、节拍、空间与待确认条件…" rows={3} /></div>
                    <div className="sm:col-span-2">
                      <Label>组成模板</Label>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {templates.map((template) => <button key={template.key} type="button" aria-pressed={form.template === template.key} onClick={() => setForm({ ...form, template: template.key })} className={cn("flex items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent/50", form.template === template.key && "border-primary/45 bg-primary/10")}><template.icon className={cn("h-5 w-5 text-muted-foreground", form.template === template.key && "text-primary")} strokeWidth={1.5} /><span><span className="block text-[13px] font-medium">{template.name}</span><span className="mt-1 block text-[11px] text-muted-foreground">{template.detail}</span></span></button>)}
                      </div>
                    </div>
                  </div>
                  <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "正在生成项目…" : "创建并进入工作台"}</Button></DialogFooter>
                </form>
              </DialogContent>
        </Dialog>

        <section className="mb-5 grid overflow-hidden rounded-md border border-primary/20 bg-primary/[.035] lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="p-5 sm:p-6"><div className="flex items-center gap-2 text-xs font-medium text-primary"><WandSparkles className="h-4 w-4" />默认自动流程</div><h2 className="display-title mt-3 text-lg font-medium">选择设备 → 填少量需求 → 自动生成方案</h2><p className="mt-2 max-w-2xl text-xs leading-6 text-muted-foreground">自动创建整机组成、分配初始参数、保存逐步计算、初筛候选部件并冻结 V1 草案。你只需集中处理警告和待确认项。</p><Button className="mt-4 gap-2" onClick={() => setAutoOpen(true)}>开始自动配置<ArrowRight className="h-4 w-4" /></Button></div>
          <div className="grid grid-cols-3 border-t border-primary/15 lg:border-l lg:border-t-0">{[{ n: "01", t: "选择设备" }, { n: "02", t: "填写需求" }, { n: "03", t: "生成草案" }].map((item) => <div key={item.n} className="flex flex-col items-center justify-center gap-2 border-r border-primary/10 py-5 last:border-r-0"><span className="mono text-xs text-primary">{item.n}</span><span className="text-[11px] text-muted-foreground">{item.t}</span></div>)}</div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "客户项目", value: stats.projects, icon: FolderKanban, suffix: "个" },
            { label: "组成模块实例", value: stats.modules, icon: Layers3, suffix: "个" },
            { label: "等待工程复核", value: stats.review, icon: CirclePlus, suffix: "项" },
            { label: "冻结版本快照", value: stats.versions, icon: GitCommitHorizontal, suffix: "份" },
          ].map((item) => <div key={item.label} className="surface p-4 sm:p-5"><div className="flex items-center justify-between"><span className="eyebrow">{item.label}</span><item.icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} /></div><div className="mt-5 flex items-end gap-2"><span className="metric-value">{projects.isLoading ? "—" : item.value}</span><span className="mb-0.5 text-[11px] text-muted-foreground">{item.suffix}</span></div></div>)}
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="surface min-w-0 overflow-hidden">
            <div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="text-sm font-medium">最近项目</h2><p className="mt-1 text-[11px] text-muted-foreground">按最近配置更新时间排序</p></div><span className="mono text-[10px] text-muted-foreground">{stats.projects.toString().padStart(2, "0")} PROJECTS</span></div>
            {projects.isLoading ? <div className="space-y-3 p-5">{[1, 2, 3].map((row) => <div key={row} className="h-12 animate-pulse rounded bg-muted/60" />)}</div> : projects.error ? <div className="p-8 text-center text-sm text-destructive">{projects.error.message}</div> : stats.projects === 0 ? (
              <div className="flex flex-col items-center px-6 py-16 text-center"><div className="rounded-md border bg-muted/40 p-3"><FolderKanban className="h-6 w-6 text-primary" strokeWidth={1.4} /></div><h3 className="mt-4 text-sm font-medium">从第一个真实需求开始</h3><p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">选择设备并填写少量整机需求，其余组成、初算和候选 BOM 由系统自动生成。</p><Button className="mt-5 gap-2" onClick={() => setAutoOpen(true)}><WandSparkles className="h-4 w-4" />自动生成第一个方案</Button></div>
            ) : (
              <><div className="divide-y md:hidden">{projects.data?.map((project) => <button key={project.id} className="block w-full p-4 text-left hover:bg-accent/35" onClick={() => navigate(`/projects/${project.id}`)}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-[13px] font-medium">{project.name}</div><div className="mono mt-1 text-[10px] text-muted-foreground">{project.code}</div></div><StatusBadge status={project.status} /></div><div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground"><span>{project.modules.length} 个模块 · {project.currentVersionNo ? `V${project.currentVersionNo}` : "未冻结"}</span><span className="flex items-center gap-1">打开<ArrowRight className="h-3 w-3" /></span></div></button>)}</div><div className="hidden overflow-x-auto thin-scrollbar md:block"><table className="data-table min-w-[700px]"><thead><tr><th>项目</th><th>应用</th><th>组成</th><th>版本</th><th>状态</th><th>更新时间</th><th><span className="sr-only">打开</span></th></tr></thead><tbody>{projects.data?.map((project) => <tr key={project.id} className="cursor-pointer" onClick={() => navigate(`/projects/${project.id}`)}><td><div className="font-medium text-foreground">{project.name}</div><div className="mono mt-1 text-[10px] text-muted-foreground">{project.code}</div></td><td className="text-muted-foreground">{templates.find((template) => template.key === project.applicationType)?.name ?? "自定义设备"}</td><td><span className="mono">{project.modules.length}</span><span className="ml-1 text-xs text-muted-foreground">模块</span></td><td className="mono text-muted-foreground">{project.currentVersionNo ? `V${project.currentVersionNo}` : "未冻结"}</td><td><StatusBadge status={project.status} /></td><td className="mono text-[11px] text-muted-foreground">{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(project.updatedAt)}</td><td><ArrowRight className="h-4 w-4 text-muted-foreground" /></td></tr>)}</tbody></table></div></>
            )}
          </section>

          <aside className="surface p-5">
            <div className="eyebrow">PILOT READINESS</div><h2 className="mt-2 text-sm font-medium">客户试点门槛</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">这里展示真实完成状态，不用演示功能替代工程验收。</p>
            <div className="mt-5 space-y-4">{RELEASE_MANIFEST.checks.map((check) => <div key={check.key} className="flex gap-3"><span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", check.status === "passed" ? "bg-emerald-400" : check.status === "blocked" ? "bg-red-400" : check.status === "recorded" ? "bg-sky-400" : "bg-slate-500")} /><div><div className="text-xs font-medium leading-5">{check.title}</div><div className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{check.evidence}</div></div></div>)}</div>
            <Button variant="outline" className="mt-6 w-full gap-2" onClick={() => navigate("/validation")}>查看验证边界<ArrowRight className="h-4 w-4" /></Button>
          </aside>
        </div>
      </div>
    </ProductLayout>
  );
}
