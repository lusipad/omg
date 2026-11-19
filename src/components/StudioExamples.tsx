import { useState } from "react";
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
  physics: "physics", so101: "physics", milo: "machining", factory: "factory", "linear-assembly": "automation", servo: "automation", wiring: "automation",
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
        {item.download && <a href={assetUrl(item.download)} download={filename === "model.zip" ? `${item.id}.zip` : filename}
          aria-label={`下载 ${item.name} ${format || "文件"}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Download className="size-3.5" />{format || "下载"}{size && ` · ${size}`}
        </a>}
      </div>
    </div>
  </li>;
}

export default function StudioExamples() {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? STUDIO_EXAMPLES : STUDIO_EXAMPLES.filter((item) => group[item.kind] === filter);
  return <section aria-labelledby="studio-examples-heading" className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 id="studio-examples-heading" className="display-title text-2xl font-semibold tracking-tight">示例库</h1>
      <p role="status" className="text-sm text-muted-foreground">{filter === "all" ? "共 " : "当前 "}{visible.length} 个示例</p>
    </header>
    <div role="group" aria-label="按领域筛选示例" className="flex flex-wrap gap-1 border-b pb-3 sm:gap-1.5">
      {filters.map(({ id, label }) => <Button key={id} type="button" size="sm" variant={id === filter ? "default" : "ghost"}
        className="px-1.5 text-xs sm:px-3 sm:text-sm" aria-pressed={id === filter} onClick={() => setFilter(id)}>{label}</Button>)}
    </div>
    <ul className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {visible.map((item) => <ExampleCard key={item.id} item={item} />)}
    </ul>
  </section>;
}
