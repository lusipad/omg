import { describe, expect, it } from "vitest";
import type { DevicePackage } from "../contracts/twin-device";
import { packageKey } from "../contracts/twin-device";
import { compositionTrail, firstPartPath, visibleCompositionRoots } from "../src/lib/device-composition-view";

const part = (model: string, composition?: DevicePackage["composition"]): DevicePackage => ({
  schemaVersion: 1, manufacturer: "教学件", model, revision: "1",
  source: { kind: "local", title: model, url: "", locator: "图纸", excerpt: model }, ports: [], rules: [], composition,
});
const ball = part("滚珠", { kind: "leaf" });
const link = (id: string, label: string, pkg: DevicePackage, quantity: number) => ({ id, label, packageKey: packageKey(pkg), quantity });
const bearing = part("支承", { kind: "assembly", parts: [link("balls", "滚珠", ball, 12)] });
const shaft = part("主轴", { kind: "assembly", parts: [link("left", "前支承", bearing, 2), link("right", "后支承", bearing, 3)] });
const root = { id: "cnc-a", label: "机床 A", packageKey: packageKey(shaft), quantity: 2 };
const installed = new Map([ball, bearing, shaft].map(p => [packageKey(p), p]));

describe("按所选实体与槽位阅读结构", () => {
  it("同型号的两个安装位置保留不同路径和精确累计数量", () => {
    const left = compositionTrail(installed, root, ["left", "balls"]);
    const right = compositionTrail(installed, root, ["right", "balls"]);
    expect(left.map(n => n.id)).toEqual(["cnc-a", "left", "balls"]);
    expect(left.map(n => n.cumulative)).toEqual([2n, 4n, 48n]);
    expect(right.at(-1)?.cumulative).toBe(72n);
    expect(firstPartPath(installed, root.packageKey, packageKey(ball))).toEqual(["left", "balls"]);
    expect(firstPartPath(installed, root.packageKey, root.packageKey)).toEqual([]);
    expect(visibleCompositionRoots([root], ["cnc-a", "cnc-a"])).toEqual([root]);
    expect(visibleCompositionRoots([root], [])).toEqual([]);
    const large = { ...root, quantity: Number.MAX_SAFE_INTEGER };
    expect(compositionTrail(installed, large, ["right", "balls"]).at(-1)?.cumulative).toBe(324259173170675676n);
  });
  it("失去旧修订的槽位时停在最近的有效祖先，缺少的设备修订仍可选中查看", () => {
    expect(compositionTrail(installed, root, ["left", "unavailable"]).at(-1)?.id).toBe("left");
    const partial = new Map(installed); partial.delete(packageKey(bearing));
    const trail = compositionTrail(partial, root, ["right", "balls"]);
    expect(trail.at(-1)).toMatchObject({ id: "right", label: "后支承", cumulative: 6n });
    expect(trail.at(-1)?.device).toBeUndefined();
    expect(firstPartPath(partial, root.packageKey, packageKey(bearing))).toEqual(["left"]);
    expect(firstPartPath(partial, root.packageKey, packageKey(ball))).toBeUndefined();
  });
});
