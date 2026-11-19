import { useMemo, useState } from "react";
import { PackagePlus, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { getDeviceParts, type CompositionShape, type DeviceComposition, type DevicePart } from "@contracts/device-composition";
import { compositionPath, createLocalLeaf, deriveDeviceComposition, nextStructureRevision } from "@contracts/device-composition-edit";
import { packageKey, signalIdSchema, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  workspace: TwinWorkspace; rootKey: string; path: string[];
  onApply: (workspace: TwinWorkspace, newRootKey: string) => void; onCancel: () => void;
};
type RatingRow = { row: string; id: string; label: string; unit: string; value: string };
type PartRow = Omit<DevicePart, "quantity"> & { row: string; quantity: string };
const slotsPerPage = 12;
const shapes: Record<CompositionShape, string> = {
  box: "块体", plate: "板件", shaft: "轴杆", ring: "圆环", gear: "齿轮", coil: "线圈", ball: "滚珠", belt: "环带",
};
const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const labelStyle = "mb-1 block text-xs text-muted-foreground";
const displayPackage = (p: DevicePackage) => `${p.model} · ${p.manufacturer} · ${p.revision}`;
const message = (e: unknown) => e instanceof Error ? e.message : "无法保存设备结构，请核对输入。";

function nextSlotId(parts: PartRow[]) {
  const ids = new Set(parts.map(part => part.id.trim()));
  let i = 1;
  while (ids.has(`part${i}`)) i++;
  return `part${i}`;
}

function ratingRows(comp?: DeviceComposition): RatingRow[] {
  return Object.entries(comp?.ratings ?? {}).map(([id, r]) => ({
    row: nanoid(), id, label: r.label, unit: r.unit, value: String(r.value),
  }));
}

function readRatings(rows: RatingRow[]) {
  const entries = new Map<string, { label: string; value: number; unit: string }>();
  for (const row of rows) {
    const id = row.id.trim(), value = Number(row.value);
    if (!signalIdSchema.safeParse(id).success) throw new Error("请为每项额定值填写有效标识，例如 lineSpeed。");
    if (entries.has(id)) throw new Error(`额定值标识 ${id} 重复。`);
    if (!row.label.trim() || !row.unit.trim() || !row.value.trim() || !Number.isFinite(value)) throw new Error(`请补全额定值 ${id} 的名称、有限数值和单位。`);
    entries.set(id, { label: row.label.trim(), unit: row.unit.trim(), value });
  }
  return entries.size ? Object.fromEntries(entries) : undefined;
}

function RatingFields({ rows, change }: { rows: RatingRow[]; change: (next: RatingRow[]) => void }) {
  function update(id: string, patch: Partial<RatingRow>) { change(rows.map(row => row.row === id ? { ...row, ...patch } : row)); }
  return <details className="rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium">部件额定值（{rows.length}）</summary>
    <div className="mt-3 space-y-3">{rows.map((r, i) => <div key={r.row} className="grid min-w-0 gap-2 border-b pb-3 sm:grid-cols-2">
      {([["id", "额定值标识"], ["label", "额定名称"], ["value", "额定数值"], ["unit", "单位"]] as const).map(([key, caption]) =>
        <label key={key} className="min-w-0"><span className={labelStyle}>{caption}</span><Input aria-label={`第 ${i + 1} 项${caption}`}
          type={key === "value" ? "number" : "text"} step={key === "value" ? "any" : undefined}
          value={r[key]} onChange={e => update(r.row, { [key]: e.target.value })} /></label>)}
      <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => change(rows.filter(v => v.row !== r.row))}><Trash2 />移除额定值</Button>
    </div>)}
      <Button type="button" size="sm" variant="outline" onClick={() => change([...rows, { row: nanoid(), id: "", label: "", value: "", unit: "" }])}><Plus />添加额定值</Button>
    </div>
  </details>;
}

function ShapeSelect({ value, change }: { value: CompositionShape | ""; change: (value: CompositionShape | "") => void }) {
  return <label className="min-w-0"><span className={labelStyle}>示意外形</span>
    <select className={selectStyle} value={value} onChange={e => change(e.target.value as CompositionShape | "")}>
      <option value="">通用示意</option>{Object.entries(shapes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>;
}

export function LocalLeafForm({ onCreate, submitLabel = "创建最小件", onCancel }: {
  onCreate: (part: DevicePackage) => void; submitLabel?: string; onCancel?: () => void;
}) {
  const [identity, setIdentity] = useState({ manufacturer: "自建部件", model: "", revision: "1", note: "" });
  const [shape, setShape] = useState<CompositionShape | "">(""), [ratings, setRatings] = useState<RatingRow[]>([]);
  const [error, setError] = useState("");
  function add() {
    try {
      if (!identity.model.trim() || !identity.manufacturer.trim() || !identity.revision.trim()) throw new Error("请填写最小件的型号、制造商和修订。");
      onCreate(createLocalLeaf({ ...identity, shape: shape || undefined, ratings: readRatings(ratings) }));
      setError("");
    } catch (e) { setError(message(e)); }
  }
  return <section aria-label="新建最小件" className="min-w-0 space-y-3" onChange={() => setError("")}>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {([["model", "最小件型号"], ["manufacturer", "制造商或制作者"], ["revision", "最小件修订"]] as const).map(([key, caption]) =>
        <label key={key} className="min-w-0"><span className={labelStyle}>{caption}</span><Input maxLength={160} value={identity[key]}
          onChange={e => setIdentity({ ...identity, [key]: e.target.value })} /></label>)}
      <ShapeSelect value={shape} change={setShape} />
    </div>
    <label className="block"><span className={labelStyle}>拆解依据或来源备注</span><Input value={identity.note}
      placeholder="如采购图号、装配图版本或教学设定" onChange={e => setIdentity({ ...identity, note: e.target.value })} /></label>
    <RatingFields rows={ratings} change={setRatings} />
    <p className="text-xs text-muted-foreground">提交即把该修订声明为本工程的最小装配件。</p>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={add}><PackagePlus />{submitLabel}</Button>
      {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消新建</Button>}</div>
  </section>;
}

function EditForm({ workspace, rootKey, path, onApply, onCancel, trail }: Props & { trail: DevicePackage[] }) {
  const target = trail[trail.length - 1], initial = target.composition;
  const [basis] = useState(() => JSON.stringify(trail));
  const [kind, setKind] = useState<"leaf" | "assembly" | "">(initial?.kind ?? "");
  const [parts, setParts] = useState<PartRow[]>(() => (initial?.kind === "assembly" ? initial.parts : [])
    .map(p => ({ ...p, row: nanoid(), quantity: String(p.quantity) })));
  const [ratings, setRatings] = useState<RatingRow[]>(() => ratingRows(initial));
  const [revision, setRevision] = useState(() => nextStructureRevision(workspace, rootKey));
  const [note, setNote] = useState(initial?.note ?? ""), [shape, setShape] = useState<CompositionShape | "">(initial?.shape ?? "");
  const [newLeafOpen, setNewLeafOpen] = useState(false), [additions, setAdditions] = useState<DevicePackage[]>([]);
  const [slotSettings, setSlotSettings] = useState(""), [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const stale = basis !== JSON.stringify(trail);
  const repeated = path.flatMap((slot, i) => getDeviceParts(trail[i]).filter(part => part.id === slot && part.quantity > 1));
  const options = useMemo(() => new Map([...workspace.packages, ...additions].map(p => [packageKey(p), p])), [workspace.packages, additions]);
  const choices = useMemo(() => [...options].map(([key, pkg]) => <option key={key} value={key}>{displayPackage(pkg)}</option>), [options]);
  const pages = Math.max(1, Math.ceil(parts.length / slotsPerPage)), first = Math.min(page, pages - 1) * slotsPerPage;
  function addSlot(pkg?: DevicePackage) {
    const row = nanoid();
    setParts([...parts, { row, id: nextSlotId(parts), label: pkg?.model ?? "", quantity: "1", packageKey: pkg ? packageKey(pkg) : "" }]);
    setPage(Math.floor(parts.length / slotsPerPage));
    setSlotSettings(pkg ? "" : row);
    setError("");
  }
  function splitSlot(part: PartRow) {
    const one = { ...part, row: nanoid(), id: nextSlotId(parts), quantity: "1" };
    setParts(parts.flatMap(p => p.row === part.row ? [{ ...p, quantity: String(Number(p.quantity) - 1) }, one] : [p]));
    setPage(Math.floor((parts.indexOf(part) + 1) / slotsPerPage));
    setError("");
  }
  function addLeaf(pkg: DevicePackage) {
    const key = packageKey(pkg), existing = options.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(pkg)) throw new Error("这个型号与修订已用于其他内容，请更改修订号。");
    if (!existing) setAdditions([...additions, pkg]);
    addSlot(pkg); setNewLeafOpen(false);
  }
  function changePart(row: string, patch: Partial<PartRow>) {
    setParts(parts.map(p => p.row === row ? { ...p, ...patch } : p));
  }
  function save() {
    try {
      if (!kind || stale) return;
      const shared = { ...(shape && { shape }), ...(note.trim() && { note: note.trim() }), ...(ratings.length && { ratings: readRatings(ratings) }) };
      const next: DeviceComposition = kind === "leaf" ? { kind, ...shared } : { kind, ...shared, parts: parts.map((p, i) => {
        if (!p.packageKey || !p.label.trim()) throw new Error(`请填写第 ${i + 1} 个槽位的名称并选择子件修订。`);
        const quantity = Number(p.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`“${p.label}”的单台用量须为正安全整数。`);
        return { id: p.id.trim(), label: p.label.trim(), packageKey: p.packageKey, quantity };
      }) };
      if (next.kind === "assembly" && !next.parts.length) throw new Error("请为装配加入至少一个直接子件。");
      const updated = deriveDeviceComposition(workspace, rootKey, path, next, revision, additions);
      onApply(updated.workspace, updated.rootKey);
    } catch (e) { setError(message(e)); }
  }
  return <section aria-label="编辑设备组成" className="surface min-w-0 space-y-4 p-3 sm:p-4" onChange={() => setError("")}>
    <header><h3 className="text-base font-semibold">编辑本层组成</h3><p className="mt-1 break-all text-xs text-muted-foreground">
      {trail.map(p => p.model).join(" → ")} · {target.revision}</p></header>
    {repeated.length > 0 && <p className="text-xs leading-5 text-muted-foreground">
      {repeated.map(p => `“${p.label}” × ${p.quantity}`).join("、")} 按槽位共用修订。本次修改会应用于槽内各件。要单独修改一件，可以先在相应父层选择“拆出 1 件”。
    </p>}
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="min-w-0"><span className={labelStyle}>本层结构类型</span><select className={selectStyle} value={kind}
        onChange={e => { setKind(e.target.value as typeof kind); setNewLeafOpen(false); }}>
        <option value="" disabled>待补组成明细</option><option value="assembly">含子件的装配</option><option value="leaf">明确为最小件</option>
      </select></label><ShapeSelect value={shape} change={setShape} />
    </div>
    {kind === "assembly" && <div className="space-y-3" aria-label="直接子件槽位">
      {pages > 1 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Button size="sm" type="button" variant="outline" disabled={!first} onClick={() => setPage(first / slotsPerPage - 1)}>上一页槽位</Button>
        <span>{first + 1}–{Math.min(parts.length, first + slotsPerPage)} / {parts.length}</span>
        <Button size="sm" type="button" variant="outline" disabled={first + slotsPerPage >= parts.length} onClick={() => setPage(first / slotsPerPage + 1)}>下一页槽位</Button>
      </div>}
      {parts.slice(first, first + slotsPerPage).map((p, index) => {
        const i = first + index;
        return <div key={p.row} className="surface-inset grid min-w-0 grid-cols-[minmax(0,1fr)_5rem] gap-2 p-3">
        <button type="button" className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left text-sm hover:text-primary"
          aria-expanded={slotSettings === p.row} aria-label={`编辑第 ${i + 1} 个槽位信息`}
          onClick={() => setSlotSettings(slotSettings === p.row ? "" : p.row)}>
          <strong className="break-all font-medium">{p.label || "新槽位"}</strong><span className="mono break-all text-xs text-muted-foreground">{p.id}</span><Pencil className="size-3" />
        </button>
        {slotSettings === p.row && <div className="col-span-2 grid min-w-0 grid-cols-2 gap-2">
          <label className="min-w-0"><span className={labelStyle}>槽位标识</span><Input aria-label={`第 ${i + 1} 个槽位标识`} maxLength={80} value={p.id} onChange={e => changePart(p.row, { id: e.target.value })} /></label>
          <label className="min-w-0"><span className={labelStyle}>槽位名称</span><Input aria-label={`第 ${i + 1} 个槽位名称`} value={p.label} onChange={e => changePart(p.row, { label: e.target.value })} /></label>
        </div>}
        <label className="min-w-0"><span className={labelStyle}>子件型号与修订</span><select aria-label={`第 ${i + 1} 个子件修订`} className={selectStyle}
          value={p.packageKey} onChange={e => changePart(p.row, { packageKey: e.target.value, ...(p.label.trim() ? {} : { label: options.get(e.target.value)?.model ?? "" }) })}>
          <option value="">选择已安装的子件</option>
          {p.packageKey && !options.has(p.packageKey) && <option value={p.packageKey}>待安装 · {p.packageKey}</option>}
          {choices}
        </select></label>
        <label className="min-w-0"><span className={labelStyle}>单台用量</span><Input aria-label={`第 ${i + 1} 个子件单台用量`} type="number" min="1" step="1"
          value={p.quantity} onChange={e => changePart(p.row, { quantity: e.target.value })} /></label>
        <div className="col-span-2 flex flex-wrap items-center gap-1">
          {Number.isSafeInteger(Number(p.quantity)) && Number(p.quantity) > 1 && <Button type="button" size="sm" variant="outline" aria-label={`第 ${i + 1} 个槽位拆出 1 件`}
            onClick={() => splitSlot(p)}>拆出 1 件</Button>}
          <Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={`移除第 ${i + 1} 个子件`}
            onClick={() => { setParts(parts.filter(v => v.row !== p.row)); setError(""); }}><Trash2 />移除子件</Button>
        </div>
      </div>;
      })}
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => addSlot()}><Plus />添加已有子件</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setNewLeafOpen(true)}><PackagePlus />新建并加入最小件</Button></div>
      {newLeafOpen && <div className="surface-inset p-3"><LocalLeafForm onCreate={addLeaf} onCancel={() => setNewLeafOpen(false)} submitLabel="加入当前草稿" /></div>}
    </div>}
    {kind === "leaf" && <p className="text-xs text-muted-foreground">此修订将以当前零件作为拆解边界。</p>}
    <RatingFields rows={ratings} change={setRatings} />
    <label className="block"><span className={labelStyle}>组成备注或资料依据</span><Input value={note} onChange={e => setNote(e.target.value)} /></label>
    <label className="block max-w-sm"><span className={labelStyle}>根设备新修订</span><Input maxLength={160} value={revision} onChange={e => setRevision(e.target.value)} /></label>
    <p className="text-xs leading-5 text-muted-foreground">保存将沿所选槽位逐层派生修订，根设备为 {trail[0].model}。绑定到此路径的模型参数将随选件重新读取。</p>
    {(error || stale) && <p role="alert" className="whitespace-pre-line break-all text-sm text-destructive">{stale ? "设备路径已经更新，请返回后重新打开编辑器。" : error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!kind || stale || newLeafOpen} onClick={save}><Save />保存结构新修订</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消编辑</Button></div>
  </section>;
}

export default function DeviceCompositionEditor(props: Props) {
  let trail: DevicePackage[];
  try {
    trail = compositionPath(props.workspace.packages, props.rootKey, props.path);
    if (trail[trail.length - 1].mechanics?.kind === "assembly") throw new Error("这一层的槽位来自机械安装点。请在“安装点与关节”中修改其安装关系。");
  } catch (e) {
    return <div className="surface space-y-3 p-3"><p role="alert" className="break-all text-sm">{message(e)}</p>
      <Button type="button" size="sm" variant="outline" onClick={props.onCancel}>返回部件结构</Button></div>;
  }
  return <EditForm key={JSON.stringify([props.rootKey, props.path])} {...props} trail={trail} />;
}
