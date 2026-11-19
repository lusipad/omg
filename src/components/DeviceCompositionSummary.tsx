import { Fragment, useMemo, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { compositionRollupCsv, rollupDeviceParts, type DeviceRollup } from "@contracts/device-composition";
import type { DevicePackage } from "@contracts/twin-device";
import { downloadBlob, downloadJson } from "@/lib/download";
import { exportDeviceLibrary } from "@/lib/device-library";
import { deviceIdentity, firstPartPath, type CompositionRoot, type PartOccurrence } from "@/lib/device-composition-view";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const states = { leaf: "最小件", unknown: "待补明细", missing: "缺少修订" } as const;
type Scope = "group" | "device" | "part";
type Props = {
  packages: readonly DevicePackage[]; installed: ReadonlyMap<string, DevicePackage>;
  labels: ReadonlyMap<string, string>; roots: readonly CompositionRoot[]; root: CompositionRoot;
  node: PartOccurrence; path: string[]; groupName: string;
  onLocate: (rootId: string, path: string[]) => void;
};

function scaled(report: DeviceRollup, factor: bigint): DeviceRollup {
  if (factor === 1n) return report;
  return { ...report, leafQuantity: String(BigInt(report.leafQuantity) * factor),
    rows: report.rows.map(row => ({ ...row, quantity: String(BigInt(row.quantity) * factor) })) };
}

export default function DeviceCompositionSummary({ packages, installed, labels, roots, root, node, path, groupName, onLocate }: Props) {
  const [chosen, setChosen] = useState<Scope>("group");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [error, setError] = useState("");
  const scope = chosen === "part" && !path.length ? "device" : chosen;
  const group = scope === "group", partial = scope === "part";
  const scopeName = group ? groupName : partial ? node.label : root.label;
  const outcome = useMemo(() => {
    try {
      const report = partial
        ? scaled(rollupDeviceParts(packages, [{ packageKey: node.packageKey, quantity: 1 }]), node.cumulative)
        : rollupDeviceParts(packages, group ? roots : [root]);
      return { report };
    } catch (cause) { return { issue: cause instanceof Error ? cause.message : "无法汇总部件结构。" }; }
  }, [group, partial, packages, roots, root, node.cumulative, node.packageKey]);
  const report = outcome.report;
  const contributions = useMemo(() => {
    if (!selectedKey || !report) return [];
    return (group ? roots : [root]).flatMap(item => {
      const key = partial ? node.packageKey : item.packageKey;
      const suffix = firstPartPath(installed, key, selectedKey);
      if (!suffix) return [];
      const unit = rollupDeviceParts(packages, [{ packageKey: key, quantity: 1 }]).rows.find(row => row.packageKey === selectedKey);
      return unit ? [{ item, quantity: String(BigInt(unit.quantity) * (partial ? node.cumulative : BigInt(item.quantity))),
        path: partial ? [...path, ...suffix] : suffix }] : [];
    });
  }, [selectedKey, report, group, roots, root, partial, node.packageKey, node.cumulative, installed, packages, path]);

  const words = query.trim().toLocaleLowerCase();
  const rows = report?.rows.filter(row => !words || [labels.get(row.packageKey), ...deviceIdentity(row.packageKey, installed.get(row.packageKey)), states[row.status]]
    .some(value => value?.toLocaleLowerCase().includes(words))) ?? [];
  const rootKeys = group ? roots.map(r => r.packageKey) : [partial ? node.packageKey : root.packageKey];
  const select = "h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm";

  return <section aria-label="基本件用量汇总" className="min-w-0 space-y-3">
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="min-w-[min(100%,12rem)] flex-1"><span className="field-label">汇总范围</span>
        <select className={select} value={scope} onChange={e => { setChosen(e.target.value as Scope); setSelectedKey(""); setError(""); }}>
          <option value="group">{groupName}</option>
          {roots.length > 1 && <option value="device">当前设备 · {root.label}</option>}
          {roots.length === 1 && scope === "device" && <option value="device">当前设备 · {root.label}</option>}
          {path.length > 0 && <option value="part">当前节点 · {node.label}</option>}
        </select>
      </label>
      <Button type="button" size="sm" variant="outline" disabled={!report?.rows.length} onClick={() => {
        if (report) downloadBlob("\uFEFF" + compositionRollupCsv(report), scopeName + "-基本件用量.csv", "text/csv;charset=utf-8");
      }}><Download />导出用量 CSV</Button>
      <Button type="button" size="sm" variant="outline" disabled={!report} onClick={() => {
        try { downloadJson(exportDeviceLibrary(packages, rootKeys), scopeName + "-结构设备库.json"); setError(""); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "结构设备库未能导出。"); }
      }}><Download />导出结构设备库</Button>
    </div>
    {(error || outcome.issue) && <p role="alert" className="break-all text-sm text-destructive">{error || outcome.issue}</p>}
    {report && <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y py-2 text-sm">
        <span>已确认 <strong className="mono text-base text-primary" aria-label="最小件总数量">{report.leafQuantity}</strong> 件最小件</span>
        <span className="text-muted-foreground">{report.rows.filter(r => r.status === "leaf").length} 种修订</span>
        {!report.complete && <span className="text-xs text-amber-300">{report.rows.filter(r => r.status !== "leaf").length} 种修订待补，已列于表中</span>}
      </div>
      {report.rows.length > 8 && <Input aria-label="筛选基本件" type="search" placeholder="按名称、型号或状态筛选" value={query} onChange={e => setQuery(e.target.value)} />}
      <div className="max-h-[31rem] overflow-y-auto rounded-md border">
        <table className="w-full table-fixed border-collapse text-left text-xs" aria-label="最小件与待补物料用量">
          <thead className="sticky top-0 z-10 bg-secondary text-muted-foreground"><tr>
            <th className="p-2 font-medium">部件与修订</th><th className="w-[20%] px-1 py-2 text-right font-medium">数量</th><th className="w-[24%] px-2 py-2 font-medium">明细状态</th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const [maker, model, revision] = deviceIdentity(row.packageKey, installed.get(row.packageKey));
            const label = labels.get(row.packageKey) || model, selected = selectedKey === row.packageKey;
            return <Fragment key={row.packageKey}><tr className="border-t align-top">
              <th scope="row" className="p-2 font-normal"><button type="button" aria-expanded={selected}
                aria-label={`查看 ${model} 用量来源`} onClick={() => setSelectedKey(selected ? "" : row.packageKey)}
                className="flex min-w-0 items-start gap-1 text-left font-medium text-foreground hover:text-primary">
                <ChevronDown aria-hidden="true" size={13} className={`mt-0.5 shrink-0 ${selected ? "" : "-rotate-90"}`} /><span className="break-all">{label}</span>
              </button><span className="mt-1 block break-all text-muted-foreground">{[maker, model, revision && "@" + revision].filter(Boolean).join(" · ")}</span></th>
              <td className="break-all px-1 py-2 text-right font-mono tabular-nums">{row.quantity}</td>
              <td className={`break-words px-2 py-2 ${row.status === "leaf" ? "text-muted-foreground" : "text-amber-300"}`}>{states[row.status]}</td>
            </tr>{selected && <tr className="border-t"><td colSpan={3} className="bg-secondary/35 px-3 py-2">
              <p className="mb-1 text-muted-foreground">各设备用量 · 选择后定位到首个安装槽位</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">{contributions.map(c => <button key={c.item.id} type="button"
                onClick={() => onLocate(c.item.id, c.path)} className="rounded-sm break-all text-left text-primary underline underline-offset-2">{c.item.label} · {c.quantity} 件</button>)}</div>
            </td></tr>}</Fragment>;
          })}</tbody>
        </table>
        {!rows.length && <p role="status" className="p-3 text-sm text-muted-foreground">当前筛选没有匹配的部件。</p>}
      </div>
    </>}
  </section>;
}
