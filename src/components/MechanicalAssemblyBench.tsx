import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, ExternalLink, Play, Plus, Save, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import {
  inspectMechanicalAssembly, MECHANICAL_LIMITS, parseMechanicalAssembly, resolveMechanicalAssembly,
  type MechanicalAssembly, type MechanicalBundle, type MechanicalPart, type ResolvedMechanicalAssembly,
} from "@contracts/mechanical-assembly";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { downloadJson } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MechanicalPoseResults from "./MechanicalPoseResults";
import MechanicalBundleControls from "./MechanicalBundleControls";

type Props = { workspace: TwinWorkspace; assembly?: MechanicalAssembly; initialPackageKey?: string;
  onSave: (a: MechanicalAssembly) => void; onInstallBundle: (b: MechanicalBundle) => void };
type Node = MechanicalAssembly["nodes"][number];
type EditNode = Node & { key: string };
type Draft = Omit<MechanicalAssembly, "nodes" | "commands"> & { nodes: EditNode[]; commands: Record<string, string> };
type Packages = Map<string, DevicePackage>;
type Run = { assembly: MechanicalAssembly; signature: string; basis: string; resolved: ResolvedMechanicalAssembly };
type CommandControl = { key: string; path: string; joint?: MechanicalPart["joint"]; inherited?: number };
const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm";
const describe = (pkg: DevicePackage) => `${pkg.manufacturer} · ${pkg.model} · ${pkg.revision}`;
const message = (cause: unknown) => cause instanceof Error ? cause.message : "机械装配操作失败，请核对输入。";
const nodeKey = () => "@" + nanoid();

function mounts(pkg?: DevicePackage): string[] {
  const m = pkg?.mechanics;
  return m?.kind === "assembly" ? ["out"] : m?.kind === "part" ? m.outputs.map(p => p.id) : [];
}
function chooseMount(pkg?: DevicePackage, preferred = "") {
  const options = mounts(pkg);
  return options.includes(preferred) ? preferred : options.length === 1 ? options[0] : "";
}
function nodeOf(d: Draft, ref: string) {
  return d.nodes.find(n => n.key === ref) ?? (ref.startsWith("!") ? d.nodes.find(n => n.id === ref.slice(1)) : undefined);
}
const idOf = (d: Draft, ref: string) => nodeOf(d, ref)?.id ?? ref.replace(/^!/, "");
function remapPath(path: string, translate: (id: string) => string) {
  const split = path.indexOf("/");
  return split < 0 ? translate(path) : translate(path.slice(0, split)) + path.slice(split);
}
function draftOf(source: MechanicalAssembly | undefined, seed: string | undefined, packages: Packages): Draft {
  if (!source) {
    const root = { key: nodeKey(), id: "node1", packageKey: seed ?? "", parent: null };
    return { schemaVersion: 1, kind: "mechanical-assembly", id: "mech-" + nanoid(), name: "新机械装配", nodes: [root],
      output: { node: root.key, mount: chooseMount(packages.get(root.packageKey)) }, commands: {} };
  }
  const keys = new Map(source.nodes.map(n => [n.id, nodeKey()]));
  const key = (id: string) => keys.get(id) ?? "!" + id;
  return { ...source, nodes: source.nodes.map(n => ({ ...n, key: key(n.id), parent: n.parent && { ...n.parent, node: key(n.parent.node) } })),
    output: { ...source.output, node: key(source.output.node) },
    commands: Object.fromEntries(Object.entries(source.commands).map(([path, v]) => [remapPath(path, key), String(v)])) };
}
function definition(d: Draft): MechanicalAssembly {
  const commands: Record<string, number> = {};
  for (const [key, text] of Object.entries(d.commands)) {
    if (!text.trim()) continue;
    const path = remapPath(key, ref => idOf(d, ref)), value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`关节 ${path} 的指令需要有限数值。`);
    commands[path] = value;
  }
  return parseMechanicalAssembly({ schemaVersion: 1, kind: d.kind, id: d.id, name: d.name, commands,
    nodes: d.nodes.map(n => ({ id: n.id, packageKey: n.packageKey, parent: n.parent && { ...n.parent, node: idOf(d, n.parent.node) },
      ...(n.materialId ? { materialId: n.materialId } : {}) })),
    output: { ...d.output, node: idOf(d, d.output.node) } });
}
function signature(a?: MechanicalAssembly) {
  return a ? JSON.stringify([a.id, a.name, a.nodes.map(n => [n.id, n.packageKey, n.parent?.node, n.parent?.mount, n.materialId]),
    a.output.node, a.output.mount, Object.entries(a.commands).sort(([x], [y]) => x.localeCompare(y))]) : null;
}
function dependencies(ws: TwinWorkspace, a: MechanicalAssembly, packages: Packages) {
  const queue = [...a.nodes], parts = new Map<string, DevicePackage["mechanics"]>(), rows = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.materialId) rows.add(n.materialId);
    if (parts.has(n.packageKey)) continue;
    const m = packages.get(n.packageKey)?.mechanics;
    parts.set(n.packageKey, m);
    if (m?.kind === "assembly") queue.push(...m.assembly.nodes);
  }
  return JSON.stringify([[...parts], (ws.catalog?.materials ?? []).filter(r => rows.has(r.id)).map(r => [r.id, r.name, r.quantity, r.unit, r.binding])]);
}
function packageControls(nodes: EditNode[], ws: TwinWorkspace, packages: Packages): CommandControl[] {
  type Slot = { path: string; part: MechanicalPart; value: number };
  const cache = new Map<string, Slot[]>(), controls: CommandControl[] = [];
  let expanded = 0;
  for (const node of nodes) {
    if (expanded >= MECHANICAL_LIMITS.expandedNodes) break;
    let slots = cache.get(node.packageKey);
    if (!slots) {
      const m = packages.get(node.packageKey)?.mechanics;
      if (m?.kind === "part") slots = [{ path: "", part: m, value: 0 }];
      else if (m?.kind === "assembly") {
        // A sibling's incomplete mount or nonzero minimum must not hide this reusable package's inputs.
        try { slots = resolveMechanicalAssembly(ws, m.assembly).nodes; }
        catch { slots = []; }
      } else slots = [];
      cache.set(node.packageKey, slots);
    }
    for (const slot of slots) {
      if (++expanded > MECHANICAL_LIMITS.expandedNodes) break;
      if (slot.part.joint.type === "fixed") continue;
      const suffix = slot.path ? "/" + slot.path : "";
      controls.push({ key: node.key + suffix, path: node.id + suffix, joint: slot.part.joint, inherited: slot.value });
    }
  }
  return controls;
}
function children(d: Draft, key: string) {
  return d.nodes.filter(n => n.parent?.node === key || (n.parent?.node.startsWith("!") && nodeOf(d, n.parent.node)?.key === key));
}
function canMoveUp(d: Draft, child: EditNode) {
  const parent = child.parent && nodeOf(d, child.parent.node);
  return !!parent && parent.key !== child.key && !(parent.parent && nodeOf(d, parent.parent.node)?.key === child.key)
    && children(d, parent.key).length === 1 && children(d, child.key).length <= 1;
}
function moveUp(d: Draft, child: EditNode, packages: Packages): Draft {
  if (!child.parent || !canMoveUp(d, child)) return d;
  const parent = nodeOf(d, child.parent.node)!, next = children(d, child.key)[0];
  const atEnd = !next && nodeOf(d, d.output.node)?.key === child.key;
  const oldParentMount = child.parent.mount;
  const childMount = chooseMount(packages.get(child.packageKey), next?.parent?.mount ?? (atEnd ? d.output.mount : ""));
  const nodes = d.nodes.map(n => {
    if (n.key === parent.key) return { ...child, parent: parent.parent };
    if (n.key === child.key) return { ...parent, parent: { node: child.key, mount: childMount } };
    if (n.key === next?.key) return { ...n, parent: { node: parent.key, mount: oldParentMount } };
    return n;
  });
  return { ...d, nodes, output: atEnd ? { node: parent.key, mount: oldParentMount } : d.output };
}
function fresh(assembly: MechanicalAssembly | undefined, seed: string | undefined, packages: Packages) {
  return { draft: draftOf(assembly, seed, packages), seen: signature(assembly), seed, submitted: null as string | null,
    run: null as Run | null, error: "", notice: "" };
}

export default function MechanicalAssemblyBench({ workspace, assembly, initialPackageKey, onSave, onInstallBundle }: Props) {
  const packages = useMemo(() => new Map(workspace.packages.map(p => [packageKey(p), p])), [workspace.packages]);
  const available = useMemo(() => workspace.packages.filter(p => p.mechanics), [workspace.packages]);
  const seed = assembly ? undefined : initialPackageKey;
  const [state, setState] = useState(() => fresh(assembly, seed, packages));
  const incoming = signature(assembly);
  if (state.seen !== incoming || state.seed !== seed) {
    if (assembly?.id === state.draft.id && incoming === state.submitted) setState({ ...state, seen: incoming, seed, submitted: null });
    else setState(fresh(assembly, seed, packages));
  }
  const d = state.draft;
  const checked = useMemo(() => {
    try { const a = definition(d); return { a, issues: inspectMechanicalAssembly(workspace, a) }; }
    catch (e) { return { a: null, issues: [message(e)] }; }
  }, [d, workspace]);
  const known = useMemo(() => packageControls(d.nodes, workspace, packages), [d.nodes, workspace, packages]);
  const controls = useMemo(() => {
    const entries = new Map(known.map(c => [c.key, c]));
    for (const key of Object.keys(d.commands)) if (!entries.has(key)) {
      entries.set(key, { key, path: remapPath(key, ref => idOf(d, ref)) });
    }
    return [...entries.values()];
  }, [known, d]);
  const basis = useMemo(() => state.run ? dependencies(workspace, state.run.assembly, packages) : "", [workspace, packages, state.run]);
  const run = state.run && checked.a && !checked.issues.length && state.run.signature === signature(checked.a) && state.run.basis === basis ? state.run : null;
  const materials = workspace.catalog?.materials ?? [];
  const endNode = nodeOf(d, d.output.node), endPorts = mounts(endNode && packages.get(endNode.packageKey));

  function edit(next: Draft) { setState(old => ({ ...old, draft: next, error: "", notice: "" })); }
  function update(key: string, patch: Partial<EditNode>) { edit({ ...d, nodes: d.nodes.map(n => n.key === key ? { ...n, ...patch } : n) }); }
  function selectPackage(n: EditNode, pkgKey: string) {
    const pkg = packages.get(pkgKey);
    const nodes = d.nodes.map(other => {
      if (other.key === n.key) return { ...other, packageKey: pkgKey, materialId: undefined };
      if (other.parent && nodeOf(d, other.parent.node)?.key === n.key) return { ...other, parent: { node: n.key, mount: chooseMount(pkg, other.parent.mount) } };
      return other;
    });
    edit({ ...d, nodes, output: endNode?.key === n.key ? { node: n.key, mount: chooseMount(pkg, d.output.mount) } : d.output,
      commands: Object.fromEntries(Object.entries(d.commands).filter(([path]) => path !== n.key && !path.startsWith(n.key + "/"))) });
  }
  function add() {
    let i = 1; while (d.nodes.some(n => n.id === "node" + i)) i++;
    const parent = endNode ?? d.nodes.at(-1), key = nodeKey();
    edit({ ...d, nodes: [...d.nodes, { key, id: "node" + i, packageKey: "", parent: parent ? {
      node: parent.key, mount: chooseMount(packages.get(parent.packageKey), endNode ? d.output.mount : ""),
    } : null }], output: { node: key, mount: "" } });
  }
  function remove(n: EditNode) {
    const nodes = d.nodes.filter(other => other.key !== n.key).map(other =>
      other.parent && nodeOf(d, other.parent.node)?.key === n.key ? { ...other, parent: { node: "!" + n.id, mount: other.parent.mount } } : other);
    edit({ ...d, nodes, output: endNode?.key === n.key ? { node: "!" + n.id, mount: d.output.mount } : d.output,
      commands: Object.fromEntries(Object.entries(d.commands).filter(([key]) => key !== n.key && !key.startsWith(n.key + "/"))) });
  }
  function submit(calculate: boolean) {
    try {
      const value = checked.a;
      if (!value) throw new Error(checked.issues[0] ?? "请核对装配定义。");
      const resolved = calculate ? resolveMechanicalAssembly(workspace, value) : null;
      onSave(value);
      const stamp = signature(value)!;
      setState(old => ({ ...old, submitted: stamp, error: "", notice: "装配已保存。",
        run: resolved ? { assembly: value, signature: stamp, basis: dependencies(workspace, value, packages), resolved } : old.run }));
    } catch (e) { setState(old => ({ ...old, error: message(e), notice: "" })); }
  }

  return <section className="min-w-0 space-y-4" aria-label="机械装配编辑器">
    <section className="surface space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">{assembly ? "机械装配设置" : "新建机械装配"}</h3>
        <a target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href="https://github.com/lusipad/omg/blob/main/docs/机械安装点与子装配.md">机械安装点与子装配<ExternalLink className="size-3" /></a></div>
      <label className="block max-w-xl"><span className="field-label">装配名称</span><Input maxLength={160} value={d.name} onChange={e => edit({ ...d, name: e.target.value })} /></label>
      {!available.length && <p className="text-sm text-muted-foreground">工程还没有机械设备包。可先留存草稿，导入带安装点的设备后再连接。</p>}
    </section>
    <section className="surface space-y-3 p-4 sm:p-5" aria-label="设备实例与安装关系">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">设备实例与安装关系</h3>
        <Button size="sm" variant="outline" disabled={d.nodes.length >= MECHANICAL_LIMITS.nodes} onClick={add}><Plus />添加实例</Button></div>
      <p className="text-xs leading-5 text-muted-foreground">新实例默认接在当前输出。选择父实例及安装点可创建分支，串联段可直接上移或下移。</p>
      {d.nodes.map(n => {
        const parent = n.parent ? nodeOf(d, n.parent.node) : undefined, ports = mounts(parent && packages.get(parent.packageKey));
        const next = children(d, n.key), pkg = packages.get(n.packageKey);
        const linkedRows = materials.filter(r => r.binding?.kind === "device" && r.binding.key === n.packageKey);
        return <article key={n.key} aria-label={`机械实例 ${n.id}`} className="surface-inset space-y-3 p-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.6fr)]">
            <label className="min-w-0"><span className="field-label">实例标识</span><Input value={n.id} maxLength={80} onChange={e => update(n.key, { id: e.target.value })} /></label>
            <label className="min-w-0"><span className="field-label">设备包</span>
              <select aria-label="设备包" className={selectClass} value={n.packageKey} onChange={e => selectPackage(n, e.target.value)}>
                <option value="">选择机械零件或子装配</option>
                {n.packageKey && !pkg?.mechanics && <option value={n.packageKey}>{pkg ? describe(pkg) : n.packageKey}（机械接口待补）</option>}
                {available.map(p => <option value={packageKey(p)} key={packageKey(p)}>{describe(p)}{p.mechanics?.kind === "assembly" ? "（子装配）" : ""}</option>)}
              </select></label>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <label className="min-w-0"><span className="field-label">父实例</span><select aria-label="父实例" className={selectClass} value={parent?.key ?? n.parent?.node ?? ""}
              onChange={e => { const target = nodeOf(d, e.target.value); update(n.key, { parent: target ? { node: target.key, mount: chooseMount(packages.get(target.packageKey), n.parent?.mount) } : null }); }}>
              <option value="">固定基底</option>
              {n.parent && (!parent || parent.key === n.key) && <option value={parent?.key ?? n.parent.node}>{idOf(d, n.parent.node) || "未指定"}（父实例待修复）</option>}
              {d.nodes.filter(p => p.key !== n.key).map(p => <option key={p.key} value={p.key}>{p.id}</option>)}
            </select></label>
            <label className="min-w-0"><span className="field-label">父安装点</span><select aria-label="父安装点" className={selectClass} disabled={!n.parent}
              value={n.parent?.mount ?? ""} onChange={e => { if (n.parent) update(n.key, { parent: { ...n.parent, mount: e.target.value } }); }}>
              <option value="">{n.parent ? "请选择安装点" : "固定基底"}</option>
              {n.parent?.mount && !ports.includes(n.parent.mount) && <option value={n.parent.mount}>{n.parent.mount}（待核对）</option>}
              {ports.map(id => <option key={id}>{id}</option>)}
            </select></label>
            <label className="min-w-0"><span className="field-label">BOM 物料（可选）</span><select aria-label="BOM 物料（可选）" className={selectClass} value={n.materialId ?? ""}
              onChange={e => update(n.key, { materialId: e.target.value || undefined })}>
              <option value="">不关联物料行</option>
              {n.materialId && !linkedRows.some(r => r.id === n.materialId) && <option value={n.materialId}>{materials.find(r => r.id === n.materialId)?.name ?? n.materialId}（绑定待核对）</option>}
              {linkedRows.map(r => <option value={r.id} key={r.id}>{r.name} · {r.quantity} {r.unit ?? "件"}{r.source && ` · ${r.source}`} · {r.id}</option>)}
            </select></label>
          </div>
          <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={!canMoveUp(d, n)} onClick={() => edit(moveUp(d, n, packages))}><ArrowUp />上移</Button>
            <Button size="sm" variant="ghost" disabled={next.length !== 1 || !canMoveUp(d, next[0])} onClick={() => edit(moveUp(d, next[0], packages))}><ArrowDown />下移</Button>
            <Button size="sm" variant="ghost" disabled={d.nodes.length === 1} onClick={() => remove(n)}><Trash2 />移除实例</Button></div>
        </article>;
      })}
    </section>
    <section className="surface space-y-3 p-4 sm:p-5" aria-label="输出与关节指令"><h3 className="text-base font-semibold">输出与关节指令</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0"><span className="field-label">输出实例</span><select aria-label="输出实例" className={selectClass} value={endNode?.key ?? d.output.node}
          onChange={e => { const node = nodeOf(d, e.target.value); if (node) edit({ ...d, output: { node: node.key, mount: chooseMount(packages.get(node.packageKey), d.output.mount) } }); }}>
          {!endNode && <option value={d.output.node}>{idOf(d, d.output.node) || "未指定"}（待选择）</option>}
          {d.nodes.map(n => <option value={n.key} key={n.key}>{n.id}</option>)}</select></label>
        <label className="min-w-0"><span className="field-label">输出安装点</span><select aria-label="输出安装点" className={selectClass} value={d.output.mount}
          onChange={e => edit({ ...d, output: { ...d.output, mount: e.target.value } })}><option value="">请选择对外输出</option>
          {d.output.mount && !endPorts.includes(d.output.mount) && <option value={d.output.mount}>{d.output.mount}（待核对）</option>}
          {endPorts.map(id => <option key={id}>{id}</option>)}</select></label>
      </div>
      {controls.length > 0 && <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">{controls.map(c => {
        const unit = c.joint?.type === "slide" ? "mm" : c.joint?.type === "hinge" ? "°" : "";
        return <div className="min-w-0" key={c.key}><label><span className="field-label break-all">指令 {c.path}{unit && `（${unit}）`}</span>
          <Input type="number" step="any" aria-label={`指令 ${c.path}${unit ? "（" + unit + "）" : ""}`} value={d.commands[c.key] ?? String(c.inherited ?? "")}
            onChange={e => edit({ ...d, commands: { ...d.commands, [c.key]: e.target.value } })} /></label>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {c.joint && c.joint.type !== "fixed" ? <span>范围 {c.joint.range.join(" 至 ")} {unit}。{c.path.includes("/") ? "子装配的默认指令为" : "未指定时取"} {c.inherited} {unit}。</span> : <span>关节路径待核对。</span>}
            {Object.hasOwn(d.commands, c.key) && <button type="button" className="text-primary hover:underline" onClick={() => {
              const commands = { ...d.commands }; delete commands[c.key]; edit({ ...d, commands });
            }}>{c.joint ? "沿用默认指令" : "移除这条指令"}</button>}
          </div></div>;
      })}</div>}
    </section>
    <div className="surface space-y-3 p-4 sm:p-5">
      {checked.issues.length > 0 && <div><h3 className="text-sm font-medium">装配待核对</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-300">
        {checked.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => submit(false)}><Save />保存装配</Button>
        <Button disabled={!checked.a || !!checked.issues.length} onClick={() => submit(true)}><Play />保存并计算</Button>
        <Button variant="ghost" disabled={!checked.a} onClick={() => { if (checked.a) downloadJson(checked.a, checked.a.name + ".assembly.json"); }}><Download />导出装配关系</Button>
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {state.notice && <p role="status" className="text-xs text-primary">{state.notice}</p>}
      {state.run && !run && <p className="text-xs text-muted-foreground">装配、指令或所需资料已变化，请重新计算。</p>}
    </div>
    <MechanicalBundleControls key={d.id} workspace={workspace} assembly={checked.a} onInstallBundle={onInstallBundle} />
    {run && <MechanicalPoseResults resolved={run.resolved} />}
  </section>;
}
