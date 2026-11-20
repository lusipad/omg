import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, CopyPlus, Download, Pause, Play, RefreshCw, Save, ShieldAlert, Wrench } from "lucide-react";
import { hasFeedRole, hasServoRole } from "@contracts/device-model-binding";
import {
  applyFieldCalibrationRevision,
  compareRuntimeWithFieldTrace,
  evaluateSystemVerificationStatus,
  parseFieldTraceCsv,
  type FieldComparisonReport,
} from "@contracts/field-alignment";
import {
  appendSubsystemInstance,
  confirmSystemProvenance,
  evaluateSystemReadiness,
  packageAxisAsSubsystem,
  type RuntimeTrace,
  type TwinSystemAssembly,
  runtimeTraceToCsv,
} from "@contracts/system-twin";
import { draftSystemFromWorkspace } from "@contracts/system-draft";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { downloadBlob, downloadFile } from "@/lib/download";
import { exportSystemTwinArchive } from "@/lib/system-twin-export";
import { runSystemTwin } from "@/lib/system-twin-runtime";

type Props = {
  workspace: TwinWorkspace;
  system?: TwinSystemAssembly;
  onSave: (system: TwinSystemAssembly, revisedWorkspace?: TwinWorkspace) => void;
};

const SAMPLE_LINUXCNC_INI = `[EMCMOT]
SERVO_PERIOD = 1000000

[TRAJ]
COORDINATES = XY

[JOINT_0]
ENCODER_SCALE = 10000
MIN_LIMIT = -5.0
MAX_LIMIT = 18.0
MAX_VELOCITY = 80.0

[JOINT_1]
ENCODER_SCALE = -10000
MIN_LIMIT = -18.0
MAX_LIMIT = 5.0
MAX_VELOCITY = 80.0
`;

const SAMPLE_LINUXCNC_HAL = `loadrt debounce cfg=2
setp debounce.0.delay 10
net plus-home-joint-0 hm2_7i95.0.inmux.00.input-02-not => joint.0.pos-lim-sw-in joint.0.home-sw-in
net neg-limit-joint-1 hm2_7i95.0.inmux.00.input-05-not => joint.1.neg-lim-sw-in
`;

function tryInitialDraft(workspace: TwinWorkspace): TwinSystemAssembly | null {
  try {
    return draftSystemFromWorkspace(workspace, { defaultTriggerPositionMm: 16 });
  } catch {
    return null;
  }
}

export default function SystemTwinBench({ workspace, system, onSave }: Props) {
  const [draft, setDraft] = useState<TwinSystemAssembly | null>(() => system ?? tryInitialDraft(workspace));
  const [iniText, setIniText] = useState("");
  const [halText, setHalText] = useState("");
  const [showLinuxCnc, setShowLinuxCnc] = useState(false);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [trace, setTrace] = useState<RuntimeTrace | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedAxisIndex, setSelectedAxisIndex] = useState(0);
  const [showFieldAlign, setShowFieldAlign] = useState(false);
  const [serialNumber, setSerialNumber] = useState(() => system?.assetBindings?.[0]?.serialNumber ?? "SN-AXIS-001");
  const [calVersion, setCalVersion] = useState("cal-v1");
  const [fieldCsvText, setFieldCsvText] = useState("");
  const [reverifyCsvText, setReverifyCsvText] = useState("");
  const [primaryComparison, setPrimaryComparison] = useState<FieldComparisonReport | null>(null);
  const [reverifyComparison, setReverifyComparison] = useState<FieldComparisonReport | null>(null);
  const [calMassInput, setCalMassInput] = useState("");
  const runAbort = useRef<AbortController | null>(null);

  const drives = useMemo(() => workspace.packages.filter((p) => hasServoRole(p, "drive")), [workspace.packages]);
  const motors = useMemo(() => workspace.packages.filter((p) => hasServoRole(p, "motor")), [workspace.packages]);
  const screws = useMemo(() => workspace.packages.filter((p) => hasFeedRole(p, "screw")), [workspace.packages]);
  const tables = useMemo(() => workspace.packages.filter((p) => hasFeedRole(p, "table")), [workspace.packages]);

  const readiness = useMemo(
    () => (draft ? evaluateSystemReadiness(workspace, draft) : null),
    [workspace, draft],
  );

  useEffect(() => () => { runAbort.current?.abort(); }, []);

  useEffect(() => {
    if (!playing || !trace || trace.frames.length < 2) return;
    const timer = window.setInterval(() => {
      setFrameIndex((prev) => {
        if (prev + 5 >= trace.frames.length - 1) {
          setPlaying(false);
          return trace.frames.length - 1;
        }
        return prev + 5;
      });
    }, 30);
    return () => window.clearInterval(timer);
  }, [playing, trace]);

  function regenerateDraft(useLinuxCnc: boolean) {
    setError("");
    try {
      const generated = draftSystemFromWorkspace(workspace, {
        id: draft?.id,
        name: draft?.name || "机电控闭环系统",
        ...(useLinuxCnc ? { iniText, halText } : { defaultTriggerPositionMm: 16 }),
      });
      setDraft(generated);
      setTrace(null);
      setFrameIndex(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法从当前工程设备生成系统草案。");
    }
  }

  async function runSimulation() {
    if (!draft) return;
    setError("");
    setPlaying(false);
    runAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    setRunning(true);
    try {
      const nextTrace = await runSystemTwin(workspace, draft, controller.signal);
      setTrace(nextTrace);
      setFrameIndex(nextTrace.frames.length - 1);
    } catch (cause) {
      if ((cause as { name?: string })?.name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : "机电控闭环仿真失败。");
      }
    } finally {
      setRunning(false);
    }
  }

  async function exportModelicaBundle() {
    if (!draft) return;
    setError("");
    setExporting(true);
    try {
      const blob = await exportSystemTwinArchive(workspace, draft);
      downloadFile(blob, `${draft.id}-modelica-verify.zip`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出 Modelica 校核包失败。");
    } finally {
      setExporting(false);
    }
  }

  function addReusedAxis() {
    if (!draft || !draft.axes.length) return;
    setError("");
    try {
      const sourceAxis = draft.axes[0];
      const tpl = packageAxisAsSubsystem(draft, sourceAxis.id);
      const nextIdx = draft.axes.length + 1;
      const newAxisId = `axis-sub-${nextIdx}`;
      const direction: [number, number, number] = nextIdx === 2 ? [0, 1, 0] : [0, 0, 1];
      const next = appendSubsystemInstance(draft, tpl, {
        axisId: newAxisId,
        axisName: `${nextIdx === 2 ? "Y" : `A${nextIdx}`} 轴（复用子系统）`,
        direction,
        originMm: [0, (nextIdx - 1) * 60, 0],
      });
      setDraft(next);
      setTrace(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复用单轴子系统失败。");
    }
  }

  if (!draft) {
    return (
      <section className="surface space-y-4 p-5" aria-label="机电控闭环系统装配">
        <h2 className="text-lg font-semibold">机电控闭环系统</h2>
        <p className="text-sm text-muted-foreground">
          请先安装伺服驱动器、伺服电机、滚珠丝杠与移动工作台设备包（可选配 GL10-1600END DI 模块），再从此生成闭环限位与轨迹仿真系统。
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => regenerateDraft(false)}><RefreshCw />尝试从工程资源生成草案</Button>
      </section>
    );
  }

  const activeFrame = trace?.frames[Math.min(frameIndex, trace.frames.length - 1)];
  const inspectAxis = trace?.axisSummaries[Math.min(selectedAxisIndex, trace.axisSummaries.length - 1)];
  const verificationStatus = evaluateSystemVerificationStatus(primaryComparison, reverifyComparison);

  function runFieldCompare(role: "primary_calibration" | "independent_reverify") {
    if (!trace || !inspectAxis) return;
    setError("");
    try {
      const csvRaw = role === "primary_calibration" ? fieldCsvText : reverifyCsvText;
      const dataset = parseFieldTraceCsv(
        csvRaw,
        { timeColumn: "timeMs", timeUnit: "ms", positionColumn: "positionMm", positionUnit: "mm", velocityColumn: "velocityMmS", velocityUnit: "mm/s", limitSignalColumn: "limitTriggered" },
        {
          id: role,
          label: role === "primary_calibration" ? "主标定实测录波" : "独立复验录波",
          axisId: inspectAxis.axisId,
          profileRole: role,
        },
      );
      const report = compareRuntimeWithFieldTrace(trace, dataset);
      if (role === "primary_calibration") setPrimaryComparison(report);
      else setReverifyComparison(report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "实测录波对标解析失败。");
    }
  }

  function applyMeasuredRevision() {
    if (!draft || !inspectAxis) return;
    setError("");
    try {
      const measuredMass = calMassInput.trim() ? Number(calMassInput) : undefined;
      const updated = applyFieldCalibrationRevision(workspace, draft, {
        axisId: inspectAxis.axisId,
        serialNumber: serialNumber.trim() || "SN-AXIS-001",
        calibrationVersion: calVersion.trim() || "cal-v1",
        ...(measuredMass !== undefined && { measuredTableMassKg: measuredMass }),
        note: "来自实机示波器录波对标标定",
      });
      setDraft(updated.system);
      onSave(updated.system, updated.workspace);
      setTrace(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "写入实测标定修订失败。");
    }
  }

  return (
    <div className="space-y-4">
      <section className="surface space-y-4 p-4 sm:p-5" aria-label="机电控系统配置">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="min-w-60 flex-1">
            <span className="field-label">系统名称</span>
            <Input
              aria-label="系统名称"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => regenerateDraft(false)}>
              <RefreshCw />从 BOM 刷新草案
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowLinuxCnc(!showLinuxCnc)}>
              <Wrench />导入 LinuxCNC .ini/.hal
            </Button>
            <Button size="sm" variant="outline" onClick={addReusedAxis}>
              <CopyPlus />复用单轴扩展多轴
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onSave(draft)}>
              <Save />保存系统
            </Button>
            <Button size="sm" disabled={running || !readiness?.ready} onClick={() => void runSimulation()}>
              <Play />{running ? "正在运行…" : "运行闭环仿真"}
            </Button>
          </div>
        </div>

        {showLinuxCnc && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                粘贴真实 CNC 的 `.ini`（读取 SERVO_PERIOD、ENCODER_SCALE 极性、限位与速度）及 `.hal`（解析 debounce 滤波、`-not` 取反及 1→N 扇出接线）。
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIniText(SAMPLE_LINUXCNC_INI);
                  setHalText(SAMPLE_LINUXCNC_HAL);
                }}
              >
                填入双轴龙门+反相+去抖示例
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label>
                <span className="field-label">.ini 配置文本</span>
                <Textarea className="mono h-32 text-xs" value={iniText} onChange={(e) => setIniText(e.target.value)} />
              </label>
              <label>
                <span className="field-label">.hal 接线文本</span>
                <Textarea className="mono h-32 text-xs" value={halText} onChange={(e) => setHalText(e.target.value)} />
              </label>
            </div>
            <Button size="sm" onClick={() => { regenerateDraft(true); setShowLinuxCnc(false); }}>
              解析并生成系统草案
            </Button>
          </div>
        )}

        {readiness && (
          <div
            role={readiness.ready ? "status" : "alert"}
            className={`rounded-md border px-3 py-2 text-xs ${
              readiness.ready
                ? "border-emerald-500/30 bg-emerald-500/5 text-foreground"
                : "border-amber-500/40 bg-amber-500/10 text-amber-200"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {readiness.ready ? <CheckCircle2 className="size-4 text-emerald-400" /> : <ShieldAlert className="size-4 text-amber-400" />}
                <span>
                  来源状态：已确认 {readiness.confirmedItems.length} 项 · 自动推断 {readiness.inferredItems.length} 项 · 待确认/阻断{" "}
                  {readiness.pendingItems.length + readiness.blockingErrors.length} 项
                </span>
              </div>
              {(readiness.inferredItems.length > 0 || readiness.pendingItems.length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setError("");
                    try {
                      setDraft(confirmSystemProvenance(draft));
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : "部分待确认项尚缺少必填参数。");
                    }
                  }}
                >
                  全部确认就绪项
                </Button>
              )}
            </div>
            {[...readiness.pendingItems, ...readiness.blockingErrors].length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                {[...readiness.pendingItems, ...readiness.blockingErrors].map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-medium">轴传动单元与运动控制器（{draft.axes.length} 轴）</h3>
            {draft.axes.map((axis, idx) => {
              const ctrl = draft.controllers.find((c) => c.axisId === axis.id)!;
              return (
                <div key={axis.id} className="space-y-2 rounded border bg-background/60 p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{axis.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{axis.provenance}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label>
                      <span className="field-label">伺服驱动器</span>
                      <select
                        className="h-8 w-full rounded border bg-background px-2 text-xs"
                        value={axis.driveKey}
                        onChange={(e) => {
                          const axes = draft.axes.map((a, i) => (i === idx ? { ...a, driveKey: e.target.value } : a));
                          setDraft({ ...draft, axes });
                          setTrace(null);
                        }}
                      >
                        {drives.map((d) => <option key={packageKey(d)} value={packageKey(d)}>{d.model} · {d.revision}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="field-label">伺服电机</span>
                      <select
                        className="h-8 w-full rounded border bg-background px-2 text-xs"
                        value={axis.motorKey}
                        onChange={(e) => {
                          const axes = draft.axes.map((a, i) => (i === idx ? { ...a, motorKey: e.target.value } : a));
                          setDraft({ ...draft, axes });
                          setTrace(null);
                        }}
                      >
                        {motors.map((m) => <option key={packageKey(m)} value={packageKey(m)}>{m.model} · {m.revision}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="field-label">滚珠丝杠</span>
                      <select
                        className="h-8 w-full rounded border bg-background px-2 text-xs"
                        value={axis.screwKey}
                        onChange={(e) => {
                          const axes = draft.axes.map((a, i) => (i === idx ? { ...a, screwKey: e.target.value } : a));
                          setDraft({ ...draft, axes });
                          setTrace(null);
                        }}
                      >
                        {screws.map((s) => <option key={packageKey(s)} value={packageKey(s)}>{s.model}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="field-label">移动工作台</span>
                      <select
                        className="h-8 w-full rounded border bg-background px-2 text-xs"
                        value={axis.tableKey}
                        onChange={(e) => {
                          const axes = draft.axes.map((a, i) => (i === idx ? { ...a, tableKey: e.target.value } : a));
                          setDraft({ ...draft, axes });
                          setTrace(null);
                        }}
                      >
                        {tables.map((t) => <option key={packageKey(t)} value={packageKey(t)}>{t.model}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label>
                      <span className="field-label">目标位移 (mm)</span>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={ctrl.targetMm}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v)) return;
                          setDraft({
                            ...draft,
                            controllers: draft.controllers.map((c) => (c.id === ctrl.id ? { ...c, targetMm: v } : c)),
                          });
                          setTrace(null);
                        }}
                      />
                    </label>
                    <label>
                      <span className="field-label">巡航速度 (mm/s)</span>
                      <Input
                        type="number"
                        min={1}
                        className="h-8 text-xs"
                        value={ctrl.cruiseVelocityMmS}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!(v > 0)) return;
                          setDraft({
                            ...draft,
                            controllers: draft.controllers.map((c) => (c.id === ctrl.id ? { ...c, cruiseVelocityMmS: v } : c)),
                          });
                          setTrace(null);
                        }}
                      />
                    </label>
                    <label>
                      <span className="field-label">安装/编码器极性</span>
                      <select
                        className="h-8 w-full rounded border bg-background px-2 text-xs"
                        value={axis.factor ?? 1}
                        onChange={(e) => {
                          const factor = Number(e.target.value) === -1 ? -1 : 1;
                          setDraft({
                            ...draft,
                            axes: draft.axes.map((a, i) => (i === idx ? { ...a, factor } : a)),
                          });
                          setTrace(null);
                        }}
                      >
                        <option value={1}>正向 (+1)</option>
                        <option value={-1}>反向 (-1)</option>
                      </select>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-medium">限位开关、DI 滤波与信号接线（{draft.wires.length} 条）</h3>
            {draft.sensors.map((s, idx) => (
              <div key={s.id} className="grid grid-cols-3 gap-2 rounded border bg-background/60 p-2.5 text-xs">
                <label className="col-span-3 flex items-center justify-between">
                  <span className="font-medium">{s.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{s.provenance}</span>
                </label>
                <label>
                  <span className="field-label">触发位置 (mm)</span>
                  <Input
                    type="number"
                    placeholder="必填"
                    className="h-8 text-xs"
                    value={s.triggerPositionMm ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const v = raw === "" ? undefined : Number(raw);
                      setDraft({
                        ...draft,
                        sensors: draft.sensors.map((item, i) =>
                          i === idx
                            ? { ...item, triggerPositionMm: v, provenance: v !== undefined ? "confirmed" : "pending" }
                            : item,
                        ),
                      });
                      setTrace(null);
                    }}
                  />
                </label>
                <label>
                  <span className="field-label">触点逻辑</span>
                  <select
                    className="h-8 w-full rounded border bg-background px-2 text-xs"
                    value={s.normallyClosed ? "nc" : "no"}
                    onChange={(e) => {
                      const nc = e.target.value === "nc";
                      setDraft({
                        ...draft,
                        sensors: draft.sensors.map((item, i) => (i === idx ? { ...item, normallyClosed: nc } : item)),
                      });
                      setTrace(null);
                    }}
                  >
                    <option value="nc">常闭 (NC)</option>
                    <option value="no">常开 (NO)</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">触发模式</span>
                  <select
                    className="h-8 w-full rounded border bg-background px-2 text-xs"
                    value={s.triggerMode}
                    onChange={(e) => {
                      const mode = e.target.value as typeof s.triggerMode;
                      setDraft({
                        ...draft,
                        sensors: draft.sensors.map((item, i) => (i === idx ? { ...item, triggerMode: mode } : item)),
                      });
                      setTrace(null);
                    }}
                  >
                    <option value="positive_overtravel">正超程 &gt;=</option>
                    <option value="negative_overtravel">负超程 &lt;=</option>
                    <option value="window">感应窗口</option>
                  </select>
                </label>
              </div>
            ))}
            {draft.diChannels.map((di, idx) => (
              <div key={di.id} className="grid grid-cols-2 gap-2 rounded border bg-background/60 p-2.5 text-xs">
                <div className="col-span-2 flex items-center justify-between">
                  <span className="font-medium">{di.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{di.provenance}</span>
                </div>
                <label>
                  <span className="field-label">DI 滤波时间 (ms)</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 text-xs"
                    value={di.filterMs ?? 10}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!(v >= 0)) return;
                      setDraft({
                        ...draft,
                        diChannels: draft.diChannels.map((item, i) =>
                          i === idx ? { ...item, filterMs: v, provenance: "confirmed" } : item,
                        ),
                      });
                      setTrace(null);
                    }}
                  />
                </label>
                <label>
                  <span className="field-label">通信周期 (ms)</span>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    className="h-8 text-xs"
                    value={draft.commStepMs}
                    onChange={(e) => {
                      const v = Math.round(Number(e.target.value));
                      if (v < 1 || v > 10) return;
                      setDraft({ ...draft, commStepMs: v });
                      setTrace(null);
                    }}
                  />
                </label>
              </div>
            ))}
            <div className="space-y-1 text-xs">
              {draft.wires.map((w, idx) => (
                <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background/40 px-2 py-1">
                  <span className="mono text-[11px]">
                    {w.from.nodeId}.{w.from.portId} {w.invert ? "-[not]->" : "-->"} {w.to.nodeId}.{w.to.portId}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {w.to.kind === "controller" && (
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                        onClick={() => {
                          setDraft({
                            ...draft,
                            wires: draft.wires.map((item, i) =>
                              i === idx ? { ...item, invert: !item.invert, provenance: "confirmed" } : item,
                            ),
                          });
                          setTrace(null);
                        }}
                      >
                        {w.invert ? "已取反 (-not)" : "直通"}
                      </button>
                    )}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{w.provenance}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {trace && activeFrame && (
        <section className="surface space-y-4 p-4 sm:p-5" aria-label="RuntimeTrace 联合轨迹与事件">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">统一闭环 RuntimeTrace（Modelica WASM + 离散开关 + 三维位姿）</h3>
                <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${verificationStatus.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-200"}`}>
                  {verificationStatus.label}
                </span>
              </div>
              <p className="mono mt-0.5 text-xs text-muted-foreground">
                t = {activeFrame.timeMs} ms · 末端合成三维位姿 ({activeFrame.tipPoseMm.map((v) => v.toFixed(3)).join(", ")}) mm ·{" "}
                {trace.modelRef.id}@{trace.modelRef.version}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowFieldAlign(!showFieldAlign)}>
                <Activity />实机录波对标
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPlaying(!playing)}>
                {playing ? <Pause /> : <Play />}
                {playing ? "暂停回放" : "同步回放"}
              </Button>
              <Button size="sm" variant="outline" disabled={exporting} onClick={() => void exportModelicaBundle()}>
                <Download />{exporting ? "打包中…" : "导出 Modelica 校核包"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadBlob(runtimeTraceToCsv(trace), `${trace.systemId}-trace.csv`, "text/csv;charset=utf-8")}
              >
                <Download />导出 Trace CSV
              </Button>
            </div>
          </div>

          <label className="flex items-center gap-3 text-xs">
            <span className="mono w-20 shrink-0">0 ms</span>
            <input
              type="range"
              aria-label="闭环轨迹时间滑块"
              className="w-full"
              min={0}
              max={trace.frames.length - 1}
              value={frameIndex}
              onChange={(e) => {
                setPlaying(false);
                setFrameIndex(Number(e.target.value));
              }}
            />
            <span className="mono w-24 shrink-0 text-right">{trace.durationMs} ms</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {trace.axisSummaries.map((sum, idx) => {
              const live = activeFrame.axes[sum.axisId];
              return (
                <button
                  key={sum.axisId}
                  type="button"
                  onClick={() => setSelectedAxisIndex(idx)}
                  className={`rounded-md border p-3 text-left text-xs transition-colors ${
                    idx === selectedAxisIndex ? "border-primary bg-primary/5" : "bg-background/50 hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center justify-between font-medium">
                    <span>{sum.axisName}</span>
                    <span className={live?.stopLatched ? "text-amber-400" : "text-emerald-400"}>
                      {live?.stopLatched ? "急停锁存" : "运行跟踪"}
                    </span>
                  </div>
                  <p className="mono mt-1 text-muted-foreground">
                    位置 {live?.positionMm.toFixed(3)} mm · 速度 {live?.velocityMmS.toFixed(1)} mm/s
                  </p>
                  <p className="mono mt-0.5 text-muted-foreground">
                    转矩 {live?.motorTorqueNm.toFixed(3)} N·m · 终停 {sum.finalPositionMm.toFixed(3)} mm
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {sum.stopTriggeredAtMs !== null
                      ? `限位触发于 ${sum.stopTriggeredAtMs} ms（${sum.stopTriggerPositionMm?.toFixed(3)} mm），滑行 ${(sum.brakingDistanceMm ?? 0).toFixed(3)} mm`
                      : "全程未触及限位"}
                  </p>
                </button>
              );
            })}
          </div>

          {inspectAxis && <AxisTracePlot trace={trace} axisId={inspectAxis.axisId} activeTimeMs={activeFrame.timeMs} overlayPoints={primaryComparison?.axisId === inspectAxis.axisId ? primaryComparison.overlayPoints : undefined} />}

          {showFieldAlign && inspectAxis && (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-medium">实机资产绑定与录波对标（{inspectAxis.axisName}）</h4>
                  <p className="text-muted-foreground">{verificationStatus.detail}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const rows = trace.frames
                      .filter((_, i) => i % 5 === 0 || i === trace.frames.length - 1)
                      .map((f) => {
                        const a = f.axes[inspectAxis.axisId];
                        return `${f.timeMs},${a.positionMm.toFixed(4)},${a.velocityMmS.toFixed(2)},${a.stopLatched ? 1 : 0}`;
                      });
                    setFieldCsvText(["timeMs,positionMm,velocityMmS,limitTriggered", ...rows].join("\n"));
                  }}
                >
                  生成示例录波 CSV（对齐本轴列格式）
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <label>
                  <span className="field-label">实机资产序列号 (S/N)</span>
                  <Input className="h-8 text-xs" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
                </label>
                <label>
                  <span className="field-label">标定修订号</span>
                  <Input className="h-8 text-xs" value={calVersion} onChange={(e) => setCalVersion(e.target.value)} />
                </label>
                <label>
                  <span className="field-label">实测修正总质量 (kg，可选)</span>
                  <Input type="number" step="0.1" placeholder="保留当前质量" className="h-8 text-xs" value={calMassInput} onChange={(e) => setCalMassInput(e.target.value)} />
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <span className="field-label">1. 主标定录波 CSV（timeMs,positionMm,velocityMmS,limitTriggered）</span>
                  <Textarea className="mono h-24 text-xs" value={fieldCsvText} onChange={(e) => setFieldCsvText(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!fieldCsvText.trim()} onClick={() => runFieldCompare("primary_calibration")}>比对主录波</Button>
                    <Button size="sm" variant="secondary" onClick={applyMeasuredRevision}>保存实测标定修订</Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <span className="field-label">2. 独立第二工况复验 CSV（完成双工况实测复验）</span>
                  <Textarea className="mono h-24 text-xs" value={reverifyCsvText} onChange={(e) => setReverifyCsvText(e.target.value)} />
                  <Button size="sm" variant="outline" disabled={!reverifyCsvText.trim()} onClick={() => runFieldCompare("independent_reverify")}>比对独立复验录波</Button>
                </div>
              </div>
              {(primaryComparison || reverifyComparison) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {[primaryComparison, reverifyComparison].filter((r): r is FieldComparisonReport => r !== null).map((rep) => (
                    <div key={rep.profileRole} className="rounded border bg-background/60 p-2">
                      <p className="font-medium">{rep.datasetLabel} · {rep.withinTolerance ? "容差内通过" : "超差"}</p>
                      <p className="mono mt-0.5 text-muted-foreground">
                        RMS {rep.rmsPositionErrorMm.toFixed(3)} mm · 终停差 {rep.finalPositionErrorMm.toFixed(3)} mm · 峰速差 {rep.peakVelocityErrorMmS.toFixed(2)} mm/s
                        {rep.limitTriggerTimeErrorMs !== null ? ` · 限位时刻差 ${rep.limitTriggerTimeErrorMs.toFixed(1)} ms` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-xs font-medium">当前时刻开关与离散状态（{activeFrame.timeMs} ms）</h4>
              <div className="space-y-1 text-xs">
                {draft.sensors.map((s) => (
                  <div key={s.id} className="mono flex justify-between rounded bg-muted/30 px-2 py-1">
                    <span>{s.name}</span>
                    <span>
                      {activeFrame.sensorTriggered[s.id] ? "TRIGGERED" : "CLEAR"} ({activeFrame.sensorVoltageV[s.id]?.toFixed(1)} V)
                    </span>
                  </div>
                ))}
                {draft.diChannels.map((d) => (
                  <div key={d.id} className="mono flex justify-between rounded bg-muted/30 px-2 py-1">
                    <span>{d.name}</span>
                    <span>{activeFrame.diState[d.id] ? "ON (1)" : "OFF (0)"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-xs font-medium">离散信号跃迁与触发日志（{trace.events.length} 条）</h4>
              {trace.events.length === 0 ? (
                <p className="text-xs text-muted-foreground">本次运行期间开关及限位状态未发生跃迁。</p>
              ) : (
                <ul className="max-h-44 space-y-1 overflow-y-auto text-xs">
                  {trace.events.map((ev, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted/40"
                        onClick={() => {
                          setPlaying(false);
                          const fIdx = trace.frames.findIndex((f) => f.timeMs === ev.timeMs);
                          if (fIdx >= 0) setFrameIndex(fIdx);
                        }}
                      >
                        <span className="mono shrink-0 text-primary">{ev.timeMs} ms</span>
                        <span className="flex-1 truncate">{ev.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function AxisTracePlot({ trace, axisId, activeTimeMs, overlayPoints }: {
  trace: RuntimeTrace;
  axisId: string;
  activeTimeMs: number;
  overlayPoints?: readonly { readonly timeMs: number; readonly measPositionMm: number }[];
}) {
  const frames = trace.frames;
  if (frames.length < 2) return null;
  const w = 680, h = 190, padL = 44, padR = 16, padT = 14, padB = 24;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const posVals = [
    ...frames.flatMap((f) => [f.axes[axisId].commandMm, f.axes[axisId].positionMm]),
    ...(overlayPoints?.map((p) => p.measPositionMm) ?? []),
  ];
  const minP = Math.min(...posVals, 0), maxP = Math.max(...posVals, 1);
  const spanP = Math.max(1e-6, maxP - minP);
  const xAt = (t: number) => padL + (t / Math.max(1, trace.durationMs)) * innerW;
  const yAt = (p: number) => padT + innerH - ((p - minP) / spanP) * innerH;
  const step = Math.max(1, Math.floor(frames.length / 220));
  const sampled = frames.filter((_, idx) => idx % step === 0 || idx === frames.length - 1);
  const cmdPath = sampled.map((f, i) => `${i ? "L" : "M"}${xAt(f.timeMs).toFixed(1)},${yAt(f.axes[axisId].commandMm).toFixed(1)}`).join("");
  const posPath = sampled.map((f, i) => `${i ? "L" : "M"}${xAt(f.timeMs).toFixed(1)},${yAt(f.axes[axisId].positionMm).toFixed(1)}`).join("");
  const measPath = overlayPoints && overlayPoints.length > 1
    ? overlayPoints.map((p, i) => `${i ? "L" : "M"}${xAt(p.timeMs).toFixed(1)},${yAt(p.measPositionMm).toFixed(1)}`).join("")
    : "";
  const cursorX = xAt(activeTimeMs);

  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>轴向指令位置（虚线）、Modelica 反馈（蓝线）{measPath ? "与实测录波（绿线）" : ""}</span>
        <span className="mono">{minP.toFixed(1)} .. {maxP.toFixed(1)} mm</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-48 w-full">
        <line x1={padL} y1={padT + innerH} x2={w - padR} y2={padT + innerH} stroke="currentColor" strokeOpacity={0.2} />
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="currentColor" strokeOpacity={0.2} />
        <path d={cmdPath} fill="none" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1.6} />
        <path d={posPath} fill="none" stroke="#38bdf8" strokeWidth={2.2} />
        {measPath && <path d={measPath} fill="none" stroke="#34d399" strokeWidth={1.8} strokeDasharray="2 2" />}
        <line x1={cursorX} y1={padT} x2={cursorX} y2={padT + innerH} stroke="#f59e0b" strokeWidth={1.5} />
      </svg>
    </div>
  );
}
