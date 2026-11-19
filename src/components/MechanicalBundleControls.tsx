import { useMemo, useState } from "react";
import { Download, PackagePlus } from "lucide-react";
import { exportMechanicalBundle, mechanicalSubassembly, type MechanicalAssembly, type MechanicalBundle } from "@contracts/mechanical-assembly";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { downloadJson } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { workspace: TwinWorkspace; assembly: MechanicalAssembly | null; onInstallBundle: (bundle: MechanicalBundle) => void };
const fields = [["manufacturer", "制作者或厂商"], ["model", "子装配型号"], ["revision", "子装配修订"]] as const;

export default function MechanicalBundleControls({ workspace, assembly, onInstallBundle }: Props) {
  const [root, setRoot] = useState("");
  const [identity, setIdentity] = useState({ manufacturer: "", model: "", revision: "" });
  const [message, setMessage] = useState({ error: "", notice: "" });
  const scoped = useMemo(() => {
    try { return { value: assembly && root ? mechanicalSubassembly(assembly, root) : assembly, error: "" }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : "无法选取这棵子树。" }; }
  }, [assembly, root]);

  function pack(install: boolean) {
    try {
      if (!scoped.value) throw new Error(scoped.error || "请先补全装配定义。");
      for (const [field, label] of fields) if (!identity[field].trim()) throw new Error(`请填写${label}。`);
      const bundle = exportMechanicalBundle(workspace, scoped.value, identity);
      if (install) onInstallBundle(bundle);
      else downloadJson(bundle, `${identity.model}-${identity.revision}.mechanical-bundle.json`);
      setMessage({ error: "", notice: install ? "子装配及其依赖已加入设备库。" : "已导出含依赖设备的子装配包。" });
    } catch (cause) { setMessage({ error: cause instanceof Error ? cause.message : "封装失败，请核对设备与安装点。", notice: "" }); }
  }

  return <details className="surface min-w-0 p-4 sm:p-5">
    <summary className="cursor-pointer text-sm font-semibold">封装子装配</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">子装配以所选根的输入为基底，将当前输出安装点公开为 out。导出的包包含所需设备，可在另一工程中导入。</p>
      <label className="block max-w-md"><span className="field-label">封装范围</span>
        <select aria-label="封装范围" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={root}
          onChange={e => { setRoot(e.target.value); setMessage({ error: "", notice: "" }); }}>
          <option value="">整个装配</option>
          {root && !assembly?.nodes.some(n => n.id === root) && <option value={root}>{root}（实例待核对）</option>}
          {assembly?.nodes.map(n => <option key={n.id} value={n.id}>{n.id} 及其后代</option>)}
        </select></label>
      <div className="grid gap-3 sm:grid-cols-3">{fields.map(([field, label]) => <label className="min-w-0" key={field}>
        <span className="field-label">{label}</span><Input value={identity[field]} onChange={e => {
          setIdentity({ ...identity, [field]: e.target.value }); setMessage({ error: "", notice: "" });
        }} /></label>)}</div>
      {scoped.error && <p className="text-xs text-amber-300">{scoped.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!scoped.value} onClick={() => pack(false)}><Download />导出子装配包</Button>
        <Button size="sm" variant="outline" disabled={!scoped.value} onClick={() => pack(true)}><PackagePlus />安装到设备库</Button>
      </div>
      {message.error && <p role="alert" className="text-sm text-destructive">{message.error}</p>}
      {message.notice && <p role="status" className="text-xs text-primary">{message.notice}</p>}
    </div>
  </details>;
}
