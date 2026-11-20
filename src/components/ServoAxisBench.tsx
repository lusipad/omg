import { useEffect, useMemo, useState } from "react";
import { Activity, Download, ExternalLink, Play } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadBlob } from "@/lib/download";
import { hasServoRole, tryResolveServoDriveRatings, tryResolveServoMotorRatings } from "@contracts/device-model-binding";
import { bindModelicaServo, modelicaServoInfo, MODELICA_SERVO_LIBRARY, MODELICA_SERVO_REF, type ModelicaServoParameters } from "@contracts/modelica-servo";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { assembleServoAxis, isCompatibleServoPair, SERVO_AXIS_MODEL, simulateServoAxis, type ServoAxisConfig, type ServoAxisResult } from "@contracts/servo-axis";
import modelicaArtifact from "../../public/modelica/runtime/manifest.json";

type Props = {
  workspace: TwinWorkspace;
  onChange: (next: TwinWorkspace) => void;
  preferred?: { driveKey?: string; motorKey?: string };
};
type Sample = ServoAxisResult["samples"][number];
type Solver = "legacy" | "modelica" | "missing";
const modelLabel = `${MODELICA_SERVO_REF.id} ${MODELICA_SERVO_REF.version}`;
const modelSource = import.meta.env.BASE_URL + "modelica/" + MODELICA_SERVO_LIBRARY.source;
const modelGuide = "https://github.com/lusipad/omg/blob/main/docs/Modelica伺服轴.md";

function solverFor(axis?: ServoAxisConfig): Solver {
  if (!axis) return "modelica";
  if (!axis.modelRef) return "legacy";
  return axis.modelRef.id === MODELICA_SERVO_REF.id && axis.modelRef.version === MODELICA_SERVO_REF.version ? "modelica" : "missing";
}

function axisSignature(axis?: ServoAxisConfig) {
  return axis ? JSON.stringify([axis.driveKey, axis.motorKey, axis.targetDeg, axis.loadInertiaRatio, axis.modelRef?.id, axis.modelRef?.version]) : "";
}

function initialForm(axis?: ServoAxisConfig, preferred?: Props["preferred"]) {
  return { origin: axisSignature(axis), driveChoice: preferred?.driveKey ?? "", motorChoice: preferred?.motorKey ?? "",
    angle: String(axis?.targetDeg ?? 90), load: String(axis?.loadInertiaRatio ?? 1), solver: solverFor(axis), error: "" };
}

const valueFormat = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 5, useGrouping: false });
function formatValue(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude > 0 && (magnitude < 0.001 || magnitude > 1e7)) return value.toExponential(2);
  return valueFormat.format(value === 0 ? 0 : value);
}

const positionColor = "#62dfb0", speedColor = "#80c0f5", targetColor = "#e7bc72";
const selectStyle = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";

function axisTicks(low: number, high: number): number[] {
  if (low === high) return [-1, 0, 1];
  const rough = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  if (!magnitude) return [low, high];
  const choices = [1, 2, 2.5, 5, 10].map((value) => value * magnitude);
  const step = choices.reduce((best, value) => Math.abs(value - rough) < Math.abs(best - rough) ? value : best);
  const start = Math.floor(low / step), stop = Math.ceil(high / step);
  return Array.from({ length: stop - start + 1 }, (_, index) => (start + index) * step);
}

function Trace({ samples, metric, targetDeg, cursor }: {
  samples: Sample[]; metric: "positionDeg" | "speedRpm"; targetDeg: number; cursor: Sample;
}) {
  const position = metric === "positionDeg";
  const title = position ? "角位置（°）" : "转速（rpm）";
  const color = position ? positionColor : speedColor;
  const values = samples.map((point) => point[metric]);
  const low = Math.min(0, ...values, position ? targetDeg : 0);
  const high = Math.max(0, ...values, position ? targetDeg : 0);
  const ticks = axisTicks(low, high);
  const minTick = ticks[0], maxTick = ticks[ticks.length - 1], padding = (maxTick - minTick) * 0.04;
  const end = samples[samples.length - 1].timeMs || SERVO_AXIS_MODEL.samplePeriodMs;
  const times = axisTicks(0, end).filter((value) => value <= end);
  return (
    <figure className="min-w-0" aria-label={`${title}随时间变化曲线`}>
      <figcaption className="mb-1 flex items-center gap-2 text-xs font-medium">
        <span aria-hidden="true" className="h-0.5 w-5" style={{ backgroundColor: color }} />{title}
        {position && <span className="ml-auto inline-flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
          <span aria-hidden="true" className="w-5 border-t-2 border-dashed" style={{ borderColor: targetColor }} />目标 {formatValue(targetDeg)}°
        </span>}
      </figcaption>
      <div className="h-36 min-w-0 sm:h-40">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={samples} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#29332f" strokeDasharray="3 4" />
            <XAxis type="number" dataKey="timeMs" domain={[0, end]} ticks={times} interval="preserveStartEnd"
              height={24} stroke="#87968e" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis type="number" width={53} domain={[minTick - padding, maxTick + padding]} ticks={ticks} interval={0}
              tickFormatter={formatValue} stroke="#87968e" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <ReferenceLine y={0} stroke="#526058" />
            {position && <ReferenceLine y={targetDeg} stroke={targetColor} strokeWidth={3} strokeDasharray="6 4" />}
            <ReferenceLine x={cursor.timeMs} stroke="#8a9d94" strokeDasharray="2 3" />
            <Line type="linear" dataKey={metric} stroke={color} strokeWidth={2} dot={samples.length === 1} isAnimationActive={false} />
            <ReferenceDot x={cursor.timeMs} y={cursor[metric]} r={3.5} fill={color} stroke="#17211c" isFront />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function ResponsePanel({ result, targetDeg, filename }: { result: ServoAxisResult; targetDeg: number; filename: string }) {
  const { samples } = result;
  const [index, setIndex] = useState(samples.length - 1);
  const sample = samples[Math.min(index, samples.length - 1)];
  const end = samples[samples.length - 1];
  function exportCsv() {
    const rows = ["time_ms,target_deg,position_deg,speed_rpm", ...samples.map(s => [s.timeMs, targetDeg, s.positionDeg, s.speedRpm].join(","))];
    downloadBlob("\uFEFF" + rows.join("\r\n") + "\r\n", filename, "text/csv;charset=utf-8");
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">从静止起步 · 计算至 {formatValue(end.timeMs)} ms</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className={result.settled ? "text-xs text-primary" : "text-xs text-amber-300"}>{result.settled ? "已到位" : "观察时间内未到位"}</span>
          <Button size="sm" type="button" variant="outline" onClick={exportCsv}><Download />导出响应 CSV</Button>
        </div>
      </div>
      <Trace samples={samples} metric="positionDeg" targetDeg={targetDeg} cursor={sample} />
      <Trace samples={samples} metric="speedRpm" targetDeg={targetDeg} cursor={sample} />
      <p className="ml-[53px] text-center text-[11px] text-muted-foreground">时间（ms）</p>
      <div className="surface-inset mt-3 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
          <label htmlFor="servo-sample">采样读数</label>
          <output htmlFor="servo-sample" aria-label="伺服采样读数" className="mono break-words">
            {formatValue(sample.timeMs)} ms · {formatValue(sample.positionDeg)}° · {formatValue(sample.speedRpm)} rpm
          </output>
        </div>
        <input id="servo-sample" className="mt-2 block h-4 w-full accent-primary" type="range" min={0} max={samples.length - 1} step={1}
          value={Math.min(index, samples.length - 1)} aria-valuetext={`${sample.timeMs} 毫秒，位置 ${formatValue(sample.positionDeg)} 度，转速 ${formatValue(sample.speedRpm)} 转每分钟`}
          onChange={(event) => setIndex(event.currentTarget.valueAsNumber)} />
      </div>
      <details className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">离线模型的假设与限值</summary>
        <p className="mt-2 leading-6">折算总惯量 {formatValue(result.inertiaKgM2)} kg·m²。模型采用连续转矩 {formatValue(result.limits.torqueNm)} N·m、额定机械功率 {formatValue(result.limits.powerW)} W 和额定转速 {formatValue(result.limits.speedRpm)} rpm。</p>
        <p className="mb-2 leading-6">位置误差在 ±{SERVO_AXIS_MODEL.positionToleranceDeg}° 内、转速在 ±{SERVO_AXIS_MODEL.speedToleranceRpm} rpm 内，持续 {SERVO_AXIS_MODEL.settleHoldMs} ms 即判为到位。</p>
        <ul className="ml-4 list-disc space-y-1 leading-5">{result.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
      </details>
    </>
  );
}

/** The parent key changes with the binding, compiled parameters or an explicit rerun. */
function ModelicaResponse({ parameters, targetDeg, filename }: { parameters: ModelicaServoParameters; targetDeg: number; filename: string }) {
  const [input] = useState(parameters);
  const [outcome, setOutcome] = useState<{ result: ServoAxisResult } | { error: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function calculate() {
      const { runModelicaServo } = await import("@/lib/modelica-servo-runtime");
      controller.signal.throwIfAborted();
      const result = await runModelicaServo(input, controller.signal);
      if (!result.samples.length) throw new Error("Modelica 运行未返回位置和速度采样。");
      if (!controller.signal.aborted) setOutcome({ result });
    }
    calculate().catch(cause => {
      if (!controller.signal.aborted) setOutcome({ error: cause instanceof Error ? cause.message : "Modelica 模型运行失败，请重新运行。" });
    });
    return () => controller.abort();
  }, [input]);
  if (!outcome) return <p role="status" className="p-3 text-sm text-muted-foreground">正在运行 Modelica 模型…</p>;
  if ("error" in outcome) return <p role="alert" className="whitespace-pre-line break-words p-3 text-sm text-destructive">{outcome.error}</p>;
  return <ResponsePanel result={outcome.result} targetDeg={targetDeg} filename={filename} />;
}

export default function ServoAxisBench({ workspace, onChange, preferred }: Props) {
  const saved = workspace.servoAxis;
  const drives = workspace.packages.filter((pkg) => hasServoRole(pkg, "drive"));
  const motors = workspace.packages.filter((pkg) => hasServoRole(pkg, "motor"));
  const [draft, setDraft] = useState(() => initialForm(saved, preferred));
  const [runId, setRunId] = useState(0);
  const origin = axisSignature(saved);
  if (draft.origin !== origin) setDraft(initialForm(saved));
  const { driveChoice, motorChoice, angle, load, solver, error } = draft;
  const missing = solverFor(saved) === "missing" ? saved?.modelRef : undefined;
  function edit(patch: Partial<typeof draft>) { setDraft(current => ({ ...current, ...patch, error: "" })); }
  const requestedMotor = motors.find((pkg) => packageKey(pkg) === motorChoice);
  const savedDrive = drives.find((pkg) => packageKey(pkg) === saved?.driveKey);
  const matchingDrive = requestedMotor && (savedDrive && isCompatibleServoPair(savedDrive, requestedMotor)
    ? savedDrive : drives.find((pkg) => isCompatibleServoPair(pkg, requestedMotor)));
  const drive = drives.find((pkg) => packageKey(pkg) === driveChoice) ?? matchingDrive ?? savedDrive
    ?? drives.find((pkg) => motors.some((candidate) => isCompatibleServoPair(pkg, candidate))) ?? drives[0];
  const compatible = drive ? motors.filter((pkg) => isCompatibleServoPair(drive, pkg)) : [];
  const motor = requestedMotor ?? compatible.find((pkg) => packageKey(pkg) === saved?.motorKey) ?? compatible[0];
  const driveRatings = drive ? tryResolveServoDriveRatings(drive) : undefined;
  const motorRatings = motor ? tryResolveServoMotorRatings(motor) : undefined;
  const canRun = !!(drive && motor && isCompatibleServoPair(drive, motor));
  const motorOptions = motor && !canRun ? [motor, ...compatible] : compatible;
  const targetDeg = angle.trim() ? Number(angle) : NaN;
  const loadInertiaRatio = load.trim() ? Number(load) : NaN;
  const matches = !!(saved && solver !== "missing" && solver === solverFor(saved) && drive && motor && saved.driveKey === packageKey(drive) && saved.motorKey === packageKey(motor)
    && saved.targetDeg === targetDeg && saved.loadInertiaRatio === loadInertiaRatio);
  const response = useMemo(() => {
    if (!matches) return null;
    try {
      if (solver === "modelica") {
        const parameters = bindModelicaServo(workspace);
        return { parameters, binding: JSON.stringify(parameters) };
      }
      return { result: simulateServoAxis(workspace) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "伺服轴仿真失败" };
    }
  }, [workspace, matches, solver]);
  const fileTag = solver === "modelica" ? `${MODELICA_SERVO_REF.id}-${MODELICA_SERVO_REF.version}` : "legacy-rigid-axis";
  const filename = `${fileTag}_${motor?.model ?? "servo"}_${targetDeg}deg_Jratio-${loadInertiaRatio}.csv`;

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)]" aria-label="伺服单轴工作台">
      <form className="surface min-w-0 self-start space-y-4 p-4 sm:p-5" onSubmit={(event) => {
        event.preventDefault();
        if (!drive || !motor || !canRun || solver === "missing") return;
        try {
          const next = assembleServoAxis(workspace, { driveKey: packageKey(drive), motorKey: packageKey(motor), targetDeg, loadInertiaRatio,
            ...(solver === "modelica" && { modelRef: MODELICA_SERVO_REF }) });
          if (solver === "modelica") modelicaServoInfo(bindModelicaServo(next));
          onChange(next);
          edit({});
          if (solver === "modelica") setRunId(n => n + 1);
        } catch (cause) {
          setDraft(current => ({ ...current, error: cause instanceof Error ? cause.message : "伺服轴组装失败" }));
        }
      }}>
        <h2 className="text-base font-semibold">组装单轴</h2>
        <div>
          <label className="block"><span className="field-label">伺服驱动器</span>
            <select aria-label="伺服驱动器" className={selectStyle} value={drive ? packageKey(drive) : ""} disabled={!drives.length} onChange={(event) => {
              edit({ driveChoice: event.target.value, motorChoice: "" });
            }}>
              {!drives.length && <option value="">请先安装驱动器设备包</option>}
              {drives.map((pkg) => <option key={packageKey(pkg)} value={packageKey(pkg)}>{pkg.model} · {pkg.revision}</option>)}
            </select>
          </label>
          {drive && <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            {drive.manufacturer} · {driveRatings ? `额定输出电流 ${formatValue(driveRatings.ratedCurrentA)} A` : "驱动器参数待确认或缺少必填项"}
            {drive.source.url && <a className="ml-2 inline-flex items-center gap-1 text-primary hover:underline" href={drive.source.url} target="_blank" rel="noreferrer">驱动器规格表<ExternalLink className="size-3" /></a>}
          </p>}
        </div>
        <div>
          <label className="block"><span className="field-label">配套伺服电机</span>
            <select aria-label="配套伺服电机" className={selectStyle} value={motor ? packageKey(motor) : ""} disabled={!motor} onChange={(event) => edit({ motorChoice: event.target.value })}>
              {!motor && <option value="">请安装配套表中的电机设备包</option>}
              {motorOptions.map((pkg) => <option key={packageKey(pkg)} value={packageKey(pkg)}>{pkg.model} · {pkg.revision}</option>)}
            </select>
          </label>
          {motor && <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            {motor.manufacturer} · {motorRatings ? `额定 ${formatValue(motorRatings.ratedTorqueNm)} N·m / ${formatValue(motorRatings.ratedSpeedRpm)} rpm` : "电机参数待确认或缺少必填项"}
            {motor.source.url && <a className="ml-2 inline-flex items-center gap-1 text-primary hover:underline" href={motor.source.url} target="_blank" rel="noreferrer">电机规格表<ExternalLink className="size-3" /></a>}
          </p>}
        </div>
        <div className="space-y-2">
          <label className="block"><span className="field-label">求解模型</span>
            <select aria-label="求解模型" className={selectStyle} value={solver} onChange={event => edit({ solver: event.target.value as Solver })}>
              <option value="modelica">Modelica · {modelLabel}</option>
              <option value="legacy">离线刚性轴（原有算法）</option>
              {missing && <option value="missing" disabled>未安装 · {missing.id} {missing.version}</option>}
            </select>
          </label>
          {missing && <p role="alert" className="break-all text-xs leading-5 text-amber-300">此工程引用的求解模型 {missing.id} {missing.version} 尚未安装。请选择可用模型并运行以更新工程。</p>}
        </div>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-1">
          <label><span className="field-label">目标角度（°）</span>
            <Input className="mono" type="number" required min={-3600} max={3600} step="any" value={angle}
              onChange={(event) => edit({ angle: event.target.value })} />
          </label>
          <label><span className="field-label">负载与转子惯量比</span>
            <Input className="mono" type="number" required min={0} max={100} step="any" value={load}
              onChange={(event) => edit({ load: event.target.value })} />
          </label>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">负载惯量按转子惯量的倍数折算。初始位置和转速均为零。</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {drive && motor && !canRun && <p role="alert" className="text-xs text-amber-300">请按电机配套表选择驱动器，当前型号组合缺少配套记录。</p>}
        <Button type="submit" disabled={!canRun || solver === "missing"} className="w-full"><Play />组轴并运行位置阶跃</Button>
      </form>
      <div className="surface min-w-0 p-4 sm:p-5">
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold"><Activity className="size-4 text-primary" />位置阶跃响应</h2>
        {solver === "modelica" ? <div className="mb-3 space-y-2 text-xs leading-5 text-muted-foreground">
          <p>{modelLabel} · {modelicaArtifact.compiler} 生成模型方程 · 浏览器 WebAssembly · Modelica 标准库 {MODELICA_SERVO_LIBRARY.uses.Modelica}</p>
          <details><summary className="cursor-pointer font-medium text-foreground">模型来源与适用工况</summary>
            <p className="mt-2">驱动器和电机的额定数据来自上方所选设备修订，分别绑定到 {MODELICA_SERVO_LIBRARY.components.drive.id} 和 {MODELICA_SERVO_LIBRARY.components.motor.id}。模型以受限平均转矩驱动刚性负载，位置和速度控制增益为建模设定。电机绕组电阻、电感、磁链及厂商控制环整定需另行取证。</p>
            <p className="mt-1">浏览器用四阶 Runge–Kutta 法按 {modelicaArtifact.integrator.stepUs / 1000} ms 积分，每 1 ms 检查到位条件，每 {SERVO_AXIS_MODEL.samplePeriodMs} ms 采样并保留终点。</p>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={modelSource} download="Gouyuan.mo"><Download className="size-3" />下载 Modelica 源码</a>
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={modelGuide} target="_blank" rel="noreferrer">模型与验证说明<ExternalLink className="size-3" /></a>
            </p>
          </details>
        </div> : solver === "legacy" && <p className="mb-3 text-xs leading-5 text-muted-foreground">原有离线刚性轴算法（TypeScript），采用假设的位置控制器。</p>}
        {response?.parameters ? <ModelicaResponse key={JSON.stringify([origin, response.binding, runId])} parameters={response.parameters} targetDeg={targetDeg} filename={filename} />
          : response?.result ? <ResponsePanel key={origin} result={response.result} targetDeg={targetDeg} filename={filename} />
          : response?.error ? <p role="alert" className="p-3 text-sm text-destructive">{response.error}</p>
          : <div className="engineering-grid grid min-h-48 place-items-center rounded-md border px-4 text-center text-sm text-muted-foreground">
            {canRun ? "运行当前单轴设置后可查看位置和速度曲线。" : "安装一对配套驱动器与电机后，即可运行位置阶跃。"}
          </div>}
      </div>
    </section>
  );
}
