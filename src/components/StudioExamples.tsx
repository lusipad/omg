import { useMemo, useState } from "react";
import { ArrowRight, Download, ExternalLink, Search } from "lucide-react";
import { Link } from "react-router";
import { STUDIO_EXAMPLES, studioHref, type StudioExample, type StudioExampleKind } from "@contracts/studio-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SolverFilter = "all" | "modelica" | "mujoco" | "factory";

const filters: readonly { id: SolverFilter; label: string }[] = [
  { id: "all", label: "全部算例" },
  { id: "modelica", label: "Modelica 机电闭环" },
  { id: "mujoco", label: "MuJoCo 多体物理与机构" },
  { id: "factory", label: "产线节拍与加工单元" },
];

const ENGINE_OF_KIND: Record<StudioExampleKind, Exclude<SolverFilter, "all">> = {
  system: "modelica",
  "linear-assembly": "modelica",
  servo: "modelica",
  wiring: "modelica",
  physics: "mujoco",
  so101: "mujoco",
  mechanism: "mujoco",
  factory: "factory",
  milo: "factory",
};

const BENCHMARK_IDS = new Set(["wiring-demo", "inovance-servo", "modelica-feed-axis"]);
const FLAGSHIP_PRIORITY: Record<string, number> = {
  "closed-loop-feed-system": 0,
  "modelica-feed-axis": 1,
  "inovance-servo": 2,
  "wiring-demo": 3,
  "ur5e-pick-place": 10,
  ur5e: 11,
  "so101-follower": 12,
  "composable-milo-mill": 13,
  "cnc-factory": 20,
  "milo-v1-5": 21,
};

function sortPriority(a: StudioExample, b: StudioExample): number {
  const pa = FLAGSHIP_PRIORITY[a.id] ?? 99;
  const pb = FLAGSHIP_PRIORITY[b.id] ?? 99;
  return pa - pb;
}

function solverTag(item: StudioExample): { label: string; highlight?: boolean } {
  if (item.id === "closed-loop-feed-system") return { label: "Modelica · 全闭环对标", highlight: true };
  if (item.id === "ur5e-pick-place") return { label: "MuJoCo · 组合取放工位", highlight: true };
  if (item.id === "cnc-factory") return { label: "产线节拍 · 三轴轮廓", highlight: true };
  if (BENCHMARK_IDS.has(item.id)) return { label: "Modelica · 单机理基准" };
  switch (item.kind) {
    case "mechanism": return { label: "三维机构 · 爆炸图" };
    case "physics":
    case "so101": return { label: "MuJoCo 多体物理" };
    case "milo": return { label: "G 代码三维切削" };
    case "factory": return { label: "产线节拍 · 轮廓" };
    case "linear-assembly": return { label: "Modelica 进给核" };
    case "servo": return { label: "Modelica 伺服" };
    case "wiring": return { label: "24V 逻辑与滤波" };
    case "system": return { label: "Modelica WASM 闭环" };
  }
}

function assetUrl(path: string) {
  return /^https?:\/\//i.test(path) ? path : import.meta.env.BASE_URL + path;
}

function ExampleCard({ item }: { item: StudioExample }) {
  const filename = item.download?.split(/[?#]/, 1)[0].split("/").pop();
  const format = filename?.split(".").pop()?.toUpperCase();
  const size = item.bytes === undefined ? "" : item.bytes < 1_048_576 ? `${Math.ceil(item.bytes / 1024)} KiB` : `${(item.bytes / 1_048_576).toFixed(1)} MiB`;
  const notesLabel = item.license || (item.source ? "资料说明" : "来源与许可");
  const badge = solverTag(item);
  return <li data-example-id={item.id} className={`surface grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 overflow-hidden p-3 sm:flex sm:flex-col sm:gap-0 sm:p-0 ${badge.highlight ? "border-primary/45 ring-1 ring-primary/15" : ""}`}>
    <div className="relative">
      <img src={assetUrl(item.preview)} alt={`${item.name}预览`} width={800} height={500} loading="lazy" decoding="async"
        className="aspect-[8/5] h-auto w-full self-start rounded-md bg-muted object-cover sm:rounded-none sm:border-b" />
      <span className={`hidden sm:inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-sm sm:absolute sm:left-2.5 sm:top-2.5 ${
        badge.highlight ? "bg-primary/90 text-primary-foreground shadow-sm" : "border border-border/60 bg-background/85 text-foreground/90"
      }`}>
        {badge.label}
      </span>
    </div>
    <div className="min-w-0 space-y-1 sm:px-3.5 sm:pt-3">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">{item.category}</p>
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium sm:hidden ${
          badge.highlight ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
        }`}>{badge.label}</span>
      </div>
      <h2 className="display-title text-balance break-words text-sm font-semibold tracking-tight sm:text-base">{item.name}</h2>
      <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">{item.description}</p>
    </div>
    <div className="col-span-full flex min-w-0 flex-wrap items-center justify-between gap-2 sm:flex-1 sm:flex-col sm:items-stretch sm:justify-end sm:gap-2 sm:px-3.5 sm:pb-3.5 sm:pt-2.5">
      {(item.source || item.author || item.sourceNotes || item.license) && <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-words text-[11px] leading-4">
        {item.source ? <a href={assetUrl(item.source)} target="_blank" rel="noreferrer" aria-label={`${item.name} 来源 · ${item.author || "资料来源"}`}
          className="text-primary hover:underline">{item.author || "资料来源"} <ExternalLink className="inline size-3" /></a> :
          item.author && <span className="text-muted-foreground">{item.author}</span>}
        {item.sourceNotes && item.sourceNotes !== item.source ?
          <a href={assetUrl(item.sourceNotes)} target="_blank" rel="noreferrer" aria-label={`${item.name} ${item.license ? "许可说明 · " : ""}${notesLabel}`} className="text-muted-foreground hover:underline">{notesLabel}</a> :
          item.license && <span className="text-muted-foreground">{item.license}</span>}
      </p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant={badge.highlight ? "default" : "outline"} size="sm" className="h-8 text-xs">
          <Link to={studioHref({ view: "workbench", exampleId: item.id })} aria-label={`打开示例 ${item.name}`}>打开算例<ArrowRight /></Link>
        </Button>
        {item.contourResource && <Link to={studioHref({ view: "workbench", exampleId: item.id, contour: item.contourResource })}
          className="text-xs font-medium text-primary hover:underline">试铣圆槽</Link>}
        {item.download && <a href={assetUrl(item.download)} download={filename === "model.zip" ? `${item.id}.zip` : filename}
          aria-label={`下载 ${item.name} ${format || "文件"}`} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <Download className="size-3.5" />{format || "下载"}{size && ` · ${size}`}
        </a>}
      </div>
    </div>
  </li>;
}

function ProblemTierSection({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: readonly StudioExample[];
}) {
  if (!items.length) return null;
  const gridCols = items.length <= 2
    ? "sm:grid-cols-2"
    : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight sm:text-base">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <span className="mono text-[11px] text-muted-foreground">{items.length} 个算例</span>
      </div>
      <ul className={`grid items-stretch gap-3 ${gridCols}`}>
        {items.map((item) => <ExampleCard key={item.id} item={item} />)}
      </ul>
    </section>
  );
}

export default function StudioExamples() {
  const [filter, setFilter] = useState<SolverFilter>("all");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const matchesSearch = useMemo(() => {
    const base = needle
      ? STUDIO_EXAMPLES.filter((item) =>
          [item.name, item.category, item.description, item.author ?? ""].join(" ").toLowerCase().includes(needle),
        )
      : [...STUDIO_EXAMPLES];
    return [...base].sort(sortPriority);
  }, [needle]);

  const counts = useMemo<Record<SolverFilter, number>>(() => {
    const res: Record<SolverFilter, number> = { all: matchesSearch.length, modelica: 0, mujoco: 0, factory: 0 };
    for (const item of matchesSearch) res[ENGINE_OF_KIND[item.kind]]++;
    return res;
  }, [matchesSearch]);

  const visible = filter === "all"
    ? matchesSearch
    : matchesSearch.filter((item) => ENGINE_OF_KIND[item.kind] === filter);

  const modelicaItems = visible.filter((item) => ENGINE_OF_KIND[item.kind] === "modelica");
  const mujocoItems = visible.filter((item) => ENGINE_OF_KIND[item.kind] === "mujoco");
  const factoryItems = visible.filter((item) => ENGINE_OF_KIND[item.kind] === "factory");

  return <section aria-labelledby="studio-examples-heading" className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="space-y-0.5">
        <h1 id="studio-examples-heading" className="display-title text-xl font-semibold tracking-tight sm:text-2xl">标准算例库</h1>
        <p className="text-xs text-muted-foreground">严格按三大求解器内核分组展示全部 16 个已校验算例，一键打开试跑或加入当前工程。</p>
      </div>
      <p role="status" className="mono text-xs text-muted-foreground">{filter === "all" && !needle ? "共 " : "当前显示 "}{visible.length} 个模板</p>
    </header>
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b pb-3">
      <div role="group" aria-label="按领域筛选示例" className="flex flex-wrap gap-1 rounded-md border bg-background/60 p-0.5">
        {filters.map(({ id, label }) => (
          <Button key={id} type="button" size="sm" variant={id === filter ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs" aria-pressed={id === filter} onClick={() => setFilter(id)}>
            <span>{label}</span>
            <span className="mono ml-1 text-[10px] text-muted-foreground">{counts[id]}</span>
          </Button>
        ))}
      </div>
      <label className="relative block min-w-0 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
        <Input
          type="search"
          aria-label="搜索参考工程模板"
          placeholder="搜索算例名称、机械臂、Modelica…"
          className="h-8 pl-8 text-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
    </div>
    {visible.length === 0 ? (
      <div className="surface flex flex-wrap items-center justify-between gap-2 p-5">
        <p className="text-xs text-muted-foreground">当前筛选条件下没有匹配的算例。</p>
        <Button size="sm" variant="outline" onClick={() => { setFilter("all"); setQuery(""); }}>重置筛选</Button>
      </div>
    ) : filter === "all" ? (
      <div className="space-y-6">
        <ProblemTierSection
          title="① Modelica 机电闭环求解器算例"
          subtitle="伺服驱动-滚珠丝杠-限位开关-防抖滤波器联合闭环仿真与实测示波器 CSV 对标基准。"
          items={modelicaItems}
        />
        <ProblemTierSection
          title="② MuJoCo 多体物理与三维机构算例"
          subtitle="工业机器人动力学接触仿真（XML/URDF）、复合取放工位与 23 件可动机械爆炸装配。"
          items={mujocoItems}
        />
        <ProblemTierSection
          title="③ 产线节拍与数控加工单元算例"
          subtitle="双产线物流节拍协同、CNC 电机选配对比及 Milo v1.5 三轴圆槽 G 代码数控切削。"
          items={factoryItems}
        />
      </div>
    ) : (
      <ul className={`grid items-stretch gap-3 ${visible.length <= 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}`}>
        {visible.map((item) => <ExampleCard key={item.id} item={item} />)}
      </ul>
    )}
  </section>;
}
