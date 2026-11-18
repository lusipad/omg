import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CircleDot,
  FileCheck2,
  GitBranch,
  Loader2,
  Move3d,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/providers/trpc";
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_DEVICES,
  AUTOMATION_REQUIREMENT_FIELDS,
  autoProjectInputSchema,
  generateAutomationPlan,
  type AutoProjectInput,
  type AutoTemplate,
  type AutomationPlan,
} from "@contracts/automation";
import { cn } from "@/lib/utils";

const deviceIcons = { cnc: Boxes, arm: GitBranch, mobile: Move3d };
const defaultNames: Record<AutoTemplate, string> = {
  cnc: "三轴数控机床方案",
  arm: "六轴机械臂方案",
  mobile: "差速轮式机器人方案",
};

function newProjectCode() {
  return `AUTO-${Date.now().toString(36).toUpperCase()}`;
}

export default function AutomationWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [template, setTemplate] = useState<AutoTemplate>("cnc");
  const [requirements, setRequirements] = useState<Record<string, number>>({ ...AUTOMATION_DEFAULTS.cnc });
  const [code, setCode] = useState(newProjectCode);
  const [name, setName] = useState(defaultNames.cnc);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const device = AUTOMATION_DEVICES.find((item) => item.key === template)!;
  const input = { code, name, description, template, requirements } as AutoProjectInput;
  const preview = useMemo<{ plan?: AutomationPlan; error?: string }>(() => {
    try {
      return { plan: generateAutomationPlan(autoProjectInputSchema.parse(input)) };
    } catch (cause) {
      const issue = (cause as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues?.[0];
      return { error: issue ? `${String(issue.path.at(-1) ?? "输入")}：${issue.message}` : "请检查输入" };
    }
    // The preview deliberately reads only the draft input, never persisted project state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, name, description, template, requirements]);

  const createAutomatic = trpc.project.createAutomatic.useMutation({
    onSuccess: async (output) => {
      await utils.project.list.invalidate();
      resetWizard();
      onOpenChange(false);
      toast.success("自动方案已生成", {
        description: `${output.moduleCount} 个组成模块 · V${output.versionNo} 草案 · ${output.pendingConfirmationCount} 项待确认`,
      });
      navigate(`/projects/${output.projectId}?generated=1`);
    },
    onError: (cause) => setError(cause.message),
  });

  function resetWizard() {
    setStep(1);
    setTemplate("cnc");
    setRequirements({ ...AUTOMATION_DEFAULTS.cnc });
    setCode(newProjectCode());
    setName(defaultNames.cnc);
    setDescription("");
    setError("");
  }

  function chooseTemplate(next: AutoTemplate) {
    setTemplate(next);
    setRequirements({ ...AUTOMATION_DEFAULTS[next] });
    setName(defaultNames[next]);
    setError("");
  }

  function goToRequirements() {
    setStep(2);
    setError("");
  }

  function goToReview() {
    const parsed = autoProjectInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${String(issue.path.at(-1) ?? "输入")}：${issue.message}`);
      return;
    }
    setStep(3);
    setError("");
  }

  function submit() {
    const parsed = autoProjectInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查输入");
      return;
    }
    setError("");
    createAutomatic.mutate(parsed.data);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!createAutomatic.isPending) onOpenChange(next); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto p-0 thin-scrollbar">
        <div className="border-b bg-primary/[.035] px-5 py-5 sm:px-7">
          <DialogHeader>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[.18em] text-primary"><WandSparkles className="h-3.5 w-3.5" />Automatic engineering draft</div>
            <DialogTitle className="display-title text-xl">从整机需求自动生成方案</DialogTitle>
            <DialogDescription>选择设备、填写少量需求，系统自动创建组成、完成初算、生成候选 BOM 和首版快照。</DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid grid-cols-3 gap-2">
            {["选择设备", "整机需求", "确认并生成"].map((label, index) => {
              const number = (index + 1) as 1 | 2 | 3;
              return <button key={label} disabled={number > step || createAutomatic.isPending} onClick={() => number < step && setStep(number)} className={cn("flex items-center gap-2 rounded border px-2.5 py-2 text-left text-[11px] text-muted-foreground", step === number && "border-primary/30 bg-primary/10 text-primary", number < step && "text-foreground hover:bg-accent/50")}><span className={cn("mono grid h-5 w-5 place-items-center rounded-full border text-[9px]", number < step && "border-primary/40 bg-primary/15 text-primary")}>{number < step ? <Check className="h-3 w-3" /> : `0${number}`}</span>{label}</button>;
            })}
          </div>
        </div>

        <div className="px-5 py-6 sm:px-7">
          {step === 1 && <div className="space-y-3">
            {AUTOMATION_DEVICES.map((item) => {
              const Icon = deviceIcons[item.key];
              const active = template === item.key;
              return <button key={item.key} onClick={() => chooseTemplate(item.key)} className={cn("group flex w-full items-start gap-4 rounded-md border p-4 text-left transition-colors hover:border-primary/25 hover:bg-primary/[.035]", active && "border-primary/40 bg-primary/[.065]")}>
                <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-md border bg-background/70 text-muted-foreground", active && "border-primary/30 text-primary")}><Icon className="h-5 w-5" strokeWidth={1.5} /></span>
                <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{item.name}</span><span className="mono rounded border px-1.5 py-0.5 text-[9px] text-muted-foreground">{item.moduleCount} MODULES</span></span><span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{item.summary}</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground/80">{item.scope}</span></span>
                <span className={cn("mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border", active ? "border-primary bg-primary text-primary-foreground" : "border-border")} >{active && <Check className="h-3 w-3" />}</span>
              </button>;
            })}
          </div>}

          {step === 2 && <div>
            <div className="mb-5 flex items-start gap-3 rounded-md border bg-muted/25 p-3.5"><Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><div className="text-xs font-medium">{device.name} · 只需填写整机级需求</div><p className="mt-1 text-[11px] leading-5 text-muted-foreground">其余参数由明示规则分配，进入工作台后仍可逐项修改。默认值仅用于方案草案，不代表推荐工况。</p></div></div>
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
              {AUTOMATION_REQUIREMENT_FIELDS[template].map((field) => <div key={field.key}>
                <label className="field-label" htmlFor={`auto-${field.key}`}><span>{field.label}</span><span className="mono text-[10px] font-normal text-primary">{field.unit}</span></label>
                <input id={`auto-${field.key}`} className="number-input" type="number" min={field.min} max={field.max} step={field.step} value={requirements[field.key] ?? ""} onChange={(event) => setRequirements((current) => ({ ...current, [field.key]: Number(event.target.value) }))} />
                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{field.description}</p>
              </div>)}
            </div>
          </div>}

          {step === 3 && <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><Label htmlFor="auto-project-name">方案名称</Label><Input id="auto-project-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div><Label htmlFor="auto-project-code">项目编号</Label><Input id="auto-project-code" className="mono mt-2" value={code} onChange={(event) => setCode(event.target.value)} /></div>
              <div className="sm:col-span-2"><Label htmlFor="auto-project-description">现场说明（可选）</Label><Textarea id="auto-project-description" className="mt-2" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：工件材料、运行节拍、安装空间、供电或客户特殊约束。" /></div>
            </div>
            {preview.plan ? <div className="rounded-md border bg-background/45">
              <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="eyebrow">自动生成范围</div><div className="mt-1.5 text-sm font-medium">{device.name} · {preview.plan.modules.length} 个组成模块</div></div><div className="flex items-center gap-2 text-[11px] text-primary"><FileCheck2 className="h-4 w-4" />初算 + 候选 BOM + V1 快照</div></div>
              <div className="grid gap-3 p-4 sm:grid-cols-2">
                <div><div className="eyebrow mb-2">组成与初算</div><div className="flex flex-wrap gap-1.5">{preview.plan.modules.map((module) => <span key={module.instanceName} className="inline-flex items-center gap-1.5 rounded border bg-card px-2 py-1 text-[10px]"><CircleDot className={cn("h-3 w-3", module.result.status === "blocked" ? "text-red-400" : module.result.status === "warning" ? "text-amber-300" : "text-primary")} />{module.instanceName}</span>)}</div></div>
                <div><div className="eyebrow mb-2">生成后你需要处理</div><p className="text-[11px] leading-5 text-muted-foreground">集中查看计算警告、缺失部件与工程假设。候选部件只完成现有资料初筛，不代表接口、寿命、热或供应商选型完成。</p></div>
              </div>
              <details className="border-t px-4 py-3"><summary className="cursor-pointer text-[11px] text-muted-foreground">查看 {preview.plan.assumptions.length} 条自动分配假设与 {preview.plan.warnings.length} 条边界警告</summary><ul className="mt-3 space-y-2 text-[10px] leading-5 text-muted-foreground">{[...preview.plan.assumptions, ...preview.plan.warnings].map((item) => <li key={item} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />{item}</li>)}</ul></details>
            </div> : <div className="rounded border border-destructive/25 bg-destructive/10 p-3 text-xs text-red-300">{preview.error}</div>}
          </div>}

          {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded border border-destructive/25 bg-destructive/10 p-3 text-[11px] leading-5 text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
        </div>

        <DialogFooter className="border-t bg-card/60 px-5 py-4 sm:px-7">
          <div className="mr-auto hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex"><Sparkles className="h-3.5 w-3.5 text-primary" />自动生成可修改草案，不自动批准制造</div>
          {step > 1 && <Button variant="outline" disabled={createAutomatic.isPending} onClick={() => { setStep((step - 1) as 1 | 2); setError(""); }}><ArrowLeft className="mr-2 h-4 w-4" />上一步</Button>}
          {step === 1 && <Button onClick={goToRequirements}>填写整机需求<ArrowRight className="ml-2 h-4 w-4" /></Button>}
          {step === 2 && <Button onClick={goToReview}>预览自动方案<ArrowRight className="ml-2 h-4 w-4" /></Button>}
          {step === 3 && <Button disabled={!preview.plan || createAutomatic.isPending} onClick={submit}>{createAutomatic.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}{createAutomatic.isPending ? "正在生成完整方案…" : "生成方案并进入工作台"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
