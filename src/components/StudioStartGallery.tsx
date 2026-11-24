import { ArrowRight, Blocks, Compass, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { FROM_ZERO_LABS, type FromZeroLabId } from "@contracts/physics-explainer";
import { UNIVERSAL_ARCHETYPES, type UniversalArchetypeId } from "@contracts/universal-archetypes";
import { Button } from "@/components/ui/button";

export type ShowcaseTemplateId = UniversalArchetypeId | "gantry-mill";

interface ShowcaseCardItem {
  readonly id: ShowcaseTemplateId;
  readonly badge: string;
  readonly domain: string;
  readonly title: string;
  readonly summary: string;
}

const SHOWCASE_ITEMS: readonly ShowcaseCardItem[] = [
  ...UNIVERSAL_ARCHETYPES.map((item) => ({
    id: item.id,
    badge: item.badge,
    domain: item.category === "flagship" ? "空天 / 地标" : "典型机构",
    title: item.title,
    summary: item.subtitle,
  })),
  {
    id: "gantry-mill",
    badge: "数控机床",
    domain: "精密加工",
    title: "龙门双立柱三轴数控铣床",
    summary: "对称双柱门架与滚珠丝杠三轴联动结构，兼顾高抗弯刚度与大工作台行程。",
  },
];

export interface StudioStartGalleryProps {
  savedMachines: ReadonlyArray<MechanicalAssembly>;
  onStartBlank: () => void;
  onStartGuidedLab: (labId: FromZeroLabId) => void;
  onLoadShowcase: (id: ShowcaseTemplateId, targetStage: "build" | "simulate") => void;
  onOpenSaved: (assemblyId: string, targetStage: "build" | "simulate") => void;
  onDeleteSaved: (assemblyId: string) => void;
}

export default function StudioStartGallery({
  savedMachines,
  onStartBlank,
  onStartGuidedLab,
  onLoadShowcase,
  onOpenSaved,
  onDeleteSaved,
}: StudioStartGalleryProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 p-3 sm:p-5">
        {/* Section 1: Start From Zero */}
        <section aria-labelledby="start-from-zero-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 id="start-from-zero-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground sm:text-base">
                <Sparkles className="size-4 text-primary" />
                从零开始造物
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                从空白画布自由拼装，或跟随分步实验从第一颗电机搭出完整载具与物理验证闭环。
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Hero Blank Canvas Card */}
            <div className="surface flex flex-col justify-between gap-3 border-primary/35 bg-primary/[0.06] p-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-primary/20 px-2 py-0.5 text-[11px] font-medium text-primary">
                    自由创造
                  </span>
                  <span className="text-[11px] text-muted-foreground">0 件起步</span>
                </div>
                <h3 className="text-sm font-semibold text-foreground">空白画布（从 0 件开始）</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  不设预设约束，用电机、铰链、型材与 13 类参数化几何原语自由拼装，随时封装子总成并送入 MuJoCo 试车。
                </p>
              </div>
              <Button size="sm" className="h-8 w-full justify-between text-xs sm:w-auto sm:justify-center" onClick={onStartBlank}>
                <Plus className="size-3.5" />
                <span>新建空白作品</span>
                <ArrowRight className="size-3.5" />
              </Button>
            </div>

            {/* Guided From-Zero Labs */}
            {FROM_ZERO_LABS.map((lab) => (
              <div key={lab.id} className="surface flex flex-col justify-between gap-3 p-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                      分步实验
                    </span>
                    <span className="mono truncate text-[10px] text-muted-foreground">
                      {lab.recommendedArena === "launch_complex" ? "发射场空域" : "10° 摩擦斜坡"}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {lab.title.replace(/^实验\s*\d+：/, "")}
                  </h3>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{lab.summary}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-full justify-between text-xs sm:w-auto sm:justify-center"
                  onClick={() => onStartGuidedLab(lab.id)}
                >
                  <span>开始分步搭建</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        {/* Section 2: Saved Local Machines */}
        {savedMachines.length > 0 && (
          <section aria-labelledby="saved-machines-heading" className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="saved-machines-heading" className="text-sm font-semibold text-foreground">
                我的本地作品 ({savedMachines.length})
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {savedMachines.map((m) => (
                <div key={m.id} className="surface flex flex-col justify-between gap-2.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-foreground">{m.name}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.nodes.length} 个零件 · {Object.keys(m.commands).length} 个可动自由度
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`删除 ${m.name}`}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      onClick={() => onDeleteSaved(m.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onOpenSaved(m.id, "build")}>
                      <Blocks className="size-3" /> 继续拼装
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={() => onOpenSaved(m.id, "simulate")}>
                      <Play className="size-3" /> 运行仿真
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Section 3: Unified Showcase Archetypes */}
        <section aria-labelledby="showcase-gallery-heading" className="space-y-3">
          <div>
            <h2 id="showcase-gallery-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground sm:text-base">
              <Compass className="size-4 text-primary" />
              精选成品样机（一键仿真或拆解改装）
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              直接送入 MuJoCo 看真实动力学运行结果，或一键拆开送入拼装设计增删零件、导出采购 BOM。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SHOWCASE_ITEMS.map((item) => (
              <div key={item.id} className="surface flex flex-col justify-between gap-3 p-3.5">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      {item.badge}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{item.domain}</span>
                  </div>
                  <h3 className="text-sm font-semibold leading-snug text-foreground">{item.title}</h3>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
                </div>

                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <Button size="sm" className="h-8 px-2 text-xs" onClick={() => onLoadShowcase(item.id, "simulate")}>
                    <Play className="size-3" /> 运行物理
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={() => onLoadShowcase(item.id, "build")}
                  >
                    拆解改装
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
