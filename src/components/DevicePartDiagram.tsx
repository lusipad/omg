import { lazy, Suspense, useMemo, useState } from "react";
import { Box, ChevronRight, PackageSearch } from "lucide-react";
import type { CompositionShape, DevicePart } from "@contracts/device-composition";
import type { DevicePackage } from "@contracts/twin-device";
import { Button } from "./ui/button";

const DevicePartScene = lazy(() => import("./DevicePartScene"));
export type DiagramMode = "slots" | "3d";

// The eight teaching shapes are orthographic renders of the same-sized drawing area.
const cells: Record<CompositionShape, number> = { box: 0, plate: 1, shaft: 2, ring: 3, gear: 4, coil: 5, ball: 6, belt: 7 };
const atlas = import.meta.env.BASE_URL + "devices/composition-shapes.webp";

export function PartIllustration({ shape, missing = false }: { shape?: CompositionShape; missing?: boolean }) {
  if (!shape) {
    const Icon = missing ? PackageSearch : Box;
    return <span aria-hidden="true" className="mx-auto grid aspect-[8/5] w-full max-w-32 place-items-center text-muted-foreground"><Icon size={30} strokeWidth={1.2} /></span>;
  }
  const cell = cells[shape];
  return <span aria-hidden="true" className="mx-auto block aspect-[8/5] w-full max-w-32" style={{
    backgroundImage: `url("${atlas}")`, backgroundSize: "400% 200%",
    backgroundPosition: `${cell % 4 * 100 / 3}% ${Math.floor(cell / 4) * 100}%`,
  }} />;
}

export default function DevicePartDiagram({ parts, installed, parentQuantity, mode, onModeChange, onChoose }: {
  parts: readonly DevicePart[];
  installed: ReadonlyMap<string, DevicePackage>;
  parentQuantity: bigint;
  mode: DiagramMode; onModeChange: (mode: DiagramMode) => void;
  onChoose: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  const perPage = 20, current = Math.min(page, Math.max(0, Math.ceil(parts.length / perPage) - 1));
  const visible = useMemo(() => parts.slice(current * perPage, (current + 1) * perPage), [parts, current]);
  return <figure aria-label="本层部件分解示意" className="overflow-hidden rounded-md border border-border/80">
    <figcaption className="flex flex-wrap items-center justify-between gap-1.5 border-b px-2.5 py-1.5 text-xs">
      <span className="font-medium text-foreground">本层子件 · {parts.length} 个槽位</span>
      <div role="group" aria-label="本层分解视图" className="flex items-center gap-1">
        <Button type="button" size="sm" variant={mode === "slots" ? "secondary" : "ghost"} aria-pressed={mode === "slots"}
          onClick={() => onModeChange("slots")}>槽位图</Button>
        <Button type="button" size="sm" variant={mode === "3d" ? "secondary" : "ghost"} aria-pressed={mode === "3d"}
          onClick={() => { setFailed(false); onModeChange("3d"); }}>三维分解</Button>
      </div>
    </figcaption>
    {mode === "3d" ? <Suspense fallback={<p role="status" className="p-3 text-sm">正在打开三维分解图…</p>}>
      <DevicePartScene parts={visible} installed={installed} parentQuantity={parentQuantity} onChoose={onChoose} onFallback={() => { setFailed(true); onModeChange("slots"); }} />
    </Suspense> : <ul className="m-0 grid list-none gap-2 bg-[#172421] p-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 8rem), 1fr))" }}>
      {visible.map(part => {
        const child = installed.get(part.packageKey);
        return <li key={part.id} className="min-w-0">
          <button type="button" aria-label={`查看子件 ${part.label}（${part.id}）`} onClick={() => onChoose(part.id)}
            className="group flex h-full w-full min-w-0 flex-col rounded-md border border-transparent px-2 py-1.5 text-left hover:border-primary/60 hover:bg-white/[.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <PartIllustration shape={child?.composition?.shape} missing={!child} />
            <span className="mt-auto flex w-full items-center justify-between gap-1 text-xs font-medium text-foreground">
              <span className="min-w-0 break-all">{part.label}</span><ChevronRight aria-hidden="true" size={13} className="shrink-0 text-muted-foreground group-hover:text-primary" />
            </span>
            <span className="mt-0.5 break-all text-xs text-muted-foreground">每套 {part.quantity} 件
              {parentQuantity !== 1n && <> · 累计 {String(parentQuantity * BigInt(part.quantity))} 件</>}
              {!child && " · 缺少修订"}
            </span>
          </button>
        </li>;
      })}
    </ul>}
    {parts.length > perPage && <div role="group" aria-label="本层槽位分页" className="flex flex-wrap items-center justify-end gap-2 border-t p-1 text-xs">
      <Button type="button" size="sm" variant="ghost" disabled={!current} onClick={() => setPage(current - 1)}>上一组槽位</Button>
      <span>{current * perPage + 1}–{Math.min(parts.length, (current + 1) * perPage)} / {parts.length}</span>
      <Button type="button" size="sm" variant="ghost" disabled={(current + 1) * perPage >= parts.length} onClick={() => setPage(current + 1)}>下一组槽位</Button>
    </div>}
    <p className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">
      {failed && mode === "slots" && <span role="status">当前浏览器采用槽位图。 </span>}
      按槽位排列，部件外形与尺寸为教学示意。
    </p>
  </figure>;
}
