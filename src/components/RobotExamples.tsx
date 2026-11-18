import { Download, ExternalLink, Play } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { ROBOT_EXAMPLES } from "@contracts/robot-examples";
import { Button } from "@/components/ui/button";

export default function RobotExamples({ selectedId, onReselect }: { selectedId: string | null; onReselect: () => void }) {
  const [search] = useSearchParams();
  return <section aria-labelledby="robot-examples-heading" className="min-w-0 space-y-3">
    <h3 id="robot-examples-heading" className="text-base font-semibold">开源机器人</h3>
    <ul className="grid gap-3 lg:grid-cols-3">
      {ROBOT_EXAMPLES.map((robot) => {
        const assets = `${import.meta.env.BASE_URL}robots/${robot.id}/`;
        const params = new URLSearchParams(search);
        params.set("view", "import"); params.set("robot", robot.id);
        return <li key={robot.id} className="surface grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-3 sm:grid-cols-[8rem_minmax(0,1fr)] lg:flex lg:flex-col lg:gap-0 lg:overflow-hidden lg:p-0">
          <img src={assets + "preview.webp"} alt={robot.name + " 模型预览"} width={800} height={500} loading="lazy" decoding="async"
            className="h-auto w-full self-start rounded-md bg-[#d7dfdc] object-contain lg:h-36 lg:rounded-none lg:border-b" />
          <div className="flex min-w-0 flex-col items-start gap-2 lg:px-4 lg:pt-3">
            <div><p className="text-xs text-muted-foreground">{robot.category}</p><h4 className="mt-0.5 break-words text-base font-semibold">{robot.name}</h4></div>
            <p className="text-xs leading-5 text-muted-foreground">{robot.description}</p>
          </div>
          <div className="col-span-full space-y-2 lg:mt-auto lg:px-4 lg:pb-4 lg:pt-2">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5">
              <a href={robot.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${robot.name} 上游来源 · ${robot.author}`} className="text-primary hover:underline">{robot.author} <ExternalLink className="inline size-3" /></a>
              <a href={assets + "SOURCE.md"} target="_blank" rel="noreferrer" aria-label={`${robot.name} 许可说明 · ${robot.license}`} className="text-muted-foreground underline-offset-2 hover:underline">{robot.license}</a>
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button size="sm" variant={selectedId === robot.id ? "secondary" : "outline"} asChild>
                <Link to={{ search: "?" + params.toString() }} preventScrollReset aria-label={`打开 ${robot.name}`} aria-current={selectedId === robot.id ? "page" : undefined} onClick={(event) => {
                  if (selectedId === robot.id && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onReselect(); }
                }}><Play />打开模型</Link>
              </Button>
              <a href={`${assets}model.zip?v=${robot.sha256}`} download={robot.id + ".zip"} aria-label={`下载 ${robot.name} 模型 ZIP`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
                <Download className="size-3.5" />ZIP · {robot.bytes < 1_048_576 ? `${Math.ceil(robot.bytes / 1024)} KiB` : `${(robot.bytes / 1_048_576).toFixed(1)} MiB`}
              </a>
            </div>
          </div>
        </li>;
      })}
    </ul>
  </section>;
}
