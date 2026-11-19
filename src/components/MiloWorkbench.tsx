import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Box, Check, Download, ExternalLink, FileUp, Layers3, Loader2, Play } from "lucide-react";
import { assembleMiloAxis, getMiloAxisRequirements, miloAxisIds, type MiloAxisId, type MiloBom } from "@contracts/milo-bom";
import { MILO_MACHINE, MILO_MAX_PROGRAM_CHARS, MiloProgramError, miloDemoGcode, planMiloProgram, type MiloMotionPlan } from "@contracts/milo-motion";
import { initialMiloWorkspace, type MiloWorkspaceState } from "@contracts/milo-workspace";
import { applyMiloBomImport } from "@contracts/import-apply";
import { decodeImportUtf8, parseImportText } from "@contracts/workbench-import";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import type { WorkbenchImportOptions } from "@/lib/workbench-import";
import { miloBomSource } from "@/lib/bom-sources";
import { useCancelOnNewImport } from "@/hooks/useWorkbenchImport";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const MotionBench = lazy(() => import("./MiloMotionBench"));
const { revision, rawUrl: officialRaw, docsRoot: officialDocs } = miloBomSource;
const localBase = `${import.meta.env.BASE_URL}machines/milo-v1-5/`;
const factsUrl = import.meta.env.BASE_URL + miloBomSource.localPath;
const pocketUrl = localBase + "circular-pocket.nc";
const localSource = `本地核对表 · 官方版本 ${revision.slice(0, 10)}`;
const manuals = { X: "50_x_axis_assembly.md", Y: "40_y_axis_assembly.md", Z: "60_z_axis_assembly.md" };
const categories: Record<string, string> = {
  "Printed Parts": "打印件", Fasteners: "紧固件", Frame: "机架", Electronics: "电气件", Motion: "运动件", Cabling: "线缆", Misc: "其他物料",
};
type Props = {
  workspace: TwinWorkspace;
  onChange: (workspace: TwinWorkspace) => void;
  onImportFile: (file: File, hint?: WorkbenchImportOptions["hint"]) => void;
};
type Issue = { message: string; line?: number; column?: number };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作失败，请重新尝试。";

async function readTextResource(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取 ${url.split("/").at(-1)} 失败（HTTP ${response.status}）。`);
  return decodeImportUtf8(await response.arrayBuffer());
}

function exampleBom(text: string, name: string): MiloBom {
  const result = parseImportText(text, name, { hint: "bom" });
  if (result.kind !== "milo-bom") throw new Error("未从示例文件识别到 Milo v1.5 采购清单。");
  return result.bom;
}

function exampleProgram(text: string, name: string): string {
  const result = parseImportText(text, name, { hint: "gcode" });
  if (result.kind !== "gcode") throw new Error("未从示例文件识别到 G 代码程序。");
  return result.program;
}

function Inventory({ bom, source }: { bom: MiloBom; source?: string }) {
  const [chosen, setChosen] = useState("");
  const groups = [...new Set<string>(bom.map((row) => row.category))];
  const group = groups.includes(chosen) ? chosen : groups.includes("Motion") ? "Motion" : groups[0];
  const rows = bom.filter((row) => row.category === group);
  return <details className="rounded-md border px-3 py-2.5">
    <summary className="cursor-pointer text-sm font-medium">查看采购清单 · {groups.length} 组 / {bom.length} 行</summary>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <label className="inline-flex items-center gap-2 text-xs">物料分组
        <select aria-label="BOM 分组" className="h-8 max-w-full rounded border bg-background px-2" value={group} onChange={(event) => setChosen(event.target.value)}>
          {groups.map((key) => <option value={key} key={key}>{categories[key] ?? key} · {key}</option>)}
        </select>
      </label>
      <p className="break-all text-xs text-muted-foreground">{source === officialRaw ? `官方采购指南 · ${revision.slice(0, 10)}` : source}</p>
    </div>
    <div className="mt-2 max-h-72 overflow-auto rounded-md border thin-scrollbar">
      <table className="w-full table-fixed border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-muted"><tr><th className="w-[52%] p-2">物料名称</th><th className="p-2">规格 / 标准</th><th className="w-[23%] p-2 text-right">原始数量</th></tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i} className="border-t">
          <td className="break-words p-2">{row.name}</td><td className="break-words p-2 text-muted-foreground">{row.standard || "—"}</td><td className="mono break-words p-2 text-right">{row.quantity}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </details>;
}

function AxisCard({ axis, state, onAssemble, onRemove }: { axis: MiloAxisId; state: MiloWorkspaceState; onAssemble: () => void; onRemove: () => void }) {
  const installed = state.assembled.includes(axis);
  const parts = state.bom ? getMiloAxisRequirements(state.bom, axis, state.assembled) : [];
  const missing = parts.filter((part) => part.shortfall > 0);
  return <article aria-label={`${axis} 轴关键件`} className="surface-inset min-w-0 space-y-3 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">{axis} 轴</h4>
      <span className={`text-xs ${installed ? "text-primary" : missing.length ? "text-amber-300" : "text-muted-foreground"}`}>
        {installed ? "已装配" : !state.bom ? "等待清单" : missing.length ? `缺 ${missing.length} 项` : "关键件齐备"}
      </span>
    </div>
    {!!missing.length && <ul className="space-y-1 text-xs leading-5 text-amber-300">{missing.map((item) => <li key={item.name}>{item.label}还差 {item.shortfall} 件</li>)}</ul>}
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant={installed ? "secondary" : "outline"} disabled={installed || !state.bom || missing.length > 0} onClick={onAssemble}>
        {installed ? <Check /> : <Layers3 />}{installed ? `${axis} 轴已装配` : `装配 ${axis} 轴`}
      </Button>
      {installed && <Button size="sm" variant="ghost" onClick={onRemove}>卸下 {axis} 轴</Button>}
    </div>
    {state.bom && <details className="border-t pt-2">
      <summary className="cursor-pointer text-xs font-medium">关键件明细（{parts.length}）</summary>
      <p className="my-2 text-[11px] leading-5 text-muted-foreground">已占为其他轴用量，新增为装配本轴还需占用的数量。X、Y 共用一块滑台板。</p>
      <table className="w-full table-fixed border-collapse text-left text-[11px]">
        <thead><tr className="border-b"><th className="w-[53%] pb-1">关键件</th>{["总量", "已占", "可用", "新增"].map((label) => <th key={label} className="pb-1 text-right">{label}</th>)}</tr></thead>
        <tbody>{parts.map((part) => <tr className="border-b border-border/50" key={part.name}>
          <td className="py-1.5 pr-1" title={part.name}>{part.label}</td>
          {[part.stock, part.reserved, part.available, part.required].map((value, i) => <td className="mono text-right" key={i}>{value}</td>)}
        </tr>)}</tbody>
      </table>
      <a href={`${officialDocs}/manual/chapters/${manuals[axis]}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
        {axis} 轴官方装配图<ExternalLink className="size-3" />
      </a>
    </details>}
  </article>;
}

export default function MiloWorkbench({ workspace, onChange, onImportFile }: Props) {
  const state = workspace.milo ?? initialMiloWorkspace;
  const latest = useRef({ workspace, state, onChange });
  useLayoutEffect(() => { latest.current = { workspace, state, onChange }; }, [workspace, state, onChange]);
  const bomFile = useRef<HTMLInputElement>(null), programFile = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const bomRequest = useRef<AbortController | null>(null), programRequest = useRef<AbortController | null>(null);
  const [reading, setReading] = useState<"official" | "local" | null>(null);
  const [bomError, setBomError] = useState(""), [notice, setNotice] = useState("");
  const [programIssue, setProgramIssue] = useState<Issue | null>(null);
  const [readingProgram, setReadingProgram] = useState(false);
  const [programNotice, setProgramNotice] = useState("");
  const [run, setRun] = useState<{ source: string; plan: MiloMotionPlan; id: number } | null>(null);
  const playback = useRef<HTMLDivElement>(null);
  const runId = useRef(0);
  const pendingAxes = miloAxisIds.filter((axis) => !state.assembled.includes(axis));
  const ready = !!state.bom && !pendingAxes.length;
  const hasDraft = !!state.program.trim() && state.program !== miloDemoGcode;
  const currentRun = ready && run?.source === state.program ? run : null;
  const cancelPending = useCallback(() => {
    const bom = bomRequest.current, program = programRequest.current;
    if (!bom && !program) return;
    bomRequest.current = null; programRequest.current = null;
    bom?.abort(); program?.abort();
    setReading(null); setReadingProgram(false);
  }, []);
  useCancelOnNewImport(cancelPending);
  useLayoutEffect(() => () => { bomRequest.current?.abort(); programRequest.current?.abort(); }, []);
  useLayoutEffect(() => {
    if (window.location.hash === "#milo-pocket") document.getElementById("milo-pocket")?.scrollIntoView();
  }, []);
  useLayoutEffect(() => { if (run) playback.current?.scrollIntoView({ block: "start" }); }, [run]);

  async function importBom(from: "official" | "local") {
    programRequest.current?.abort(); setReadingProgram(false);
    bomRequest.current?.abort();
    const controller = new AbortController();
    bomRequest.current = controller;
    setReading(from); setBomError(""); setNotice("");
    let timedOut = false, fetchingOfficial = from === "official";
    const timer = from === "official" ? window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000) : undefined;
    try {
      const text = await readTextResource(from === "official" ? officialRaw : factsUrl, controller.signal);
      const source = from === "official" ? officialRaw : localSource;
      if (bomRequest.current !== controller) return;
      if (timedOut) throw new Error("连接超时。");
      if (controller.signal.aborted) return;
      fetchingOfficial = false;
      const current = latest.current;
      const next = applyMiloBomImport(current.workspace, exampleBom(text, from === "official" ? "sourcing_guide.md" : "bom-facts.md"), source);
      current.onChange(next);
      const lost = current.state.assembled.filter((axis) => !next.milo.assembled.includes(axis));
      setNotice(`已读入 ${next.milo.bom?.length} 行物料。${lost.length ? `${lost.join("、")} 轴缺少关键件，需重新装配。` : next.milo.assembled.length ? `已保留 ${next.milo.assembled.join("、")} 轴的装配。` : ""}`);
      if (lost.length) { programRequest.current?.abort(); setReadingProgram(false); setRun(null); }
    } catch (cause) {
      if (bomRequest.current === controller && (!controller.signal.aborted || timedOut)) {
        setBomError(fetchingOfficial ? `官方 BOM 读取失败。${timedOut ? "连接超时。" : message(cause)} 可重试、上传官方原件，或载入本地核对表。` : message(cause));
      }
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (bomRequest.current === controller) { bomRequest.current = null; setReading(null); }
    }
  }

  function assemble(axis: MiloAxisId) {
    const { workspace: ws, state: current, onChange: save } = latest.current;
    if (!current.bom) return;
    try {
      save({ ...ws, milo: { ...current, assembled: assembleMiloAxis(current.bom, current.assembled, axis) } });
      setBomError(""); setNotice(`已装配 ${axis} 轴。`);
    } catch (cause) { setBomError(message(cause)); }
  }

  function removeAxis(axis: MiloAxisId) {
    const { workspace: ws, state: current, onChange: save } = latest.current;
    try {
      save({ ...ws, milo: { ...current, assembled: current.assembled.filter((item) => item !== axis) } });
      programRequest.current?.abort(); setReadingProgram(false); setRun(null);
      setProgramIssue(null); setProgramNotice(""); setBomError(""); setNotice(`已卸下 ${axis} 轴，已按剩余装配重新核算可用数量。`);
    } catch (cause) { setBomError(message(cause)); }
  }

  function changeProgram(value: string, feedback = "") {
    programRequest.current?.abort();
    setReadingProgram(false);
    const { workspace: ws, state: current, onChange: save } = latest.current;
    try {
      if (!current.bom || !miloAxisIds.every((axis) => current.assembled.includes(axis))) throw new Error("请先完成三轴装配。");
      if (value.length > MILO_MAX_PROGRAM_CHARS) throw new Error(`程序超过 ${MILO_MAX_PROGRAM_CHARS} 字符，请缩短后再载入。`);
      save({ ...ws, milo: { ...current, program: value } }); setProgramIssue(null); setProgramNotice(feedback);
    } catch (cause) { setProgramIssue({ message: message(cause) }); setProgramNotice(""); }
  }

  function previewFile(file: File, hint?: WorkbenchImportOptions["hint"]) {
    cancelPending();
    setBomError(""); setProgramIssue(null); setNotice(""); setProgramNotice("");
    onImportFile(file, hint);
  }

  async function loadPocket() {
    programRequest.current?.abort();
    const controller = new AbortController();
    programRequest.current = controller;
    setReadingProgram(true); setProgramIssue(null); setProgramNotice("");
    try {
      const previous = latest.current.state;
      const [programText, facts] = await Promise.all([
        readTextResource(pocketUrl, controller.signal),
        previous.bom ? "" : readTextResource(factsUrl, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (previous !== latest.current.state) throw new Error("工程已更新，请重新打开圆槽示例。");
      const program = exampleProgram(programText, "circular-pocket.nc");
      const bom = previous.bom ?? exampleBom(facts, "bom-facts.md");
      const base = previous.bom ? previous : applyMiloBomImport(latest.current.workspace, bom, localSource).milo;
      const assembled = miloAxisIds.reduce((axes, axis) => assembleMiloAxis(bom, axes, axis), base.assembled);
      const plan = planMiloProgram(program);
      if (previous.program.trim() && previous.program !== miloDemoGcode && previous.program.trim() !== program.trim()
        && !window.confirm("用圆形凹槽示例替换当前 G 代码？如需保留，请先取消并导出工程。")) return;
      latest.current.onChange({ ...latest.current.workspace, milo: { ...base, assembled, program } });
      setRun({ source: program, plan, id: ++runId.current }); setBomError("");
      setProgramNotice("已载入 circular-pocket.nc。可修改程序后再次运行。");
    } catch (cause) {
      if (!controller.signal.aborted) { setProgramIssue({ message: message(cause) }); setProgramNotice(""); }
    } finally { if (programRequest.current === controller) { programRequest.current = null; setReadingProgram(false); } }
  }

  function execute() {
    programRequest.current?.abort();
    if (!ready) return;
    try {
      const plan = planMiloProgram(state.program);
      setRun({ source: state.program, plan, id: ++runId.current }); setProgramIssue(null); setProgramNotice("");
    } catch (cause) {
      setRun(null); setProgramNotice("");
      setProgramIssue(cause instanceof MiloProgramError ? { message: cause.message, line: cause.line, column: cause.column } : { message: message(cause) });
    }
  }

  function locateIssue() {
    const input = editor.current;
    if (!input || !programIssue?.line) return;
    const lines = input.value.split("\n"), i = programIssue.line - 1, column = Math.max(0, (programIssue.column ?? 1) - 1);
    const lineStart = lines.slice(0, i).reduce((offset, line) => offset + line.length + 1, 0);
    const offset = lineStart + Math.min(column, lines[i]?.length ?? 0);
    input.focus(); input.setSelectionRange(offset, Math.min(offset + 1, input.value.length));
  }

  return <section className="min-w-0 space-y-4" aria-label="Milo v1.5 三轴铣床">
    <section className="surface min-w-0 space-y-3 p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Box className="size-5 text-primary" />Milo v1.5 三轴铣床</h2>
      <p className="text-sm leading-6 text-muted-foreground">导入 Millennium Machines 采购清单，核对三轴运动与驱动关键件，再用 G 代码仿真工作台与主轴座的联动。</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={reading === "official"} onClick={() => void importBom("official")}>{reading === "official" ? <Loader2 className="animate-spin" /> : <Download />}载入官方 BOM</Button>
        <Button variant="outline" disabled={reading === "local"} onClick={() => void importBom("local")}>{reading === "local" ? <Loader2 className="animate-spin" /> : <Layers3 />}载入本地核对表</Button>
        <Button variant="outline" onClick={() => bomFile.current?.click()}><FileUp />上传采购指南</Button>
        <input ref={bomFile} aria-label="上传 Milo BOM 文件" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={(event) => {
          const selected = event.target.files?.[0]; event.target.value = ""; if (selected) previewFile(selected, "bom");
        }} />
      </div>
      {reading && <p role="status" className="text-xs text-muted-foreground">{reading === "official" ? "正在从 GitHub 读取固定版本的 sourcing_guide.md…" : "正在读取采购清单…"}</p>}
      {bomError && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{bomError}</p>}
      {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
      {state.bom && <Inventory bom={state.bom} source={state.bomSource} />}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <a href={miloBomSource.documentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">官方采购指南<ExternalLink className="size-3" /></a>
        <a href={factsUrl} download="milo-v1.5-bom.md" className="hover:text-primary">下载核对表</a>
        <a href={localBase + "SOURCE.md"} target="_blank" rel="noreferrer" className="hover:text-primary">数据来源与工作包络</a>
      </div>
    </section>

    <section className="surface min-w-0 p-4 sm:p-5" aria-label="逐轴装配">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1"><h3 className="text-base font-semibold">逐轴装配</h3><span className="mono text-xs text-muted-foreground">已装配 {state.assembled.length} / 3 轴</span></div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">{miloAxisIds.map((axis) => <AxisCard key={axis} axis={axis} state={state} onAssemble={() => assemble(axis)} onRemove={() => removeAxis(axis)} />)}</div>
    </section>

    <section id="milo-pocket" className="surface min-w-0 space-y-3 p-4 sm:p-5" aria-label="G 代码控制">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">G 代码程序</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => programFile.current?.click()}><FileUp />载入程序文件</Button>
          <a className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline" href={pocketUrl} download="circular-pocket.nc"><Download className="size-3.5" />下载圆槽 G 代码</a>
        </div>
      </div>
      <input ref={programFile} aria-label="载入 G 代码文件" type="file" accept=".gcode,.nc,.ngc,.cnc,.tap,.txt,text/plain" className="hidden" onChange={(event) => {
        const selected = event.target.files?.[0]; event.target.value = "";
        if (selected) previewFile(selected, /\.txt$/i.test(selected.name) ? "gcode" : undefined);
      }} />
      <div className="surface-inset flex flex-wrap items-center justify-between gap-3 p-3">
        <div><h4 className="text-sm font-medium">圆形平底凹槽</h4><p className="mt-1 text-xs text-muted-foreground">Ø6 mm 平底刀分三层铣出直径 30 mm、深 3 mm 的凹槽。回放时可旋转视角，检查槽底或查看整机。</p></div>
        <Button variant="outline" disabled={!!reading || readingProgram} onClick={() => void loadPocket()}><Play />{ready ? "回放圆形凹槽" : "组装并回放圆形凹槽"}</Button>
      </div>
      {!ready ? <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{hasDraft ? "程序已保存，" : "可先"}{state.bom ? "" : "载入 BOM 并"}完成 {pendingAxes.join("、")} 轴装配{hasDraft ? "后运行。" : "，再编辑自己的程序。"}</p>
        {hasDraft && <details><summary className="cursor-pointer text-xs font-medium">查看已保存的程序</summary>
          <pre className="mono mt-2 max-h-48 overflow-auto rounded-md border p-3 text-xs">{state.program}</pre></details>}
      </div> : <>
        <p className="text-xs leading-5 text-muted-foreground">程序从工件坐标 {miloAxisIds.map((axis, i) => axis + MILO_MACHINE.initialWorkMm[i]).join(" ")} 起步。G17 选 XY 平面，G2 顺时针、G3 逆时针。I、J 为相对圆弧起点的圆心偏移，进给 F 以 mm/min 计。</p>
        <p className="text-xs leading-5 text-muted-foreground">曲线为理想开环步进规划值，按参考固件的轴限速与加速度计算，每个运动段起止时停稳。</p>
        <details className="text-xs leading-5 text-muted-foreground">
          <summary className="cursor-pointer text-foreground">工件零点与行程</summary>
          <p className="mt-1.5">示例装夹的工件零点位于机床坐标 {miloAxisIds.map((axis, i) => axis + MILO_MACHINE.workOriginMachineMm[i]).join(" ")} mm。</p>
          <p>仿真假定平底刀已旋转，G0 只做定位，G1、G2、G3 进给时按刀刃扫过的体积去料。</p>
          <p>M208 机床坐标范围为 {miloAxisIds.map((axis, i) => `${axis} [${MILO_MACHINE.minMm[i]}, ${MILO_MACHINE.maxMm[i]}]`).join("，")} mm。</p>
          <p>换算后的工件可编程范围为 {miloAxisIds.map((axis, i) => `${axis} [${MILO_MACHINE.minMm[i] - MILO_MACHINE.workOriginMachineMm[i]}, ${MILO_MACHINE.maxMm[i] - MILO_MACHINE.workOriginMachineMm[i]}]`).join("，")} mm。</p>
        </details>
        <Textarea aria-label="G 代码程序" ref={editor} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" value={state.program} placeholder="输入 G 代码，或载入示例程序"
          className="mono h-48 w-full resize-y text-sm leading-6" onChange={(event) => changeProgram(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={readingProgram || !state.program.trim()} onClick={execute}><Play />运行 G 代码</Button>
          <Button variant="ghost" onClick={() => changeProgram(exampleProgram(miloDemoGcode, "linear-example.nc"), "已载入三轴直线示例。")}>载入直线示例</Button>
        </div>
        {run && !currentRun && <p role="status" className="text-xs text-amber-300">程序已修改，请重新运行以查看当前文本的轨迹。</p>}
      </>}
      {programIssue && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span className="whitespace-pre-line break-words">{programIssue.message}</span>
        {ready && programIssue.line && <Button size="sm" variant="outline" onClick={locateIssue}>定位到第 {programIssue.line} 行</Button>}
      </div>}
      {readingProgram && <p role="status" className="text-xs text-muted-foreground">正在读取程序文件…</p>}
      {programNotice && <p role="status" className="text-xs text-primary">{programNotice}</p>}
    </section>
    {currentRun && <div ref={playback} className="scroll-mt-3"><Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开三轴轨迹…</p>}>
      <MotionBench key={currentRun.id} plan={currentRun.plan} />
    </Suspense></div>}
  </section>;
}
