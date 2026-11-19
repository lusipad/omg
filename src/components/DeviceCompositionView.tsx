import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Box, ChevronDown, ChevronRight, ExternalLink, GitFork, ListTree, Pencil, Table2 } from "lucide-react";
import { compositionKind, getDeviceParts } from "@contracts/device-composition";
import { getFactoryModel, resolveFactoryParameters } from "@contracts/factory";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { compositionTrail, deviceIdentity, visibleCompositionRoots, type CompositionLine, type CompositionRoot } from "@/lib/device-composition-view";
import { Button } from "./ui/button";
import DeviceCompositionEditor from "./DeviceCompositionEditor";
import DeviceCompositionSummary from "./DeviceCompositionSummary";
import DevicePartDiagram, { PartIllustration, type DiagramMode } from "./DevicePartDiagram";
import "./DeviceCompositionView.css";

type Props = {
  workspace: TwinWorkspace; roots: readonly CompositionRoot[]; lines?: readonly CompositionLine[]; initialRootId?: string;
  onApplyRevision?: (rootId: string, workspace: TwinWorkspace, newRootKey: string) => void;
  onEditingChange?: (editing: boolean) => void;
  onOpenMotorAxis?: (resourceId: string, axisId: string) => void;
};
const statusText = { assembly: "装配件", leaf: "最小件", unknown: "待补明细", missing: "缺少修订" } as const;
const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm";
const pathKey = (path: readonly string[]) => JSON.stringify(path);
const pathSet = (path: readonly string[]) => new Set(Array.from({ length: path.length + 1 }, (_, i) => pathKey(path.slice(0, i))));
function treeState(pkg?: DevicePackage) { return pkg ? compositionKind(pkg) : "missing"; }

function TreeItem({ installed, node, path, activePath, expanded, parents, onSelect, onToggle }: {
  installed: ReadonlyMap<string, DevicePackage>; node: { id: string; label: string; packageKey: string; quantity: number }; path: string[];
  activePath: string[]; expanded: ReadonlySet<string>; parents: string[];
  onSelect: (path: string[]) => void; onToggle: (path: string[]) => void;
}) {
  const key = pathKey(path), pkg = installed.get(node.packageKey), cycle = parents.includes(node.packageKey);
  const children = pkg && !cycle ? getDeviceParts(pkg) : [], branch = children.length > 0;
  const open = expanded.has(key), ancestor = path.length <= activePath.length && path.every((id, i) => activePath[i] === id);
  const current = ancestor && path.length === activePath.length, childId = ancestor ? activePath[path.length] : undefined;
  const [manual, setManual] = useState<{ childId?: string; page: number } | null>(null);
  const perPage = 20, autoPage = childId ? Math.floor(Math.max(0, children.findIndex(c => c.id === childId)) / perPage) : 0;
  const page = Math.min(Math.max(0, Math.ceil(children.length / perPage) - 1), manual && manual.childId === childId ? manual.page : autoPage);
  return <li>
    <div className={`flex min-w-0 items-center rounded px-0.5 py-0.5 ${current ? "bg-primary/10 text-primary" : ""}`}
      style={{ paddingLeft: Math.min(path.length, 5) * 9 }}>
      {branch ? <button type="button" aria-label={`${open ? "收起" : "展开"}槽位 ${node.label}（${node.id}）`} aria-expanded={open}
        onClick={() => onToggle(path)} className="grid size-7 shrink-0 place-items-center rounded hover:bg-secondary">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button> : <span className="grid size-7 shrink-0 place-items-center text-muted-foreground"><Box size={12} aria-hidden="true" /></span>}
      <button type="button" aria-current={current ? "true" : undefined} aria-label={`树中选择 ${node.label}（${node.id}）`}
        onClick={() => onSelect(path)} className="flex min-w-0 flex-1 items-baseline gap-1 rounded-sm py-1 pr-1 text-left text-xs hover:text-primary">
        <span className="min-w-0 break-all">{node.label}</span>
        <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">×{node.quantity}</span>
      </button>
    </div>
    {branch && open && <><ul>{children.slice(page * perPage, (page + 1) * perPage).map(child => <TreeItem key={child.id} installed={installed} node={child} path={[...path, child.id]}
      activePath={activePath} expanded={expanded} parents={[...parents, node.packageKey]} onSelect={onSelect} onToggle={onToggle} />)}</ul>
      {children.length > perPage && <div role="group" aria-label={`${node.label}的树目录分页`} className="flex flex-wrap items-center gap-2 py-1 text-[11px] text-muted-foreground">
        <button type="button" disabled={!page} className="px-1 text-primary disabled:opacity-40" onClick={() => setManual({ childId, page: page - 1 })}>上一组</button>
        <span>{page * perPage + 1}–{Math.min(children.length, (page + 1) * perPage)} / {children.length}</span>
        <button type="button" disabled={(page + 1) * perPage >= children.length} className="px-1 text-primary disabled:opacity-40" onClick={() => setManual({ childId, page: page + 1 })}>下一组</button>
      </div>}</>}
  </li>;
}

function ParameterSources({ root, installed, path, onLocate }: {
  root: CompositionRoot; installed: ReadonlyMap<string, DevicePackage>; path: string[]; onLocate: (path: string[]) => void;
}) {
  const device = installed.get(root.packageKey), factory = device?.factory, model = getFactoryModel(factory?.modelRef);
  if (!device || !factory || !model) return null;
  const bindings = factory.partParameters ?? {};
  const specs = model.parameters.filter(spec => !path.length || path.every((id, i) => bindings[spec.key]?.path[i] === id));
  if (!specs.length) return null;
  const { parameterSources, issues } = resolveFactoryParameters(device, model, installed, root.parameters);
  return <details className="rounded-md border p-2.5 text-xs">
    <summary className="cursor-pointer font-medium">{path.length ? "本分支关联的工厂参数" : "工厂求解参数与来源"}</summary>
    <p className="mt-2 break-all text-muted-foreground">{model.id} @ {factory.modelRef.version}</p>
    <dl className="mt-2 divide-y">{specs.map(spec => {
      const origin = parameterSources[spec.key], binding = bindings[spec.key];
      return <div key={spec.key} className="flex flex-wrap items-baseline justify-between gap-1 py-1.5">
        <dt className="font-medium">{spec.label}</dt>
        <dd className="min-w-0 break-all">
          {origin ? <><span className="mono">{origin.value} {origin.unit}</span><span className="ml-2 text-muted-foreground">
            {origin.kind === "instance" ? "实例覆盖" : origin.kind === "device" ? "设备包" : "部件额定值"}
          </span></> : <span className="text-amber-300">待补参数</span>}
        </dd>
        {binding && <dd className="w-full break-all">
          <button type="button" className="text-left text-primary underline underline-offset-2" onClick={() => onLocate(binding.path)}>
            {binding.path.join(" / ")} · {binding.rating}
          </button>
        </dd>}
      </div>;
    })}</dl>
    {issues.length > 0 && <ul className="mt-2 space-y-1 break-all text-amber-300">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
  </details>;
}

function CompositionSession({ workspace, roots, lines, initialRootId, onApplyRevision, onEditingChange, onOpenMotorAxis }: Props) {
  const [lineId, setLineId] = useState("");
  const [selectedId, setSelectedId] = useState(initialRootId ?? roots[0]?.id ?? "");
  const [requestedPath, setPath] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(() => pathSet([]));
  const [mobileTree, setMobileTree] = useState(false);
  const [mode, setMode] = useState<"parts" | "totals">("parts");
  const [diagram, setDiagram] = useState<DiagramMode>("slots");
  const [edit, setEdit] = useState<{ id: string; rootKey: string; path: string[] } | null>(null);
  const treeId = useId(), treeList = useRef<HTMLUListElement>(null), notify = useRef(onEditingChange);
  const installed = useMemo(() => new Map(workspace.packages.map(pkg => [packageKey(pkg), pkg])), [workspace.packages]);
  const { labels, partsByKey } = useMemo(() => {
    const labels = new Map<string, string>(), partsByKey = new Map<string, ReturnType<typeof getDeviceParts>>();
    for (const p of workspace.packages) {
      const children = getDeviceParts(p); partsByKey.set(packageKey(p), children);
      for (const slot of children) if (!labels.has(slot.packageKey)) labels.set(slot.packageKey, slot.label);
    }
    return { labels, partsByKey };
  }, [workspace.packages]);
  const line = lines?.find(l => l.id === lineId);
  const filtered = useMemo(() => visibleCompositionRoots(roots, line?.resourceIds), [roots, line]);
  const root = filtered.find(r => r.id === selectedId) ?? filtered[0];
  const trail = root ? compositionTrail(installed, root, root.id === selectedId ? requestedPath : []) : [];
  const node = trail.at(-1), path = trail.slice(1).map(n => n.id);
  const currentPath = pathKey(path);
  const cycle = !!node && trail.slice(0, -1).some(ancestor => ancestor.packageKey === node.packageKey);
  const selected = node?.device;
  const parts = node && !cycle ? partsByKey.get(node.packageKey) ?? [] : [];
  const editing = !!edit && !!onApplyRevision && edit.id === root?.id && edit.rootKey === root?.packageKey;
  useLayoutEffect(() => { notify.current = onEditingChange; }, [onEditingChange]);
  useLayoutEffect(() => {
    notify.current?.(editing);
    return () => { if (editing) notify.current?.(false); };
  }, [editing]);
  useLayoutEffect(() => {
    const list = treeList.current, row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row || !list.clientHeight) return;
    const box = list.getBoundingClientRect(), item = row.getBoundingClientRect();
    if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
    else if (item.top < box.top) list.scrollTop -= box.top - item.top;
  }, [currentPath, root?.id, mobileTree, mode]);
  if (edit && !editing) setEdit(null);

  function navigate(id: string, next: string[]) {
    setSelectedId(id); setPath(next); setExpanded(old => new Set([...(id === selectedId ? old : []), ...pathSet(next)]));
    setMode("parts"); setMobileTree(false);
  }
  function toggle(branch: string[]) {
    const key = pathKey(branch);
    setExpanded(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  if (editing && edit && onApplyRevision) return <DeviceCompositionEditor workspace={workspace} rootKey={edit.rootKey} path={edit.path}
    onCancel={() => setEdit(null)} onApply={(next, newRootKey) => {
      onApplyRevision(edit.id, next, newRootKey);
      if (edit.id === edit.rootKey) setSelectedId(newRootKey);
      setEdit(null);
    }} />;
  const status = treeState(node?.device);
  const [maker, model, revision] = node ? deviceIdentity(node.packageKey, node.device) : ["", "", ""];
  const ratings = Object.entries(selected?.composition?.ratings ?? {});
  const modelRef = selected?.factory?.modelRef ?? selected?.motorPhysics?.modelRef ?? selected?.servo?.modelRef ?? selected?.feed?.modelRef;
  const axisPorts = root && onOpenMotorAxis ? installed.get(root.packageKey)?.axisPorts?.filter(port =>
    !path.length || (port.path.length <= path.length && port.path.every((id, i) => path[i] === id))) : undefined;
  const groupName = line ? line.name : lines ? "整厂" : roots.length === 1 ? roots[0].label : "设备库";

  return <section className="composition-view min-w-0 space-y-3" aria-label="设备组成与明细">
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      {!!lines?.length && <label className="min-w-[min(100%,10rem)] flex-1"><span className="field-label">结构范围</span>
        <select className={selectClass} value={line?.id ?? ""} onChange={e => {
          const id = e.target.value; setLineId(id);
          const choices = visibleCompositionRoots(roots, lines.find(l => l.id === id)?.resourceIds);
          if (!choices.some(r => r.id === selectedId)) { setSelectedId(choices[0]?.id ?? ""); setPath([]); setExpanded(pathSet([])); }
        }}><option value="">整厂 · {roots.length} 台实际设备</option>
          {lines.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></label>}
      {(roots.length > 1 || !!lines?.length) && <label className="min-w-[min(100%,11rem)] flex-1"><span className="field-label">设备实例</span>
        <select className={selectClass} disabled={!root} value={root?.id ?? ""} onChange={e => navigate(e.target.value, [])}>
          {!root && <option value="">当前范围没有设备</option>}
          {filtered.map(r => <option key={r.id} value={r.id}>{r.label} · {r.id}</option>)}
        </select></label>}
      {!!root && <div role="group" aria-label="组成视图" className="flex flex-wrap gap-1">
        <Button size="sm" variant={mode === "parts" ? "secondary" : "ghost"} type="button" aria-pressed={mode === "parts"} onClick={() => setMode("parts")}><GitFork />逐层拆解</Button>
        <Button size="sm" variant={mode === "totals" ? "secondary" : "ghost"} type="button" aria-pressed={mode === "totals"} onClick={() => setMode("totals")}><Table2 />基本件汇总</Button>
      </div>}
    </div>
    {!root || !node ? <p role="status" className="surface-inset p-3 text-sm text-muted-foreground">{line ? "这条产线尚未引用设备。" : "当前范围尚无设备实例。"}</p>
      : mode === "totals" ? <DeviceCompositionSummary packages={workspace.packages} installed={installed} labels={labels} roots={filtered}
        root={root} node={node} path={path} groupName={groupName} onLocate={navigate} />
        : <>
          <nav aria-label="部件路径" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y py-1.5">
            <button className="composition-tree-toggle inline-flex items-center gap-1 rounded px-1 py-1.5 text-xs text-primary" type="button"
              onClick={() => setMobileTree(!mobileTree)} aria-controls={treeId} aria-expanded={mobileTree}><ListTree size={15} />装配树</button>
            <ol className="composition-crumbs flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
              {trail.map((item, i) => trail.length > 8 && i === 1 ? <li key="ancestors" className="min-w-0">
                <select aria-label="跳转到中间层级" value="" className="max-w-[11rem] rounded border bg-background py-0.5 text-xs" onChange={e => {
                  if (e.target.value) navigate(root.id, path.slice(0, Number(e.target.value)));
                }}>
                  <option value="">中间 {trail.length - 4} 层</option>
                  {trail.slice(1, -3).map((ancestor, index) => <option key={index} value={index + 1}>第 {index + 2} 层 · {ancestor.label}</option>)}
                </select>
              </li> : trail.length > 8 && i > 1 && i < trail.length - 3 ? null : <li className="flex min-w-0 max-w-full items-center gap-1" key={i}>
                {i > 0 && <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-muted-foreground" />}
                {i === trail.length - 1 ? <span aria-current="page" className="break-all font-medium">{item.label}</span>
                  : <button className="break-all text-left text-primary underline-offset-2 hover:underline" type="button"
                    onClick={() => navigate(root.id, path.slice(0, i))}>{item.label}</button>}
              </li>)}
            </ol>
            {!!path.length && <Button size="sm" variant="ghost" type="button" onClick={() => navigate(root.id, path.slice(0, -1))}><ArrowLeft />上一级</Button>}
          </nav>
          <div className="composition-browser">
            <aside id={treeId} data-open={mobileTree} aria-label="装配树" className="composition-index min-w-0 rounded-md border bg-background/40 p-2">
              <h3 className="mb-1 px-1 text-xs font-medium text-muted-foreground">安装槽位</h3>
              <ul ref={treeList} aria-label="安装槽位目录" className="max-h-[31rem] overflow-y-auto"><TreeItem installed={installed} node={root} path={[]}
                activePath={path} expanded={expanded} parents={[]} onSelect={next => navigate(root.id, next)} onToggle={toggle} /></ul>
            </aside>
            <section aria-label="选中部件" className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="break-all text-base font-semibold">{node.label}</h3><span aria-label="明细状态"
                    className={`text-xs ${status === "unknown" || status === "missing" || cycle ? "text-amber-300" : "text-primary"}`}>{cycle ? "循环引用" : statusText[status]}</span>
                </div><p className="mt-1 break-all text-xs text-muted-foreground">{[maker, model, revision && "修订 " + revision].filter(Boolean).join(" · ")}</p></div>
                {onApplyRevision && selected && !cycle && <Button size="sm" variant="outline" type="button" onClick={() => setEdit({ id: root.id, rootKey: root.packageKey, path })}>
                  <Pencil />编辑本层组成
                </Button>}
              </div>
              <dl className="flex flex-wrap gap-x-5 gap-y-2 border-l-2 border-primary/60 pl-3 text-xs">
                <div><dt className="text-muted-foreground">{path.length ? "安装槽位" : "根实例"}</dt><dd className="mono break-all">{node.id}</dd></div>
                {path.length > 0 && <div><dt className="text-muted-foreground">每套数量</dt><dd className="mono" aria-label="每套数量">{node.quantity}</dd></div>}
                <div><dt className="text-muted-foreground">此路径累计数量</dt><dd className="mono break-all" aria-label="此路径累计数量">{String(node.cumulative)}</dd></div>
              </dl>
              {parts.length > 0 ? <DevicePartDiagram key={node.packageKey} parts={parts} installed={installed} mode={diagram} onModeChange={setDiagram}
                parentQuantity={node.cumulative} onChoose={id => navigate(root.id, [...path, id])} />
                : <div className="surface-inset flex min-w-0 items-center gap-2 p-2.5">
                  <div className="w-[4.5rem] shrink-0 rounded bg-[#192823]"><PartIllustration shape={selected?.composition?.shape} missing={!selected} /></div>
                  <p className="min-w-0 break-words text-sm">{cycle ? "这条路径重新指向了上级修订，请核对设备库的组成关系。"
                    : status === "leaf" ? "该修订将此部件明确列为最小建模单元。"
                    : status === "missing" ? "当前工程缺少此修订。安装对应设备包后，可继续查看其组成。"
                    : "此修订尚未声明内部组成。可补充子件清单，或按资料标记最小建模单元。"}</p>
                </div>}
              {selected?.composition?.note && <p className="break-words text-xs text-muted-foreground">{selected.composition.note}</p>}
              {ratings.length > 0 && <dl aria-label="部件额定值" className="grid gap-2 text-xs" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))" }}>
                {ratings.map(([key, r]) => <div key={key} className="surface-inset p-2"><dt className="break-all text-muted-foreground">{r.label}</dt>
                  <dd className="mono mt-0.5 break-all">{r.value} {r.unit}</dd></div>)}
              </dl>}
              {modelRef && <p className="break-all text-xs text-muted-foreground">模型 · <span className="mono text-foreground">{modelRef.id} @ {modelRef.version}</span></p>}
              {onOpenMotorAxis && !!axisPorts?.length && <div className="flex flex-wrap gap-2">{axisPorts.map(port =>
                <Button type="button" size="sm" variant="outline" key={port.id} onClick={() => onOpenMotorAxis(root.id, port.id)}>
                  组装电机并试跑 {port.name}
                </Button>)}</div>}
              <ParameterSources root={root} installed={installed} path={path} onLocate={next => navigate(root.id, next)} />
              {selected && <details className="rounded-md border p-2.5 text-xs">
                <summary className="cursor-pointer font-medium">部件资料来源</summary>
                <div className="mt-2 space-y-1 break-words"><p>{selected.source.title}</p><p className="text-muted-foreground">{selected.source.locator}</p>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-line text-muted-foreground">{selected.source.excerpt}</p>
                  {selected.source.url && <a className="inline-flex items-center gap-1 text-primary underline" href={selected.source.url} target="_blank" rel="noreferrer">
                    打开原始资料<ExternalLink size={12} /></a>}</div>
              </details>}
            </section>
          </div>
        </>}
  </section>;
}

export default function DeviceCompositionView(props: Props) {
  return <CompositionSession key={props.initialRootId ?? ""} {...props} />;
}
