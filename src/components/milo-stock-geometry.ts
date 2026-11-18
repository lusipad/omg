import { Box3, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Mesh, MeshStandardMaterial, Sphere, Vector3 } from "three";
import { MILO_STOCK, type MiloStockState } from "@contracts/milo-stock";
import { depthColor } from "./milo-stock-drawing";

const { columns, rows, cellSizeMm: cell, widthMm, heightMm, thicknessMm } = MILO_STOCK;
const bottom = -thicknessMm;
type Tint = [number, number, number];
function tint(css: string, light = 1): Tint {
  const color = new Color(css).multiplyScalar(light);
  return [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)];
}
const surfaceTints = Array.from({ length: 201 }, (_, i) => tint(depthColor(i * thicknessMm / 200)));
const wallTints = Array.from({ length: 201 }, (_, i) => tint(depthColor(Math.max(0.05, i * thicknessMm / 200)), 0.67));
const shellTint = tint("#82938a"), bottomTint = tint("#64756c");
const band = (z: number) => z >= 0 ? 0 : Math.max(1, Math.min(200, Math.round(-z / thicknessMm * 200)));

/** 格心 Z 定义该 0.5 mm 方柱的水平顶面，所有坐标均为工件坐标（mm）。 */
export function createMiloStockMesh() {
  const geometry = new BufferGeometry();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.73, metalness: 0.12 });
  const mesh = new Mesh(geometry, material);
  mesh.name = "milo-stock";
  mesh.castShadow = mesh.receiveShadow = true;
  geometry.boundingBox = new Box3(new Vector3(0, 0, bottom), new Vector3(widthMm, heightMm, 0));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  geometry.setDrawRange(0, 0);

  let capacity = 0, quads = 0;
  let xyz = new Float32Array(), normals = new Int8Array(), colors = new Uint8Array();
  const snapshot = new Float32Array(columns * rows);
  let lastBuffer: Float32Array | undefined, lastRevision = -1;

  function grow() {
    const next = Math.max(4096, capacity * 2);
    const positions = new Float32Array(12 * next), directions = new Int8Array(12 * next), shades = new Uint8Array(12 * next);
    positions.set(xyz); directions.set(normals); shades.set(colors);
    // 更换属性前释放旧 GPU 缓冲。常规回放只更新已使用的前缀，同一个 Mesh 一直在场景中。
    if (capacity) geometry.dispose();
    xyz = positions; normals = directions; colors = shades; capacity = next;
    geometry.setAttribute("position", new BufferAttribute(xyz, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3, true).setUsage(DynamicDrawUsage));
    geometry.setAttribute("color", new BufferAttribute(colors, 3, true).setUsage(DynamicDrawUsage));
    const indices = next * 4 <= 65536 ? new Uint16Array(next * 6) : new Uint32Array(next * 6);
    for (let i = 0; i < next; i++) {
      const v = 4 * i, j = 6 * i;
      indices[j] = v; indices[j + 1] = v + 1; indices[j + 2] = v + 2;
      indices[j + 3] = v; indices[j + 4] = v + 2; indices[j + 5] = v + 3;
    }
    geometry.setIndex(new BufferAttribute(indices, 1));
  }
  grow();

  // 在 X、Y 墙上 v 为 Z；两端可有各自的竖向分段。所有几何均使用朝外绕序。
  function quad(axis: 0 | 1 | 2, positive: boolean, plane: number, u0: number, u1: number,
    v0: number, v1: number, uniform: Tint | null, far0 = v0, far1 = v1) {
    if (quads === capacity) grow();
    const uAxis = axis === 0 ? 1 : 0, vAxis = axis === 2 ? 1 : 2;
    const forward = axis === 1 ? !positive : positive;
    for (let corner = 0; corner < 4; corner++) {
      const k = forward ? corner : (4 - corner) % 4, at = 12 * quads + 3 * corner;
      const farU = k === 1 || k === 2, farV = k >= 2;
      xyz[at + axis] = plane; xyz[at + uAxis] = farU ? u1 : u0;
      xyz[at + vAxis] = farU ? (farV ? far1 : far0) : (farV ? v1 : v0);
      normals[at + axis] = positive ? 127 : -127; normals[at + uAxis] = 0; normals[at + vAxis] = 0;
      const color = uniform ?? wallTints[band(xyz[at + 2])];
      colors[at] = color[0]; colors[at + 1] = color[1]; colors[at + 2] = color[2];
    }
    quads++;
  }

  function gridLines(count: number, span: number, across: number, along: number) {
    const lines = [0];
    for (let k = 1; k < count; k++) {
      for (let j = 0, p = k * across; j < span; j++, p += along) {
        if (snapshot[p] !== snapshot[p - across]) { lines.push(k); break; }
      }
    }
    lines.push(count);
    return lines;
  }

  // 在竖棱上复用相邻四格产生的所有高度分点。斜坡转角也不会出现长边接短边。
  function cornerLevels(x: number, y: number, low: number, high: number, out: number[]) {
    out.length = 0;
    out.push(low);
    for (let iy = Math.max(0, y - 1); iy <= Math.min(rows - 1, y); iy++) {
      for (let ix = Math.max(0, x - 1); ix <= Math.min(columns - 1, x); ix++) {
        const z = snapshot[iy * columns + ix];
        if (z > low && z < high && !out.includes(z)) out.push(z);
      }
    }
    if (out.length > 2) out.sort((a, b) => a - b);
    out.push(high);
  }

  const near: number[] = [], far: number[] = [];
  function wall(axis: 0 | 1, edge: number, u0: number, u1: number, a: number, b: number, outer: boolean) {
    if (a === b) return;
    const low = Math.min(a, b), high = Math.max(a, b);
    cornerLevels(axis === 0 ? edge : u0, axis === 0 ? u0 : edge, low, high, near);
    cornerLevels(axis === 0 ? edge : u1, axis === 0 ? u1 : edge, low, high, far);
    let i = 0, j = 0;
    while (i < near.length - 1 || j < far.length - 1) {
      const z = Math.min(near[i + 1] ?? Infinity, far[j + 1] ?? Infinity);
      const ni = near[i + 1] === z ? i + 1 : i, nj = far[j + 1] === z ? j + 1 : j;
      quad(axis, a > b, edge * cell, u0 * cell, u1 * cell, near[i], near[ni], outer ? shellTint : null, far[j], far[nj]);
      i = ni; j = nj;
    }
  }

  function buildSurface() {
    // 行列只在某处确有高差时分割。所有水平面与外壁共享这组端点，可消除 MSAA 下的 T 接缝。
    const xs = gridLines(columns, rows, 1, columns), ys = gridLines(rows, columns, columns, 1);
    for (let y = 1; y < ys.length; y++) {
      const y0 = ys[y - 1], y1 = ys[y];
      for (let x = 1; x < xs.length; x++) {
        const x0 = xs[x - 1], x1 = xs[x], p = y0 * columns + x0, z = snapshot[p];
        if (z > bottom) {
          quad(2, true, z, x0 * cell, x1 * cell, y0 * cell, y1 * cell, surfaceTints[band(z)]);
          quad(2, false, bottom, x0 * cell, x1 * cell, y0 * cell, y1 * cell, bottomTint);
        }
        wall(0, x0, y0, y1, x0 ? snapshot[p - 1] : bottom, z, x0 === 0);
        wall(1, y0, x0, x1, y0 ? snapshot[p - columns] : bottom, z, y0 === 0);
        if (x1 === columns) wall(0, x1, y0, y1, z, bottom, true);
        if (y1 === rows) wall(1, y1, x0, x1, z, bottom, true);
      }
    }
  }

  function update(frame: MiloStockState) {
    const heights = frame.heights;
    if (heights === lastBuffer && frame.revision === lastRevision) return;
    const initialized = !!lastBuffer;
    lastBuffer = heights; lastRevision = frame.revision;
    if (initialized && heights.every((z, i) => z === snapshot[i])) return;
    snapshot.set(heights);
    quads = 0;
    buildSurface();
    geometry.setDrawRange(0, quads * 6);
    if (!quads) return;
    for (const name of ["position", "normal", "color"]) {
      const buffer = geometry.getAttribute(name) as BufferAttribute;
      buffer.clearUpdateRanges(); buffer.addUpdateRange(0, quads * 12); buffer.needsUpdate = true;
    }
  }

  function dispose() { geometry.dispose(); material.dispose(); }
  return { mesh, update, dispose };
}
