import { useMemo } from "react";
import { Calculator } from "lucide-react";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { deriveAssemblyPhysicsModel } from "@contracts/physics-explainer";
import type { TwinWorkspace } from "@contracts/twin-simulation";

export interface PhysicsModelCardProps {
  readonly workspace: TwinWorkspace;
  readonly assembly: MechanicalAssembly;
  readonly selectedNodeId?: string;
  readonly compact?: boolean;
  readonly hideSystemSummary?: boolean;
}

const STATUS_BADGE: Record<"pass" | "warn" | "info", { text: string; cls: string }> = {
  pass: { text: "条件满足", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  warn: { text: "待调整", cls: "border-amber-500/50 bg-amber-500/15 text-amber-300" },
  info: { text: "运动学", cls: "border-sky-500/40 bg-sky-500/15 text-sky-300" },
};

export default function PhysicsModelCard({
  workspace,
  assembly,
  selectedNodeId,
  compact = false,
  hideSystemSummary = false,
}: PhysicsModelCardProps) {
  const model = useMemo(
    () => deriveAssemblyPhysicsModel(workspace, assembly, selectedNodeId),
    [workspace, assembly, selectedNodeId],
  );

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <Calculator className="size-3.5 text-primary" />
          数学物理模型推导
        </span>
        <span className="mono text-[11px] text-muted-foreground">
          {model.baseMobility === "free" ? "6-DOF 浮基" : "0-DOF 固定基"}
        </span>
      </div>

      {/* 3 Core System Invariants (hidden in MuJoCo Arena where top summary covers body/mass) */}
      {!hideSystemSummary && (
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded-md border bg-background/60 p-2.5">
            <div className="text-[11px] text-muted-foreground">自由度</div>
            <div className="mono mt-0.5 text-sm font-semibold text-foreground">{model.netDof} DOF</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{model.bodyCount} 刚体</div>
          </div>
          <div className="rounded-md border bg-background/60 p-2.5">
            <div className="text-[11px] text-muted-foreground">总重</div>
            <div className="mono mt-0.5 text-sm font-semibold text-foreground">
              {model.totalMassKg.toFixed(2)} kg
            </div>
            <div className="mono mt-0.5 text-[11px] text-muted-foreground">{model.weightN.toFixed(1)} N</div>
          </div>
          <div
            className="rounded-md border bg-background/60 p-2.5"
            title={`系统质心 r_COM = (${model.comMm[0]}, ${model.comMm[1]}, ${model.comMm[2]}) mm`}
          >
            <div className="text-[11px] text-muted-foreground">质心 X 偏距</div>
            <div className="mono mt-0.5 text-sm font-semibold text-emerald-300">{model.comMm[0]} mm</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{model.actuatorCount} 驱动输入</div>
          </div>
        </div>
      )}

      {/* Selected Part Summary */}
      {model.selectedNodeMath && (
        <div
          className="space-y-1 rounded-md border border-primary/40 bg-primary/10 p-2.5 text-xs"
          title={`世界坐标 p = (${model.selectedNodeMath.worldPosMm.join(", ")}) mm`}
        >
          <div className="flex items-center justify-between gap-2 font-semibold text-foreground">
            <span className="truncate">选中：{model.selectedNodeMath.label}</span>
            <span className="mono shrink-0 text-[11px] text-primary">
              {model.selectedNodeMath.massKg} kg ({model.selectedNodeMath.massSharePct}%)
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">{model.selectedNodeMath.jointText}</div>
          {(model.selectedNodeMath.coupledText || model.selectedNodeMath.thrusterText) && (
            <div className="mono text-[11px] text-amber-300">
              {model.selectedNodeMath.thrusterText ?? model.selectedNodeMath.coupledText}
            </div>
          )}
        </div>
      )}

      {/* Domain Governing Equations & Plain-Language Verdict First */}
      <div className="space-y-2.5">
        {model.sections.map((sec) => {
          const badge = STATUS_BADGE[sec.status];
          return (
            <div key={sec.id} className="space-y-2 rounded-md border bg-background/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">{sec.title}</span>
                <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                  {badge.text}
                </span>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">{sec.explanation}</p>

              {sec.metrics.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5">
                  {sec.metrics.map((m, idx) => {
                    const spanFull = sec.metrics.length % 2 === 1 && idx === sec.metrics.length - 1;
                    return (
                      <div
                        key={m.label}
                        className={`rounded border bg-background/70 px-2 py-1.5 ${spanFull ? "col-span-2" : ""}`}
                      >
                        <div className="leading-snug text-[11px] text-muted-foreground">{m.label}</div>
                        <div className="mono break-words leading-snug text-xs font-semibold text-foreground">{m.value}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              <details className="rounded border bg-background/50 px-2.5 py-1.5 text-xs">
                <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
                  查看数学控制方程
                </summary>
                <p className="mono mt-1.5 break-words rounded bg-background/80 px-2 py-1.5 text-[11px] text-sky-300">
                  {sec.equation}
                </p>
              </details>
            </div>
          );
        })}
      </div>

      {/* Universal SE(3) & Euler-Lagrange Equations (collapsed by default) */}
      {!compact && (
        <details className="rounded-md border bg-background/50 px-2.5 py-2 text-xs">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
            查看通用刚体树与拉格朗日控制方程
          </summary>
          <div className="mt-2 space-y-1.5">
            <p className="mono break-all rounded bg-background/80 p-1.5 text-[11px] text-sky-300">
              {model.kinematicsEquation}
            </p>
            <p className="mono break-all rounded bg-background/80 p-1.5 text-[11px] text-emerald-300">
              {model.dynamicsEquation}
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
