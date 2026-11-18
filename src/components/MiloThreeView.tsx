import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { MiloMotionSample } from "@contracts/milo-motion";
import type { MiloStockState } from "@contracts/milo-stock";
import type { MiloSpatialPath } from "./milo-plot";
import { Button } from "@/components/ui/button";
import { createMiloThreeView, type MiloCameraView } from "./milo-three-view";

type Props = {
  path: MiloSpatialPath; sample: MiloMotionSample; frame: MiloStockState;
  onUnavailable: (message: string) => void;
};

export default function MiloThreeView({ path, sample, frame, onUnavailable }: Props) {
  const [cameraView, setCameraView] = useState<MiloCameraView>("workpiece");
  const [showPath, setShowPath] = useState(true);
  const view = useRef<ReturnType<typeof createMiloThreeView> | null>(null);
  const report = useRef(onUnavailable);
  useLayoutEffect(() => { report.current = onUnavailable; }, [onUnavailable]);
  const mount = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    let active = true;
    const unavailable = (message: string) => queueMicrotask(() => { if (active) report.current(message); });
    try { view.current = createMiloThreeView(host, path, unavailable); }
    catch (cause) { unavailable(cause instanceof Error ? cause.message : "三维图形设备初始化失败。"); }
    return () => {
      active = false;
      view.current?.dispose(); view.current = null;
    };
  }, [path]);
  useLayoutEffect(() => { view.current?.setView(cameraView); }, [cameraView, path]);
  useLayoutEffect(() => { view.current?.showPath(showPath); }, [showPath, path]);
  useLayoutEffect(() => { view.current?.update(sample, frame); }, [sample, frame, path]);

  return <figure className="min-w-0" aria-label="Milo 交互式三维视图">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-3 py-2">
      <div className="flex items-center gap-1" role="group" aria-label="取景对象">
        <Button type="button" size="sm" variant={cameraView === "workpiece" ? "secondary" : "ghost"} aria-pressed={cameraView === "workpiece"} onClick={() => setCameraView("workpiece")}>工件特写</Button>
        <Button type="button" size="sm" variant={cameraView === "machine" ? "secondary" : "ghost"} aria-pressed={cameraView === "machine"} onClick={() => setCameraView("machine")}>整机视图</Button>
      </div>
      <div className="flex items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" title="刀路叠加在模型上，关闭可单独检查槽底。"><input type="checkbox" className="size-3.5 accent-primary" checked={showPath} onChange={(event) => setShowPath(event.target.checked)} />显示刀路</label>
        <Button type="button" size="sm" variant="outline" onClick={() => view.current?.reset()}><RotateCcw />复位视角</Button>
      </div>
    </div>
    <div className="relative bg-[#121c19]">
      <div ref={mount} className="w-full" style={{ height: "clamp(320px, 46vw, 590px)" }} />
      <span className="pointer-events-none absolute bottom-2 left-3 rounded bg-background/75 px-2 py-1 text-[10px] text-muted-foreground">Z 向上 · XYZ 同比例（mm）</span>
    </div>
    <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px] leading-5 text-muted-foreground">
      <span>拖动旋转，右键平移，滚轮缩放。触屏双指可平移或缩放。</span>
      {showPath && <span className="inline-flex flex-wrap items-center gap-x-3">
        <span className="inline-flex items-center gap-1"><i className="w-4 border-t border-dashed border-[#a4bbd0]" />计划全程</span>
        <span className="inline-flex items-center gap-1"><i className="h-0.5 w-4 bg-[#ffd18d]" />已走刀路</span>
        <span className="inline-flex items-center gap-1"><i className="size-1.5 rounded-full bg-[#ff875f]" />当前刀尖</span>
      </span>}
    </figcaption>
  </figure>;
}
