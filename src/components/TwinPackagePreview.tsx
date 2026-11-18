import { Box, Download, ExternalLink, PackageCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadJson } from "@/lib/download";
import type { DevicePackage } from "@contracts/twin-device";

function describeRule(rule: DevicePackage["rules"][number], unit?: string) {
  switch (rule.op) {
    case "digitalInput":
      return `接通 > ${rule.onAbove}${unit ? " " + unit : ""}，关断 < ${rule.offBelow}${unit ? " " + unit : ""}，滤波 ${rule.filterMs} ms`;
    case "linear":
      return `输出 = 输入 × ${rule.gain} ${rule.offset < 0 ? "−" : "+"} ${Math.abs(rule.offset)}`;
    case "copy":
      return "输出跟随输入";
  }
}

export function ServoRatings({ servo }: { servo: NonNullable<DevicePackage["servo"]> }) {
  const rows = servo.kind === "drive"
    ? [["额定电流", `${servo.ratedCurrentA} A`], ["峰值电流", `${servo.peakCurrentA} A`]]
    : [
      ["额定功率", `${servo.ratedPowerW} W`],
      ["额定电流", servo.ratedCurrentA === undefined ? "资料未给出" : `${servo.ratedCurrentA} A`],
      ["额定转矩", `${servo.ratedTorqueNm} N·m`],
      ["峰值转矩", `${servo.peakTorqueNm} N·m`],
      ["额定转速", `${servo.ratedSpeedRpm} rpm`],
      ["最高转速", `${servo.maxSpeedRpm} rpm`],
      ["转子惯量", `${servo.rotorInertiaKgM2} kg·m²`],
      ["配套驱动型号", servo.compatibleDriveModels.join("、")],
    ];
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-xs">
    {rows.map(([label, value]) => <div key={label} className="contents">
      <dt className="text-muted-foreground">{label}</dt><dd className="mono break-words">{value}</dd>
    </div>)}
  </dl>;
}

export function DeviceSourceEvidence({ source }: { source: DevicePackage["source"] }) {
  return <section className="surface-inset min-w-0 p-3 sm:p-4">
    <h3 className="text-sm font-medium">资料依据</h3>
    {source.url ? <a href={source.url} target="_blank" rel="noreferrer" className="mt-2 break-words text-sm text-primary hover:underline">
      {source.title} <ExternalLink className="inline size-3.5" />
    </a> : <p className="mt-2 break-words text-sm">{source.title} · 本地资料</p>}
    {source.productUrl && source.productUrl !== source.url && <p className="mt-1">
      <a href={source.productUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">产品官网 <ExternalLink className="inline size-3" /></a>
    </p>}
    <p className="mt-1 break-words text-xs text-muted-foreground">{source.locator}</p>
    <blockquote className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/40 pl-3 text-xs leading-6">{source.excerpt}</blockquote>
  </section>;
}

export default function TwinPackagePreview({ device, installed, error, onClose, onInstall, onAssemble }: {
  device: DevicePackage;
  installed: boolean;
  error: string;
  onClose: () => void;
  onInstall: () => void;
  onAssemble: () => void;
}) {
  const ports = new Map(device.ports.map((port) => [port.id, port]));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto thin-scrollbar sm:max-w-[740px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-xs font-medium text-primary"><Box size={15} />{installed ? "已安装设备" : "安装前核对"}</div>
          <DialogTitle className="break-words text-xl">{device.model}</DialogTitle>
          <DialogDescription>{device.manufacturer} · 设备包版本 {device.revision} · {device.servo ? (device.servo.kind === "drive" ? "伺服驱动器" : "伺服电机") : `${device.ports.length} 个端口 · ${device.rules.length} 条行为规则`}</DialogDescription>
        </DialogHeader>
        <DeviceSourceEvidence source={device.source} />
        {device.calibration && <p className="surface-inset p-3 text-xs">
          已记录的两组标定值为 {device.calibration.inputPoints[0]} → {device.calibration.outputPoints[0]} 和 {device.calibration.inputPoints[1]} → {device.calibration.outputPoints[1]}，范围外按同一条直线外推。
        </p>}
        {device.servo ? <section aria-label="伺服参数" className="space-y-3">
          <h3 className="text-sm font-medium">型号参数</h3><ServoRatings servo={device.servo} />
        </section> : <><section aria-label="仿真行为">
          <h3 className="mb-2 text-sm font-medium">仿真行为</h3>
          <div className="max-h-48 overflow-auto rounded-md border thin-scrollbar">
            <table className="data-table">
              <thead><tr><th>信号路径</th><th>转换规则</th></tr></thead>
              <tbody>{device.rules.map((rule) => (
                <tr key={rule.output}>
                  <td className="break-words text-xs">{ports.get(rule.input)?.label} → {ports.get(rule.output)?.label}</td>
                  <td className="text-xs leading-5">{describeRule(rule, ports.get(rule.input)?.unit)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {device.rules.some((rule) => rule.op === "digitalInput") && <p className="mt-2 text-xs leading-5 text-muted-foreground">仿真中，输入连续越过阈值达到滤波时间才翻转。两阈值之间及边界保持已确认的输出，取消尚未完成的计时。</p>}
        </section>
        <details className="rounded-md border px-3 py-2.5 text-xs">
          <summary className="cursor-pointer font-medium">查看全部端口（{device.ports.length}）</summary>
          <ul className="mt-3 grid max-h-40 gap-2 overflow-auto sm:grid-cols-2">{device.ports.map((port) => (
            <li key={port.id} className="break-words">{port.label} <span className="text-muted-foreground">· {port.direction === "input" ? "输入" : "输出"} · {port.type === "number" ? "数值" : "布尔"}{port.unit ? ` · ${port.unit}` : ""} · {port.id}</span></li>
          ))}</ul>
        </details></>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => downloadJson(device, `${device.model}-${device.revision}.device.json`)}><Download />导出设备包</Button>
          {installed
            ? <Button onClick={onAssemble}><Plus />{device.servo ? "用于伺服仿真" : "添加到仿真装配"}</Button>
            : <Button onClick={onInstall}><PackageCheck />确认安装</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
