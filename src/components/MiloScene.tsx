import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Box, ExternalLink, PanelsTopLeft } from "lucide-react";
import { MILO_MACHINE, miloSegmentFractionAtTime, type MiloMotionSample, type MiloVec3 } from "@contracts/milo-motion";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM, type MiloStockState } from "@contracts/milo-stock";
import { Button } from "@/components/ui/button";
import MiloStockView, { MiloStockFootprint, MiloStockReadouts } from "./MiloStockView";
import { miloAxes, miloAxisColors, miloNumber, tickStep, type MiloSpatialPath } from "./milo-plot";

type Point = [number, number];
type View = "iso" | "xy" | "xz" | "yz";
const traces = { planned: "#758980", travelled: "#62dbab", tool: "#ff9874" };

function project([x, y, z]: readonly [number, number, number], view: View): Point {
  if (view === "xy") return [x, -y];
  if (view === "xz") return [x, -z];
  if (view === "yz") return [y, -z];
  return [0.866 * x + 0.5 * y, 0.211 * x - 0.366 * y - 0.906 * z];
}

const iso = (x: number, y: number, z: number) => project([x, y, z], "iso");
const polygon = (points: Point[]) => points.map((p) => p.join(",")).join(" ");
function Edge({ from, to, color, width = 1.4 }: { from: MiloVec3; to: MiloVec3; color: string; width?: number }) {
  const a = project(from, "iso"), b = project(to, "iso");
  return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={width} />;
}

// 部件外形为示意，工作台与主轴的位移使用控制器的毫米坐标。
function Block({ x, y, z, width, depth, height, top, front, end }: {
  x: number; y: number; z: number; width: number; depth: number; height: number; top: string; front: string; end: string;
}) {
  const left = x - width / 2, right = x + width / 2, near = y - depth / 2, far = y + depth / 2, lid = z + height;
  return <g stroke="#15221f" strokeWidth="1.3" strokeLinejoin="round">
    <polygon fill={front} points={polygon([iso(left, near, z), iso(right, near, z), iso(right, near, lid), iso(left, near, lid)])} />
    <polygon fill={end} points={polygon([iso(right, near, z), iso(right, far, z), iso(right, far, lid), iso(right, near, lid)])} />
    <polygon fill={top} points={polygon([iso(left, near, lid), iso(right, near, lid), iso(right, far, lid), iso(left, far, lid)])} />
  </g>;
}
function Cylinder({ z, height, radius, color, cap }: { z: number; height: number; radius: number; color: string; cap: string }) {
  const bottom = iso(0, 0, z)[1], top = iso(0, 0, z + height)[1], ry = radius * 0.4226;
  return <g stroke="#23332f" strokeWidth="1">
    <path d={`M${-radius},${bottom}V${top}H${radius}V${bottom}A${radius},${ry} 0 0 1 ${-radius},${bottom}Z`} fill={color} />
    <ellipse cx="0" cy={top} rx={radius} ry={ry} fill={cap} />
  </g>;
}

const frameMetal = { top: "#667770", front: "#43534c", end: "#34443d" };
const slideMetal = { top: "#81968c", front: "#53675d", end: "#394e44" };
const tableMetal = { top: "#a2b5ab", front: "#677c71", end: "#465b50" };
const bracket = { top: "#4c7a68", front: "#325e4d", end: "#294c3e" };
const tableWidth = 500;
const tableDepth = MILO_MACHINE.maxMm[1] - MILO_MACHINE.minMm[1] + 20;
const columnY = 245;
const stock = { width: MILO_STOCK.widthMm, depth: MILO_STOCK.heightMm, height: MILO_STOCK.thicknessMm };
const midX = (MILO_MACHINE.maxMm[0] + MILO_MACHINE.minMm[0]) / 2;
const midY = (MILO_MACHINE.maxMm[1] + MILO_MACHINE.minMm[1]) / 2;
function machineBounds(path: MiloSpatialPath) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  function box(x: number, y: number, w: number, d: number, fromZ: number, toZ: number) {
    for (const xx of [x-w/2, x+w/2]) for (const yy of [y-d/2, y+d/2]) for (const zz of [fromZ, toZ]) {
      const [u, v] = iso(xx, yy, zz);
      left = Math.min(left, u); right = Math.max(right, u); top = Math.min(top, v); bottom = Math.max(bottom, v);
    }
  }
  box(0, 65, 290, 435, -66, -44);
  box(0, columnY, 82, 60, -50, 157);
  const x = midX - MILO_MACHINE.workOriginMachineMm[0] - (path.min[0] + path.max[0]) / 2;
  const y = midY - MILO_MACHINE.workOriginMachineMm[1] - (path.min[1] + path.max[1]) / 2;
  box(x, y, tableWidth + path.max[0] - path.min[0], tableDepth + path.max[1] - path.min[1], -14, stock.height);
  box(0, (columnY - 38) / 2, 68, columnY + 12, stock.height + path.min[2], stock.height + path.max[2] + 116);
  return { x: left - 20, y: top - 18, width: right - left + 40, height: bottom - top + 48 };
}
type SceneProps = { path: MiloSpatialPath; sample: MiloMotionSample; frame: MiloStockState };
function MiloMachine({ path, sample, frame }: SceneProps) {
  const [mx, my, mz] = sample.machineMm;
  const tx = midX - mx, ty = midY - my, tipHeight = stock.height + sample.positionMm[2];
  const saddle = iso(0, ty, 0), table = iso(tx, ty, 0), spindle = iso(0, 0, tipHeight);
  const wx = MILO_MACHINE.workOriginMachineMm[0] - midX, wy = MILO_MACHINE.workOriginMachineMm[1] - midY;
  const [workX, workY] = sample.positionMm;
  const aboveStock = workX >= 0 && workX <= stock.width && workY >= 0 && workY <= stock.depth;
  const view = useMemo(() => machineBounds(path), [path]);
  const stockTransform = [...iso(1, 0, 0), ...iso(0, 1, 0), ...iso(wx, wy, stock.height)].join(" ");
  let surface = 0;
  if (aboveStock) {
    const column = Math.min(frame.columns - 1, Math.floor(workX / frame.cellSizeMm));
    const row = Math.min(frame.rows - 1, Math.floor(workY / frame.cellSizeMm));
    surface = stock.height + frame.heights[row * frame.columns + column];
  }
  return <figure className="surface min-w-0 overflow-hidden">
    <figcaption className="border-b px-4 py-3 text-sm font-semibold">铣床运动简图</figcaption>
    <svg viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} role="img" aria-label="Milo 铣床运动简图" className="engineering-grid block h-56 w-full sm:h-64">
      <title>Milo 工作台沿 X、Y 反向移动，主轴沿 Z 升降</title>
      <Block x={0} y={65} z={-66} width={290} depth={435} height={18} {...frameMetal} />
      <Block x={0} y={columnY} z={-50} width={82} depth={60} height={207} {...frameMetal} />
      {[-25, 25].map((x) => <Block key={x} x={x} y={columnY - 33} z={-40} width={6} depth={6} height={184} {...slideMetal} />)}
      <Edge from={[25, columnY - 36, -36]} to={[25, columnY - 36, 140]} color={miloAxisColors[2]} width={2} />
      {[-57, 57].map((x) => <Block key={x} x={x} y={0} z={-47} width={10} depth={267} height={9} {...slideMetal} />)}
      <Edge from={[-57, -130, -38]} to={[-57, 130, -38]} color={miloAxisColors[1]} width={2} />
      <g transform={`translate(${saddle.join(" ")})`} data-part="y-carriage" data-y-mm={ty}>
        <Block x={0} y={0} z={-37} width={184} depth={93} height={17} {...bracket} />
        {[-29, 29].map((y) => <Block key={y} x={0} y={y} z={-20} width={193} depth={6} height={6} {...slideMetal} />)}
      </g>
      <g transform={`translate(${table.join(" ")})`} data-part="xy-table" data-x-mm={tx} data-y-mm={ty}>
        <Block x={0} y={0} z={-14} width={tableWidth} depth={tableDepth} height={14} {...tableMetal} />
        {[-78, -39, 0, 39, 78].map((y) => <Edge key={y} from={[-tableWidth / 2 + 2, y, 0.3]} to={[tableWidth / 2 - 2, y, 0.3]} color="#4b6355" width={3.3} />)}
        <Edge from={[-tableWidth / 2 + 2, -tableDepth / 2, 0]} to={[tableWidth / 2 - 2, -tableDepth / 2, 0]} color={miloAxisColors[0]} width={2} />
        <g data-part="work-stock" data-origin-world-x-mm={-workX} data-origin-world-y-mm={-workY} data-top-z-mm={stock.height}>
          <Block x={wx + stock.width / 2} y={wy + stock.depth / 2} z={0} width={stock.width} depth={stock.depth} height={stock.height}
            top="#c2a57a" front="#887053" end="#725b42" />
          <g data-part="machine-stock-footprint" data-max-depth-mm={frame.maxDepthMm} transform={`matrix(${stockTransform})`}>
            <MiloStockFootprint frame={frame} />
          </g>
        </g>
        <g data-part="work-xy-datum">
          <Edge from={[wx, wy, stock.height]} to={[wx + 15, wy, stock.height]} color="#356452" width={3} />
          <Edge from={[wx, wy, stock.height]} to={[wx, wy + 15, stock.height]} color="#3c6280" width={3} />
        </g>
      </g>
      <line x1="0" x2="0" y1={iso(0, 0, surface)[1]} y2={spindle[1]} stroke={traces.tool} strokeWidth="1.7" strokeDasharray="3 4" opacity="0.8" />
      <g transform={`translate(${spindle.join(" ")})`} data-part="z-spindle" data-z-mm={mz}>
        <Block x={0} y={columnY - 43} z={38} width={68} depth={18} height={78} {...bracket} />
        <Block x={0} y={(columnY - 40) / 2} z={61} width={53} depth={columnY - 27} height={21} {...bracket} />
        <Cylinder z={32} height={75} radius={24} color="#94a8a0" cap="#c1d2c9" />
        <Cylinder z={24} height={15} radius={17} color="#4f625a" cap="#788b82" />
        <Cylinder z={11} height={13} radius={8.5} color="#52675d" cap="#778b80" />
        <Cylinder z={0} height={11} radius={MILO_TOOL_DIAMETER_MM / 2} color="#c9a365" cap="#ead5a6" />
        <circle data-part="machine-tool-tip" data-height-over-stock-mm={sample.positionMm[2]} cx="0" cy="0" r="3.2" fill={traces.tool} stroke="#6e4732" strokeWidth="0.8" />
      </g>
      <AxisKey x={view.x + 22} y={view.y + view.height - 28} view="iso" />
    </svg>
    <p className="border-t px-4 py-2 text-xs leading-5 text-muted-foreground">工作台沿 X、Y 反向移动，主轴沿 Z 升降。毛坯原顶面为工件 Z0，着色随去料更新。</p>
  </figure>;
}

function AxisKey({x, y, view}: {x:number; y:number; view:View}) {
  const length = view === "iso" ? 27 : 22;
  return <g transform={`translate(${x} ${y})`} aria-hidden="true" fontSize="12" fontWeight="600">
    {miloAxes.map((axis, i) => {
      const unit: MiloVec3 = [0, 0, 0]; unit[i] = 1;
      const [dx, dy] = project(unit, view);
      if (dx === 0 && dy === 0) return null;
      return <g key={axis} stroke={miloAxisColors[i]} fill={miloAxisColors[i]}>
        <line x1="0" y1="0" x2={dx * length} y2={dy * length} strokeWidth="2" />
        <text x={dx * (length + 8)} y={dy * (length + 8) + 3} stroke="none" textAnchor="middle">{axis}</text>
      </g>;
    })}
  </g>;
}

function toolDrawing(path: MiloSpatialPath, view: View) {
  const projected = path.vertices.map((vertex) => project(vertex, view));
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const [x, y] of projected) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const span = Math.max(right - left, bottom - top);
  const minimum = span > 0 ? Math.max(span * 0.02, 1 / Math.max(...MILO_MACHINE.stepsPerMm)) : 5;
  const scale = Math.min(396 / Math.max(right - left, minimum), 158 / Math.max(bottom - top, minimum));
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const plot = ([x, y]: Point): Point => [250 + (x - cx) * scale, 105 + (y - cy) * scale];
  const points = projected.map(plot), cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i-1] + Math.hypot(points[i][0]-points[i-1][0], points[i][1]-points[i-1][1]));
  return { points, cumulative, scale, locate: (p:MiloVec3) => plot(project(p, view)),
    path: points.map(([x,y], i) => `${i ? "L" : "M"}${x.toFixed(4)} ${y.toFixed(4)}`).join(" ") };
}

function Toolpath({path, sample}: Pick<SceneProps, "path" | "sample">) {
  const [view, setView] = useState<View>("iso");
  const grid = useId();
  const chart = useMemo(() => toolDrawing(path, view), [path, view]);
  const tip = chart.locate(sample.positionMm);
  const length = chart.cumulative[chart.cumulative.length - 1];
  const span = sample.line === null ? undefined : path.spans.get(sample.line);
  let drawn = 0;
  if (span) {
    const f = miloSegmentFractionAtTime(span.segment, sample.timeS);
    const fractions = span.fractions;
    let first = 0, last = fractions.length - 1;
    while (last - first > 1) {
      const mid = (first + last) >>> 1;
      if (fractions[mid] <= f) first = mid; else last = mid;
    }
    const start = span.first + first;
    const part = Math.max(0, Math.min(1, (f - fractions[first]) / (fractions[last] - fractions[first])));
    drawn = chart.cumulative[start] + part * (chart.cumulative[start + 1] - chart.cumulative[start]);
  }
  const barMm = tickStep(48 / chart.scale), spacing = barMm * chart.scale;
  const zero = chart.locate([0, 0, 0]);
  return <figure className="surface min-w-0 overflow-hidden">
    <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
      <h3 className="text-sm font-semibold">刀尖轨迹 · 工件坐标</h3>
      <select className="h-8 rounded border bg-background px-2 text-xs" aria-label="刀尖轨迹视图" value={view} onChange={(event) => setView(event.target.value as View)}>
        <option value="iso">等轴测</option><option value="xy">XY 俯视</option><option value="xz">XZ 正视</option><option value="yz">YZ 侧视</option>
      </select>
    </figcaption>
    <svg viewBox="0 0 500 242" role="img" aria-label="工件坐标系刀尖轨迹" className="block h-56 w-full bg-[#0d1612] sm:h-64">
      {view !== "iso" && <>
        <defs><pattern id={grid} patternUnits="userSpaceOnUse" x={zero[0]} y={zero[1]} width={spacing} height={spacing}>
          <path d={`M${spacing},0H0V${spacing}`} stroke="#2c4035" strokeWidth="1" fill="none" />
        </pattern></defs>
        <rect width="500" height="242" fill={`url(#${grid})`} />
      </>}
      <path data-path="planned" d={chart.path} fill="none" stroke={traces.planned} strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      {drawn > 0 && <path d={chart.path} data-path="travelled" fill="none" stroke={traces.travelled} strokeWidth="2.7" strokeLinecap="round"
        strokeDasharray={`${drawn} ${length + 2}`} />}
      <circle data-part="tool-tip" cx={tip[0]} cy={tip[1]} r="4.5" fill={traces.tool} stroke="#18241f" strokeWidth="1.5" />
      <AxisKey x={31} y={214} view={view} />
      <g fill="#a7b8ae" fontSize="10" transform="translate(466 220)">
        <path d={`M0,-4V0H${-barMm*chart.scale}V-4`} fill="none" stroke="#a7b8ae" strokeWidth="1.2" />
        <text x={-barMm*chart.scale/2} y="13" textAnchor="middle">{miloNumber(barMm)} mm</text>
      </g>
    </svg>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs leading-5 text-muted-foreground">
      <span className="flex items-center gap-1.5"><i className="w-4 border-t border-dashed" style={{borderColor:traces.planned}} />完整路径</span>
      <span className="flex items-center gap-1.5"><i className="h-0.5 w-4" style={{background:traces.travelled}} />已走路径</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full" style={{background:traces.tool}} />当前刀尖</span>
      {length === 0 && path.spans.size > 0 && <span>该视角的轨迹投影为一点</span>}
    </div>
  </figure>;
}

function MiloPlanarScene({path, sample, frame}: SceneProps) {
  return <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
    <MiloStockView frame={frame} sample={sample} />
    <div className="min-w-0 space-y-4">
      <Toolpath path={path} sample={sample} />
      <MiloMachine path={path} sample={sample} frame={frame} />
    </div>
  </div>;
}

export default function MiloScene(props: SceneProps) {
  const [mode, setMode] = useState<"3d" | "2d">("3d");
  const [failure, setFailure] = useState("");
  const [ThreeView, setThreeView] = useState<typeof import("./MiloThreeView").default | null>(null);
  const onUnavailable = useCallback((reason: string) => {
    setFailure(reason);
    setMode("2d");
  }, []);

  useEffect(() => {
    if (mode !== "3d" || ThreeView) return;
    let active = true;
    import("./MiloThreeView").then(
      module => { if (active) setThreeView(() => module.default); },
      () => { if (active) onUnavailable("三维视图资源加载失败。"); },
    );
    return () => { active = false; };
  }, [mode, ThreeView, onUnavailable]);

  return <section aria-label="Milo 加工视图" className="min-w-0 space-y-3">
    <div className="surface min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:px-4">
        <h3 className="text-base font-semibold">{mode === "3d" ? "三维加工视窗" : "二维加工分析"}</h3>
        <div role="group" aria-label="加工视图模式" className="flex gap-1">
          {failure && !ThreeView
            ? <Button asChild size="sm" variant="ghost"><a href={window.location.href} target="_blank" rel="noreferrer"><ExternalLink />在新页重试三维</a></Button>
            : <Button type="button" size="sm" variant={mode === "3d" ? "secondary" : "ghost"} aria-pressed={mode === "3d"} onClick={() => { setFailure(""); setMode("3d"); }}>
              <Box />{failure ? "重试三维" : "三维视图"}
            </Button>}
          <Button type="button" size="sm" variant={mode === "2d" ? "secondary" : "ghost"} aria-pressed={mode === "2d"} onClick={() => setMode("2d")}>
            <PanelsTopLeft />二维分析
          </Button>
        </div>
      </div>
      {failure && <p role="status" className="border-t px-4 py-2 text-sm text-muted-foreground">{failure} 当前使用二维分析。</p>}
      {mode === "3d" && <>
        {ThreeView ? <ThreeView {...props} onUnavailable={onUnavailable} /> :
          <p role="status" className="grid h-72 place-items-center border-t text-sm text-muted-foreground">正在载入三维视窗…</p>}
        <div className="px-3 pb-2 sm:px-4"><MiloStockReadouts frame={props.frame} /></div>
      </>}
    </div>
    {mode === "2d" && <MiloPlanarScene {...props} />}
  </section>;
}
