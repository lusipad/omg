import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { MiloMotionSample } from "@contracts/milo-motion";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM, type MiloStockState } from "@contracts/milo-stock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { depthColor, drawIsometric, drawPlan, iso, isoScale, planLeft, planScale, planTop, plotWidth, plotHeight, top, verticalScale } from "./milo-stock-drawing";

const { widthMm: width, heightMm: height, thicknessMm: thickness } = MILO_STOCK;
const radius = MILO_TOOL_DIAMETER_MM / 2;
const numbers = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3, useGrouping: false });
const format = (number: number) => numbers.format(Math.abs(number) < 0.0005 ? 0 : number);
type View = "iso" | "xy";

// 用真实格子为整机缩略图着色，仅合并同一排相邻色块，未切区域透出原毛坯。
export function MiloStockFootprint({ frame }: { frame: MiloStockState }) {
  const { heights, columns, rows, cellSizeMm: cell, removedVolumeMm3 } = frame;
  const paths = useMemo(() => {
    const groups = new Map<number, string[]>();
    if (!removedVolumeMm3) return [];
    for (let row = 0; row < rows; row++) {
      const offset = row * columns;
      for (let col = 0; col < columns;) {
        const depth = Math.ceil(-2 * heights[offset + col]);
        let end = col + 1;
        while (end < columns && Math.ceil(-2 * heights[offset + end]) === depth) end++;
        if (depth > 0) {
          const commands = groups.get(depth) ?? [];
          const span = (end - col) * cell;
          commands.push(`M${col * cell},${row * cell}h${span}v${cell}h${-span}Z`);
          groups.set(depth, commands);
        }
        col = end;
      }
    }
    return [...groups].map(([band, commands]) => ({ band, path: commands.join("") }));
  }, [heights, columns, rows, cell, removedVolumeMm3]);
  return <g data-stock-footprint="true" aria-hidden="true" stroke="none">
    {paths.map(({ band, path }) => <path key={band} fill={depthColor(band / 2)} d={path} />)}
  </g>;
}

function StockCanvas({ frame, view, onPick }: { frame: MiloStockState; view: View; onPick: (x: number, y: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const texture = useRef<{ canvas: HTMLCanvasElement; pixels: ImageData } | null>(null);
  const painted = useRef<{ view: View; field: Float32Array; volume: number } | null>(null);
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    // 同一刀路中每一格只能降低，两时刻去除体积相同即有相同表面；换程序会换高度缓冲。
    if (painted.current?.view === view && painted.current.field === frame.heights && painted.current.volume === frame.removedVolumeMm3) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, plotWidth, plotHeight);
    if (view === "iso") drawIsometric(ctx, frame);
    else {
      if (!texture.current || texture.current.pixels.width !== frame.columns || texture.current.pixels.height !== frame.rows) {
        const bitmap = document.createElement("canvas");
        bitmap.width = frame.columns; bitmap.height = frame.rows;
        texture.current = { canvas: bitmap, pixels: new ImageData(frame.columns, frame.rows) };
      }
      drawPlan(ctx, frame, texture.current.canvas, texture.current.pixels);
    }
    painted.current = { view, field: frame.heights, volume: frame.removedVolumeMm3 };
  }, [frame, view]);

  function pick(event: MouseEvent<HTMLCanvasElement>) {
    if (view !== "xy" || event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) * plotWidth / bounds.width - planLeft) / planScale;
    const y = height - ((event.clientY - bounds.top) * plotHeight / bounds.height - planTop) / planScale;
    if (x >= 0 && y >= 0 && x <= width && y <= height) onPick(x, y);
  }
  return <canvas ref={canvas} width={plotWidth * 2} height={plotHeight * 2} role="img"
    aria-label={view === "iso" ? "毛坯等轴测高度场" : "毛坯俯视深度图"} onClick={pick}
    className={`block h-auto w-full ${view === "xy" ? "cursor-crosshair" : ""}`} />;
}

function Coordinates({ view }: { view: View }) {
  if (view === "iso") return <g transform={`translate(23 ${plotHeight - 25})`} strokeWidth="1.5" fontSize="10">
    <path d="M0,0l16,9" stroke="#62dbab" /><text x="18" y="13" fill="#62dbab">X</text>
    <path d="M0,0l16,-9" stroke="#80bfff" /><text x="18" y="-8" fill="#80bfff">Y</text>
    <path d="M0,0v-20" stroke="#f0b66e" /><text x="-3" y="-24" fill="#f0b66e">Z</text>
  </g>;
  const bottom = top(0, 0)[1];
  return <g fill="#b1c0b6" fontSize="10">
    <rect x={planLeft} y={planTop} width={width * planScale} height={height * planScale} fill="none" stroke="#7b9186" />
    {[0, width / 3, width * 2 / 3, width].map((x) => <g key={x} transform={`translate(${top(x, 0)[0]} ${bottom})`}>
      <path d="M0,0v4" stroke="#778e82" /><text textAnchor="middle" y="15">{format(x)}</text>
    </g>)}
    {[0, height / 3, height * 2 / 3, height].map((y) => <g key={y} transform={`translate(${planLeft} ${top(0, y)[1]})`}>
      <path d="M0,0h-4" stroke="#778e82" /><text textAnchor="end" x="-6" y="3">{format(y)}</text>
    </g>)}
    <text x={planLeft - 9} y={planTop - 7} textAnchor="end">Y</text><text x={top(width, 0)[0] + 13} y={bottom + 3}>X</text>
  </g>;
}

function SurfaceProfile({ frame, row, col }: { frame: MiloStockState; row: number; col: number }) {
  const { columns, heights } = frame;
  const range = Math.max(3, Math.ceil(frame.maxDepthMm));
  const left = 24, right = 360, floor = 63, ceiling = 8;
  const px = (i: number) => left + i * (right - left) / columns;
  const py = (z: number) => ceiling - z / range * (floor - ceiling);
  const offset = row * columns;
  let path = `M${left} ${py(heights[offset])}`;
  for (let i = 1; i < columns; i++) if (heights[offset + i] !== heights[offset + i - 1]) path += `H${px(i)}V${py(heights[offset + i])}`;
  path += `H${right}`;
  return <svg className="mt-2 block w-full" viewBox="0 0 372 83" role="img" aria-label="沿检查点 Y 坐标的实际表面截面">
    <rect x={left} y={ceiling} width={right-left} height={floor-ceiling} fill="#101b17" />
    <path d={`${path}V${floor}H${left}Z`} fill="#426659" />
    {[0, range / 3, 2 * range / 3, range].map((depth) => <g key={depth} fontSize="9" fill="#9bafa3">
      <path d={`M${left} ${py(-depth)}H${right}`} stroke="#60766a" strokeDasharray="2 4" />
      <text x={left-4} y={py(-depth)+3} textAnchor="end">{format(-depth)}</text>
    </g>)}
    <path d={path} fill="none" stroke="#80e7be" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx={px(col + 0.5)} cy={py(heights[offset + col])} r="2.5" fill="#fff2ba" />
    <g fill="#a9bbae" fontSize="9"><text x={left} y="78">0</text><text x={(left+right)/2} y="78" textAnchor="middle">X（mm）</text><text x={right} y="78" textAnchor="end">{width}</text></g>
  </svg>;
}

export function MiloStockReadouts({ frame }: { frame: MiloStockState }) {
  const ratio = 100 * frame.removedVolumeMm3 / (width * height * thickness);
  return <dl className="grid grid-cols-3 gap-2 border-y py-2.5">
    {([
      ["最大切深", frame.maxDepthMm, "mm"], ["去除体积", frame.removedVolumeMm3, "mm³"], ["材料去除比例", ratio, "%"],
    ] as const).map(([label, value, unit]) => <div key={label} className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-1"><output aria-label={label} className="mono text-base font-semibold">{format(value)}</output><span className="text-[11px] text-muted-foreground">{unit}</span></dd>
    </div>)}
  </dl>;
}

export default function MiloStockView({ frame, sample }: { frame: MiloStockState; sample: MiloMotionSample }) {
  const [view, setView] = useState<View>("iso");
  const [query, setQuery] = useState({ x: String(width / 2), y: String(height / 2) });
  const [inspecting, setInspecting] = useState(false);
  const detail = useRef<HTMLDetailsElement>(null);
  const cell = frame.cellSizeMm, x = Number(query.x), y = Number(query.y);
  const valid = query.x.trim() !== "" && query.y.trim() !== "" && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= width && y >= 0 && y <= height;
  const col = Math.min(frame.columns - 1, Math.floor(x / cell)), row = Math.min(frame.rows - 1, Math.floor(y / cell));
  const cx = (col + 0.5) * cell, cy = (row + 0.5) * cell;
  const z = valid ? frame.heights[row * frame.columns + col] : 0;
  const tool = sample.positionMm;
  const [tx, ty] = view === "xy" ? top(tool[0], tool[1]) : iso(...tool);
  const rx = radius * (view === "xy" ? planScale : Math.sqrt(1.5) * isoScale);
  const ry = radius * (view === "xy" ? planScale : Math.sqrt(0.5) * isoScale);
  const [probeX, probeY] = valid ? (view === "xy" ? top(cx, cy) : iso(cx, cy, z)) : [0, 0];
  const outside = tool[0] < -radius || tool[0] > width + radius || tool[1] < -radius || tool[1] > height + radius;

  return <section className="surface min-w-0 overflow-hidden" aria-label="毛坯去料回放">
    <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:px-4">
      <h3 className="text-base font-semibold">毛坯去料</h3>
      <div className="flex gap-1" aria-label="毛坯视角">
        {(["iso", "xy"] as const).map((option) => <Button size="sm" key={option} variant={view === option ? "secondary" : "ghost"} aria-pressed={view === option}
          onClick={() => setView(option)}>{option === "iso" ? "等轴测" : "俯视"}</Button>)}
      </div>
    </div>
    <div className="engineering-grid relative border-y">
      <StockCanvas frame={frame} view={view} onPick={(mx, my) => {
        setQuery({ x: format((Math.min(frame.columns - 1, Math.floor(mx / cell)) + 0.5) * cell), y: format((Math.min(frame.rows - 1, Math.floor(my / cell)) + 0.5) * cell) });
        if (detail.current) detail.current.open = true;
      }} />
      <svg aria-hidden="true" viewBox={`0 0 ${plotWidth} ${plotHeight}`} className="pointer-events-none absolute inset-0 h-full w-full">
        <Coordinates view={view} />
        {inspecting && valid && <g>
          {view === "xy" && <path d={`M${planLeft} ${probeY}h${width * planScale}`} stroke="#254f4b" strokeDasharray="3 3" />}
          <path d={`M${probeX - 4} ${probeY}h8M${probeX} ${probeY - 4}v8`} stroke="#163830" strokeWidth="3" />
          <path d={`M${probeX - 4} ${probeY}h8M${probeX} ${probeY - 4}v8`} stroke="#fff2ba" strokeWidth="1.3" />
        </g>}
        <g data-stock-tool="true" fill="none" stroke="#f3a15f" strokeWidth="1.7">
          <ellipse cx={tx} cy={ty} rx={rx} ry={ry} fill="#fdad73" fillOpacity=".18" />
          <path d={`M${tx - 3} ${ty}h6M${tx} ${ty - 3}v6`} />
        </g>
      </svg>
    </div>
    <div className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-full border border-[#f3a15f]" />当前刀盘{outside && " · 毛坯外"}</span>
        <span>切深（mm）</span>{[0, 1, 2, 3, thickness].map((depth) => <span key={depth} className="inline-flex items-center gap-1"><i className="size-2.5 rounded-sm border border-white/15" style={{ backgroundColor: depthColor(depth) }} />{depth}</span>)}
      </div>
      <MiloStockReadouts frame={frame} />
      <p className="text-xs leading-5 text-muted-foreground">
        {width} × {height} × {thickness} mm 毛坯 · Ø{MILO_TOOL_DIAMETER_MM} mm 平底刀几何扫掠 · {cell} mm 网格。{view === "iso" ? `等轴测的 Z 方向放大 ${verticalScale} 倍。` : "俯视图按 XY 等比例显示，可点击毛坯检查切深。"}
      </p>
      <details ref={detail} className="border-t pt-2 text-xs" onToggle={(event) => setInspecting(event.currentTarget.open)}>
        <summary className="cursor-pointer font-medium">坐标读点与表面截面</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {(["x", "y"] as const).map((axis) => <label key={axis} className="min-w-0 flex-1"><span className="field-label">检查点 {axis.toUpperCase()}（mm）</span>
            <Input type="number" min={0} max={axis === "x" ? width : height} step="any" aria-label={`检查点 ${axis.toUpperCase()}（mm）`} className="mono h-8" value={query[axis]}
              onChange={(event) => setQuery({ ...query, [axis]: event.target.value })} />
          </label>)}
        </div>
        {valid ? <>
          <p className="mt-2 leading-5 text-muted-foreground">格心 ({format(cx)}, {format(cy)}) mm · 切深 <output aria-label="检查点切深" className="mono text-foreground">{format(-z)}</output> mm · 截面 Z（mm）</p>
          {inspecting && <SurfaceProfile frame={frame} row={row} col={col} />}
        </> : <p role="alert" className="mt-2 text-amber-300">检查点应在 X 0–{width} mm、Y 0–{height} mm 范围内。</p>}
      </details>
    </div>
  </section>;
}
