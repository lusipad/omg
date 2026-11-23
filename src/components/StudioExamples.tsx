import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Download, ExternalLink, Search } from "lucide-react";
import { Link } from "react-router";
import { STUDIO_EXAMPLES, studioHref, type StudioExample } from "@contracts/studio-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const filters = [
  { id: "all", label: "全部" },
  { id: "automation", label: "机电控闭环与伺服" },
  { id: "physics", label: "机器人与三维机构" },
  { id: "machining", label: "数控加工" },
  { id: "factory", label: "工厂物流" },
] as const;
type Filter = typeof filters[number]["id"];
const group: Record<StudioExample["kind"], Exclude<Filter, "all">> = {
  physics: "physics", mechanism: "physics", so101: "physics", milo: "machining", factory: "factory", "linear-assembly": "automation", servo: "automation", wiring: "automation", system: "automation",
};

const BENCHMARK_IDS = new Set(["wiring-demo", "inovance-servo", "modelica-feed-axis"]);

function solverTag(item: StudioExample): { label: string; highlight?: boolean } {
  if (item.id === "closed-loop-feed-system") return { label: "推荐主干 · 全闭环对标", highlight: true };
  if (BENCHMARK_IDS.has(item.id)) return { label: "单机理验证基准" };
  switch (item.kind) {
    case "mechanism": return { label: "三维可动 · 爆炸图" };
    case "physics":
    case "so101": return { label: "MuJoCo 多体物理" };
    case "milo": return { label: "G代码三维切削" };
    case "factory": return { label: "产线节拍 · 轮廓" };
    case "linear-assembly": return { label: "Modelica 进给核" };
    case "servo": return { label: "Modelica 伺服" };
    case "wiring": return { label: "24V 接线仿真" };
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
        badge.highlight ? "bg-primary/90 text-primary-foreground shadow-sm" : "bg-background/85 text-foreground/90 border border-border/60"
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
          <Link to={studioHref({ view: "workbench", exampleId: item.id })} aria-label={`打开示例 ${item.name}`}>打开示例<ArrowRight /></Link>
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
  extraFooter,
}: {
  title: string;
  subtitle: string;
  items: readonly StudioExample[];
  extraFooter?: ReactNode;
}) {
  if (!items.length && !extraFooter) return null;
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight sm:text-base">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <span className="mono text-[11px] text-muted-foreground">{items.length} 项</span>
      </div>
      <ul className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => <ExampleCard key={item.id} item={item} />)}
      </ul>
      {extraFooter}
    </section>
  );
}

export default function StudioExamples() {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const matchesSearch = useMemo(() => {
    if (!needle) return STUDIO_EXAMPLES;
    return STUDIO_EXAMPLES.filter((item) =>
      [item.name, item.category, item.description, item.author ?? ""].join(" ").toLowerCase().includes(needle),
    );
  }, [needle]);

  const visible = filter === "all"
    ? matchesSearch
    : matchesSearch.filter((item) => group[item.kind] === filter || (filter === "machining" && item.contourResource));

  const mechatronicAll = visible.filter((item) => group[item.kind] === "automation");
  const kinematicsMachining = visible.filter((item) => group[item.kind] === "physics" || group[item.kind] === "machining");
  const factoryTemplates = visible.filter((item) => group[item.kind] === "factory");

  return <section aria-labelledby="studio-examples-heading" className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="space-y-0.5">
        <h1 id="studio-examples-heading" className="display-title text-xl font-semibold tracking-tight sm:text-2xl">参考工程模板</h1>
        <p className="text-xs text-muted-foreground">按工程验证域分层展示全部标准样板，支持一键载入装配工作台试跑并对标。</p>
      </div>
      <p role="status" className="mono text-xs text-muted-foreground">{filter === "all" && !needle ? "共 " : "当前显示 "}{visible.length} 个模板</p>
    </header>
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b pb-3">
      <div role="group" aria-label="按领域筛选示例" className="flex flex-wrap gap-1 rounded-md border bg-background/60 p-0.5">
        {filters.map(({ id, label }) => <Button key={id} type="button" size="sm" variant={id === filter ? "secondary" : "ghost"}
          className="h-7 px-2.5 text-xs" aria-pressed={id === filter} onClick={() => setFilter(id)}>{label}</Button>)}
      </div>
      <label className="relative block min-w-0 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
        <Input
          type="search"
          aria-label="搜索参考工程模板"
          placeholder="搜索机床、机械臂或伺服模板…"
          className="h-8 pl-8 text-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
    </div>
    {visible.length === 0 ? (
      <div className="surface flex flex-wrap items-center justify-between gap-2 p-5">
        <p className="text-xs text-muted-foreground">当前筛选条件下没有匹配的参考模板。</p>
        <Button size="sm" variant="outline" onClick={() => { setFilter("all"); setQuery(""); }}>重置筛选</Button>
      </div>
    ) : filter === "all" ? (
      <div className="space-y-6">
        <ProblemTierSection
          title="① 机电控闭环与伺服进给系统（核心主干与单机理基准）"
          subtitle="包含跨品牌限位闭环与实测对标主干样板，以及 Modelica 进给核、伺服位置环、24V 信号接线三个基础验证基准。"
          items={mechatronicAll}
        />
        <ProblemTierSection
          title="② 三维可动机构、机器人动力学与数控铣削"
          subtitle="机械基本件装配（可动与三维爆炸视图）、机械臂 MuJoCo 多体模型及铣床 G 代码轮廓误差验证。"
          items={kinematicsMachining}
        />
        <ProblemTierSection
          title="③ 产线节拍与多机物流"
          subtitle="多工位 CNC 加工单元、输送节拍与搬运产线联合仿真模板。"
          items={factoryTemplates}
        />
      </div>
    ) : (
      <ul className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((item) => <ExampleCard key={item.id} item={item} />)}
      </ul>
    )}
  </section>;
}
