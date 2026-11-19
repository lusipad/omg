import { useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, Upload } from "lucide-react";
import { FACTORY_LIMITS, getFactoryModel, replaceFactoryResourcePackage, resolveFactoryParameters, type FactoryLayout, type FactoryLine, type FactoryResource, type FactoryRole, type FactoryStage } from "@contracts/factory";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const roleNames: Record<FactoryRole, string> = { handle: "上下料", machine: "加工", conveyor: "输送线", mobile: "移动运输" };
const transport = (role?: FactoryRole) => role === "conveyor" || role === "mobile";
const displayPackage = (pkg: DevicePackage) => `${pkg.model} · ${pkg.manufacturer} · ${pkg.revision}`;
const numeric = (n: number | undefined) => n !== undefined && Number.isFinite(n) ? n : "";

function nextId(prefix: string, items: { id: string }[]) {
  let index = 1;
  while (items.some(item => item.id === prefix + index)) index++;
  return prefix + index;
}

function newStage(stages: FactoryStage[]): FactoryStage {
  return { id: nextId("stage-", stages), name: stages.length ? `工序 ${stages.length + 1}` : "上料",
    operation: stages.length ? "machine" : "handle", stations: [], carriers: [] };
}

type Props = {
  workspace: TwinWorkspace; draft: FactoryLayout; tab: "devices" | "lines"; selectedId: string;
  onSelect: (id: string) => void; onChange: (next: FactoryLayout) => void;
  onAddResource: (pkg: DevicePackage) => void; onImport?: () => void; onOpenStructure: (id: string) => void; replacementRef: RefObject<HTMLSelectElement | null>;
};

function DeviceEditor({ workspace, draft, selectedId, onSelect, onChange, onAddResource, onImport, onOpenStructure, replacementRef }: Props) {
  const [addKey, setAddKey] = useState("");
  const packages = workspace.packages.filter(p => p.factory);
  const add = packages.find(p => packageKey(p) === addKey) ?? packages[0];
  const selected = draft.resources.find(r => r.id === selectedId) ?? draft.resources[0];
  const current = packages.find(p => packageKey(p) === selected?.packageKey);
  const model = getFactoryModel(current?.factory?.modelRef);
  const sources = current && model ? resolveFactoryParameters(current, model, new Map(workspace.packages.map(pkg => [packageKey(pkg), pkg])), {}, false).parameterSources : {};
  const materials = workspace.catalog?.materials ?? [];
  const matchingRows = materials.filter(r => r.binding?.kind === "device" && r.binding.key === selected?.packageKey);
  const stages = draft.lines.flatMap(line => line.stages);
  const alternatives = packages.filter(p => {
    if (p === current) return true;
    const candidate = getFactoryModel(p.factory?.modelRef);
    if (!candidate) return false;
    if (model) return candidate.role === model.role || (transport(candidate.role) && transport(model.role));
    return !selected || stages.every(s => (!s.stations.includes(selected.id) || s.operation === candidate.role) &&
      (!s.carriers.includes(selected.id) || transport(candidate.role)));
  });
  function replace(value: FactoryResource) {
    onChange({ ...draft, resources: draft.resources.map(r => r.id === value.id ? value : r) });
  }
  function remove(id: string) {
    const resources = draft.resources.filter(r => r.id !== id);
    const lines = draft.lines.map(l => ({ ...l, stages: l.stages.map(s => ({ ...s,
      stations: s.stations.filter(ref => ref !== id), carriers: s.carriers.filter(ref => ref !== id) })) }));
    onChange({ ...draft, resources, lines }); onSelect(resources[0]?.id ?? "");
  }
  return <section className="min-w-0 space-y-4" aria-label="工厂设备编辑器">
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="min-w-[min(100%,12rem)] flex-1"><span className="field-label">从设备库添加</span>
        <select className={selectStyle} disabled={!packages.length} value={add ? packageKey(add) : ""} onChange={e => setAddKey(e.target.value)}>
          {!packages.length && <option value="">工程内尚无工厂设备包</option>}
          {packages.map(p => <option value={packageKey(p)} key={packageKey(p)}>{displayPackage(p)}</option>)}
        </select></label>
      <Button type="button" variant="outline" disabled={!add || draft.resources.length >= FACTORY_LIMITS.resources}
        onClick={() => add && onAddResource(add)}><Plus />添加设备</Button>
      {onImport && <Button type="button" variant="ghost" onClick={onImport}><Upload />导入设备包或 BOM</Button>}
    </div>
    {!selected ? <div className="surface-inset space-y-2 p-4 text-sm text-muted-foreground">
      <p>{packages.length ? "选择一个设备包，添加工厂中的第一台设备。" : "导入设备包后即可放置工位、输送线和移动机器人。"}</p>
      {!packages.length && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <a className="text-primary underline-offset-4 hover:underline" href={import.meta.env.BASE_URL + "assemblies/cnc-factory/devices.library.json"} download>示例设备库</a>
        <a className="text-primary underline-offset-4 hover:underline" href={import.meta.env.BASE_URL + "assemblies/cnc-factory/bom.csv"} download>示例 BOM</a>
      </div>}
    </div>
      : <div className="surface-inset min-w-0 space-y-4 p-3 sm:p-4">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-[min(100%,12rem)] flex-1"><span className="field-label">编辑设备实例</span>
            <select className={selectStyle} value={selected.id} onChange={e => onSelect(e.target.value)}>
              {draft.resources.map(r => <option key={r.id} value={r.id}>{r.name || r.id} · {r.id}</option>)}
            </select></label>
          <Button type="button" variant="ghost" size="sm" onClick={() => remove(selected.id)}><Trash2 />移除设备</Button>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0"><span className="field-label">设备名称</span>
            <Input value={selected.name} maxLength={160} onChange={e => replace({ ...selected, name: e.target.value })} /></label>
          <label className="min-w-0"><span className="field-label">设备型号与修订</span>
            <select className={selectStyle} ref={replacementRef} value={selected.packageKey} onChange={e => {
              const next = alternatives.find(p => packageKey(p) === e.target.value);
              if (!next) return;
              const updated = replaceFactoryResourcePackage(selected, next);
              const matching = materials.filter(r => r.binding?.kind === "device" && r.binding.key === updated.packageKey);
              replace(selected.materialId && matching.length === 1 ? { ...updated, materialId: matching[0].id } : updated);
            }}>
              {!current && <option value={selected.packageKey}>{selected.packageKey ? "原设备修订尚未安装" : "选择设备包"}</option>}
              {alternatives.map(p => <option value={packageKey(p)} key={packageKey(p)}>{displayPackage(p)}</option>)}
            </select></label>
          {(["X", "Y"] as const).map((axis, index) => <label key={axis} className="min-w-0"><span className="field-label">{axis} 坐标（m）</span>
            <Input type="number" step="any" value={numeric(selected.positionM[index])} onChange={e => {
              const positionM: [number, number] = [...selected.positionM]; positionM[index] = e.target.valueAsNumber;
              replace({ ...selected, positionM });
            }} /></label>)}
          {(matchingRows.length > 0 || selected.materialId) && <label className="min-w-0 sm:col-span-2"><span className="field-label">BOM 物料</span>
            <select value={selected.materialId ?? ""} className={selectStyle} onChange={e => {
              const updated = { ...selected };
              if (e.target.value) updated.materialId = e.target.value; else delete updated.materialId;
              replace(updated);
            }}>
              <option value="">直接使用设备库修订</option>
              {selected.materialId && !matchingRows.some(r => r.id === selected.materialId) && <option value={selected.materialId}>
                原物料待核对 · {materials.find(r => r.id === selected.materialId)?.name ?? selected.materialId}</option>}
              {matchingRows.map(r => <option value={r.id} key={r.id}>{r.name} · {r.quantity}{r.unit ?? " 件"} · {r.model || r.id}</option>)}
            </select></label>}
        </div>
        {current?.factory && <div className="min-w-0 space-y-2 border-t pt-3">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-sm font-medium">{model?.label ?? "未安装的设备模型"}</span>
            <span className="mono min-w-0 break-all text-xs text-muted-foreground">Modelica · {current.factory.modelRef.id} @ {current.factory.modelRef.version}</span></p>
          {model && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {model.parameters.map(spec => <label key={spec.key} className="min-w-0"><span className="field-label">{spec.label}（{spec.unit}）</span>
              <Input type="number" step="any" min="0" value={numeric(selected.parameters?.[spec.key])}
                placeholder={sources[spec.key] ? `${sources[spec.key].kind === "part" ? "部件" : "设备包"} · ${sources[spec.key].value}` : "待填写"}
                onChange={e => {
                  const parameters = { ...selected.parameters };
                  if (e.target.value === "") delete parameters[spec.key]; else parameters[spec.key] = e.target.valueAsNumber;
                  const updated = { ...selected };
                  if (Object.keys(parameters).length) updated.parameters = parameters; else delete updated.parameters;
                  replace(updated);
                }} />
              {current.factory?.partParameters?.[spec.key] && <span className="mt-1 block break-words text-xs text-muted-foreground">
                {selected.parameters?.[spec.key] === undefined ? "取自部件" : "实例值覆盖部件"} · {current.factory.partParameters[spec.key].path.join(" / ")} · {current.factory.partParameters[spec.key].rating}
              </span>}</label>)}
          </div>}
          <Button size="sm" variant="outline" onClick={() => onOpenStructure(selected.id)}>拆解此设备</Button>
          <details className="pt-1 text-xs leading-5 text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">设备修订与资料来源</summary>
            <p className="mt-2 break-words">{displayPackage(current)}</p>
            {model && <p className="break-all">模型接口 · {model.interface}</p>}
            <p className="break-words">{current.source.url ? <a className="text-primary hover:underline" href={current.source.url} target="_blank" rel="noreferrer">{current.source.title}</a> : current.source.title}
              {" · "}{current.source.locator}</p>
          </details>
        </div>}
      </div>}
  </section>;
}

function ResourceChoices({ label, options, selected, onChange }: {
  label: string; options: FactoryResource[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const missing = selected.filter(id => !options.some(r => r.id === id));
  return <fieldset className="min-w-0"><legend className="field-label">{label}</legend>
    <div className="flex min-w-0 flex-wrap gap-2">
      {[...options.map(r => ({ id: r.id, name: r.name || r.id })), ...missing.map(id => ({ id, name: `${id}（待核对）` }))].map(r =>
        <label key={r.id} className="flex min-w-0 max-w-full cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-primary/10">
          <input type="checkbox" className="mt-1 shrink-0 accent-primary" checked={selected.includes(r.id)} onChange={e =>
            onChange(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} />
          <span className="min-w-0 break-words">{r.name}</span></label>)}
      {!options.length && !missing.length && <span className="text-xs text-muted-foreground">暂无兼容设备</span>}
    </div>
  </fieldset>;
}

function LineEditor({ workspace, draft, onChange }: Props) {
  const [lineId, setLineId] = useState(draft.lines[0]?.id ?? "");
  const [stageId, setStageId] = useState("");
  const line = draft.lines.find(l => l.id === lineId) ?? draft.lines[0];
  const stage = line?.stages.find(s => s.id === stageId) ?? line?.stages[0];
  const index = stage && line ? line.stages.indexOf(stage) : -1;
  const totalStages = draft.lines.reduce((n, l) => n + l.stages.length, 0);
  const roles = new Map(workspace.packages.map(pkg => [packageKey(pkg), getFactoryModel(pkg.factory?.modelRef)?.role]));
  function edit(next: FactoryLine) { onChange({ ...draft, lines: draft.lines.map(l => l.id === next.id ? next : l) }); }
  function editStage(next: FactoryStage) { edit({ ...line, stages: line.stages.map(s => s.id === next.id ? next : s) }); }
  function setStages(stages: FactoryStage[]) {
    edit({ ...line, stages: stages.map((s, i) => i === 0 && s.carriers.length ? { ...s, carriers: [] } : s) });
  }
  function move(offset: number) {
    const ordered = [...line.stages];
    [ordered[index], ordered[index + offset]] = [ordered[index + offset], ordered[index]];
    setStages(ordered);
  }
  return <section aria-label="工厂产线编辑器" className="min-w-0 space-y-4">
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="min-w-[min(100%,12rem)] flex-1"><span className="field-label">编辑产线</span>
        <select className={selectStyle} value={line?.id ?? ""} disabled={!line} onChange={e => { setLineId(e.target.value); setStageId(""); }}>
          {!line && <option value="">尚无产线</option>}
          {draft.lines.map(l => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}
        </select></label>
      <Button type="button" variant="outline" disabled={draft.lines.length >= FACTORY_LIMITS.lines} onClick={() => {
        const id = nextId("line-", draft.lines);
        const addition = { id, name: `产线 ${draft.lines.length + 1}`, batch: { quantity: 1, releaseIntervalS: 0 }, stages: [] };
        onChange({ ...draft, lines: [...draft.lines, addition] }); setLineId(id); setStageId("");
      }}><Plus />添加产线</Button>
      {line && <Button variant="ghost" size="sm" type="button" onClick={() => {
        const lines = draft.lines.filter(l => l.id !== line.id); onChange({ ...draft, lines }); setLineId(lines[0]?.id ?? ""); setStageId("");
      }}><Trash2 />移除产线</Button>}
    </div>
    {line && <div className="surface-inset min-w-0 space-y-4 p-3 sm:p-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <label className="min-w-0"><span className="field-label">产线名称</span><Input value={line.name} maxLength={160} onChange={e => edit({ ...line, name: e.target.value })} /></label>
        <label className="min-w-0"><span className="field-label">批量（件）</span><Input type="number" min="1" max={FACTORY_LIMITS.jobs} step="1" value={numeric(line.batch.quantity)}
          onChange={e => edit({ ...line, batch: { ...line.batch, quantity: e.target.valueAsNumber } })} /></label>
        <label className="min-w-0"><span className="field-label">投料间隔（s）</span><Input type="number" min="0" step="any" value={numeric(line.batch.releaseIntervalS)}
          onChange={e => edit({ ...line, batch: { ...line.batch, releaseIntervalS: e.target.valueAsNumber } })} /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <h3 className="text-sm font-semibold">工艺顺序</h3>
        <Button type="button" size="sm" variant="outline" disabled={totalStages >= FACTORY_LIMITS.stages} onClick={() => {
          const addition = newStage(line.stages);
          setStages([...line.stages, addition]); setStageId(addition.id);
        }}><Plus />添加工序</Button>
      </div>
      {line.stages.length > 0 && <ol className="flex flex-wrap gap-1.5" aria-label="依次选择工序">
        {line.stages.map((s, i) => <li key={s.id} className="max-w-full"><Button type="button" size="sm" variant={s === stage ? "secondary" : "ghost"}
          aria-pressed={s === stage} className="max-w-full" onClick={() => setStageId(s.id)}><span className="mono text-xs text-muted-foreground">{i + 1}</span>
          <span className="truncate">{s.name || s.id}</span></Button></li>)}
      </ol>}
      {stage && <div className="min-w-0 space-y-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0"><span className="field-label">工序名称</span><Input value={stage.name} maxLength={160} onChange={e => editStage({ ...stage, name: e.target.value })} /></label>
          <label className="min-w-0"><span className="field-label">工序类型</span><select className={selectStyle} value={stage.operation} onChange={e => {
            const operation = e.target.value as FactoryStage["operation"];
            editStage({ ...stage, operation, stations: stage.stations.filter(id => roles.get(draft.resources.find(r => r.id === id)?.packageKey ?? "") === operation) });
          }}><option value="handle">上下料</option><option value="machine">加工</option></select></label>
        </div>
        <ResourceChoices label={`候选${roleNames[stage.operation]}工位`} options={draft.resources.filter(r => roles.get(r.packageKey) === stage.operation)}
          selected={stage.stations} onChange={stations => editStage({ ...stage, stations })} />
        {index > 0 && <div className="space-y-1.5"><ResourceChoices label="入站运输设备" options={draft.resources.filter(r => transport(roles.get(r.packageKey)))}
          selected={stage.carriers} onChange={carriers => editStage({ ...stage, carriers })} />
          <p className="text-xs text-muted-foreground">同一位置可直接交接。跨工位时选取输送线或移动机器人。</p></div>}
        <div className="flex flex-wrap gap-1 border-t pt-2">
          <Button type="button" variant="ghost" size="sm" disabled={index < 1} onClick={() => move(-1)}><ArrowUp />工序前移</Button>
          <Button type="button" variant="ghost" size="sm" disabled={index >= line.stages.length - 1} onClick={() => move(1)}><ArrowDown />工序后移</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => {
            const stages = line.stages.filter(s => s.id !== stage.id); setStages(stages); setStageId(stages[Math.min(index, stages.length - 1)]?.id ?? "");
          }}><Trash2 />移除工序</Button>
        </div>
      </div>}
    </div>}
  </section>;
}

export default function FactoryEditor(props: Props) {
  return <div className="surface min-w-0 space-y-4 p-4 sm:p-5">
    <label className="block max-w-lg"><span className="field-label">工厂名称</span>
      <Input value={props.draft.name} maxLength={160} onChange={e => props.onChange({ ...props.draft, name: e.target.value })} /></label>
    {props.tab === "devices" ? <DeviceEditor {...props} /> : <LineEditor {...props} />}
  </div>;
}
