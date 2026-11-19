import { useState } from "react";
import { Box, Download, ExternalLink, PackageCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadJson } from "@/lib/download";
import { bundleMechanicalDevice, type MechanicalAssembly } from "@contracts/mechanical-assembly";
import { packageKey, type DevicePackage } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";

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
    {servo.modelRef && <><dt className="text-muted-foreground">绑定模型</dt>
      <dd className="mono break-all">{servo.modelRef.id} @ {servo.modelRef.version}</dd></>}
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

export function MechanicalDefinitionDetails({ definition, packages = [] }: { definition: MechanicalAssembly; packages?: DevicePackage[] }) {
  const types = new Map(packages.map((pkg) => [packageKey(pkg), pkg]));
  const controls = Object.entries(definition.commands);
  return <div className="space-y-2 text-xs">
    <p>装配输出 · <span className="mono break-all">{definition.output.node || "待选节点"} / {definition.output.mount || "待选安装点"}</span></p>
    <div className="max-h-48 overflow-auto rounded-md border">
      <table aria-label="机械装配节点与父安装点" className="w-full table-fixed border-collapse text-left">
        <thead className="sticky top-0 bg-muted"><tr><th scope="col" className="p-2">节点</th><th scope="col" className="p-2">设备修订</th><th scope="col" className="p-2">父节点 / 安装点</th></tr></thead>
        <tbody>{definition.nodes.map((node) => {
          const pkg = types.get(node.packageKey);
          return <tr key={node.id} className="border-t align-top"><th scope="row" className="break-all p-2 font-medium">{node.id}</th>
            <td className="break-all p-2">{pkg ? [pkg.manufacturer, pkg.model, pkg.revision].join(" · ") : node.packageKey || "待选设备修订"}
              {node.materialId && <p className="mt-1 text-muted-foreground">BOM · {node.materialId}</p>}</td>
            <td className="break-all p-2">{node.parent ? (node.parent.node || "待选父节点") + " / " + (node.parent.mount || "待选安装点") : "根节点"}</td></tr>;
        })}</tbody>
      </table>
    </div>
    {controls.length > 0 && <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer font-medium">关节控制量（{controls.length}，按各关节单位）</summary>
      <dl className="mt-2 grid max-h-32 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 overflow-auto">
        {controls.map(([path, value]) => <div key={path} className="contents"><dt className="mono break-all">{path}</dt><dd>{value}</dd></div>)}
      </dl>
    </details>}
  </div>;
}

export function MechanicalDetails({ mechanics }: { mechanics: NonNullable<DevicePackage["mechanics"]> }) {
  if (mechanics.kind === "assembly") return <section aria-label="封装的子装配" className="space-y-2">
    <h3 className="text-sm font-medium">子装配 · {mechanics.assembly.name}</h3>
    <p className="text-xs text-muted-foreground">{mechanics.assembly.nodes.length} 个节点，对外输出安装点为 <span className="mono">out</span>。</p>
    <MechanicalDefinitionDetails definition={mechanics.assembly} />
  </section>;
  const joint = mechanics.joint;
  const mounts = [{ direction: "输入", id: "input", pose: mechanics.input }, ...mechanics.outputs.map((pose) => ({ direction: "可观察输出", id: pose.id, pose }))];
  return <section aria-label="机械接口与关节" className="space-y-2">
    <h3 className="text-sm font-medium">机械接口与关节</h3>
    {joint.type === "fixed" ? <p className="text-xs">固定连接</p> : <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span>{joint.type === "hinge" ? "旋转关节 · 角度控制" : "移动关节 · 位移控制"}</span>
      <span>本地轴向 [{joint.axis.join(", ")}]</span><span>控制范围 {joint.range[0]} 至 {joint.range[1]} {joint.unit}</span>
    </div>}
    <div className="max-h-52 overflow-auto rounded-md border"><table aria-label="机械安装点坐标" className="w-full table-fixed border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-muted"><tr><th scope="col" className="p-2">安装点</th><th scope="col" className="p-2">XYZ（mm）</th><th scope="col" className="p-2">四元数 WXYZ</th></tr></thead>
      <tbody>{mounts.map(({ direction, id, pose }) => <tr key={direction + id} className="border-t">
        <th scope="row" className="break-all p-2 font-medium">{direction} · {id}</th>
        <td className="mono break-all p-2">[{pose.positionMm.join(", ")}]</td><td className="mono break-all p-2">[{pose.quatWxyz.join(", ")}]</td></tr>)}</tbody>
    </table></div>
  </section>;
}

export default function TwinPackagePreview({ device, workspace, installed, error, onClose, onInstall, onAssemble }: {
  device: DevicePackage;
  workspace: TwinWorkspace;
  installed: boolean;
  error: string;
  onClose: () => void;
  onInstall: () => void;
  onAssemble: () => void;
}) {
  const [failedExport, setFailedExport] = useState<{ device: DevicePackage; workspace: TwinWorkspace; message: string } | null>(null);
  const exportError = failedExport?.device === device && failedExport.workspace === workspace ? failedExport.message : "";
  const ports = new Map(device.ports.map((port) => [port.id, port]));
  const capabilities = [
    device.mechanics && (device.mechanics.kind === "part" ? "机械部件" : "可复用机械装配"),
    device.servo && (device.servo.kind === "drive" ? "伺服驱动器" : "伺服电机"),
    device.ports.length > 0 && (device.ports.length + " 个端口 · " + device.rules.length + " 条行为规则"),
  ].filter(Boolean).join(" · ");
  function exportPackage() {
    const filename = device.model + "-" + device.revision;
    try {
      if (device.mechanics?.kind === "assembly") {
        downloadJson(bundleMechanicalDevice(workspace, device), filename + ".mechanical-bundle.json");
      } else {
        downloadJson(device, filename + ".device.json");
      }
      setFailedExport(null);
    } catch (cause) {
      setFailedExport({ device, workspace, message: "导出失败。" + (cause instanceof Error ? cause.message : "请核对设备及其依赖。") });
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto thin-scrollbar sm:max-w-[740px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-xs font-medium text-primary"><Box size={15} />{installed ? "已安装设备" : "安装前核对"}</div>
          <DialogTitle className="break-words text-xl">{device.model}</DialogTitle>
          <DialogDescription>{device.manufacturer} · 设备包版本 {device.revision} · {capabilities}</DialogDescription>
        </DialogHeader>
        <DeviceSourceEvidence source={device.source} />
        {device.calibration && <p className="surface-inset p-3 text-xs">
          已记录的两组标定值为 {device.calibration.inputPoints[0]} → {device.calibration.outputPoints[0]} 和 {device.calibration.inputPoints[1]} → {device.calibration.outputPoints[1]}，范围外按同一条直线外推。
        </p>}
        {device.mechanics && <MechanicalDetails mechanics={device.mechanics} />}
        {device.servo && <section aria-label="伺服参数" className="space-y-3">
          <h3 className="text-sm font-medium">型号参数</h3><ServoRatings servo={device.servo} />
        </section>}
        {device.ports.length > 0 && <><section aria-label="仿真行为">
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
        {(error || exportError) && <p role="alert" className="whitespace-pre-line break-words text-sm text-destructive">{[error, exportError].filter(Boolean).join("\n")}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={exportPackage}><Download />{device.mechanics?.kind === "assembly" ? "导出含依赖机械包" : "导出设备包"}</Button>
          {installed
            ? <Button onClick={onAssemble}><Plus />{device.mechanics ? "用于机械装配" : device.servo ? "用于伺服仿真" : "添加到仿真装配"}</Button>
            : <Button onClick={onInstall}><PackageCheck />确认安装</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
