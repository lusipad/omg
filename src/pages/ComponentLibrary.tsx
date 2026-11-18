import { useMemo, useState } from "react";
import { ExternalLink, FileText, PackageSearch, Search } from "lucide-react";
import ProductLayout from "@/components/ProductLayout";
import PageHeader from "@/components/PageHeader";
import StatusBadge from "@/components/StatusBadge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/providers/trpc";

const categoryNames: Record<string, string> = { ball_screw: "滚珠丝杠", linear_guide: "直线导向", servo_motor: "伺服电机", servo_drive: "伺服驱动器", gearbox: "精密减速器", encoder: "编码器", controller: "控制器", wheel: "轮体", safety: "安全部件" };

export default function ComponentLibrary() {
  const components = trpc.catalog.components.useQuery();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const filtered = useMemo(() => (components.data ?? []).filter((component) => `${component.model} ${component.manufacturer.name} ${categoryNames[component.category]}`.toLowerCase().includes(query.toLowerCase())), [components.data, query]);
  const selected = components.data?.find((component) => component.id === selectedId);
  const latestRevision = selected ? [...selected.revisions].sort((a, b) => b.id - a.id)[0] : undefined;

  return (
    <ProductLayout>
      <div className="page-enter mx-auto max-w-[1500px] px-4 py-7 sm:px-6 lg:px-8">
        <PageHeader eyebrow="COMPONENT PROVENANCE / 部件溯源" title="参数必须能回到制造商资料" description="型号、资料标题、官方链接、样本版本与页码或章节共同组成一条部件修订记录。“来源已记录”不代表供应商已经确认，也不代表工程师已经复核。" />
        <section className="surface overflow-hidden">
          <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between"><div className="relative w-full sm:max-w-sm"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索制造商、型号或部件类别" /></div><div className="mono text-[10px] text-muted-foreground">{filtered.length} / {components.data?.length ?? 0} COMPONENTS</div></div>
          {components.isLoading ? <div className="space-y-3 p-5">{[1, 2, 3, 4].map((row) => <div key={row} className="h-12 animate-pulse rounded bg-muted/50" />)}</div> : components.error ? <div className="p-8 text-center text-destructive">{components.error.message}</div> : filtered.length === 0 ? <div className="flex flex-col items-center px-6 py-16 text-center"><PackageSearch className="h-7 w-7 text-muted-foreground" strokeWidth={1.3} /><h3 className="mt-4 text-sm font-medium">{components.data?.length ? "没有匹配的部件" : "部件库等待首批官方资料"}</h3><p className="mt-2 max-w-md text-xs leading-6 text-muted-foreground">{components.data?.length ? "调整搜索关键词后再试。" : "系统不会用无来源的示例数值填充商业部件库。"}</p></div> : <div className="overflow-x-auto thin-scrollbar"><table className="data-table min-w-[850px]"><thead><tr><th>制造商 / 型号</th><th>类别</th><th>最新修订</th><th>样本版本</th><th>验证状态</th><th>来源</th></tr></thead><tbody>{filtered.map((component) => { const revision = [...component.revisions].sort((a, b) => b.id - a.id)[0]; return <tr key={component.id} className="cursor-pointer" onClick={() => setSelectedId(component.id)}><td><div className="text-[11px] text-muted-foreground">{component.manufacturer.name}</div><div className="mono mt-1 text-[13px] font-medium text-foreground">{component.model}</div></td><td>{categoryNames[component.category]}</td><td className="mono text-xs">{revision?.revisionLabel ?? "—"}</td><td className="text-xs text-muted-foreground">{revision?.sourceVersion || "资料未标明"}</td><td><StatusBadge status={revision?.verificationStatus ?? "pending"} /></td><td><Button variant="ghost" size="sm" className="gap-2"><FileText className="h-3.5 w-3.5" />查看记录</Button></td></tr>; })}</tbody></table></div>}
        </section>
      </div>

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[720px]">
          {selected && latestRevision && <>
            <DialogHeader><DialogTitle className="mono">{selected.manufacturer.name} · {selected.model}</DialogTitle><DialogDescription>{categoryNames[selected.category]} / {latestRevision.revisionLabel}</DialogDescription></DialogHeader>
            <div className="flex flex-wrap gap-2"><StatusBadge status={latestRevision.verificationStatus} /><span className="status-pill border-border bg-muted text-muted-foreground">{latestRevision.sourceVersion || "样本版本未标明"}</span></div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="surface-inset p-4"><div className="eyebrow">官方资料</div><div className="mt-2 text-xs leading-6">{latestRevision.sourceTitle}</div><div className="mono mt-2 text-[10px] text-muted-foreground">定位：{latestRevision.sourceLocator}</div></div><div className="surface-inset p-4"><div className="eyebrow">来源证据</div><p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{latestRevision.sourceEvidence}</p></div></div>
            <div className="surface-inset overflow-hidden"><div className="border-b px-4 py-3 text-xs font-medium">已记录参数</div><dl>{Object.entries(latestRevision.parameters as Record<string, unknown>).map(([key, value]) => <div key={key} className="flex items-start justify-between gap-4 border-b px-4 py-3 last:border-0"><dt className="mono text-[11px] text-muted-foreground">{key}</dt><dd className="mono text-right text-xs text-foreground">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></div>
            <a href={latestRevision.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs font-medium text-primary hover:underline">打开制造商官方资料<ExternalLink className="h-3.5 w-3.5" /></a>
            <p className="rounded-md border border-amber-400/15 bg-amber-400/[.055] p-3 text-[11px] leading-5 text-amber-200/80">使用边界：以上参数只按官方资料记录。采购、选型、接口兼容和实机应用仍需供应商确认及工程师复核。</p>
          </>}
        </DialogContent>
      </Dialog>
    </ProductLayout>
  );
}
