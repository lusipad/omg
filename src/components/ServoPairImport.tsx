import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, Download, FileCheck2, Link2, Loader2, PackageCheck, Sparkles } from "lucide-react";
import { isCompatibleServoPair } from "@contracts/servo-axis";
import { servoExampleDrive, servoExampleLinks, servoExampleMotor } from "@contracts/servo-example";
import { parseDevicePackage, type DevicePackage } from "@contracts/twin-device";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadJson } from "@/lib/download";
import { trpc } from "@/providers/trpc";
import { DeviceSourceEvidence, ServoRatings } from "./TwinPackagePreview";

const emptyFields = { driveUrl: "", motorUrl: "", catalogUrl: "", driveModel: "", motorModel: "" };
type Pair = { drive: DevicePackage; motor: DevicePackage };

function verifiedRoles(result: unknown): Pair {
  if (!result || typeof result !== "object" || !("drive" in result) || !("motor" in result)) {
    throw new Error("生成结果缺少驱动器包或电机包，请核对资料后重试。");
  }
  const drive = parseDevicePackage(result.drive), motor = parseDevicePackage(result.motor);
  if (drive.servo?.kind !== "drive" || motor.servo?.kind !== "motor") {
    throw new Error("设备包的驱动器或电机角色有误，请检查两个资料链接。");
  }
  return { drive, motor };
}

function DeviceCard({ device }: { device: DevicePackage }) {
  if (!device.servo) return null;
  const role = device.servo.kind === "drive" ? "伺服驱动器" : "伺服电机";
  return <article className="surface min-w-0 space-y-4 p-3 sm:p-4" aria-label={role + "设备包"}>
    <div>
      <p className="text-xs font-medium text-primary">{role}</p>
      <h4 className="mono mt-1 break-all text-sm font-semibold">{device.model}</h4>
      <p className="mt-1 text-xs text-muted-foreground">{device.manufacturer} · {device.revision}</p>
    </div>
    <ServoRatings servo={device.servo} />
    <DeviceSourceEvidence source={device.source} />
    <Button size="sm" variant="outline" onClick={() => downloadJson(device, `${device.model}-${device.revision}.device.json`)}><Download />下载{role}包</Button>
  </article>;
}

export default function ServoPairImport({ onInstall }: { onInstall: (drive: DevicePackage, motor: DevicePackage) => void }) {
  const [fields, setFields] = useState(emptyFields);
  const [draft, setDraft] = useState<(Pair & { example: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(import.meta.env.DEV ? null : false);
  const pending = useRef<AbortController | null>(null);
  const account = trpc.twinAi.status.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const generateRemote = trpc.twinAi.generateServoPair.useMutation();
  const remote = Boolean(account.data?.available && account.data.authenticated);
  const available = remote || localAvailable === true;
  const checking = !available && (account.isLoading || localAvailable === null);
  const matched = draft && isCompatibleServoPair(draft.drive, draft.motor);

  useEffect(() => {
    const controller = new AbortController();
    if (import.meta.env.DEV) {
      fetch("/api/local-servo/status", { signal: controller.signal })
        .then((response) => response.ok && response.headers.get("content-type")?.includes("application/json") ? response.json() : null)
        .then((data) => { if (!controller.signal.aborted) setLocalAvailable(data?.available === true); })
        .catch(() => { if (!controller.signal.aborted) setLocalAvailable(false); });
    }
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);

  function reset() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setDraft(null);
    setError("");
    setNotice("");
  }

  function update(key: keyof typeof fields, value: string) {
    reset();
    setFields((old) => ({ ...old, [key]: value }));
  }

  async function generate() {
    if (busy) return;
    reset();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const input = {
        driveUrl: fields.driveUrl.trim(), motorUrl: fields.motorUrl.trim(),
        catalogUrl: fields.catalogUrl.trim() || undefined,
        driveModel: fields.driveModel.trim() || undefined, motorModel: fields.motorModel.trim() || undefined,
      };
      if (!available) throw new Error("请启用本机 AI，或登录已配置模型的工作区。");
      let result: unknown;
      if (remote) {
        result = await generateRemote.mutateAsync(input);
      } else {
        const response = await fetch("/api/local-servo/generate", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (typeof body?.error === "string") throw new Error(body.error);
        if (!response.ok || !body) {
          throw new Error("本机 AI 服务未返回草案，请确认已用 npm run dev:servo 启动本项目。");
        }
        result = body;
      }
      if (!controller.signal.aborted) setDraft({ ...verifiedRoles(result), example: false });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "生成失败，请检查官网链接和模型服务。");
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }

  function install() {
    if (!draft || !matched) return;
    try {
      onInstall(draft.drive, draft.motor);
      setDraft(null);
      setError("");
      setNotice(`已安装 ${draft.drive.model} 和 ${draft.motor.model}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "安装失败，请检查设备包版本。");
    }
  }

  return <div className="min-w-0 space-y-4">
    <p className="text-sm text-muted-foreground">输入汇川 SV660N 驱动器和 MS1 无抱闸电机的产品页，按官方配套选型表生成两个独立设备包。</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => {
        reset(); setFields({ ...emptyFields, driveUrl: servoExampleLinks.driveUrl, motorUrl: servoExampleLinks.motorUrl });
      }}><Link2 />填入汇川链接</Button>
      <Button variant="outline" size="sm" onClick={() => {
        reset(); setDraft({ drive: servoExampleDrive, motor: servoExampleMotor, example: true });
      }}><BookOpen />打开已核对的示例包</Button>
    </div>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
      <div className="grid gap-3 md:grid-cols-2">
        <label><span className="field-label">驱动器官网链接</span>
          <Input value={fields.driveUrl} type="url" required placeholder="驱动器产品页或规格资料" onChange={(event) => update("driveUrl", event.target.value)} />
        </label>
        <label><span className="field-label">电机官网链接</span>
          <Input value={fields.motorUrl} type="url" required placeholder="电机产品页或规格资料" onChange={(event) => update("motorUrl", event.target.value)} />
        </label>
      </div>
      <details className="rounded-md border px-3 py-2.5 text-xs">
        <summary className="cursor-pointer font-medium">指定配套选型表或精确型号（可选）</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2"><span className="field-label">配套选型表链接</span>
            <Input type="url" value={fields.catalogUrl} placeholder="驱动器与电机选型对照表" onChange={(event) => update("catalogUrl", event.target.value)} />
          </label>
          <label><span className="field-label">驱动器精确型号</span>
            <Input value={fields.driveModel} onChange={(event) => update("driveModel", event.target.value)} />
          </label>
          <label><span className="field-label">电机精确型号</span>
            <Input value={fields.motorModel} onChange={(event) => update("motorModel", event.target.value)} />
          </label>
        </div>
      </details>
      {available
        ? <p className="text-xs leading-5 text-muted-foreground">生成时会读取这些链接，将核对过的订货号和对应的选型表段落发送给{remote ? "工作区配置的模型服务" : "本机 Codex 使用的模型服务"}。</p>
        : <p className="text-xs leading-5 text-muted-foreground">{checking ? "正在检查可用的 AI 服务…" : <>在线生成需要已登录且配置了模型的工作区。本机可在项目目录运行 <code className="mono">npm run dev:servo</code> 启用 Codex，或直接打开离线示例包。</>}</p>}
      <Button type="submit" disabled={!available || busy || !fields.driveUrl.trim() || !fields.motorUrl.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}AI 生成两个设备包
      </Button>
    </form>
    {busy && <p role="status" className="text-sm text-muted-foreground">正在读取官网资料并提取驱动器、电机参数…</p>}
    {error && <p role="alert" className="whitespace-pre-line break-words rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {draft && <div className="space-y-3 border-t pt-4" aria-label="伺服设备包核对">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><FileCheck2 className="size-4 text-primary" />{draft.example ? "已核对的离线示例包" : "AI 生成的设备草案"}</h3>
      <div className="grid items-start gap-3 lg:grid-cols-2"><DeviceCard device={draft.drive} /><DeviceCard device={draft.motor} /></div>
      {matched
        ? <p className="flex items-start gap-2 text-xs leading-5 text-primary"><Check className="mt-0.5 size-4 shrink-0" />电机的配套驱动清单中包含 {draft.drive.model}。</p>
        : <p role="alert" className="text-sm text-destructive">两个设备的制造商或配套型号不匹配，请核对选型表。</p>}
      <Button disabled={!matched} onClick={install}><PackageCheck />确认安装两个设备包</Button>
    </div>}
  </div>;
}
