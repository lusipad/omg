import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM, type MiloStockState } from "@contracts/milo-stock";
import type { CncContourSample } from "@/lib/cnc-contour-runtime";
import { commandColor, feedbackColor, traceBounds, type ContourFocus } from "@/lib/cnc-contour-display";
import { paintStockTexture } from "./milo-stock-drawing";
import { createContourScene } from "./cnc-contour-three";
import { Button } from "./ui/button";

interface ViewProps {
  samples: readonly CncContourSample[]; index: number; frame: MiloStockState; focus: ContourFocus;
  all: boolean; command: boolean; feedback: boolean;
}
const size = "clamp(300px, 38vw, 500px)";

function ThreeOverlay({ samples, index, frame, focus, all, command, feedback, failed }: ViewProps & { failed: () => void }) {
  const view = useRef<ReturnType<typeof createContourScene> | null>(null);
  const mount = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    let active = true;
    const fallback = () => queueMicrotask(() => { if (active) failed(); });
    try { view.current = createContourScene(host, samples, fallback); } catch { fallback(); }
    return () => { active = false; view.current?.dispose(); view.current = null; };
  }, [samples, failed]);
  useLayoutEffect(() => { view.current?.focus(focus); }, [samples, focus]);
  useLayoutEffect(() => { view.current?.update(index, frame, all, command, feedback); }, [samples, index, frame, all, command, feedback]);
  return <div className="relative min-w-0">
    <div ref={mount} className="w-full" style={{ height: size }} />
    <Button size="sm" type="button" variant="outline" aria-label="复位刀尖视角" className="absolute right-2 top-2 h-7 bg-background/80 px-2 text-xs"
      onClick={() => view.current?.reset()}><RotateCcw size={13} />复位视角</Button>
    <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/75 px-2 py-1 text-[10px] text-muted-foreground">工件坐标 · Z 向上 · XYZ 同比例</span>
  </div>;
}

function PlanOverlay({ samples, index, frame, focus, all, command, feedback }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null), bitmap = useRef<HTMLCanvasElement | null>(null);
  const bounds = useMemo(() => traceBounds(samples, focus), [samples, focus]);
  const texture = useRef<{ field: Float32Array; volume: number; image: ImageData } | undefined>(undefined);
  useLayoutEffect(() => {
    const el = canvas.current, ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    function draw() {
      if (!el || !ctx) return;
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      const density = Math.min(2, devicePixelRatio || 1);
      if (el.width !== Math.round(w * density) || el.height !== Math.round(h * density)) {
        el.width = Math.round(w * density); el.height = Math.round(h * density);
      }
      ctx.setTransform(density, 0, 0, density, 0, 0);
      const scale = Math.min((w - 44) / (bounds.max[0] - bounds.min[0]), (h - 36) / (bounds.max[1] - bounds.min[1]));
      const cx = (bounds.min[0] + bounds.max[0]) / 2, cy = (bounds.min[1] + bounds.max[1]) / 2;
      const x = (v: number) => (v - cx) * scale + w / 2, y = (v: number) => h / 2 - (v - cy) * scale;
      ctx.fillStyle = "#15231f"; ctx.fillRect(0, 0, w, h);
      if (!bitmap.current) {
        bitmap.current = document.createElement("canvas"); bitmap.current.width = frame.columns; bitmap.current.height = frame.rows;
      }
      if (texture.current?.field !== frame.heights || texture.current.volume !== frame.removedVolumeMm3) {
        const pixels = texture.current?.image ?? new ImageData(frame.columns, frame.rows);
        paintStockTexture(frame, bitmap.current, pixels);
        texture.current = { field: frame.heights, volume: frame.removedVolumeMm3, image: pixels };
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap.current, x(0), y(MILO_STOCK.heightMm), MILO_STOCK.widthMm * scale, MILO_STOCK.heightMm * scale);
      ctx.strokeStyle = "#5f766e"; ctx.strokeRect(x(0), y(MILO_STOCK.heightMm), MILO_STOCK.widthMm * scale, MILO_STOCK.heightMm * scale);
      const limit = all ? samples.length - 1 : index;
      const path = (key: "commandMm" | "actualMm", color: string, dashed: boolean) => {
        ctx.beginPath();
        for (let i = 0; i <= limit; i++) {
          const p = samples[i][key];
          if (i) ctx.lineTo(x(p[0]), y(p[1])); else ctx.moveTo(x(p[0]), y(p[1]));
        }
        ctx.lineJoin = "round"; ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.strokeStyle = "#21392f"; ctx.lineWidth = dashed ? 2.9 : 4; ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.5 : 2.25; ctx.stroke(); ctx.setLineDash([]);
      };
      if (feedback) path("actualMm", feedbackColor, false);
      if (command) path("commandMm", commandColor, true);
      const a = samples[index].actualMm, d = samples[index].commandMm;
      const circle = (cx: number, cy: number, r: number) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); };
      circle(x(a[0]), y(a[1]), MILO_TOOL_DIAMETER_MM * scale / 2);
      ctx.fillStyle = "#ffc97c22"; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = "#604c30"; ctx.stroke();
      if (feedback && command) {
        ctx.beginPath(); ctx.moveTo(x(a[0]), y(a[1])); ctx.lineTo(x(d[0]), y(d[1])); ctx.strokeStyle = "#503225"; ctx.stroke();
      }
      if (feedback) { circle(x(a[0]), y(a[1]), 3.5); ctx.fillStyle = feedbackColor; ctx.fill(); ctx.strokeStyle = "#543b1f"; ctx.stroke(); }
      if (command) { circle(x(d[0]), y(d[1]), 5); ctx.lineWidth = 2; ctx.strokeStyle = "#1c4c5d"; ctx.stroke(); ctx.lineWidth = 1.25; ctx.strokeStyle = commandColor; ctx.stroke(); }
      // A physical horizontal scale remains valid when the bounding box or viewport changes.
      const nominal = 69 / scale, magnitude = 10 ** Math.floor(Math.log10(nominal));
      const length = ([5, 2, 1].find(n => n * magnitude <= nominal) ?? 1) * magnitude;
      const bottom = h - 12, left = 13;
      ctx.fillStyle = "#122019dc"; ctx.fillRect(left - 5, bottom - 21, length * scale + 14, 27);
      ctx.strokeStyle = "#d7e6dc"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(left, bottom - 3); ctx.lineTo(left, bottom); ctx.lineTo(left + length * scale, bottom);
      ctx.lineTo(left + length * scale, bottom - 3); ctx.stroke();
      ctx.font = "11px sans-serif"; ctx.fillStyle = "#d5e7de"; ctx.fillText(length + " mm", left, bottom - 6);
    }
    draw(); const observer = new ResizeObserver(draw); observer.observe(el); return () => observer.disconnect();
  }, [samples, index, frame, all, command, feedback, bounds]);
  return <canvas ref={canvas} role="img" aria-label="工件 XY 俯视指令和仿真反馈轨迹叠图" className="block w-full" style={{ height: size }} />;
}

export default function CncContourOverlay({ samples, index, frame }: Pick<ViewProps, "samples" | "index" | "frame">) {
  const [mode, setMode] = useState<"3d" | "xy">("3d"), [failed, setFailed] = useState(false);
  const [focus, setFocus] = useState<ContourFocus>("cut"), [all, setAll] = useState(false);
  const [command, setCommand] = useState(true), [feedback, setFeedback] = useState(true);
  const fallback = useCallback(() => { setFailed(true); setMode("xy"); }, []);
  const cutting = useMemo(() => traceBounds(samples, "cut"), [samples]);
  const inside = [samples[index].actualMm, samples[index].commandMm].every(point =>
    point.every((v, i) => v >= cutting.min[i] && v <= cutting.max[i]));
  const props = { samples, index, frame, all, focus: inside ? focus : "workpiece" as const, command, feedback };
  return <figure aria-label="刀尖指令与仿真反馈叠图" className="min-w-0 overflow-hidden rounded-md border">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-background/45 px-2.5 py-1.5">
      <figcaption className="text-sm font-semibold">刀尖轨迹对比</figcaption>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button type="button" size="sm" variant={mode === "3d" ? "secondary" : "ghost"} aria-pressed={mode === "3d"}
          onClick={() => { setFailed(false); setMode("3d"); }}>三维</Button>
        <Button type="button" size="sm" variant={mode === "xy" ? "secondary" : "ghost"} aria-pressed={mode === "xy"} onClick={() => setMode("xy")}>XY 俯视</Button>
        <select aria-label="刀尖取景范围" className="h-8 rounded border bg-background px-1 text-xs" value={focus} onChange={e => setFocus(e.target.value as ContourFocus)}>
          <option value="cut">随工步取景</option><option value="workpiece">完整毛坯</option>
        </select>
      </div>
    </div>
    {mode === "3d" ? <ThreeOverlay {...props} failed={fallback} /> : <PlanOverlay {...props} />}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-2.5 py-2 text-xs">
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={command} onChange={e => setCommand(e.target.checked)} />
        <i className="w-4 border-t-2 border-dashed" style={{ borderColor: commandColor }} />指令</label>
      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={feedback} onChange={e => setFeedback(e.target.checked)} />
        <i className="w-4 border-t-2" style={{ borderColor: feedbackColor }} />仿真反馈</label>
      <label className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />显示全程轨迹</label>
      {failed && <p role="status" className="w-full text-xs text-muted-foreground">当前浏览器使用 XY 俯视图。</p>}
    </div>
  </figure>;
}
