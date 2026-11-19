import { useLayoutEffect, useState } from "react";
import { Download, PackagePlus } from "lucide-react";
import { buildServoMotor } from "@contracts/motor-assembly";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Kind = "stator" | "rotor" | "bearing";
const kinds: Kind[] = ["stator", "rotor", "bearing"];
const names = { stator: "定子", rotor: "转子", bearing: "轴承" };
const highlights = { stator: ["phaseResistanceOhm", "qInductanceH"], rotor: ["rotorFluxWb", "rotorInertiaKgM2"], bearing: ["bearingViscousNmS", "boreMm"] };
const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const kit = import.meta.env.BASE_URL + "assemblies/motor-kit/components.library.json";
const unitNames: Record<string, string> = { Ohm: "Ω", "kg.m2": "kg·m²", "N.m.s/rad": "N·m·s/rad", "1": "" };

function ratingValue({ value, unit }: { value: number; unit: string }) {
  if (unit === "H" && Math.abs(value) < 0.1) return Number((value * 1000).toPrecision(8)) + " mH";
  if (unit === "Wb" && Math.abs(value) < 0.1) return Number((value * 1000).toPrecision(8)) + " mWb";
  return [value, unitNames[unit] ?? unit].filter(x => x !== "").join(" ");
}

interface Props {
  workspace: TwinWorkspace;
  initialPartKey?: string;
  preferredFit?: string;
  submitLabel: string;
  onBuild: (device: DevicePackage) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function availableRevision(workspace: TwinWorkspace, manufacturer: string, model: string) {
  const taken = new Set(workspace.packages.filter(p => p.manufacturer === manufacturer.trim() && p.model === model.trim()).map(p => p.revision));
  let n = 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

export default function MotorAssemblyForm({ workspace, initialPartKey, preferredFit, submitLabel, onBuild, onDirtyChange }: Props) {
  const initial = workspace.packages.find(p => packageKey(p) === initialPartKey);
  const fit = initial?.motorPhysics?.fit ?? preferredFit;
  const [draft, setDraft] = useState(() => ({
    manufacturer: "工程自建", model: "自组伺服电机", revision: undefined as string | undefined,
    stator: initial?.motorPhysics?.kind === "stator" ? initialPartKey : undefined,
    rotor: initial?.motorPhysics?.kind === "rotor" ? initialPartKey : undefined,
    bearing: initial?.motorPhysics?.kind === "bearing" ? initialPartKey : undefined,
    previous: undefined as string | undefined,
  }));
  const [error, setError] = useState("");
  const revision = draft.revision ?? availableRevision(workspace, draft.manufacturer, draft.model);
  const options = (kind: Kind) => workspace.packages.filter(p => p.motorPhysics?.kind === kind);
  const selection = (kind: Kind, preferred?: string) => {
    const choices = options(kind);
    return draft[kind] ? choices.find(p => packageKey(p) === draft[kind]) :
      choices.find(p => p.motorPhysics?.fit === preferred) ?? choices[0];
  };
  const stator = selection("stator", fit), rotor = selection("rotor", stator?.motorPhysics?.fit), bearing = selection("bearing", stator?.motorPhysics?.fit);
  const selected = { stator, rotor, bearing };
  const signature = JSON.stringify([draft.manufacturer, draft.model, revision, ...kinds.map(k => selected[k] && packageKey(selected[k]!))]);
  const dirty = draft.previous !== undefined && draft.previous !== signature;
  useLayoutEffect(() => {
    onDirtyChange?.(dirty);
    return () => { if (dirty) onDirtyChange?.(false); };
  }, [dirty, onDirtyChange]);

  function edit(patch: Partial<typeof draft>) {
    setError("");
    setDraft(old => ({ ...old, previous: old.previous ?? signature, ...patch }));
  }
  let device: DevicePackage | undefined, issue = "";
  if (stator && rotor && bearing) {
    try {
      device = buildServoMotor(workspace, { manufacturer: draft.manufacturer, model: draft.model, revision,
        statorKey: packageKey(stator), rotorKey: packageKey(rotor), bearingKey: packageKey(bearing) });
    } catch (cause) { issue = cause instanceof Error ? cause.message : "请核对零件规格和电机修订。"; }
  }
  const missing = kinds.filter(k => !selected[k]);
  return <form aria-label="从零件组装伺服电机" className="grid min-w-0 gap-3" onSubmit={event => {
    event.preventDefault();
    if (!device || issue) return;
    try { onBuild(device); setDraft(old => ({ ...old, previous: undefined })); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "电机未能入库，请核对设备修订。"); }
  }}>
    <div className="grid min-w-0 gap-3 sm:grid-cols-3">
      {kinds.map(kind => {
        const part = selected[kind], ratings = part?.composition?.ratings;
        const detail = highlights[kind].flatMap(key => {
          const r = ratings?.[key];
          return r ? [`${r.label} ${ratingValue(r)}`] : [];
        }).join(" · ");
        return <div key={kind} className="min-w-0">
          <label className="block"><span className="field-label">{names[kind]}{kind === "bearing" ? " × 2" : ""}</span>
            <select className={selectClass} aria-label={names[kind] + "型号"} value={part ? packageKey(part) : ""} disabled={!options(kind).length}
              onChange={e => edit({ [kind]: e.target.value })}>
              {!part && <option value="">请选择已安装的{names[kind]}</option>}
              {options(kind).map(p => <option key={packageKey(p)} value={packageKey(p)}>{p.model} · {p.revision} · {p.manufacturer}</option>)}
            </select>
          </label>
          {!!detail && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{detail}</p>}
        </div>;
      })}
    </div>
    {missing.length > 0 && <p className="break-words text-xs leading-5 text-muted-foreground">
      请先导入有模型参数的{missing.map(k => names[k]).join("、")}设备包。
      <a className="ml-2 inline-flex items-center gap-1 text-primary underline underline-offset-2" href={kit} download><Download size={13} />下载教学电机零件库</a>
    </p>}
    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(5rem,.5fr)]">
      <label className="min-w-0"><span className="field-label">电机制造商</span><Input required maxLength={160} value={draft.manufacturer} onChange={e=>edit({ manufacturer:e.target.value })} /></label>
      <label className="min-w-0"><span className="field-label">电机型号</span><Input required maxLength={160} value={draft.model} onChange={e=>edit({ model:e.target.value })} /></label>
      <label className="min-w-0"><span className="field-label">电机修订</span><Input required maxLength={160} value={revision} onChange={e=>edit({ revision:e.target.value })} /></label>
    </div>
    {stator && rotor && bearing && <details className="min-w-0 border-t pt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">三种零件的配合、参数和来源</summary>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">{[stator, rotor, bearing].map(p => <div key={packageKey(p)} className="min-w-0 space-y-1 break-words">
        <p className="font-medium">{p.model} · {p.revision}</p><p className="mono break-all text-muted-foreground">{p.motorPhysics?.fit}</p>
        {Object.entries(p.composition?.ratings ?? {}).map(([key, r]) => <p key={key}>{r.label} · {ratingValue(r)}</p>)}
        <p className="text-muted-foreground">{p.source.title} · {p.source.locator}</p>
      </div>)}</div>
    </details>}
    {(error || issue) && <p role="alert" className="whitespace-pre-line break-words text-xs text-destructive">{error || issue}</p>}
    <div><Button type="submit" disabled={!device || !!issue}><PackagePlus />{submitLabel}</Button></div>
  </form>;
}
