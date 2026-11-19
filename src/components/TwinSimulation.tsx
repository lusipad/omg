import { useState } from "react";
import { Cable, Cpu, Plus, RotateCcw, Trash2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { packageKey, type DevicePackage, type SignalPort } from "@contracts/twin-device";
import {
  addInstance, advanceSimulation, connectPorts, disconnectPorts, initialSimulation, nextInstanceName, removeInstance, setInput,
  type SignalValue, type SimulationState, type TwinInstance, type TwinWorkspace,
} from "@contracts/twin-simulation";

type WorkspaceProps = { workspace: TwinWorkspace; onChange: (next: TwinWorkspace) => void };
type ApplyChange = (change: () => TwinWorkspace) => TwinWorkspace | undefined;

const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs";

function signalText(value: SignalValue | undefined) {
  if (value === undefined) return "—";
  return typeof value === "boolean" ? (value ? "ON" : "OFF") : String(value);
}

function resetBench(workspace: TwinWorkspace): { state: SimulationState | null; error: string } {
  try {
    return { state: initialSimulation(workspace), error: "" };
  } catch (cause) {
    return { state: null, error: cause instanceof Error ? cause.message : "仿真初始化失败" };
  }
}

function SignalBench({ workspace, device, instance, apply }: {
  workspace: TwinWorkspace; device: DevicePackage; instance: TwinInstance; apply: ApplyChange;
}) {
  const [{ state: simulation, error }, setResult] = useState(() => resetBench(workspace));

  function advance(deltaMs: number) {
    try {
      const state = advanceSimulation(workspace, simulation ?? initialSimulation(workspace), deltaMs);
      setResult({ state, error: "" });
    } catch (cause) {
      setResult({ state: simulation, error: cause instanceof Error ? cause.message : "仿真步进失败" });
    }
  }

  function changeInput(port: SignalPort, value: SignalValue) {
    apply(() => setInput(workspace, instance.id, port.id, value));
  }

  const incoming = new Map(workspace.connections.filter((wire) => wire.to.instanceId === instance.id)
    .map((wire) => [wire.to.portId, wire.from]));
  return (
    <section className="surface min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <div className="text-xs text-muted-foreground">仿真时间</div>
          <output className="mono mt-1 block text-2xl font-medium text-primary" aria-label="仿真时间">{simulation?.timeMs ?? 0} ms</output>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => advance(1)}>步进 1 ms</Button>
          <Button size="sm" onClick={() => advance(10)}>步进 10 ms</Button>
          <Button size="sm" variant="ghost" onClick={() => setResult(resetBench(workspace))}><RotateCcw />复位</Button>
        </div>
      </header>
      {error && <p className="px-4 pt-3 text-xs text-destructive" role="alert">{error}。可调整输入后重新步进。</p>}
      <div className="p-4">
        <div className="mb-4">
          <h3 className="break-words text-sm font-semibold">{instance.name}</h3>
          <p className="mt-1 break-words text-xs text-muted-foreground">{device.manufacturer} · {device.model} · {device.revision}</p>
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-medium">输入激励</h4>
            <div className="surface-inset thin-scrollbar max-h-72 overflow-y-auto divide-y">
              {device.ports.filter((port) => port.direction === "input").map((port) => {
                const from = incoming.get(port.id);
                const value = instance.inputs[port.id] ?? (port.type === "boolean" ? false : 0);
                return (
                  <div key={JSON.stringify([instance.id, port.id])} className="flex min-h-11 items-center justify-between gap-2 px-3 py-1.5">
                    <div className="min-w-0 break-words text-xs">{port.label}
                      <div className="mono text-[10px] text-muted-foreground">{port.id}{port.unit && ` · ${port.unit}`}</div>
                    </div>
                    {from ? <div className="text-right">
                      <div className="mono text-xs">{signalText(simulation?.outputs[from.instanceId]?.[from.portId])}</div>
                      <span className="text-[10px] text-muted-foreground">连线驱动</span>
                    </div> : port.type === "boolean" ? (
                      <Button size="sm" variant={value ? "default" : "outline"} aria-label={`输入 ${port.label}`} aria-pressed={Boolean(value)} onClick={() => changeInput(port, !value)}>
                        {signalText(value)}
                      </Button>
                    ) : (
                      <Input className="mono h-8 w-20 shrink-0 text-right text-xs" type="number" step="any" defaultValue={Number(value)}
                        aria-label={`输入 ${port.label}${port.unit ? `（${port.unit}）` : ""}`}
                        onChange={(event) => { const number = event.currentTarget.valueAsNumber; if (Number.isFinite(number)) changeInput(port, number); }}
                        onBlur={(event) => { event.currentTarget.value = String(value); }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-medium">输出读数</h4>
            <div className="surface-inset thin-scrollbar max-h-72 overflow-y-auto divide-y">
              {device.ports.filter((port) => port.direction === "output").map((port) => {
                const value = simulation?.outputs[instance.id]?.[port.id];
                return (
                  <div key={port.id} className="flex min-h-11 items-center justify-between gap-2 px-3 py-1.5">
                    <div className="min-w-0 break-words text-xs">{port.label}
                      <div className="mono text-[10px] text-muted-foreground">{port.id}{port.unit && ` · ${port.unit}`}</div>
                    </div>
                    <output aria-label={`输出 ${port.label}`} className="mono flex items-center gap-2 break-all text-xs">
                      {typeof value === "boolean" && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${value ? "bg-primary" : "border border-muted-foreground/70"}`} />}
                      {signalText(value)}
                    </output>
                  </div>
                );
              })}
              {!device.ports.some((port) => port.direction === "output") && <p className="p-3 text-xs text-muted-foreground">此设备没有输出端口。</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Connections({ workspace, packages, apply }: {
  workspace: TwinWorkspace; packages: Map<string, DevicePackage>; apply: ApplyChange;
}) {
  const [fromNode, setFromNode] = useState("");
  const [fromPort, setFromPort] = useState("");
  const [toNode, setToNode] = useState("");
  const [toPort, setToPort] = useState("");
  const occupied = new Set(workspace.connections.map(({ to }) => JSON.stringify([to.instanceId, to.portId])));
  const nodes = workspace.instances.map((instance) => {
    const ports = packages.get(instance.packageKey)?.ports ?? [];
    return { ...instance, ports, outputs: ports.filter((port) => port.direction === "output"),
      freeInputs: ports.filter((port) => port.direction === "input" && !occupied.has(JSON.stringify([instance.id, port.id]))) };
  });
  const sources = nodes.filter((node) => node.outputs.length);
  const source = sources.find((node) => node.id === fromNode)
    ?? sources.find((node) => node.id === workspace.connections[0]?.from.instanceId) ?? sources[0];
  const output = source?.outputs.find((port) => port.id === fromPort) ?? source?.outputs[0];
  const targets = nodes.filter((node) => node.id !== source?.id).map((node) => ({
    ...node, inputs: node.freeInputs.filter((port) => port.type === output?.type && port.unit === output?.unit),
  })).filter((node) => node.inputs.length);
  const target = targets.find((node) => node.id === toNode) ?? targets[0];
  const input = target?.inputs.find((port) => port.id === toPort) ?? target?.inputs[0];

  function endpointLabel(instanceId: string, portId: string) {
    const node = nodes.find((item) => item.id === instanceId);
    const port = node?.ports.find((item) => item.id === portId);
    return `${node?.name} / ${port?.label} (${portId})`;
  }

  return (
    <section className="surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Cable className="h-4 w-4 text-primary" />信号接线</h3>
      {workspace.instances.length < 2 ? <p className="mt-3 text-xs text-muted-foreground">添加两个设备实例后，可以连接一个输出和另一个实例的输入。</p> : (
        <form className="mt-3 grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]" onSubmit={(event) => {
          event.preventDefault();
          if (source && output && target && input) apply(() => connectPorts(workspace, {
            from: { instanceId: source.id, portId: output.id },
            to: { instanceId: target.id, portId: input.id },
          }));
        }}>
          <label className="block min-w-0"><span className="field-label">输出实例</span>
            <select className={selectStyle} value={source?.id ?? ""} disabled={!source} onChange={(event) => { setFromNode(event.target.value); setFromPort(""); }}>
              {!source && <option value="">没有带输出的设备</option>}
              {sources.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0"><span className="field-label">输出端口</span>
            <select className={selectStyle} value={output?.id ?? ""} disabled={!output} onChange={(event) => setFromPort(event.target.value)}>
              {source?.outputs.map((port) => <option key={port.id} value={port.id}>{port.label} ({port.id})</option>)}
            </select>
          </label>
          <label className="block min-w-0"><span className="field-label">目标实例</span>
            <select className={selectStyle} value={target?.id ?? ""} disabled={!target} onChange={(event) => { setToNode(event.target.value); setToPort(""); }}>
              {!target && <option value="">没有兼容的空闲输入</option>}
              {targets.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0"><span className="field-label">目标输入端口</span>
            <select className={selectStyle} value={input?.id ?? ""} disabled={!input} onChange={(event) => setToPort(event.target.value)}>
              {!input && <option value="">按类型与单位匹配</option>}
              {target?.inputs.map((port) => <option key={port.id} value={port.id}>{port.label} ({port.id})</option>)}
            </select>
          </label>
          <Button type="submit" variant="outline" disabled={!target}><Cable />连接</Button>
        </form>
      )}
      {workspace.connections.length > 0 && <ul className="mt-4 divide-y border-t">
        {workspace.connections.map((wire) => {
          const from = endpointLabel(wire.from.instanceId, wire.from.portId);
          const to = endpointLabel(wire.to.instanceId, wire.to.portId);
          return (
            <li key={JSON.stringify(wire.to)} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 break-words text-xs">{from} <span className="text-primary">→</span> {to}</span>
              <Button size="sm" variant="ghost" aria-label={`断开 ${from} 到 ${to}`} onClick={() => apply(() => disconnectPorts(workspace, wire))}><Unplug />断开</Button>
            </li>
          );
        })}
      </ul>}
    </section>
  );
}

export default function TwinSimulation({ workspace, onChange }: WorkspaceProps) {
  const count = workspace.instances.length;
  const [selection, setSelection] = useState({ count, id: "" });
  const [choice, setChoice] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const signalPackages = workspace.packages.filter((device) => !device.servo && device.ports.length > 0);
  const packages = new Map(signalPackages.map((device) => [packageKey(device), device]));
  const device = packages.get(choice) ?? signalPackages[0];
  const selected = (count > selection.count ? workspace.instances[count - 1]
    : workspace.instances.find((instance) => instance.id === selection.id)) ?? workspace.instances[0];
  if (count !== selection.count) setSelection({ count, id: selected?.id ?? "" });
  const selectedDevice = selected && packages.get(selected.packageKey);
  // Manual stimulus changes preserve filter history. A different wiring graph starts at t=0.
  const topologyKey = JSON.stringify([workspace.instances.map(({ id, packageKey: key }) => [id, key]), workspace.connections]);

  const apply: ApplyChange = (change) => {
    try {
      const next = change();
      onChange(next);
      setError("");
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "场景更新失败");
    }
  };

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">{error}</p>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="surface min-w-0 self-start p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Cpu className="h-4 w-4 text-primary" />场景设备</h3>
          {workspace.instances.length > 0 && <ul className="thin-scrollbar mt-3 max-h-56 space-y-1 overflow-y-auto">
            {workspace.instances.map((instance) => <li key={instance.id} className="flex gap-1">
              <button type="button" className="tree-item min-w-0 flex-1" data-active={selected?.id === instance.id} aria-pressed={selected?.id === instance.id}
                onClick={() => setSelection({ count, id: instance.id })}><span className="truncate text-xs" title={instance.name}>{instance.name}</span></button>
              <Button size="icon-sm" variant="ghost" aria-label={`移除实例 ${instance.name}`} title="移除实例" onClick={() => {
                const linked = workspace.connections.some((wire) => wire.from.instanceId === instance.id || wire.to.instanceId === instance.id);
                if (linked && !window.confirm(`移除“${instance.name}”并断开关联接线？`)) return;
                apply(() => removeInstance(workspace, instance.id));
              }}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button>
            </li>)}
          </ul>}
          {device ? <form className="mt-4 space-y-3 border-t pt-4" onSubmit={(event) => {
            event.preventDefault();
            const instanceName = name.trim() || nextInstanceName(workspace, device.model);
            if (workspace.instances.some((instance) => instance.name === instanceName)) { setError("场景中已有同名实例，请换一个名称。"); return; }
            const next = apply(() => addInstance(workspace, packageKey(device), instanceName));
            if (next) setName("");
          }}>
            <label className="block"><span className="field-label">已安装型号</span>
              <select className={selectStyle} value={packageKey(device)} onChange={(event) => setChoice(event.target.value)}>
                {signalPackages.map((item) => <option key={packageKey(item)} value={packageKey(item)}>{item.manufacturer} · {item.model} · {item.revision}</option>)}
              </select>
            </label>
            <label className="block"><span className="field-label">实例名称</span>
              <Input maxLength={160} value={name} placeholder={nextInstanceName(workspace, device.model)} onChange={(event) => setName(event.target.value)} />
            </label>
            <Button className="w-full" size="sm" variant="outline" type="submit"><Plus />添加实例</Button>
          </form> : <p className="mt-3 text-xs leading-6 text-muted-foreground">先在设备库安装设备包，即可在场景中添加实例。</p>}
        </aside>
        <div className="min-w-0 space-y-4">
          {selected && selectedDevice ? (
            <SignalBench key={topologyKey} workspace={workspace} device={selectedDevice} instance={selected} apply={apply} />
          ) : <section className="surface engineering-grid flex min-h-44 items-center justify-center p-6 text-center">
            <p className="text-sm text-muted-foreground">添加设备实例后，可设置输入并步进仿真。</p>
          </section>}
          <Connections workspace={workspace} packages={packages} apply={apply} />
        </div>
      </div>
    </div>
  );
}
