import { useLayoutEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Play, Plus, Save, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import type { MaterialRow } from "@contracts/import-catalog";
import { LINEAR_ASSEMBLY_LIMITS, MODELICA_FEED_REF, parseLinearAssembly, inspectLinearAssembly, runLinearAssembly, type LinearAssembly, type LinearAssemblyResult } from "@contracts/linear-assembly";
import { packageKey, type ModelReference } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import feedLibrary from "../../public/modelica/linear-library.json";
import { downloadJson } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LinearAssemblyResults from "./LinearAssemblyResults";

type Props = {
  workspace: TwinWorkspace; assembly?: LinearAssembly; trial?: boolean; initialPackageKey?: string;
  onSave: (value: LinearAssembly) => void; onTrialReady?: (ready: boolean) => void;
};
type Role = "drive" | "motor" | "screw" | "table";
type Vector = [number, number, number];
type TextVector = [string, string, string];
type ModuleDraft = { key: string; id: string; drive: string; motor: string; screw: string; table: string; lead: string; load: string };
type AxisDraft = { key: string; id: string; moduleKey: string; direction: TextVector; custom: boolean; target: string };
type Draft = { id: string; name: string; modelRef?: ModelReference; modules: ModuleDraft[]; axes: AxisDraft[] };
type RunSpec = { assembly: LinearAssembly; signature: string; basis: string };
type Run = RunSpec & { result: LinearAssemblyResult };
type Request = RunSpec & { workspace: TwinWorkspace; save?: Props["onSave"] };
const presets: { label: string; vector: Vector }[] = [
  { label: "+X", vector: [1, 0, 0] }, { label: "-X", vector: [-1, 0, 0] },
  { label: "+Y", vector: [0, 1, 0] }, { label: "-Y", vector: [0, -1, 0] },
  { label: "+Z", vector: [0, 0, 1] }, { label: "-Z", vector: [0, 0, -1] },
];
const roles: Record<Role, string> = { drive: "驱动器物料", motor: "电机物料", screw: "丝杠物料", table: "工作台物料" };
const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "装配操作失败，请重试。";
const asText = (v: Vector): TextVector => [String(v[0]), String(v[1]), String(v[2])];
const presetOf = (v: TextVector) => presets.find(p => p.vector.every((n, i) => v[i] !== "" && n === Number(v[i])));

function defaultModule(id: string): ModuleDraft {
  return { key: nanoid(), id, drive: "", motor: "", screw: "", table: "", lead: "", load: "1" };
}
function defaultAxis(id: string, moduleKey: string): AxisDraft {
  const preset = presets.find(p => p.label === "+" + id) ?? presets[0];
  return { key: nanoid(), id, moduleKey, direction: asText(preset.vector), custom: false, target: "0" };
}
function draftFrom(assembly?: LinearAssembly): Draft {
  if (!assembly) {
    const module = defaultModule("module1");
    return { id: "linear-" + nanoid(), name: "新直线装配", modelRef: MODELICA_FEED_REF, modules: [module], axes: [defaultAxis("X", module.key)] };
  }
  const modules = assembly.modules.map(m => ({ key: nanoid(), id: m.id, drive: m.drive, motor: m.motor, screw: m.screw, table: m.table ?? "",
    lead: m.leadMmPerRev === null ? "" : String(m.leadMmPerRev), load: String(m.loadInertiaRatio ?? 1) }));
  const axes = assembly.axes.map(axis => {
    const direction = asText(axis.direction);
    return { key: nanoid(), id: axis.id, moduleKey: modules.find(m => m.id === axis.module)?.key ?? axis.module,
      direction, custom: !presetOf(direction), target: String(axis.targetMm) };
  });
  return { id: assembly.id, name: assembly.name, modelRef: assembly.modelRef, modules, axes };
}
function numberField(text: string, caption: string) {
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error(`请填写${caption}的有限数值。`);
  return Number(text);
}
function definitionOf(d: Draft): LinearAssembly {
  return parseLinearAssembly({
    schemaVersion: 1, kind: "linear-axis-assembly", id: d.id, name: d.name, ...(d.modelRef && { modelRef: d.modelRef }),
    modules: d.modules.map(m => ({
      id: m.id, drive: m.drive, motor: m.motor, screw: m.screw,
      leadMmPerRev: m.lead.trim() ? numberField(m.lead, "丝杠导程") : null,
      ...(d.modelRef ? { table: m.table } : { loadInertiaRatio: numberField(m.load, "负载惯量比") }),
    })),
    axes: d.axes.map(a => ({ id: a.id, module: d.modules.find(m => m.key === a.moduleKey)?.id ?? a.moduleKey,
      direction: a.direction.map(v => numberField(v, "方向分量")), targetMm: numberField(a.target, "目标位移") })),
  });
}
function signature(a?: LinearAssembly) {
  return a ? JSON.stringify([a.id, a.name, a.modelRef?.id, a.modelRef?.version, a.modules.map(m => [m.id, m.drive, m.motor, m.screw, m.table, m.leadMmPerRev, a.modelRef ? null : m.loadInertiaRatio]),
    a.axes.map(axis => [axis.id, axis.module, axis.direction, axis.targetMm])]) : null;
}
function runBasis(ws: TwinWorkspace, assembly: LinearAssembly) {
  const used = new Set(assembly.axes.map(a => a.module));
  const refs = new Set(assembly.modules.filter(m => used.has(m.id)).flatMap(m => [m.drive, m.motor, m.screw, m.table]));
  const rows = ws.catalog?.materials.filter(r => refs.has(r.id) || refs.has(r.name)) ?? [];
  const keys = new Set(rows.map(r => r.binding?.key)), models = new Set(rows.map(r => r.model));
  const devices = ws.packages.filter(p => keys.has(packageKey(p)) || models.has(p.model));
  return JSON.stringify([rows.map(r => [r.id, r.name, r.quantity, r.unit, r.model, r.manufacturer, r.source, r.leadMmPerRev, r.massKg, r.binding?.kind, r.binding?.key]),
    devices.map(p => [packageKey(p), p.servo, p.feed]), ws.catalog?.models.filter(m => keys.has(m.id)).map(m => m.id)]);
}
function nextId(prefix: string, ids: string[]) {
  let i = 1;
  while (ids.includes(prefix + i)) i++;
  return prefix + i;
}
function materialIndex(rows: MaterialRow[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const byName = new Map<string, MaterialRow[]>();
  rows.forEach(row => { const group = byName.get(row.name); if (group) group.push(row); else byName.set(row.name, [row]); });
  const resolve = (ref: string) => byId.get(ref) ?? (byName.get(ref)?.length === 1 ? byName.get(ref)?.[0] : undefined);
  const options = rows.map(row => {
    const duplicate = byName.get(row.name)!.length > 1;
    const label = [row.name, row.manufacturer, row.model, `${row.quantity}${row.unit ? " " + row.unit : ""}`,
      ...(duplicate ? [row.source, row.id] : [])].filter(Boolean).join(" · ");
    return { value: row.id, ref: duplicate || (byId.has(row.name) && row.name !== row.id) ? row.id : row.name, label };
  });
  return { resolve, byName, options, refs: new Map(options.map(o => [o.value, o.ref])) };
}

function fresh(assembly: LinearAssembly | undefined, workspace: TwinWorkspace, trial: boolean, initialPackageKey?: string) {
  const draft = draftFrom(assembly);
  let notice = "";
  if (!assembly && initialPackageKey) {
    const device = workspace.packages.find(p => packageKey(p) === initialPackageKey);
    const rows = workspace.catalog?.materials.filter(r => r.binding?.kind === "device" && r.binding.key === initialPackageKey) ?? [];
    if (device?.feed && rows.length === 1) draft.modules[0][device.feed.kind === "lead-screw" ? "screw" : "table"] = rows[0].id;
    else if (device?.feed) notice = rows.length ? `多条 BOM 物料绑定了 ${device.model}，请选择本次使用的物料。` : `请先在 BOM 中为 ${device.model} 绑定一条物料。`;
  }
  const request: Request | null = assembly && trial && !inspectLinearAssembly(workspace, assembly).length
    ? { assembly, signature: signature(assembly)!, basis: runBasis(workspace, assembly), workspace } : null;
  return { draft, seen: signature(assembly), submitted: null as string | null,
    request, run: null as Run | null, error: "", notice, initialPackageKey };
}

export default function LinearAssemblyBench({ workspace, assembly, trial = false, initialPackageKey, onSave, onTrialReady }: Props) {
  const [session, setSession] = useState(() => fresh(assembly, workspace, trial, initialPackageKey));
  const incoming = signature(assembly);
  if (session.seen !== incoming || session.initialPackageKey !== initialPackageKey) {
    // A parent save can return a newly parsed copy of our own submission.
    if (assembly?.id === session.draft.id && incoming === session.submitted) setSession({ ...session, seen: incoming, submitted: null, initialPackageKey });
    else setSession(fresh(assembly, workspace, trial, initialPackageKey));
  }
  const draft = session.draft;
  const ref = draft.modelRef;
  const solver = !ref ? "legacy" : ref.id === MODELICA_FEED_REF.id && ref.version === MODELICA_FEED_REF.version ? "modelica" : "missing";
  const materials = workspace.catalog?.materials;
  const index = useMemo(() => materialIndex(materials ?? []), [materials]);
  const packages = useMemo(() => new Map(workspace.packages.map(p => [packageKey(p), p])), [workspace.packages]);
  const bound = (row?: MaterialRow) => row?.binding?.kind === "device" ? packages.get(row.binding.key) : undefined;
  const checked = useMemo(() => {
    try {
      const value = definitionOf(draft);
      return { value, signature: signature(value), basis: runBasis(workspace, value), issues: inspectLinearAssembly(workspace, value) };
    } catch (cause) { return { value: null, signature: null, basis: "", issues: [errorText(cause)] }; }
  }, [draft, workspace]);
  const priorRun = session.run;
  const visibleRun = priorRun && !checked.issues.length && priorRun.signature === checked.signature && priorRun.basis === checked.basis ? priorRun : null;
  const job = session.request?.workspace === workspace && session.request.signature === checked.signature ? session.request : null;
  const trialReady = trial && !!checked.value && checked.signature === incoming && !checked.issues.length && !job && !session.error;
  useLayoutEffect(() => { onTrialReady?.(trialReady); }, [trialReady, onTrialReady]);
  if (session.seen === incoming && session.request && !job) {
    setSession({ ...session, request: null, run: null, notice: "工程或物料已更改，请重新运行。" });
  }
  useLayoutEffect(() => {
    if (!job) return;
    const controller = new AbortController();
    const { signal } = controller;
    async function solve(request: Request) {
      signal.throwIfAborted();
      const result = request.assembly.modelRef
        ? await (await import("@/lib/modelica-feed-runtime")).runModelicaLinearAssembly(request.workspace, request.assembly, signal)
        : runLinearAssembly(request.workspace, request.assembly);
      if (signal.aborted) return;
      if (request.save) request.save(request.assembly);
      setSession(s => ({ ...s, request: null, submitted: request.save ? request.signature : null,
        run: { assembly: request.assembly, signature: request.signature, basis: request.basis, result }, error: "",
        notice: request.save && !trial ? "装配已保存，仿真已完成。" : "仿真已完成。" }));
    }
    Promise.resolve().then(() => solve(job)).catch(cause => {
      if (!signal.aborted) setSession(s => ({ ...s, request: null, run: null, error: errorText(cause), notice: "" }));
    });
    return () => controller.abort();
  }, [job, trial]);

  function edit(next: Draft) {
    setSession(s => ({ ...s, draft: next, request: null, run: null, error: "", notice: "" }));
  }
  function moduleChange(key: string, patch: Partial<ModuleDraft>) {
    edit({ ...draft, modules: draft.modules.map(m => m.key === key ? { ...m, ...patch } : m) });
  }
  function axisChange(key: string, patch: Partial<AxisDraft>) {
    edit({ ...draft, axes: draft.axes.map(a => a.key === key ? { ...a, ...patch } : a) });
  }
  function submit(run: boolean) {
    try {
      if (!checked.value || !checked.signature) throw new Error(checked.issues[0] ?? "请核对装配定义。");
      const value = checked.value;
      if (solver === "missing") throw new Error("请先选择已安装的求解模型。");
      if (run) {
        if (checked.issues.length) throw new Error(checked.issues.join("\n"));
        const request: Request = { assembly: value, signature: checked.signature, basis: checked.basis, workspace, save: onSave };
        setSession(s => ({ ...s, request, run: null, error: "", notice: "" }));
        return;
      }
      onSave(value);
      setSession(s => ({ ...s, request: null, submitted: checked.signature, error: "", notice: trial ? "已更新试用配置。" : "装配已保存。" }));
    } catch (cause) { setSession(s => ({ ...s, request: null, run: null, error: errorText(cause), notice: "" })); }
  }

  return <section aria-label="直线轴装配工作台" className="min-w-0 space-y-4">
    <div className="surface space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{assembly ? "直线装配设置" : "新建直线装配"}</h3>
        <div className="flex flex-wrap items-center gap-3">
          {assembly && <Button variant="outline" size="sm" onClick={() => downloadJson(assembly, assembly.name + ".assembly.json")}><Download />导出装配关系</Button>}
          <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href="https://github.com/lusipad/omg/blob/main/docs/直线轴装配.md" target="_blank" rel="noreferrer">装配文件格式<ExternalLink className="size-3" /></a>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0"><span className="field-label">系统名称</span>
          <Input value={draft.name} maxLength={160} onChange={e => edit({ ...draft, name: e.target.value })} /></label>
        <label className="min-w-0"><span className="field-label">求解模型</span>
          <select aria-label="求解模型" className={selectClass} value={solver} onChange={e => edit({ ...draft, modelRef: e.target.value === "modelica" ? MODELICA_FEED_REF : undefined })}>
            <option value="modelica">Modelica · {MODELICA_FEED_REF.id} {MODELICA_FEED_REF.version}</option>
            <option value="legacy">离线折算惯量模型（原有算法）</option>
            {solver === "missing" && <option value="missing" disabled>未安装 · {ref?.id} {ref?.version}</option>}
          </select></label>
      </div>
      {solver === "modelica" && <p className="text-xs leading-5 text-muted-foreground">水平刚性进给。模型从静止起步，按丝杠导程与工作台移动质量求解，摩擦和外力取零。</p>}
      {solver === "missing" && <p role="alert" className="break-words text-xs text-amber-300">工程引用的 {ref?.id} {ref?.version} 尚未安装。请选择可用的求解模型。</p>}
      {!materials?.length && <p className="text-sm text-muted-foreground">工程还没有 BOM 物料。可用右上角“导入文件”补充清单和设备包，或先保存装配草稿。</p>}
    </div>
    <section className="surface space-y-3 p-4 sm:p-5" aria-label="轴模块">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">轴模块</h3>
        <Button variant="outline" size="sm" disabled={draft.modules.length >= LINEAR_ASSEMBLY_LIMITS.modules} onClick={() => edit({ ...draft,
          modules: [...draft.modules, defaultModule(nextId("module", draft.modules.map(m => m.id)))] })}><Plus />添加模块</Button></div>
      <p className="text-xs leading-5 text-muted-foreground">一个模块可供多根轴使用。模块和轴标识以英文字母或数字开头，可含连字符或下划线。</p>
      {draft.modules.map(m => {
        const usage = draft.axes.filter(a => a.moduleKey === m.key).length;
        const screw = index.resolve(m.screw);
        const screwFeed = bound(screw)?.feed;
        const lead = screw?.leadMmPerRev ?? (solver === "modelica" && screwFeed?.kind === "lead-screw" ? screwFeed.leadMmPerRev : undefined);
        const leadSource = screw?.leadMmPerRev !== undefined ? "BOM" : "设备包";
        const table = index.resolve(m.table), tableFeed = bound(table)?.feed;
        const mass = table?.massKg ?? (tableFeed?.kind === "moving-table" ? tableFeed.massKg : undefined);
        const parts = (Object.keys(roles) as Role[]).filter(role => solver !== "legacy" || role !== "table").map(role => {
          const ref = m[role], row = index.resolve(ref);
          return { role, ref, row, actual: bound(row) };
        });
        return <article className="surface-inset min-w-0 space-y-3 p-3" key={m.key} aria-label={`轴模块 ${m.id}`}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1"><span className="field-label">模块标识</span><Input value={m.id} maxLength={80} onChange={e => moduleChange(m.key, { id: e.target.value })} /></label>
            <span className="mb-2 text-xs text-muted-foreground">{usage} 根轴引用</span>
            <Button variant="ghost" size="sm" disabled={!!usage || draft.modules.length === 1} title={usage ? "先为引用此模块的轴选择其他模块" : "移除模块"}
              onClick={() => edit({ ...draft, modules: draft.modules.filter(other => other.key !== m.key) })}><Trash2 />移除模块</Button>
          </div>
          <div className={`grid gap-3 ${solver === "legacy" ? "md:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4"}`}>{parts.map(({ role, ref, row, actual }) => {
            const substitute = row && actual && ((row.manufacturer && row.manufacturer !== actual.manufacturer) || (row.model && row.model !== actual.model));
            return <div key={role} className="min-w-0"><label><span className="field-label">{roles[role]}</span>
              <select aria-label={roles[role]} className={selectClass} value={row?.id ?? ref} onChange={e => moduleChange(m.key, { [role]: index.refs.get(e.target.value) ?? "", ...(role === "screw" && { lead: "" }) })}>
                <option value="">请选择工程物料</option>
                {ref && !row && <option value={ref}>{ref}（{index.byName.has(ref) ? "同名物料待选" : "工程中未找到"}）</option>}
                {index.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select></label>
              {actual && <p className={`mt-1 break-words text-xs ${substitute ? "text-amber-300" : "text-muted-foreground"}`}>
                {substitute && <>按已绑定的替代件运行。BOM 标注 {[row.manufacturer, row.model].filter(Boolean).join(" · ")}。</>}
                已绑定 {actual.manufacturer} · {actual.model} · 修订 {actual.revision}。
              </p>}
            </div>;
          })}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0"><label><span className="field-label">丝杠导程（mm/rev）</span>
              <Input type="number" step="any" value={m.lead} placeholder={lead === undefined ? "资料未给出，可补填" : `沿用${leadSource} · ${lead}`}
                onChange={e => moduleChange(m.key, { lead: e.target.value })} /></label>
              {lead !== undefined && <p className="mt-1 text-xs text-muted-foreground">{leadSource} 导程 {lead} mm/rev。
                {m.lead.trim() && <button type="button" className="ml-1 text-primary hover:underline" onClick={() => moduleChange(m.key, { lead: "" })}>沿用{leadSource}值</button>}</p>}
            </div>
            {solver === "legacy" ? <label className="min-w-0"><span className="field-label">负载惯量比（仿真假设）</span><Input aria-label="负载惯量比（仿真假设）" type="number" min="0" max="100" step="any" value={m.load}
              onChange={e => moduleChange(m.key, { load: e.target.value })} /><span className="mt-1 block text-xs text-muted-foreground">负载折算惯量与转子惯量之比。</span></label> :
              <div className="min-w-0"><span className="field-label">工作台移动质量</span>
                <output aria-label="工作台移动质量" className="flex h-9 items-center gap-2 text-sm">
                  {mass === undefined ? "待提供质量" : <><span className="mono">{mass} kg</span><span className="text-xs text-muted-foreground">来自{table?.massKg === undefined ? "设备包" : " BOM"}</span></>}
                </output></div>}
          </div>
          {parts.some(p => p.row) && <details className="border-t pt-2 text-xs leading-5 text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">部件模型与资料来源</summary>
            <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">{parts.map(({ role, row, actual }) => {
              if (!row) return null;
              const declared = actual?.servo?.modelRef ?? actual?.feed?.modelRef;
              const model = declared ?? (solver === "modelica" ? feedLibrary.components[role] : undefined);
              return <div key={role} className="min-w-0 break-words">
                <dt className="font-medium text-foreground">{roles[role]} · {row.name}</dt>
                {model && <dd className="break-all">{declared ? "设备模型" : "装配指定模型"} · {model.id} {model.version}</dd>}
                {actual && <dd>{actual.source.url ? <a className="text-primary hover:underline" href={actual.source.url} target="_blank" rel="noreferrer">{actual.source.title}</a> : actual.source.title} · {actual.source.locator}</dd>}
                {row.source && row.source !== actual?.source.url && <dd className="break-all">BOM 来源 · {/^https?:\/\//i.test(row.source) ? <a className="text-primary hover:underline" href={row.source} target="_blank" rel="noreferrer">查看原文</a> : row.source}</dd>}
              </div>;
            })}</dl>
          </details>}
        </article>;
      })}
    </section>
    <section className="surface space-y-3 p-4 sm:p-5" aria-label="轴实例">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">轴实例</h3>
        <Button variant="outline" size="sm" disabled={draft.axes.length >= LINEAR_ASSEMBLY_LIMITS.axes} onClick={() => {
          const ids = draft.axes.map(a => a.id), id = ["X", "Y", "Z"].find(n => !ids.includes(n)) ?? nextId("axis", ids);
          edit({ ...draft, axes: [...draft.axes, defaultAxis(id, draft.modules[0].key)] });
        }}><Plus />添加轴</Button></div>
      {draft.axes.map(a => <article key={a.key} className="surface-inset min-w-0 space-y-3 p-3" aria-label={`轴实例 ${a.id}`}>
        <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <label className="min-w-0"><span className="field-label">轴标识</span><Input value={a.id} maxLength={80} onChange={e => axisChange(a.key, { id: e.target.value })} /></label>
          <label className="min-w-0"><span className="field-label">使用模块</span><select aria-label="使用模块" className={selectClass} value={a.moduleKey} onChange={e => axisChange(a.key, { moduleKey: e.target.value })}>
            {draft.modules.map(m => <option value={m.key} key={m.key}>{m.id || "未填写标识"}</option>)}</select></label>
          <label className="min-w-0"><span className="field-label">安装方向</span>
            <select aria-label="安装方向" className={selectClass} value={a.custom ? "custom" : presetOf(a.direction)?.label ?? "custom"} onChange={e => {
              const chosen = presets.find(p => p.label === e.target.value);
              axisChange(a.key, chosen ? { custom: false, direction: asText(chosen.vector) } : { custom: true });
            }}>{presets.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}<option value="custom">自定义向量</option></select>
          </label>
          <label className="min-w-0"><span className="field-label">目标位移（mm）</span><Input type="number" step="any" value={a.target} onChange={e => axisChange(a.key, { target: e.target.value })} /></label>
          <Button variant="ghost" size="sm" disabled={draft.axes.length === 1} onClick={() => edit({ ...draft, axes: draft.axes.filter(other => other.key !== a.key) })}><Trash2 />移除轴</Button>
        </div>
        {a.custom && <div className="grid grid-cols-3 gap-2">{["X", "Y", "Z"].map((name, i) => <label className="min-w-0" key={name}>
          <span className="field-label">方向 {name} 分量</span><Input type="number" step="any" value={a.direction[i]} onChange={e => {
            const direction: TextVector = [...a.direction]; direction[i] = e.target.value; axisChange(a.key, { direction });
          }} /></label>)}</div>}
      </article>)}
    </section>
    <div className="surface space-y-3 p-4 sm:p-5">
      {checked.issues.length > 0 && <div><h3 className="text-sm font-medium">装配待核对</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-300">
        {checked.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={solver === "missing"} onClick={() => submit(false)}><Save />{trial ? "应用到示例" : "保存装配"}</Button>
        <Button disabled={solver === "missing" || !checked.value || !!checked.issues.length} onClick={() => submit(true)}><Play />{trial ? "运行" : "保存并运行"}</Button>
      </div>
      {job && <p role="status" className="text-xs text-primary">正在计算进给轴响应…</p>}
      {session.error && <p role="alert" className="text-sm text-destructive">{session.error}</p>}
      {session.notice && (!priorRun || visibleRun) && <p role="status" className="text-xs text-primary">{session.notice}</p>}
      {priorRun && !visibleRun && <p className="text-xs text-muted-foreground">配置或物料已更改，请重新运行以查看对应结果。</p>}
    </div>
    {visibleRun && <LinearAssemblyResults assembly={visibleRun.assembly} result={visibleRun.result} />}
  </section>;
}
