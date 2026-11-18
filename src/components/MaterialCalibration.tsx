import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MaterialRow } from "@contracts/import-catalog";
import { createCalibratedPackage } from "@contracts/material-calibration";
import type { DevicePackage } from "@contracts/twin-device";

type Props = { material: MaterialRow; onInstall: (pkg: DevicePackage) => void };

function initialForm(material: MaterialRow) {
  const source = material.source ?? "";
  const hasUrl = /^https?:\/\//i.test(source);
  return {
    manufacturer: material.manufacturer ?? "", model: material.model ?? "", revision: "",
    title: material.name, url: hasUrl ? source : "", locator: hasUrl ? "" : source,
    excerpt: material.notes && material.notes.length <= 16_000 ? material.notes : "",
    inputLabel: "", inputUnit: "", outputLabel: "", outputUnit: "", x1: "", y1: "", x2: "", y2: "",
  };
}

type Form = ReturnType<typeof initialForm>;
const identityFields = [
  ["manufacturer", "制造商或制作者", "填写厂商或自制设备的制作者"], ["model", "设备型号", "填写型号或自定义编号"],
  ["revision", "设备包修订", "此份标定的修订号"],
] as const;
const portFields = [
  ["inputLabel", "输入名称", "例如压力"], ["inputUnit", "输入单位", "例如 kPa，无量纲填 1"],
  ["outputLabel", "输出名称", "例如电流"], ["outputUnit", "输出单位", "例如 mA，无量纲填 1"],
] as const;
const pointFields = [
  ["x1", "第一点输入"], ["y1", "第一点输出"], ["x2", "第二点输入"], ["y2", "第二点输出"],
] as const;
const sourceFields = [
  ["title", "资料标题", "手册或实测记录名称"], ["locator", "证据位置", "例如第 3 页、台架记录编号"],
  ["url", "资料链接（可选）", "本地资料可留空"],
] as const;

function CalibrationEditor({ material, onInstall }: Props) {
  const [form, setForm] = useState(() => initialForm(material));
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<DevicePackage | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");

  function edit(key: keyof Form, value: string) {
    setForm(previous => ({ ...previous, [key]: value }));
    setConfirmed(false); setPreview(null); setError(""); setNotice("");
  }
  function textField([key, caption, hint]: readonly [keyof Form, string, string]) {
    return <label key={key} className="min-w-0">
      <span className="field-label">{caption}</span>
      <Input value={form[key]} placeholder={hint} onChange={event => edit(key, event.target.value)} />
    </label>;
  }
  function generate() {
    setError(""); setNotice(""); setPreview(null);
    try {
      for (const [key, caption] of pointFields) {
        if (!form[key].trim() || !Number.isFinite(Number(form[key]))) throw new Error(`请填写${caption}的有限数值。`);
      }
      setPreview(createCalibratedPackage({ ...form, confirmedLinear: confirmed,
        inputPoints: [Number(form.x1), Number(form.x2)], outputPoints: [Number(form.y1), Number(form.y2)],
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法生成标定草案。"); }
  }
  function install() {
    if (!preview) return;
    try {
      onInstall(preview);
      setPreview(null); setError(""); setNotice("已安装标定设备并绑定此物料。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "安装标定设备失败。"); }
  }
  const rule = preview?.rules[0], points = preview?.calibration?.inputPoints;
  return <details className="surface-inset rounded-md px-3 py-2.5">
    <summary className="cursor-pointer text-sm font-medium">按两点标定建模</summary>
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">{identityFields.map(textField)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{portFields.map(textField)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{pointFields.map(([key, caption]) => <label className="min-w-0" key={key}>
        <span className="field-label break-all">{caption}{(key.startsWith("x") ? form.inputUnit : form.outputUnit) && `（${key.startsWith("x") ? form.inputUnit : form.outputUnit}）`}</span>
        <Input type="number" step="any" value={form[key]} onChange={event => edit(key, event.target.value)} />
      </label>)}</div>
      <div className="grid gap-3 sm:grid-cols-3">{sourceFields.map(textField)}</div>
      <label className="block"><span className="field-label">手册摘录或实测记录</span>
        <Textarea value={form.excerpt} placeholder="填写两个标定点的资料依据" onChange={event => edit("excerpt", event.target.value)} /></label>
      <label className="flex items-start gap-2 text-xs leading-5">
        <input type="checkbox" checked={confirmed} className="mt-1 accent-primary" onChange={event => {
          setConfirmed(event.target.checked); setPreview(null); setError(""); setNotice("");
        }} />
        <span>我确认使用线性关系连接这两个标定点，区间外按同一直线外推。</span>
      </label>
      <Button type="button" variant="outline" size="sm" onClick={generate}>生成标定草案</Button>
      {preview && rule?.op === "linear" && points && <section aria-label="标定草案" className="space-y-2 rounded-md border bg-background/60 p-3 text-xs">
        <p className="font-medium">{preview.manufacturer} · {preview.model} · {preview.revision}</p>
        <p className="break-words">{form.outputLabel} = {rule.gain} × {form.inputLabel} {rule.offset < 0 ? "−" : "+"} {Math.abs(rule.offset)}</p>
        <p>增益 {rule.gain}，偏置 {rule.offset} {form.outputUnit}。输入标定区间为 {Math.min(...points)} 至 {Math.max(...points)} {form.inputUnit}，超出后仍按此公式外推。</p>
        <Button type="button" size="sm" onClick={install}>安装并绑定此物料</Button>
      </section>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
    </div>
  </details>;
}

export default function MaterialCalibration(props: Props) {
  return <CalibrationEditor key={props.material.id} {...props} />;
}
