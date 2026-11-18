import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Raycaster, Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { planMiloProgram } from "../contracts/milo-motion";
import { createMiloStockPlayback, MILO_STOCK } from "../contracts/milo-stock";
import { createMiloStockMesh } from "../src/components/milo-stock-geometry";

const program = readFileSync(new URL("../public/machines/milo-v1-5/circular-pocket.nc", import.meta.url), "utf8");

function ray(mesh: Mesh, from: number[], direction: number[]) {
  return new Raycaster(new Vector3().fromArray(from), new Vector3().fromArray(direction)).intersectObject(mesh)[0];
}

function signedVolume(geometry: BufferGeometry) {
  const positions = geometry.getAttribute("position"), indices = geometry.getIndex()!;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  let sum = 0;
  for (let i = 0; i < geometry.drawRange.count; i += 3) {
    a.fromBufferAttribute(positions, indices.getX(i));
    b.fromBufferAttribute(positions, indices.getX(i + 1));
    c.fromBufferAttribute(positions, indices.getX(i + 2));
    sum += a.dot(b.cross(c));
  }
  return sum / 6;
}

// 一条长边接两条短边时体积仍正确，却可能在 MSAA 光栅化中漏出背景。
function unpairedEdges(geometry: BufferGeometry) {
  const positions = geometry.getAttribute("position"), indices = geometry.getIndex()!;
  const open = new Set<string>();
  for (let i = 0; i < geometry.drawRange.count; i += 3) {
    const corners = [0, 1, 2].map((n) => {
      const p = indices.getX(i + n);
      return [positions.getX(p), positions.getY(p), positions.getZ(p)].join(",");
    });
    if (new Set(corners).size < 3) continue;
    for (let j = 0; j < 3; j++) {
      const a = corners[j], b = corners[(j + 1) % 3], edge = a < b ? a + "/" + b : b + "/" + a;
      if (!open.delete(edge)) open.add(edge);
    }
  }
  return open.size;
}

it("初始毛坯的六个面与实际尺寸相符，重复更新复用同一几何和缓冲", () => {
  const plan = planMiloProgram(program), play = createMiloStockPlayback(plan), view = createMiloStockMesh();
  try {
    const geometry = view.mesh.geometry;
    view.update(play.seek(0));
    const position = geometry.getAttribute("position") as BufferAttribute;
    expect(geometry.drawRange.count).toBe(36);
    expect(ray(view.mesh, [25.25, 30.25, 20], [0, 0, -1]).point.z).toBe(0);
    expect(ray(view.mesh, [25.25, 30.25, -20], [0, 0, 1]).point.z).toBe(-10);
    expect(signedVolume(geometry)).toBeCloseTo(75 * 60 * 10, 8);
    const version = position.version;
    view.update(play.seek(plan.segments[0].endS)); // 空走，不上传重复的几何。
    expect(position.version).toBe(version);
    view.update(play.seek(plan.durationS));
    expect(view.mesh.geometry).toBe(geometry);
    expect(geometry.getAttribute("position")).toBe(position);
  } finally { view.dispose(); }
});

it("圆槽三层的槽底、内壁法线、外壁和三角面闭合体积均来自回放格高", () => {
  const plan = planMiloProgram(program), play = createMiloStockPlayback(plan), view = createMiloStockMesh();
  try {
    const ends = plan.segments.filter((s) => s.arc?.radiusMm === 12);
    for (const layer of [1, 2, 3, 1]) {
      const f = play.seek(ends[layer - 1].endS);
      view.update(f);
      expect(ray(view.mesh, [36.25, 30.25, 5], [0, 0, -1]).point.z).toBeCloseTo(-layer, 7);
      expect(ray(view.mesh, [50.75, 30.25, 5], [0, 0, -1]).point.z).toBeCloseTo(-layer, 7);
      expect(ray(view.mesh, [51.25, 30.25, 5], [0, 0, -1]).point.z).toBe(0);
      const wall = ray(view.mesh, [36.25, 30.25, -layer / 2], [1, 0, 0]);
      expect(wall.point.x).toBeCloseTo(51, 8);
      expect(wall.face!.normal.x).toBe(-1);
      expect(ray(view.mesh, [36.25, 30.25, -layer / 2], [0, -1, 0]).face!.normal.y).toBe(1);
      expect(ray(view.mesh, [80, 10.25, -5], [-1, 0, 0]).point.x).toBe(75);
      expect(ray(view.mesh, [36.25, 30.25, -15], [0, 0, 1]).face!.normal.z).toBe(-1);
      expect(signedVolume(view.mesh.geometry)).toBeCloseTo(45000 - f.removedVolumeMm3, 7);
    }
    view.update(play.seek(0));
    expect(view.mesh.geometry.drawRange.count).toBe(36);
  } finally { view.dispose(); }
});

it("切穿后上下均能透过孔，孔侧壁持续到真实底面", () => {
  const plan = planMiloProgram("G21 G90\nG0 X35.25 Y20.25 Z0\nG1 Z-12 F180");
  const frame = createMiloStockPlayback(plan).seek(plan.durationS), view = createMiloStockMesh();
  try {
    view.update(frame);
    expect(ray(view.mesh, [35.25, 20.25, 20], [0, 0, -1])).toBeUndefined();
    expect(ray(view.mesh, [35.25, 20.25, -20], [0, 0, 1])).toBeUndefined();
    const inner = ray(view.mesh, [35.25, 20.25, -9.9], [1, 0, 0]);
    expect(inner.face!.normal.x).toBe(-1);
    expect(inner.point.x).toBeCloseTo(38.5, 7);
    expect(ray(view.mesh, [40.25, 20.25, -15], [0, 0, 1]).point.z).toBe(-MILO_STOCK.thicknessMm);
    expect(signedVolume(view.mesh.geometry)).toBeCloseTo(45000 - frame.removedVolumeMm3, 8);
  } finally { view.dispose(); }
});

it("圆槽与斜坡在顶面、底面和竖壁共用相同的边端点", () => {
  const view = createMiloStockMesh();
  try {
    for (const code of [program, "G0 X3 Y9 Z-1\nG1 X43 Y23 Z-8 F350\nG1 X0 Y17 Z-4"]) {
      const plan = planMiloProgram(code);
      view.update(createMiloStockPlayback(plan).seek(plan.durationS));
      expect(unpairedEdges(view.mesh.geometry)).toBe(0);
    }
  } finally { view.dispose(); }
});

it("密集的相邻高差扩容后仍保持封闭，完全去料后不遗留旧面", () => {
  const play = createMiloStockPlayback(planMiloProgram("G21 G90"));
  const initial = play.seek(0), view = createMiloStockMesh();
  const heights = Float32Array.from(initial.heights, (_, i) => (i + Math.floor(i / initial.columns)) % 2 ? -2 : -8);
  try {
    view.update({ ...initial, heights, maxDepthMm: 8, removedVolumeMm3: 22500, revision: 2 });
    expect(view.mesh.geometry.getIndex()!.array).toBeInstanceOf(Uint32Array);
    expect(signedVolume(view.mesh.geometry)).toBeCloseTo(22500, 8);
    heights.fill(-10);
    view.update({ ...initial, heights, maxDepthMm: 10, removedVolumeMm3: 45000, revision: 3 });
    expect(view.mesh.geometry.drawRange.count).toBe(0);
    expect(ray(view.mesh, [12.25, 8.25, 5], [0, 0, -1])).toBeUndefined();
    view.update(initial);
    expect(signedVolume(view.mesh.geometry)).toBeCloseTo(45000, 8);
  } finally { view.dispose(); }
});
