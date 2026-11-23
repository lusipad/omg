import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Cable, CheckCircle2, ChevronDown, CopyPlus, Download, FolderInput, Layers, Pause, Play, RefreshCw, Save, ShieldAlert, SlidersHorizontal, Wrench } from "lucide-react";
import { Link } from "react-router";
import { studioHref } from "@contracts/studio-navigation";
import { buildComposableFeedModuleTemplate, mapSystemTraceFrameToCommands } from "@contracts/articulated-kinematics";
import {
  effectiveModelBindings,
  evaluateBindingReadiness,
  fillPendingParameterValue,
  hasFeedRole,
  hasServoRole,
  resolveParameterChoice,
  type PendingParameterIssue,
} from "@contracts/device-model-binding";
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
import { installPackage, parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { downloadBlob, downloadFile } from "@/lib/download";
import { exportSystemTwinArchive } from "@/lib/system-twin-export";
import { runSystemTwin } from "@/lib/system-twin-runtime";

const ArticulatedAssemblyViewport = lazy(() => import("./ArticulatedAssemblyViewport"));

type Props = {
  workspace: TwinWorkspace;
  system?: TwinSystemAssembly;
  trial?: boolean;
  onTrialReady?: (ready: boolean) => void;
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

type InspectorTab = "axes" | "wiring" | "calibration" | "events";

function provenanceBadge(p: string): { label: string; cls: string } {
  switch (p) {
    case "confirmed":
      return { label: "已核实", cls: "bg-emerald-500/15 text-emerald-300" };
    case "inferred":
      return { label: "自动推断", cls: "bg-sky-500/15 text-sky-300" };
    case "assumed":
      return { label: "人工设定", cls: "bg-indigo-500/15 text-indigo-300" };
    default:
      return { label: "待确认", cls: "bg-amber-500/15 text-amber-200" };
  }
}

function tryInitialDraft(workspace: TwinWorkspace): TwinSystemAssembly | null {
  try {
    return draftSystemFromWorkspace(workspace, { defaultTriggerPositionMm: 16 });
  } catch {
    return null;
  }
}

export default function SystemTwinBench({ workspace, system, trial = false, onTrialReady, onSave }: Props) {
  const [draft, setDraft] = useState<TwinSystemAssembly | null>(() => system ?? tryInitialDraft(workspace));
  const [iniText, setIniText] = useState("");
  const [halText, setHalText] = useState("");
  const [showLinuxCnc, setShowLinuxCnc] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingStarter, setLoadingStarter] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [trace, setTrace] = useState<RuntimeTrace | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedAxisIndex, setSelectedAxisIndex] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("axes");
  const [serialNumber, setSerialNumber] = useState(() => system?.assetBindings?.[0]?.serialNumber ?? "SN-AXIS-001");
  const [calVersion, setCalVersion] = useState("cal-v1");
  const [fieldCsvText, setFieldCsvText] = useState("");
  const [reverifyCsvText, setReverifyCsvText] = useState("");
  const [primaryComparison, setPrimaryComparison] = useState<FieldComparisonReport | null>(null);
  const [reverifyComparison, setReverifyComparison] = useState<FieldComparisonReport | null>(null);
  const [calMassInput, setCalMassInput] = useState("");
  const [pendingInputs, setPendingInputs] = useState<Record<string, string>>({});
  const runAbort = useRef<AbortController | null>(null);
  const autoRanId = useRef<string | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);

  const drives = useMemo(() => workspace.packages.filter((p) => hasServoRole(p, "drive")), [workspace.packages]);
  const motors = useMemo(() => workspace.packages.filter((p) => hasServoRole(p, "motor")), [workspace.packages]);
  const screws = useMemo(() => workspace.packages.filter((p) => hasFeedRole(p, "screw")), [workspace.packages]);
  const tables = useMemo(() => workspace.packages.filter((p) => hasFeedRole(p, "table")), [workspace.packages]);

  const readiness = useMemo(
    () => (draft ? evaluateSystemReadiness(workspace, draft) : null),
    [workspace, draft],
  );

  const devicePendingItems = useMemo(() => {
    if (!draft) return [];
    const referencedKeys = Array.from(
      new Set([
        ...draft.axes.flatMap((a) => [a.driveKey, a.motorKey, a.screwKey, a.tableKey]),
        ...draft.sensors.map((s) => s.packageKey).filter((k): k is string => Boolean(k)),
        ...draft.diChannels.map((d) => d.packageKey).filter((k): k is string => Boolean(k)),
      ]),
    );
    const seen = new Set<string>();
    const items: Array<{
      itemId: string;
      pkgKey: string;
      pkgLabel: string;
      key: string;
      sourceKey: string;
      label: string;
      unit: string;
      reason: string;
      valueType: "number" | "boolean";
      candidates: PendingParameterIssue["candidates"];
    }> = [];

    for (const refKey of referencedKeys) {
      const pkg = workspace.packages.find((p) => packageKey(p) === refKey);
      if (!pkg) continue;
      for (const binding of effectiveModelBindings(pkg)) {
        const res = evaluateBindingReadiness(pkg, binding.id);
        for (const pend of res.pendingParameters) {
          if (
            binding.modelRef.id === "GouyuanSignal.PositionLimitSwitch"
            && pend.key === "triggerPositionMm"
            && draft.sensors.some((s) => s.packageKey === refKey && s.triggerPositionMm !== undefined)
          ) {
            continue;
          }
          const itemId = `${refKey}::${pend.sourceKey}`;
          if (seen.has(itemId)) continue;
          seen.add(itemId);
          const spec = res.model?.parameters.find((p) => p.key === pend.key);
          items.push({
            itemId,
            pkgKey: refKey,
            pkgLabel: `${pkg.manufacturer} ${pkg.model}`,
            key: pend.key,
            sourceKey: pend.sourceKey,
            label: pend.label,
            unit: pend.modelUnit,
            reason: pend.reason,
            valueType: spec?.valueType ?? "number",
            candidates: pend.candidates,
          });
        }
        for (const miss of res.missingParameters) {
          const itemId = `${refKey}::${miss.key}`;
          if (seen.has(itemId)) continue;
          seen.add(itemId);
          const spec = res.model?.parameters.find((p) => p.key === miss.key);
          items.push({
            itemId,
            pkgKey: refKey,
            pkgLabel: `${pkg.manufacturer} ${pkg.model}`,
            key: miss.key,
            sourceKey: miss.key,
            label: miss.label,
            unit: miss.unit,
            reason: miss.reason,
            valueType: spec?.valueType ?? "number",
            candidates: [],
          });
        }
      }
    }
    return items;
  }, [draft, workspace.packages]);

  function applyPendingParameter(item: (typeof devicePendingItems)[number]) {
    if (!draft) return;
    setError("");
    const raw = (pendingInputs[item.itemId] ?? "").trim();
    if (!raw) {
      setError(`请先填写「${item.label}」的数值。`);
      return;
    }
    try {
      let parsedValue: number | boolean;
      if (item.valueType === "boolean") {
        const lowered = raw.toLowerCase();
        if (["true", "1", "yes", "是", "nc", "常闭"].includes(lowered)) parsedValue = true;
        else if (["false", "0", "no", "否", "常开"].includes(lowered)) parsedValue = false;
        else throw new Error(`“${item.label}”需输入布尔值（true/false 或 1/0）。`);
      } else {
        const num = Number(raw);
        if (!Number.isFinite(num)) throw new Error(`“${item.label}”请输入有效数字（支持科学计数法，如 2.6e-5）。`);
        parsedValue = num;
      }
      const pkg = workspace.packages.find((p) => packageKey(p) === item.pkgKey);
      if (!pkg) throw new Error(`找不到设备包：${item.pkgKey}`);
      const updatedPkg = fillPendingParameterValue(
        pkg,
        item.sourceKey,
        parsedValue,
        item.unit,
        "assumed",
        "闭环工作台人工补全照片/资料未列参数",
      );
      const nextWorkspace = parseWorkspace({
        ...workspace,
        packages: workspace.packages.map((p) => (packageKey(p) === item.pkgKey ? updatedPkg : p)),
      });
      autoRanId.current = null;
      setTrace(null);
      onSave(draft, nextWorkspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "补全待确认参数失败。");
    }
  }

  function choosePendingCandidate(item: (typeof devicePendingItems)[number], candidateIndex: number) {
    if (!draft) return;
    setError("");
    try {
      const pkg = workspace.packages.find((p) => packageKey(p) === item.pkgKey);
      if (!pkg) throw new Error(`找不到设备包：${item.pkgKey}`);
      const updatedPkg = resolveParameterChoice(pkg, item.sourceKey, candidateIndex);
      const nextWorkspace = parseWorkspace({
        ...workspace,
        packages: workspace.packages.map((p) => (packageKey(p) === item.pkgKey ? updatedPkg : p)),
      });
      autoRanId.current = null;
      setTrace(null);
      onSave(draft, nextWorkspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "应用选件候选失败。");
    }
  }

  useEffect(() => () => { runAbort.current?.abort(); }, []);

  useEffect(() => {
    onTrialReady?.(Boolean(readiness?.ready));
  }, [onTrialReady, readiness?.ready]);

  useEffect(() => {
    if (!draft || !readiness?.ready || autoRanId.current === draft.id) return;
    const controller = new AbortController();
    void runSystemTwin(workspace, draft, controller.signal).then((nextTrace) => {
      if (!controller.signal.aborted) {
        autoRanId.current = draft.id;
        setTrace(nextTrace);
        setFrameIndex(nextTrace.frames.length - 1);
      }
    }).catch((cause) => {
      if (!controller.signal.aborted && (cause as { name?: string })?.name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : "机电控闭环初始化仿真失败。");
      }
    });
    return () => controller.abort();
  }, [draft, readiness?.ready, workspace]);

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

  async function loadStarterKit() {
    setError("");
    setLoadingStarter(true);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}assemblies/closed-loop-axis/project.twin.json`);
      if (!response.ok) throw new Error(`读取标准闭环工程模板失败（HTTP ${response.status}）。`);
      const starterWs = parseWorkspace(await response.json());
      const starterSys = starterWs.systems?.[0];
      if (!starterSys) throw new Error("标准模板缺少闭环系统定义。");
      const mergedWs = starterWs.packages.reduce(installPackage, workspace);
      setDraft(starterSys);
      setTrace(null);
      onSave(starterSys, mergedWs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "载入跨品牌标准闭环模板失败。");
    } finally {
      setLoadingStarter(false);
    }
  }

  const feedVisual = useMemo(
    () => (draft ? buildComposableFeedModuleTemplate(draft, workspace) : null),
    [draft, workspace],
  );

  if (!draft) {
    return (
      <section className="surface space-y-4 p-5" aria-label="机电控闭环系统装配">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">搭建机电控闭环系统</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            系统闭环需要绑定伺服驱动器、伺服电机、滚珠丝杠与移动工作台设备包（可选配限位开关与 DI 模块）。当前工程尚缺少成套驱动与进给器件，可直接载入跨品牌标准套件立即开始。
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={loadingStarter} onClick={() => void loadStarterKit()}>
            <Play />{loadingStarter ? "正在载入跨品牌套件…" : "载入跨品牌标准套件（台达 + THK + 汇川 GL10）"}
          </Button>
          <Button variant="outline" onClick={() => regenerateDraft(false)}><RefreshCw />从当前工程资源生成草案</Button>
          <Button variant="ghost" asChild>
            <Link to={studioHref({ view: "resources" })}><FolderInput />去设备与资料库拍照/导入</Link>
          </Button>
        </div>
      </section>
    );
  }

  const activeFrame = trace?.frames[Math.min(frameIndex, trace.frames.length - 1)];
  const inspectAxis = trace?.axisSummaries[Math.min(selectedAxisIndex, trace.axisSummaries.length - 1)];
  const inspectAxisLive = inspectAxis ? activeFrame?.axes[inspectAxis.axisId] : undefined;
  const drivenFeedCommands =
    feedVisual && activeFrame
      ? mapSystemTraceFrameToCommands(feedVisual.assembly, activeFrame, feedVisual.workspace)
      : undefined;
  const verificationStatus = evaluateSystemVerificationStatus(primaryComparison, reverifyComparison);
  const missingSensorTriggers = draft.sensors.filter((s) => s.triggerPositionMm === undefined);
  const hasBlockingPending = Boolean(
    readiness && (
      readiness.pendingItems.length > 0 ||
      readiness.blockingErrors.length > 0 ||
      devicePendingItems.length > 0 ||
      missingSensorTriggers.length > 0
    ),
  );

  function openCalibrationTab() {
    setInspectorTab("calibration");
    inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

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
    <div className="space-y-3.5">
      {/* Compact Top Control Bar */}
      <section className="surface space-y-3 p-3.5 sm:p-4" aria-label="机电控系统配置">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            <label className="flex min-w-52 max-w-sm flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">系统</span>
              <Input
                aria-label="系统名称"
                className="h-8 text-sm font-medium"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {readiness && (
              <span
                role={readiness.ready ? "status" : "alert"}
                className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium ${
                  readiness.ready
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                }`}
              >
                {readiness.ready ? <CheckCircle2 className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                {readiness.ready
                  ? `就绪 · 已核实 ${readiness.confirmedItems.length} 项${readiness.inferredItems.length ? ` · 自动推断 ${readiness.inferredItems.length} 项` : ""}`
                  : `待补全 ${readiness.pendingItems.length + readiness.blockingErrors.length} 项参数`}
              </span>
            )}
            {trace && (
              <span className={`rounded px-2 py-1 text-[11px] font-medium ${verificationStatus.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground"}`}>
                {verificationStatus.label}
              </span>
            )}
            {readiness && (readiness.inferredItems.length > 0 || readiness.pendingItems.length > 0) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-primary"
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

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={running || !readiness?.ready} onClick={() => void runSimulation()}>
              <Play className="size-3.5" />{running ? "正在求解…" : trace ? "重新求解闭环" : "运行闭环仿真"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onSave(draft)}>
              <Save className="size-3.5" />{trial ? "更新试用修改" : "保存系统"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1">
                  <Wrench className="size-3.5" />工程工具<ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>建模与导出操作</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => regenerateDraft(false)}>
                  <RefreshCw />从 BOM 重新生成草案
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShowLinuxCnc((v) => !v)}>
                  <Wrench />{showLinuxCnc ? "收起 LinuxCNC 导入框" : "导入 LinuxCNC .ini/.hal"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={addReusedAxis}>
                  <CopyPlus />复用单轴扩展多轴
                </DropdownMenuItem>
                {trace && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={exporting} onSelect={() => void exportModelicaBundle()}>
                      <Download />{exporting ? "打包 Modelica 校核包中…" : "导出 Modelica 校核包 (ZIP)"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => downloadBlob(runtimeTraceToCsv(trace), `${trace.systemId}-trace.csv`, "text/csv;charset=utf-8")}>
                      <Download />导出闭环轨迹 Trace CSV
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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

        {hasBlockingPending && readiness && (
          <div role="alert" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <p className="font-medium text-amber-200">
              待补全器件参数（不编造照片/资料未列数值，补全后立即解锁闭环仿真）：
            </p>
            {[...readiness.pendingItems, ...readiness.blockingErrors].length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-amber-100/90">
                {[...readiness.pendingItems, ...readiness.blockingErrors].map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
            )}
            {devicePendingItems.map((item) => (
              <div
                key={item.itemId}
                className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background/90 p-2 text-foreground"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {item.pkgLabel} · {item.label}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">（单位：{item.unit}）</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">{item.reason}</p>
                </div>
                {item.candidates.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {item.candidates.map((cand, cIdx) => (
                      <Button
                        key={`${item.itemId}-cand-${cIdx}`}
                        size="sm"
                        variant="outline"
                        onClick={() => choosePendingCandidate(item, cIdx)}
                      >
                        采用「{cand.option}」({String(cand.value)} {cand.unit ?? item.unit})
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Input
                      type="text"
                      inputMode="decimal"
                      aria-label={`补全 ${item.pkgLabel} ${item.label}`}
                      placeholder={
                        item.key === "rotorInertiaKgM2"
                          ? "例如 0.000026 或 2.6e-5"
                          : `输入数值 (${item.unit})`
                      }
                      className="h-8 w-44 text-xs"
                      value={pendingInputs[item.itemId] ?? ""}
                      onChange={(e) =>
                        setPendingInputs((prev) => ({ ...prev, [item.itemId]: e.target.value }))
                      }
                    />
                    <Button size="sm" onClick={() => applyPendingParameter(item)}>
                      确认补全并解锁
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {missingSensorTriggers.map((s) => (
              <div
                key={`missing-trig-${s.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background/90 p-2 text-foreground"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name} · 安装触发坐标（单位：mm）</p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.note || "草图/设备包未标注限位开关触发坐标（mm），填写后即可参与限位截断仿真。"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    type="text"
                    inputMode="decimal"
                    aria-label={`补全限位 ${s.name} 触发坐标`}
                    placeholder="例如 115"
                    className="h-8 w-44 text-xs"
                    value={pendingInputs[`sensor::${s.id}`] ?? ""}
                    onChange={(e) =>
                      setPendingInputs((prev) => ({ ...prev, [`sensor::${s.id}`]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const num = Number((pendingInputs[`sensor::${s.id}`] ?? "").trim());
                      if (!Number.isFinite(num)) {
                        setError(`限位「${s.name}」的触发坐标请输入有效数字（mm）。`);
                        return;
                      }
                      setError("");
                      setDraft({
                        ...draft,
                        sensors: draft.sensors.map((item) =>
                          item.id === s.id ? { ...item, triggerPositionMm: num, provenance: "confirmed" } : item,
                        ),
                      });
                      autoRanId.current = null;
                      setTrace(null);
                    }}
                  >
                    设置坐标并确认
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>

      {/* Stage First: Closed-Loop RuntimeTrace & Coupled 3D Screw Twin */}
      {trace && activeFrame && (
        <section className="surface space-y-3.5 p-4" aria-label="RuntimeTrace 联合轨迹与事件">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b pb-2.5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Activity className="size-4 text-primary" />
                <h3 className="text-sm font-semibold sm:text-base">Modelica WASM + 离散开关闭环仿真结果</h3>
                <span className="mono rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  t = {activeFrame.timeMs} / {trace.durationMs} ms · 末端 ({activeFrame.tipPoseMm.map((v) => v.toFixed(2)).join(", ")}) mm
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {trace.axisSummaries.length > 1 && (
                <div role="group" aria-label="切换观察轴" className="flex items-center gap-1 rounded border bg-background/60 p-0.5">
                  {trace.axisSummaries.map((sum, idx) => (
                    <Button
                      key={sum.axisId}
                      size="sm"
                      type="button"
                      className="h-6 px-2 text-xs"
                      variant={idx === selectedAxisIndex ? "secondary" : "ghost"}
                      onClick={() => setSelectedAxisIndex(idx)}
                    >
                      {sum.axisName}
                    </Button>
                  ))}
                </div>
              )}
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setPlaying(!playing)}>
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {playing ? "暂停回放" : "同步回放"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={openCalibrationTab}>
                <Activity className="size-3.5" />实机录波对标
              </Button>
            </div>
          </div>

          <label className="flex items-center gap-3 text-xs">
            <span className="mono w-14 shrink-0 text-muted-foreground">0 ms</span>
            <input
              type="range"
              aria-label="闭环轨迹时间滑块"
              className="h-4 w-full accent-primary"
              min={0}
              max={trace.frames.length - 1}
              value={frameIndex}
              onChange={(e) => {
                setPlaying(false);
                setFrameIndex(Number(e.target.value));
              }}
            />
            <span className="mono w-16 shrink-0 text-right text-muted-foreground">{trace.durationMs} ms</span>
          </label>

          {/* Balanced 4-Column Telemetry Strip */}
          {inspectAxis && inspectAxisLive && (
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="surface-inset p-2.5">
                <p className="text-[11px] text-muted-foreground">{inspectAxis.axisName} · 实时位移</p>
                <p className="mono mt-0.5 text-lg font-semibold text-foreground">{inspectAxisLive.positionMm.toFixed(3)} mm</p>
                <p className="mono text-[11px] text-muted-foreground">终停 {inspectAxis.finalPositionMm.toFixed(3)} mm</p>
              </div>
              <div className="surface-inset p-2.5">
                <p className="text-[11px] text-muted-foreground">瞬时进给速度</p>
                <p className="mono mt-0.5 text-lg font-semibold text-foreground">{inspectAxisLive.velocityMmS.toFixed(1)} mm/s</p>
                <p className="mono text-[11px] text-muted-foreground">电机转速 {inspectAxisLive.speedRpm.toFixed(0)} rpm</p>
              </div>
              <div className="surface-inset p-2.5">
                <p className="text-[11px] text-muted-foreground">电机电磁转矩</p>
                <p className="mono mt-0.5 text-lg font-semibold text-foreground">{inspectAxisLive.motorTorqueNm.toFixed(3)} N·m</p>
                <p className="mono text-[11px] text-muted-foreground">轴向推力 {inspectAxisLive.axialForceN.toFixed(1)} N</p>
              </div>
              <div className="surface-inset p-2.5">
                <p className="text-[11px] text-muted-foreground">限位保护与状态</p>
                <p className={`mt-0.5 text-sm font-semibold ${inspectAxisLive.stopLatched ? "text-amber-400" : "text-emerald-400"}`}>
                  {inspectAxisLive.stopLatched ? "急停锁存生效" : "闭环运行跟踪"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {inspectAxis.stopTriggeredAtMs !== null
                    ? `触发于 ${inspectAxis.stopTriggeredAtMs} ms (${inspectAxis.stopTriggerPositionMm?.toFixed(2)} mm · 滑行 ${(inspectAxis.brakingDistanceMm ?? 0).toFixed(2)} mm)`
                    : "全程未触及限位"}
                </p>
              </div>
            </div>
          )}

          {/* Side-by-Side Stage: Waveform Plot + Coupled 3D Feed Screw Viewport */}
          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="min-w-0 space-y-2.5">
              {inspectAxis && (
                <AxisTracePlot
                  trace={trace}
                  axisId={inspectAxis.axisId}
                  activeTimeMs={activeFrame.timeMs}
                  stopTriggeredAtMs={inspectAxis.stopTriggeredAtMs}
                  overlayPoints={primaryComparison?.axisId === inspectAxis.axisId ? primaryComparison.overlayPoints : undefined}
                />
              )}
              <div className="grid gap-1.5">
                {draft.sensors.map((s) => (
                  <div key={s.id} className="mono flex items-center justify-between gap-2 rounded border bg-background/60 px-2.5 py-1.5 text-[11px]">
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className={`shrink-0 whitespace-nowrap ${activeFrame.sensorTriggered[s.id] ? "font-semibold text-amber-300" : "text-emerald-300"}`}>
                      {activeFrame.sensorTriggered[s.id] ? "触发" : "未触发"} ({activeFrame.sensorVoltageV[s.id]?.toFixed(1)} V)
                    </span>
                  </div>
                ))}
                {draft.diChannels.map((d) => (
                  <div key={d.id} className="mono flex items-center justify-between gap-2 rounded border bg-background/60 px-2.5 py-1.5 text-[11px]">
                    <span className="min-w-0 truncate">{d.name}</span>
                    <span className={`shrink-0 whitespace-nowrap ${activeFrame.diState[d.id] ? "font-semibold text-primary" : "text-muted-foreground"}`}>
                      {activeFrame.diState[d.id] ? "DI = ON (1)" : "DI = OFF (0)"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {feedVisual && (
              <div className="surface-inset min-w-0 p-3">
                <Suspense fallback={<p role="status" className="py-6 text-center text-xs text-muted-foreground">正在加载三维可动视口…</p>}>
                  <ArticulatedAssemblyViewport
                    compact
                    hideHeader
                    workspace={feedVisual.workspace}
                    assembly={feedVisual.assembly}
                    externalCommands={drivenFeedCommands}
                    externalStatusLabel={`三维机械同步联动 · 时刻 ${activeFrame.timeMs} ms · 工作台 ${(activeFrame.axes[draft.axes[0].id]?.positionMm ?? 0).toFixed(3)} mm`}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Tabbed Engineering Inspector */}
      <section ref={inspectorRef} className="surface space-y-3.5 p-4" aria-label="系统参数与对标检查器">
        <div role="tablist" aria-label="工程检查器分页" className="flex flex-wrap gap-1 border-b pb-2.5">
          <Button
            size="sm"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "axes"}
            variant={inspectorTab === "axes" ? "secondary" : "ghost"}
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => setInspectorTab("axes")}
          >
            <SlidersHorizontal className="size-3.5" />
            轴传动与控制器 ({draft.axes.length})
          </Button>
          <Button
            size="sm"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "wiring"}
            variant={inspectorTab === "wiring" ? "secondary" : "ghost"}
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => setInspectorTab("wiring")}
          >
            <Cable className="size-3.5" />
            限位滤波与接线 ({draft.wires.length})
          </Button>
          <Button
            size="sm"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "calibration"}
            variant={inspectorTab === "calibration" ? "secondary" : "ghost"}
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => setInspectorTab("calibration")}
          >
            <Activity className="size-3.5" />
            实机录波对标与标定
          </Button>
          <Button
            size="sm"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "events"}
            variant={inspectorTab === "events" ? "secondary" : "ghost"}
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => setInspectorTab("events")}
          >
            <Layers className="size-3.5" />
            离散信号跃迁日志 ({trace?.events.length ?? 0})
          </Button>
        </div>

        {inspectorTab === "axes" && (
          <div className="grid gap-3 lg:grid-cols-2">
            {draft.axes.map((axis, idx) => {
              const ctrl = draft.controllers.find((c) => c.axisId === axis.id)!;
              const badge = provenanceBadge(axis.provenance);
              return (
                <div key={axis.id} className="space-y-2.5 rounded-md border bg-background/60 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2 border-b pb-2">
                    <span className="font-semibold text-foreground">{axis.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
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
        )}

        {inspectorTab === "wiring" && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-2.5">
              {draft.sensors.map((s, idx) => {
                const badge = provenanceBadge(s.provenance);
                return (
                  <div key={s.id} className="grid grid-cols-3 gap-2 rounded-md border bg-background/60 p-3 text-xs">
                    <div className="col-span-3 flex items-center justify-between">
                      <span className="font-semibold">{s.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                    </div>
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
                );
              })}
              {draft.diChannels.map((di, idx) => {
                const badge = provenanceBadge(di.provenance);
                return (
                  <div key={di.id} className="grid grid-cols-2 gap-2 rounded-md border bg-background/60 p-3 text-xs">
                    <div className="col-span-2 flex items-center justify-between">
                      <span className="font-semibold">{di.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
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
                );
              })}
            </div>

            <div className="space-y-2 rounded-md border bg-background/40 p-3 text-xs">
              <h4 className="font-semibold">数字量信号与控制器连线（{draft.wires.length} 条）</h4>
              <div className="space-y-1.5">
                {draft.wires.map((w, idx) => {
                  const badge = provenanceBadge(w.provenance);
                  return (
                    <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background/70 px-2.5 py-1.5">
                      <span className="mono text-[11px]">
                        {w.from.nodeId}.{w.from.portId} ──▶ {w.to.nodeId}.{w.to.portId}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {w.to.kind === "controller" && (
                          <button
                            type="button"
                            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                              w.invert ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20" : "hover:bg-muted"
                            }`}
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
                            {w.invert ? "常闭取反 (-not)" : "直通逻辑"}
                          </button>
                        )}
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {inspectorTab === "calibration" && (
          inspectAxis && trace ? (
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-semibold">实机资产绑定与示波器录波对标（{inspectAxis.axisName}）</h4>
                  <p className="text-muted-foreground">{verificationStatus.detail}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
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
              <div className="grid gap-2.5 sm:grid-cols-3">
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
                    <div key={rep.profileRole} className="rounded border bg-background/60 p-2.5">
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
          ) : (
            <p className="text-xs text-muted-foreground">请先运行闭环仿真，再导入实机示波器 CSV 进行双工况录波对标。</p>
          )
        )}

        {inspectorTab === "events" && (
          !trace ? (
            <p className="text-xs text-muted-foreground">运行闭环仿真后可查看传感器触发与急停锁存的完整时间轴跃迁日志。</p>
          ) : trace.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">本次运行期间开关及限位状态未发生跃迁。</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {trace.events.map((ev, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded border bg-background/50 px-2.5 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
                    onClick={() => {
                      setPlaying(false);
                      const fIdx = trace.frames.findIndex((f) => f.timeMs === ev.timeMs);
                      if (fIdx >= 0) setFrameIndex(fIdx);
                    }}
                  >
                    <span className="mono shrink-0 font-semibold text-primary">{ev.timeMs} ms</span>
                    <span className="flex-1 truncate">{ev.detail}</span>
                    <span className="text-[11px] text-muted-foreground">跳至此帧</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </div>
  );
}

function AxisTracePlot({ trace, axisId, activeTimeMs, stopTriggeredAtMs, overlayPoints }: {
  trace: RuntimeTrace;
  axisId: string;
  activeTimeMs: number;
  stopTriggeredAtMs: number | null;
  overlayPoints?: readonly { readonly timeMs: number; readonly measPositionMm: number }[];
}) {
  const frames = trace.frames;
  if (frames.length < 2) return null;
  const w = 640, h = 230, padL = 48, padR = 16, padT = 18, padB = 30;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const posVals = [
    ...frames.flatMap((f) => [f.axes[axisId].commandMm, f.axes[axisId].positionMm]),
    ...(overlayPoints?.map((p) => p.measPositionMm) ?? []),
  ];
  const minP = Math.min(...posVals, 0), maxP = Math.max(...posVals, 1);
  const spanP = Math.max(1e-6, maxP - minP);
  const totalMs = Math.max(1, trace.durationMs);
  const xAt = (t: number) => padL + (t / totalMs) * innerW;
  const yAt = (p: number) => padT + innerH - ((p - minP) / spanP) * innerH;
  const step = Math.max(1, Math.floor(frames.length / 220));
  const sampled = frames.filter((_, idx) => idx % step === 0 || idx === frames.length - 1);
  const cmdPath = sampled.map((f, i) => `${i ? "L" : "M"}${xAt(f.timeMs).toFixed(1)},${yAt(f.axes[axisId].commandMm).toFixed(1)}`).join("");
  const posPath = sampled.map((f, i) => `${i ? "L" : "M"}${xAt(f.timeMs).toFixed(1)},${yAt(f.axes[axisId].positionMm).toFixed(1)}`).join("");
  const measPath = overlayPoints && overlayPoints.length > 1
    ? overlayPoints.map((p, i) => `${i ? "L" : "M"}${xAt(p.timeMs).toFixed(1)},${yAt(p.measPositionMm).toFixed(1)}`).join("")
    : "";
  const cursorX = xAt(activeTimeMs);
  const activePos = frames.find((f) => f.timeMs === activeTimeMs)?.axes[axisId]?.positionMm;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => minP + r * spanP);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(r * totalMs));

  return (
    <div className="surface-inset p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-sky-400" />Modelica 闭环反馈 (mm)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed border-slate-400" />控制指令
          </span>
          {measPath && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-emerald-400" />实测录波
            </span>
          )}
        </div>
        <span className="mono text-[11px] text-muted-foreground">{minP.toFixed(1)} ~ {maxP.toFixed(1)} mm</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-56 w-full select-none">
        {yTicks.map((val, idx) => {
          const y = yAt(val);
          return (
            <g key={idx}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="currentColor" strokeOpacity={0.1} strokeDasharray="3 3" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity={0.55}>
                {val.toFixed(1)}
              </text>
            </g>
          );
        })}
        {xTicks.map((ms, idx) => {
          const x = xAt(ms);
          return (
            <g key={idx}>
              <line x1={x} y1={padT} x2={x} y2={padT + innerH} stroke="currentColor" strokeOpacity={0.08} />
              <text x={x} y={padT + innerH + 15} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.55}>
                {ms} ms
              </text>
            </g>
          );
        })}
        <line x1={padL} y1={padT + innerH} x2={w - padR} y2={padT + innerH} stroke="currentColor" strokeOpacity={0.25} />
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="currentColor" strokeOpacity={0.25} />
        {stopTriggeredAtMs !== null && (
          <g>
            <line
              x1={xAt(stopTriggeredAtMs)}
              y1={padT}
              x2={xAt(stopTriggeredAtMs)}
              y2={padT + innerH}
              stroke="#fb7185"
              strokeDasharray="4 3"
              strokeWidth={1.3}
            />
            <text x={Math.min(xAt(stopTriggeredAtMs) + 4, w - 70)} y={padT + 11} fontSize="10" fill="#fda4af">
              限位急停 {stopTriggeredAtMs}ms
            </text>
          </g>
        )}
        <path d={cmdPath} fill="none" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1.6} />
        <path d={posPath} fill="none" stroke="#38bdf8" strokeWidth={2.4} />
        {measPath && <path d={measPath} fill="none" stroke="#34d399" strokeWidth={1.8} strokeDasharray="2 2" />}
        <line x1={cursorX} y1={padT} x2={cursorX} y2={padT + innerH} stroke="#f59e0b" strokeWidth={1.5} />
        {activePos !== undefined && (
          <circle cx={cursorX} cy={yAt(activePos)} r={4} fill="#f59e0b" stroke="#0b100e" strokeWidth={1.5} />
        )}
      </svg>
    </div>
  );
}
