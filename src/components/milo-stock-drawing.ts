import { MILO_STOCK, type MiloStockState } from "@contracts/milo-stock";

export const plotWidth = 440, plotHeight = 280, verticalScale = 2;
const { widthMm: w, heightMm: h, thicknessMm: thickness } = MILO_STOCK;
const cos30 = Math.sqrt(3) / 2;
export const isoScale = Math.min((plotWidth - 44) / ((w + h) * cos30), (plotHeight - 48) / ((w + h) / 2 + thickness * verticalScale));
const isoLeft = (plotWidth - (w + h) * cos30 * isoScale) / 2;
const isoTop = (plotHeight - ((w + h) / 2 + thickness * verticalScale) * isoScale) / 2 + h * isoScale / 2;
export const planScale = Math.min((plotWidth - 64) / w, (plotHeight - 50) / h);
export const planLeft = (plotWidth - w * planScale) / 2, planTop = (plotHeight - 8 - h * planScale) / 2;
type Point = [number, number];
type RGB = [number, number, number];

export function iso(x: number, y: number, z: number): Point {
  return [isoLeft + (x + y) * cos30 * isoScale, isoTop + ((x - y) / 2 - z * verticalScale) * isoScale];
}
export function top(x: number, y: number): Point {
  return [planLeft + x * planScale, planTop + (h - y) * planScale];
}

// 颜色映射连续深度，几何面的位置始终取格心的实际 Z。
const levels: { depth: number; rgb: RGB }[] = [
  { depth: 0, rgb: [185, 199, 188] }, { depth: 0.05, rgb: [155, 223, 190] },
  { depth: 1, rgb: [101, 200, 161] }, { depth: 2, rgb: [47, 164, 153] },
  { depth: 3, rgb: [31, 122, 139] }, { depth: thickness, rgb: [25, 47, 61] },
];
const colorSteps = 200;
const rgbCss = (rgb: RGB, gain: number) => `rgb(${rgb.map((v) => Math.round(v * gain)).join(",")})`;
const palette = Array.from({ length: colorSteps + 1 }, (_, i) => {
  const depth = i * thickness / colorSteps;
  const right = levels.findIndex((stop) => stop.depth >= depth);
  const hi = levels[right], lo = levels[Math.max(0, right - 1)];
  const fraction = hi === lo ? 0 : (depth - lo.depth) / (hi.depth - lo.depth);
  const rgb = lo.rgb.map((v, axis) => Math.round(v + fraction * (hi.rgb[axis] - v))) as RGB;
  return { rgb, face: rgbCss(rgb, 1), front: rgbCss(rgb, 0.65), side: rgbCss(rgb, 0.81) };
});
const indexFor = (depth: number) => depth <= 0 ? 0 : Math.max(1, Math.min(colorSteps, Math.round(depth / thickness * colorSteps)));
export const depthColor = (depth: number) => palette[indexFor(depth)].face;

function quad(ctx: CanvasRenderingContext2D, color: string, a: Point, b: Point, c: Point, d: Point) {
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b);
  ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath(); ctx.fill(); ctx.stroke();
}

function wall(ctx: CanvasRenderingContext2D, side: "front" | "side", outer: boolean, x0: number, y0: number, x1: number, y1: number, high: number, low: number) {
  // 内壁色带以真实 1 mm 高程分段；不改变轮廓或制造不存在的台阶。
  for (let z = high; z > low;) {
    const next = outer ? low : Math.max(low, -(Math.floor(-z) + 1));
    const color = outer ? (side === "front" ? "#65786f" : "#85998d") : palette[indexFor(-(z + next) / 2)][side];
    quad(ctx, color, iso(x0, y0, z), iso(x1, y1, z), iso(x1, y1, next), iso(x0, y0, next));
    z = next;
  }
}

export function drawIsometric(ctx: CanvasRenderingContext2D, frame: MiloStockState) {
  const { heights, columns, rows, cellSizeMm: cell } = frame;
  const bottom = -thickness;
  ctx.lineWidth = 0.48; ctx.lineJoin = "round";
  quad(ctx, "#253b38", iso(0, 0, bottom), iso(w, 0, bottom), iso(w, h, bottom), iso(0, h, bottom));
  // 从远至近绘制；同一排同高且前壁相同的格子合并成一个面。
  for (let row = rows - 1; row >= 0; row--) {
    const offset = row * columns, y = row * cell;
    for (let col = 0; col < columns;) {
      const z = heights[offset + col], front = row ? heights[offset + col - columns] : bottom;
      let end = col + 1;
      while (end < columns && heights[offset + end] === z && (!row || heights[offset + end - columns] === front)) end++;
      if (z > bottom) {
        const x0 = col * cell, x1 = end * cell;
        const east = end < columns ? heights[offset + end] : bottom;
        if (z > front) wall(ctx, "front", !row, x0, y, x1, y, z, front);
        if (z > east) wall(ctx, "side", end === columns, x1, y, x1, y + cell, z, east);
        quad(ctx, depthColor(-z), iso(x0, y, z), iso(x1, y, z), iso(x1, y + cell, z), iso(x0, y + cell, z));
      }
      col = end;
    }
  }
}

export function drawPlan(ctx: CanvasRenderingContext2D, frame: MiloStockState, texture: HTMLCanvasElement, pixels: ImageData) {
  const { heights, columns, rows } = frame;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = ((rows - 1 - y) * columns + x) * 4;
      const rgb = palette[indexFor(-heights[y * columns + x])].rgb;
      pixels.data[i] = rgb[0]; pixels.data[i + 1] = rgb[1]; pixels.data[i + 2] = rgb[2]; pixels.data[i + 3] = 255;
    }
  }
  texture.getContext("2d")?.putImageData(pixels, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(texture, planLeft, planTop, w * planScale, h * planScale);
}
