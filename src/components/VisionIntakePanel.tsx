import { useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  FileJson,
  ImagePlus,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import type { StudioTarget } from "@contracts/studio-navigation";
import { packageKey } from "@contracts/twin-device";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import {
  buildVisionIntakePrompt,
  verifyAndApplyVisionIntake,
  VISION_DEMO_PRESETS,
  type VisionImageInput,
  type VisionIntakeResult,
} from "@contracts/vision-intake";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IS_PAGES } from "@/const";
import { sha256Hex } from "@/lib/model-files";
import { trpc } from "@/providers/trpc";

export interface VisionIntakePanelProps {
  workspace: TwinWorkspace;
  onApply: (
    nextWorkspace: TwinWorkspace,
    options?: { openTarget?: StudioTarget; message?: string },
  ) => void;
  onBrowseRegistry?: () => void;
}

type UploadedPhoto = VisionImageInput & {
  id: string;
  sizeBytes: number;
};

const MAX_PHOTOS = 4;
const DOWNSCALE_THRESHOLD_BYTES = 900 * 1024;
const MAX_EDGE_PX = 1600;

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法将图片读取为 Data URL。"));
    };
    reader.onerror = () => reject(new Error("读取图片文件失败。"));
    reader.readAsDataURL(file);
  });
}

async function encodeImageForIntake(
  file: File,
): Promise<{ mimeType: "image/jpeg" | "image/png" | "image/webp"; dataUrl: string }> {
  const mime =
    file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg";
  if (file.size <= DOWNSCALE_THRESHOLD_BYTES) {
    return { mimeType: mime, dataUrl: await readFileAsDataUrl(file) };
  }

  const rawUrl = await readFileAsDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("图片解码失败，请确认文件未损坏。"));
    el.src = rawUrl;
  });

  const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.width, img.height, 1));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { mimeType: mime, dataUrl: rawUrl };
  ctx.drawImage(img, 0, 0, width, height);
  return { mimeType: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.85) };
}

function DemoThumb({ id }: { id: (typeof VISION_DEMO_PRESETS)[number]["id"] }) {
  if (id === "nameplate-panasonic") {
    return (
      <svg
        viewBox="0 0 120 72"
        className="h-14 w-24 shrink-0 rounded border bg-slate-950/90 p-1 text-slate-200"
        aria-hidden="true"
      >
        <rect x="4" y="6" width="112" height="60" rx="4" fill="#0f172a" stroke="#64748b" strokeWidth="1.5" />
        <text x="10" y="20" fontSize="7.5" fill="#38bdf8" fontFamily="monospace" fontWeight="bold">Panasonic SERVO</text>
        <text x="10" y="31" fontSize="6.5" fill="#e2e8f0" fontFamily="monospace">MSMF042L1V2M</text>
        <text x="10" y="42" fontSize="6.5" fill="#94a3b8" fontFamily="monospace">400W 3000r/min</text>
        <text x="10" y="53" fontSize="6.5" fill="#94a3b8" fontFamily="monospace">1.27 N.m 2.6 A</text>
        <rect x="86" y="45" width="24" height="14" rx="2" fill="none" stroke="#f59e0b" strokeDasharray="2 1.5" />
        <text x="90" y="54" fontSize="6" fill="#fbbf24" fontFamily="monospace">J?</text>
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 120 72"
      className="h-14 w-24 shrink-0 rounded border bg-slate-950/90 p-1 text-slate-200"
      aria-hidden="true"
    >
      <rect x="4" y="6" width="112" height="60" rx="4" fill="#0f172a" stroke="#64748b" strokeWidth="1.5" />
      <rect x="8" y="14" width="22" height="18" rx="2" fill="#1e293b" stroke="#38bdf8" />
      <text x="11" y="25" fontSize="5.5" fill="#7dd3fc" fontFamily="monospace">SV660</text>
      <rect x="36" y="14" width="20" height="18" rx="2" fill="#1e293b" stroke="#34d399" />
      <text x="41" y="25" fontSize="5.5" fill="#6ee7b7" fontFamily="monospace">M</text>
      <line x1="56" y1="23" x2="96" y2="23" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="2 1" />
      <rect x="92" y="15" width="20" height="16" rx="2" fill="#1e293b" stroke="#e2e8f0" />
      <text x="95" y="25" fontSize="5.5" fill="#f8fafc" fontFamily="monospace">8kg</text>
      <path d="M 98 35 L 98 52 L 58 52" fill="none" stroke="#f59e0b" strokeWidth="1.2" />
      <rect x="26" y="44" width="32" height="14" rx="2" fill="#1e293b" stroke="#f59e0b" />
      <text x="29" y="53" fontSize="5.5" fill="#fbbf24" fontFamily="monospace">NC-&gt;DI00</text>
    </svg>
  );
}

export function VisionIntakePanel({ workspace, onApply, onBrowseRegistry }: VisionIntakePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trpcUtils = trpc.useUtils();
  const aiStatus = trpc.twinAi.status.useQuery(undefined, {
    enabled: !IS_PAGES,
    retry: false,
    staleTime: 60_000,
  });

  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [userGoal, setUserGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [pastedJson, setPastedJson] = useState("");
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState<VisionIntakeResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const serverAiReady = !IS_PAGES && Boolean(aiStatus.data?.available && aiStatus.data?.authenticated);

  async function addFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setError("");
    const candidates = Array.from(fileList).filter((f) =>
      /^image\/(?:jpeg|png|webp)$/i.test(f.type) || /\.(?:jpe?g|png|webp)$/i.test(f.name),
    );
    if (!candidates.length) {
      setError("请选择 JPG、PNG 或 WebP 格式的照片或截图。");
      return;
    }

    const slotsLeft = MAX_PHOTOS - photos.length;
    if (slotsLeft <= 0) {
      setError(`单次最多上传 ${MAX_PHOTOS} 张照片，请先移除部分照片再添加。`);
      return;
    }

    const nextBatch: UploadedPhoto[] = [];
    try {
      for (const file of candidates.slice(0, slotsLeft)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha256 = await sha256Hex(bytes);
        const encoded = await encodeImageForIntake(file);
        nextBatch.push({
          id: `${file.name}-${sha256.slice(0, 8)}-${Date.now()}`,
          name: file.name,
          mimeType: encoded.mimeType,
          dataUrl: encoded.dataUrl,
          sha256,
          sizeBytes: file.size,
        });
      }
      setPhotos((prev) => [...prev, ...nextBatch]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取照片失败。");
    }
  }

  async function analyzeOnline() {
    if (!photos.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const raw = await trpcUtils.client.twinAi.analyzePhotos.mutate({
        images: photos.map(({ name, mimeType, dataUrl, sha256 }) => ({
          name,
          mimeType,
          dataUrl,
          sha256,
        })),
        userGoal: userGoal.trim() || undefined,
      });
      const result = verifyAndApplyVisionIntake(workspace, raw, {
        sourceLabel: `照片识别（${photos.map((p) => p.name).join("、")}）`,
      });
      setLastResult(result);
      onApply(result.workspace, {
        message: `已校验并导入 ${result.createdDevices.length} 个器件包${result.createdSystem ? `与系统草图「${result.createdSystem.name}」` : ""}。`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "照片识别失败，请确认多模态模型配置或改用离线 JSON 导入。");
    } finally {
      setBusy(false);
    }
  }

  function runDemoPreset(presetId: (typeof VISION_DEMO_PRESETS)[number]["id"]) {
    const preset = VISION_DEMO_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setError("");
    try {
      const result = verifyAndApplyVisionIntake(workspace, preset.rawOutput, {
        sourceLabel: preset.title,
      });
      setLastResult(result);
      onApply(result.workspace, {
        message: `已加载「${preset.title}」。`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载示例识别结果失败。");
    }
  }

  async function copyVisionPrompt() {
    setError("");
    try {
      await navigator.clipboard.writeText(
        buildVisionIntakePrompt({ userGoal: userGoal.trim() || undefined }),
      );
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 2200);
    } catch {
      setError("复制失败，请检查浏览器剪贴板权限。");
    }
  }

  function verifyPastedVisionJson() {
    if (!pastedJson.trim()) {
      setError("请先粘贴外部看图 AI 返回的 JSON 结果。");
      return;
    }
    setError("");
    try {
      const cleaned = pastedJson.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(cleaned) as unknown;
      const result = verifyAndApplyVisionIntake(workspace, parsed, {
        sourceLabel: photos.length ? `视觉导入（${photos.map((p) => p.name).join("、")}）` : "外部视觉 AI 识别导入",
      });
      setLastResult(result);
      onApply(result.workspace, {
        message: `已通过原文逐字防编造校验，导入 ${result.createdDevices.length} 个器件包。`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSON 校验未通过，请确认遵循视觉提示词格式且无编造数值。");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          拍电机铭牌、丝杠参数表或手绘接线草图自动提取；未标出参数标记为「待补全」，绝不编造。
        </p>
        {onBrowseRegistry && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onBrowseRegistry}>
            查看可绑定模型清单
          </Button>
        )}
      </div>

      {/* 2 built-in 1-click presets so GitHub Pages / zero-API users can try immediately */}
      <div className="grid gap-2 md:grid-cols-2">
        {VISION_DEMO_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => runDemoPreset(preset.id)}
            className="flex items-center gap-2.5 rounded-lg border bg-background/60 p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
          >
            <DemoThumb id={preset.id} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">{preset.title}</span>
              </div>
              <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {preset.subtitle}
              </p>
              <span className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {preset.badge}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Photo dropzone */}
      <div
        className={`rounded-lg border border-dashed p-3 transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border/80 bg-background/40"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="sr-only"
          aria-label="选择或拍摄设备照片"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
            <ImagePlus className="size-4 text-primary" />
            <span>
              支持 1–{MAX_PHOTOS} 张照片（.jpg / .png / .webp）：拖入图片，或点击右侧选择/拍照
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Camera />
              选择照片 / 拍照 ({photos.length}/{MAX_PHOTOS})
            </Button>
            {photos.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setPhotos([])}>
                <Trash2 />
                清空
              </Button>
            )}
          </div>
        </div>

        {photos.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {photos.map((photo) => (
              <div key={photo.id} className="relative overflow-hidden rounded-md border bg-background p-1.5">
                <img
                  src={photo.dataUrl}
                  alt={photo.name}
                  className="h-24 w-full rounded object-contain bg-muted/30"
                />
                <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
                  <span className="truncate font-medium" title={photo.name}>{photo.name}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${photo.name}`}
                    className="rounded px-1 text-muted-foreground hover:text-destructive"
                    onClick={() => setPhotos((prev) => prev.filter((item) => item.id !== photo.id))}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Goal + Analyze / Offline Prompt Controls */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="space-y-1">
          <span className="field-label">本次装配/仿真意图（可选）</span>
          <Input
            className="h-8 text-xs"
            placeholder="例如：X 轴伺服+滚珠丝杠单轴台，需限位急停闭环仿真"
            value={userGoal}
            onChange={(e) => setUserGoal(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {serverAiReady && (
            <Button size="sm" onClick={() => void analyzeOnline()} disabled={!photos.length || busy}>
              <Upload />
              {busy ? "正在识别照片..." : "AI 识别照片并构建"}
            </Button>
          )}
          <Button size="sm" variant={serverAiReady ? "outline" : "secondary"} onClick={() => void copyVisionPrompt()}>
            {copiedPrompt ? <Check /> : <Copy />}
            {copiedPrompt ? "已复制提示词" : "复制视觉提示词（外部 AI 用）"}
          </Button>
        </div>
      </div>

      <details className="rounded-md border bg-background/50 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
          {IS_PAGES
            ? "展开粘贴外部多模态 AI（GPT-4o / Gemini / Claude）识别 JSON 并校验入库"
            : serverAiReady
              ? "或展开粘贴外部多模态 AI 返回的 JSON 直接入库"
              : "未配置服务端视觉模型：展开粘贴外部看图 AI 返回的 JSON 校验入库"}
        </summary>
        <div className="mt-2.5 space-y-2">
          <Textarea
            className="mono min-h-24 text-xs"
            placeholder='粘贴包含 "sceneKind"、"transcribedText"、"devices" 的严格 JSON...'
            value={pastedJson}
            onChange={(e) => setPastedJson(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={verifyPastedVisionJson}>
            <FileJson />
            校验并导入照片识别 JSON
          </Button>
        </div>
      </details>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {lastResult && (
        <div role="status" className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <CheckCircle2 className="size-4 text-emerald-500" />
              <span>
                照片识别校验通过：已入库 {lastResult.createdDevices.length} 个器件包
                {lastResult.createdSystem ? `，已生成系统草图「${lastResult.createdSystem.name}」` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {lastResult.createdSystem ? (
                <Button
                  size="sm"
                  onClick={() =>
                    onApply(lastResult.workspace, {
                      openTarget: `system:${lastResult.createdSystem!.id}`,
                    })
                  }
                >
                  <Workflow />
                  打开闭环工作台补全待填项并仿真
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() =>
                    onApply(lastResult.workspace, {
                      openTarget: "system-new",
                    })
                  }
                >
                  <Workflow />
                  带入装配与仿真工作台
                </Button>
              )}
            </div>
          </div>

          {lastResult.createdDevices.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {lastResult.createdDevices.map((pkg) => (
                <span key={packageKey(pkg)} className="rounded border bg-background px-2 py-0.5 text-[11px]">
                  {pkg.manufacturer} · {pkg.model}
                </span>
              ))}
            </div>
          )}

          {lastResult.pendingItems.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-200">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5 text-amber-400" />
                <span>检测到 {lastResult.pendingItems.length} 项照片未写出参数（未编造，需补全）：</span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">
                {lastResult.pendingItems.map((item, idx) => (
                  <li key={`${item.packageKey}-${item.parameterKey}-${idx}`}>
                    <strong>{item.deviceLabel}</strong> — {item.label}（单位：{item.unit}）：{item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastResult.unmodeledRequests.length > 0 && (
            <div className="rounded border bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">暂未纳入可执行行为模型族的部件：</span>
              {lastResult.unmodeledRequests.map((u) => `${u.deviceLabel}（${u.reason}）`).join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
