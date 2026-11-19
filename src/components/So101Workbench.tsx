import { lazy, Suspense, useRef } from "react";
import { Bot, Download, ExternalLink, FileUp, Layers3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SO101_JOINTS, SO101_UPSTREAM, parseSo101Motion } from "@contracts/so101";
import { isSo101ServoPart, so101BomNotes } from "@contracts/so101-bom";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { WorkbenchImportOptions } from "@/lib/workbench-import";
import { so101BomSource } from "@/lib/bom-sources";

const MotionBench = lazy(() => import("./So101MotionBench"));
const modelBase = `${import.meta.env.BASE_URL}models/so101/`;
const bomUrl = import.meta.env.BASE_URL + so101BomSource.localPath;

export default function So101Workbench({ workspace, onChange, onImportFile, onImportText }: {
  workspace: TwinWorkspace;
  onChange: (next: TwinWorkspace) => void;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
  onImportText: (text: string, name: string, options?: WorkbenchImportOptions) => void;
}) {
  const assembly = workspace.so101;
  const fileInput = useRef<HTMLInputElement>(null);

  const controls = <div className="flex flex-wrap gap-2">
    <Button size="sm" variant={assembly ? "outline" : "default"} onClick={() => onImportText(so101BomSource.rawUrl, "README.md", { source: so101BomSource.rawUrl })}>
      <Download />导入官方采购表
    </Button>
    <Button size="sm" variant="outline" onClick={() => onImportText(new URL(bomUrl, document.baseURI).href, "follower-bom.md", { source: `本站核对表 · ${so101BomSource.documentUrl}` })}>
      <Layers3 />使用本地核对表
    </Button>
    <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}><FileUp />导入 BOM 文件</Button>
    <input ref={fileInput} type="file" className="hidden" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="导入 SO-101 BOM 文件" onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) onImportFile(file, "bom");
    }} />
  </div>;

  return <div className="space-y-4">
    <section className={`surface p-4 sm:p-5 ${assembly ? "" : "grid items-center gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"}`} aria-label="SO-101 从臂装配">
      <div className="min-w-0">
        <div className={assembly ? "flex flex-wrap items-start justify-between gap-4" : "space-y-4"}>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Bot className="size-5 text-primary" />SO-101 从臂</h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{assembly
              ? "已绑定 Follower 新标定模型。关节指令使用角度，末端位置取夹爪工具坐标系的原点。"
              : "载入单从臂采购清单，或导入上游项目的 README.md。系统按清单匹配舵机，从官方模型读取连杆、转轴和惯量。"}</p>
          </div>
          {controls}
        </div>
        {assembly && <details className="mt-3 border-t pt-3 text-sm">
          <summary className="cursor-pointer font-medium">查看装配清单 · {assembly.bom.length} 项物料 / 6 个驱动关节</summary>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <table className="w-full border-collapse text-left text-xs">
              <caption className="mb-2 text-left text-xs font-semibold text-muted-foreground">采购物料</caption>
              <thead><tr className="border-b"><th className="pb-2">物料</th><th className="whitespace-nowrap pb-2 text-right">清单数量</th></tr></thead>
              <tbody>{assembly.bom.map((row) => <tr key={row.part} className="border-b border-border/50"><td className="py-1.5 pr-2">{row.part}{isSo101ServoPart(row.part) && <span className="ml-1.5 text-primary">执行器</span>}</td><td className="mono text-right">{row.quantity}</td></tr>)}</tbody>
            </table>
            <div><div className="mb-2 text-xs font-semibold text-muted-foreground">舵机到模型关节的对应关系</div>
              <ul className="divide-y text-xs">{SO101_JOINTS.map((joint) => <li key={joint.id} className="flex flex-wrap items-center justify-between gap-1 py-1.5"><span>{joint.label} · STS3215</span><code className="mono text-muted-foreground">{joint.id}</code></li>)}</ul>
            </div>
          </div>
          {so101BomNotes(assembly.bom).map((note) => <p key={note} className="mt-2 text-xs text-muted-foreground">{note}</p>)}
        </details>}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <a href={bomUrl} download="SO-101-Follower-BOM.md" className="inline-flex items-center gap-1 hover:text-primary"><Download className="size-3.5" />下载核对表</a>
          <a href={so101BomSource.documentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">原始采购表<ExternalLink className="size-3.5" /></a>
          <a href={SO101_UPSTREAM} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">模型来源<ExternalLink className="size-3.5" /></a>
        </div>
      </div>
      {!assembly && <img src={`${modelBase}preview.png`} width={1246} height={737} alt="SO-101 从臂在 MuJoCo 中运行时的姿态和夹爪末端轨迹" className="w-full rounded-md border bg-background" />}
    </section>
    {assembly && <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开机械臂仿真…</p>}>
      <MotionBench waypoints={assembly.waypoints} onChange={(next) => onChange({ ...workspace, so101: { ...assembly, waypoints: parseSo101Motion(next) } })} />
    </Suspense>}
  </div>;
}
