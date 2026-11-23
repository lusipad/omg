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
}

const STATUS_BADGE: Record<"pass" | "warn" | "info", { text: string; cls: string }> = {
  pass: { text: "条件满足", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  warn: { text: "参数待调", cls: "border-amber-500/50 bg-amber-500/15 text-amber-300" },
  info: { text: "控制方程", cls: "border-sky-500/40 bg-sky-500/15 text-sky-300" },
};

export default function PhysicsModelCard({
  workspace,
  assembly,
  selectedNodeId,
  compact = false,
}: PhysicsModelCardProps) {
  const model = useMemo(
    () => deriveAssemblyPhysicsModel(workspace, assembly, selectedNodeId),
    [workspace, assembly, selectedNodeId],
  );

  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 font-semibold text-foreground">
          <Calculator className="size-3.5 text-primary" />
          数学物理模型推导
        </span>
        <span className="mono text-[10px] text-muted-foreground">
          {model.baseMobility === "free" ? "6-DOF 浮基" : "0-DOF 固定基"}
        </span>
      </div>

      {/* 4 Core System Invariants */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded border bg-background/60 p-1.5">
          <div className="text-[10px] text-muted-foreground">刚体 / 净自由度</div>
          <div className="mono font-semibold text-foreground">
            {model.bodyCount} 体 · {model.netDof} DOF
          </div>
        </div>
        <div className="rounded border bg-background/60 p-1.5">
          <div className="text-[10px] text-muted-foreground">主动控制输入</div>
          <div className="mono font-semibold text-sky-300">
            {model.actuatorCount} 驱动{model.thrusterCount > 0 ? ` (${model.thrusterCount} 推力)` : ""}
          </div>
        </div>
        <div className="rounded border bg-background/60 p-1.5">
          <div className="text-[10px] text-muted-foreground">总质量与重力载荷</div>
          <div className="mono font-semibold text-foreground">
            {model.totalMassKg.toFixed(2)} kg · {model.weightN.toFixed(1)} N
          </div>
        </div>
        <div className="rounded border bg-background/60 p-1.5">
          <div className="text-[10px] text-muted-foreground">系统质心 r_COM</div>
          <div className="mono truncate font-semibold text-emerald-300">
            ({model.comMm[0]}, {model.comMm[1]}, {model.comMm[2]}) mm
          </div>
        </div>
      </div>

      {/* Universal SE(3) & Euler-Lagrange Equation */}
      {!compact && (
        <div className="space-y-1 rounded border bg-background/70 p-2">
          <div className="text-[10px] font-medium text-muted-foreground">刚体树运动学链与拉格朗日动力学方程</div>
          <p className="mono break-all text-[10px] text-sky-300">{model.kinematicsEquation}</p>
          <p className="mono break-all text-[10px] text-emerald-300">{model.dynamicsEquation}</p>
        </div>
      )}

      {/* Selected Part Math Breakdown */}
      {model.selectedNodeMath && (
        <div className="space-y-1 rounded border border-primary/40 bg-primary/10 p-2">
          <div className="flex items-center justify-between gap-1 font-semibold text-foreground">
            <span className="truncate">选中节点：{model.selectedNodeMath.label}</span>
            <span className="mono shrink-0 text-[10px] text-primary">
              {model.selectedNodeMath.massKg} kg ({model.selectedNodeMath.massSharePct}%)
            </span>
          </div>
          <div className="mono text-[10px] text-muted-foreground">
            世界坐标 p = ({model.selectedNodeMath.worldPosMm.join(", ")}) mm
          </div>
          <div className="text-[10px] text-foreground">{model.selectedNodeMath.jointText}</div>
          {model.selectedNodeMath.coupledText && (
            <div className="mono text-[10px] text-sky-300">{model.selectedNodeMath.coupledText}</div>
          )}
          {model.selectedNodeMath.thrusterText && (
            <div className="mono text-[10px] text-amber-300">{model.selectedNodeMath.thrusterText}</div>
          )}
        </div>
      )}

      {/* Active Domain Governing Equations */}
      <div className="space-y-1.5">
        {model.sections.map((sec) => {
          const badge = STATUS_BADGE[sec.status];
          return (
            <div key={sec.id} className="space-y-1.5 rounded border bg-background/60 p-2">
              <div className="flex items-center justify-between gap-1">
                <span className="font-semibold text-foreground">{sec.title}</span>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${badge.cls}`}>
                  {badge.text}
                </span>
              </div>
              <p className="mono break-words rounded bg-background/80 px-1.5 py-1 text-[10px] text-sky-300">
                {sec.equation}
              </p>
              <div className="grid grid-cols-1 gap-0.5">
                {sec.metrics.map((m) => (
                  <div key={m.label} className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="text-muted-foreground">{m.label}</span>
                    <span className="mono font-medium text-foreground">{m.value}</span>
                  </div>
                ))}
              </div>
              {!compact && <p className="text-[10px] leading-snug text-muted-foreground">{sec.explanation}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
