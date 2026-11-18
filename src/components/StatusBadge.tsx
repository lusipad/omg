import { AlertTriangle, Ban, Check, CircleDashed, Clock3, FileCheck2, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

const styles: Record<string, { label: string; className: string; icon: typeof Check }> = {
  ok: { label: "初算通过", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: Check },
  passed: { label: "已通过", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: Check },
  warning: { label: "需复核", className: "border-amber-400/20 bg-amber-400/10 text-amber-300", icon: AlertTriangle },
  blocked: { label: "已阻断", className: "border-red-400/20 bg-red-400/10 text-red-300", icon: Ban },
  draft: { label: "草稿", className: "border-slate-400/20 bg-slate-400/10 text-slate-300", icon: CircleDashed },
  in_review: { label: "复核中", className: "border-amber-400/20 bg-amber-400/10 text-amber-300", icon: Clock3 },
  pilot_ready: { label: "试点就绪", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: FlaskConical },
  archived: { label: "已归档", className: "border-slate-400/20 bg-slate-400/10 text-slate-400", icon: CircleDashed },
  recorded: { label: "来源已记录", className: "border-sky-400/20 bg-sky-400/10 text-sky-300", icon: FileCheck2 },
  source_recorded: { label: "来源已记录", className: "border-sky-400/20 bg-sky-400/10 text-sky-300", icon: FileCheck2 },
  engineer_reviewed: { label: "工程师已复核", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: Check },
  supplier_confirmed: { label: "供应商已确认", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: Check },
  pending: { label: "待完成", className: "border-slate-400/20 bg-slate-400/10 text-slate-300", icon: Clock3 },
  pilot: { label: "试点规则", className: "border-violet-400/20 bg-violet-400/10 text-violet-300", icon: FlaskConical },
  released: { label: "已发布", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300", icon: Check },
  retired: { label: "已停用", className: "border-slate-400/20 bg-slate-400/10 text-slate-400", icon: Ban },
};

export default function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const config = styles[status] ?? { label: status, className: "border-border bg-muted text-muted-foreground", icon: CircleDashed };
  const Icon = config.icon;
  return (
    <span className={cn("status-pill", config.className, className)}>
      <Icon className="h-3 w-3" strokeWidth={1.8} />
      {label ?? config.label}
    </span>
  );
}
