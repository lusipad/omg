import { useState, type ReactNode } from "react";
import { ArrowRight, Download, ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { STUDIO_EXAMPLES, studioHref, type StudioExample } from "@contracts/studio-navigation";
import { Button } from "@/components/ui/button";

const filters = [
  { id: "all", label: "全部" },
  { id: "physics", label: "机器人与物理模型" },
  { id: "machining", label: "数控加工" },
  { id: "factory", label: "工厂物流" },
  { id: "automation", label: "伺服与信号" },
] as const;
type Filter = typeof filters[number]["id"];
const group: Record<StudioExample["kind"], Exclude<Filter, "all">> = {
  physics: "physics", mechanism: "physics", so101: "physics", milo: "machining", factory: "factory", "linear-assembly": "automation", servo: "automation", wiring: "automation", system: "automation",
};

function assetUrl(path: string) {
  return /^https?:\/\//i.test(path) ? path : import.meta.env.BASE_URL + path;
}

function ExampleCard({ item }: { item: StudioExample }) {
  const filename = item.download?.split(/[?#]/, 1)[0].split("/").pop();
  const format = filename?.split(".").pop()?.toUpperCase();
  const size = item.bytes === undefined ? "" : item.bytes < 1_048_576 ? `${Math.ceil(item.bytes / 1024)} KiB` : `${(item.bytes / 1_048_576).toFixed(1)} MiB`;
  const notesLabel = item.license || (item.source ? "资料说明" : "来源与许可");
  return <li data-example-id={item.id} className="surface grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 overflow-hidden p-3 sm:flex sm:flex-col sm:gap-0 sm:p-0">
    <img src={assetUrl(item.preview)} alt={`${item.name}预览`} width={800} height={500} loading="lazy" decoding="async"
      className="aspect-[8/5] h-auto w-full self-start rounded-md bg-muted object-cover sm:rounded-none sm:border-b" />
    <div className="min-w-0 space-y-1 sm:px-4 sm:pt-3.5">
      <p className="text-xs text-muted-foreground">{item.category}</p>
      <h2 className="display-title break-words text-base font-semibold tracking-tight sm:text-lg">{item.name}</h2>
      <p className="text-xs leading-5 text-muted-foreground sm:text-[13px]">{item.description}</p>
    </div>
    <div className="col-span-full flex min-w-0 flex-wrap items-center justify-between gap-2 sm:flex-1 sm:flex-col sm:items-stretch sm:justify-end sm:gap-2.5 sm:px-4 sm:pb-4 sm:pt-3">
      {(item.source || item.author || item.sourceNotes || item.license) && <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words text-xs leading-5">
        {item.source ? <a href={assetUrl(item.source)} target="_blank" rel="noreferrer" aria-label={`${item.name} 来源 · ${item.author || "资料来源"}`}
          className="text-primary hover:underline">{item.author || "资料来源"} <ExternalLink className="inline size-3" /></a> :
          item.author && <span className="text-muted-foreground">{item.author}</span>}
        {item.sourceNotes && item.sourceNotes !== item.source ?
          <a href={assetUrl(item.sourceNotes)} target="_blank" rel="noreferrer" aria-label={`${item.name} ${item.license ? "许可说明 · " : ""}${notesLabel}`} className="text-muted-foreground hover:underline">{notesLabel}</a> :
          item.license && <span className="text-muted-foreground">{item.license}</span>}
      </p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={studioHref({ view: "workbench", exampleId: item.id })} aria-label={`打开示例 ${item.name}`}>打开示例<ArrowRight /></Link>
        </Button>
        {item.contourResource && <Link to={studioHref({ view: "workbench", exampleId: item.id, contour: item.contourResource })}
          className="text-xs text-primary hover:underline">试铣圆槽</Link>}
        {item.download && <a href={assetUrl(item.download)} download={filename === "model.zip" ? `${item.id}.zip` : filename}
          aria-label={`下载 ${item.name} ${format || "文件"}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
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
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <ul className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => <ExampleCard key={item.id} item={item} />)}
      </ul>
      {extraFooter}
    </section>
  );
}

const LEGACY_BENCHMARK_IDS = new Set(["wiring-demo", "inovance-servo", "modelica-feed-axis"]);

export default function StudioExamples() {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? STUDIO_EXAMPLES : STUDIO_EXAMPLES.filter((item) => group[item.kind] === filter || (filter === "machining" && item.contourResource));

  const mechatronicPrimary = STUDIO_EXAMPLES.filter(
    (item) => group[item.kind] === "automation" && !LEGACY_BENCHMARK_IDS.has(item.id),
  );
  const legacyBenchmarks = STUDIO_EXAMPLES.filter((item) => LEGACY_BENCHMARK_IDS.has(item.id));
  const kinematicsMachining = STUDIO_EXAMPLES.filter(
    (item) => group[item.kind] === "physics" || group[item.kind] === "machining",
  );
  const factoryTemplates = STUDIO_EXAMPLES.filter((item) => group[item.kind] === "factory");

  return <section aria-labelledby="studio-examples-heading" className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="space-y-1">
        <h1 id="studio-examples-heading" className="display-title text-2xl font-semibold tracking-tight">参考工程模板</h1>
        <p className="text-xs text-muted-foreground">按要验证的工程问题分层浏览现成样板，可一键载入装配工作台对比参考结果。</p>
      </div>
      <p role="status" className="text-sm text-muted-foreground">{filter === "all" ? "共 " : "当前 "}{visible.length} 个模板</p>
    </header>
    <div role="group" aria-label="按领域筛选示例" className="flex flex-wrap gap-1 border-b pb-3 sm:gap-1.5">
      {filters.map(({ id, label }) => <Button key={id} type="button" size="sm" variant={id === filter ? "default" : "ghost"}
        className="px-1.5 text-xs sm:px-3 sm:text-sm" aria-pressed={id === filter} onClick={() => setFilter(id)}>{label}</Button>)}
    </div>
    {filter === "all" ? (
      <div className="space-y-6">
        <ProblemTierSection
          title="① 机电控闭环与伺服进给系统（主干能力）"
          subtitle="把“设备资料 → 行为模型参数绑定 → 限位接线 → Modelica 闭环运动跟踪 → 现场对标”完整串通的样板。"
          items={mechatronicPrimary}
          extraFooter={legacyBenchmarks.length > 0 && (
            <details className="rounded-lg border bg-card/40 p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                展开 {legacyBenchmarks.length} 个单机理基础验证基准（24V 接线 / 单伺服轴 / Modelica 进给核）
              </summary>
              <ul className="mt-3 grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {legacyBenchmarks.map((item) => <ExampleCard key={item.id} item={item} />)}
              </ul>
            </details>
          )}
        />
        <ProblemTierSection
          title="② 三维机构、机器人与数控轮廓"
          subtitle="机械装配几何验证、机械臂动力学对比，以及铣床进给轮廓 G 代码误差分析样板。"
          items={kinematicsMachining}
        />
        <ProblemTierSection
          title="③ 产线节拍与多机物流"
          subtitle="多工位加工单元、输送节拍与搬运产线仿真模板。"
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
