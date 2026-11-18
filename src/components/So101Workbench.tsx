import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bot, Check, Download, ExternalLink, FileUp, Layers3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_SO101_MOTION, SO101_JOINTS, SO101_MODEL_ID, SO101_REVISION, SO101_UPSTREAM, parseSo101Motion } from "@contracts/so101";
import { isSo101ServoPart, parseSo101Bom, so101BomNotes } from "@contracts/so101-bom";
import type { TwinWorkspace } from "@contracts/twin-simulation";

const MotionBench = lazy(() => import("./So101MotionBench"));
const bomUrl = "/models/so101/follower-bom.md";
const upstreamBom = `https://github.com/TheRobotStudio/SO-ARM100/blob/${SO101_REVISION}/README.md#parts-for-one-follower-arm`;

export default function So101Workbench({ workspace, onChange }: { workspace: TwinWorkspace; onChange: (next: TwinWorkspace) => void }) {
  const assembly = workspace.so101;
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function importBom(file?: File) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setNotice("");
    setError("");
    try {
      let content: string;
      if (file) {
        if (file.size > 2 * 1024 * 1024) throw new Error("请选择 2 MiB 以内的 SO-101 官方 Markdown 清单。");
        content = await file.text();
      } else {
        const response = await fetch(bomUrl, { signal: controller.signal });
        if (!response.ok) throw new Error("本地示例清单读取失败，请重试或导入官方 README。");
        content = await response.text();
      }
      if (controller.signal.aborted) return;
      const bom = parseSo101Bom(content);
      const waypoints = assembly?.waypoints ?? parseSo101Motion(DEFAULT_SO101_MOTION);
      onChange({ ...workspace, so101: { modelId: SO101_MODEL_ID, bom, waypoints } });
      setNotice("已按清单绑定 6 个舵机和官方从臂模型。");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "清单导入失败。");
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }

  const controls = <div className="flex flex-wrap gap-2">
    <Button size="sm" variant={assembly ? "outline" : "default"} disabled={reading} onClick={() => void importBom()}>
      {reading ? <Loader2 className="animate-spin" /> : <Layers3 />}{assembly ? "重新核对官方 BOM" : "载入官方 BOM 示例"}
    </Button>
    <Button size="sm" variant="outline" disabled={reading} onClick={() => fileInput.current?.click()}><FileUp />导入 BOM 文件</Button>
    <input ref={fileInput} type="file" className="hidden" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="导入 SO-101 BOM 文件" onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void importBom(file);
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
        {error && <p role="alert" className="mt-3 rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs text-primary"><Check className="size-4" />{notice}</p>}
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
          <a href={bomUrl} download="SO-101-Follower-BOM.md" className="inline-flex items-center gap-1 hover:text-primary"><Download className="size-3.5" />下载示例 BOM</a>
          <a href={upstreamBom} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">原始采购表<ExternalLink className="size-3.5" /></a>
          <a href={SO101_UPSTREAM} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">模型来源<ExternalLink className="size-3.5" /></a>
        </div>
      </div>
      {!assembly && <img src="/models/so101/preview.png" width={1246} height={737} alt="SO-101 从臂在 MuJoCo 中运行时的姿态和夹爪末端轨迹" className="w-full rounded-md border bg-background" />}
    </section>
    {assembly && <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开机械臂仿真…</p>}>
      <MotionBench waypoints={assembly.waypoints} onChange={(next) => onChange({ ...workspace, so101: { ...assembly, waypoints: parseSo101Motion(next) } })} />
    </Suspense>}
  </div>;
}
