import { AlertOctagon, CheckCircle2, ClipboardCheck, FileClock, ShieldAlert } from "lucide-react";
import ProductLayout from "@/components/ProductLayout";
import PageHeader from "@/components/PageHeader";
import StatusBadge from "@/components/StatusBadge";
import { RELEASE_MANIFEST } from "@contracts/release-manifest";
import { cn } from "@/lib/utils";

export default function ValidationCenter() {
  const passed = RELEASE_MANIFEST.checks.filter((check) => check.status === "passed").length;
  return (
    <ProductLayout>
      <div className="page-enter mx-auto max-w-[1300px] px-4 py-7 sm:px-6 lg:px-8">
        <PageHeader eyebrow="VERIFICATION GATES / 验证中心" title="把已验证、已记录和未完成分开" description="客户试点并不意味着所有工程验证已经完成。本页是该交付版本的验收清单与阻断项，状态只能由真实测试、来源记录或具名复核更新。" />
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <div className="surface p-5"><div className="eyebrow">当前交付</div><div className="mt-3 text-sm font-medium">{RELEASE_MANIFEST.name}</div><div className="mono mt-2 text-[11px] text-primary">{RELEASE_MANIFEST.release}</div></div>
          <div className="surface p-5"><div className="eyebrow">已通过门槛</div><div className="metric-value mt-4">{passed}<span className="ml-2 text-sm text-muted-foreground">/ {RELEASE_MANIFEST.checks.length}</span></div></div>
          <div className="surface border-amber-400/15 bg-amber-400/[.04] p-5"><div className="flex items-center gap-2 text-xs font-medium text-amber-300"><ShieldAlert className="h-4 w-4" />不可直接制造</div><p className="mt-3 text-[11px] leading-5 text-muted-foreground">当前输出用于方案与试点协同，不是生产图纸、采购定型或安全认证。</p></div>
        </div>
        <section className="surface overflow-hidden">
          <div className="flex items-center gap-3 border-b px-5 py-4"><ClipboardCheck className="h-4 w-4 text-primary" /><div><h2 className="text-sm font-medium">版本验收记录</h2><p className="mt-1 text-[11px] text-muted-foreground">每一项都保留证据和适用边界</p></div></div>
          <div>{RELEASE_MANIFEST.checks.map((check, index) => <div key={check.key} className="grid gap-4 border-b px-5 py-5 last:border-0 md:grid-cols-[42px_minmax(180px,.75fr)_minmax(260px,1.25fr)_130px] md:items-start"><div className={cn("flex h-8 w-8 items-center justify-center rounded-md border", check.status === "passed" ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : check.status === "blocked" ? "border-red-400/20 bg-red-400/10 text-red-300" : "bg-muted text-muted-foreground")}>{check.status === "passed" ? <CheckCircle2 className="h-4 w-4" /> : check.status === "blocked" ? <AlertOctagon className="h-4 w-4" /> : <FileClock className="h-4 w-4" />}</div><div><div className="mono mb-1 text-[9px] text-muted-foreground">GATE {String(index + 1).padStart(2, "0")}</div><h3 className="text-xs font-medium leading-5">{check.title}</h3></div><div><p className="text-xs leading-5 text-foreground/85">{check.evidence}</p><p className="mt-2 text-[11px] leading-5 text-muted-foreground">边界：{check.boundary}</p></div><div><StatusBadge status={check.status} /></div></div>)}</div>
        </section>
        <section className="mt-5 rounded-md border border-red-400/15 bg-red-400/[.035] p-5"><div className="flex items-start gap-3"><AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-300" /><div><h2 className="text-sm font-medium text-red-200">OpenModelica 是当前明确阻断项</h2><p className="mt-2 max-w-4xl text-xs leading-6 text-muted-foreground">本环境没有 omc，因此旧演示模型和本版本的参数化三维都不能被描述为“已在指定 OpenModelica 版本编译并通过数值回归”。要达到客户试点验收，必须在锁定版本中执行模型编译、测试工况和结果对比，并保存工具版本、模型哈希与回归报告。</p></div></div></section>
      </div>
    </ProductLayout>
  );
}
