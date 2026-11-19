import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deviceCompositionClosure, getDeviceParts, rollupDeviceParts } from "../contracts/device-composition";
import { packageKey } from "../contracts/twin-device";
import { parseWorkspace } from "../contracts/twin-simulation";

const source = new URL("../public/assemblies/cnc-factory/project.twin.json", import.meta.url);
const ws = parseWorkspace(JSON.parse(readFileSync(source, "utf8")));
const layout = ws.factories![0], installed = new Map(ws.packages.map(p => [packageKey(p), p]));
const demand = layout.resources.map(r => ({ packageKey: r.packageKey, quantity: 1 }));

describe("教学车间的多级物理 BOM", () => {
  it("八种整机及备选型号的依赖可全部展开，现场需求按八台实体计算", () => {
    const roots = ws.packages.filter(p => p.factory);
    const all = deviceCompositionClosure(ws.packages, roots.map(packageKey));
    expect(all.missing).toEqual([]);
    const optionalMotorParts = ws.packages.filter(p => p.motorPhysics);
    expect(optionalMotorParts).toHaveLength(6);
    expect(new Set([...all.packages, ...optionalMotorParts].map(packageKey))).toEqual(new Set(installed.keys()));
    for (const device of roots) {
      const one = rollupDeviceParts(ws.packages, [{ packageKey: packageKey(device), quantity: 1 }]);
      expect(one.complete).toBe(true);
      expect(one.rows.every(row => installed.get(row.packageKey)?.composition?.kind === "leaf")).toBe(true);
    }
    const shop = rollupDeviceParts(ws.packages, demand);
    expect(shop.complete).toBe(true);
    expect(shop.leafQuantity).toBe("3717");
    expect(shop.rows).toHaveLength(67);
    const steelBalls = shop.rows.find(row => installed.get(row.packageKey)?.model === "BALL-4");
    expect(steelBalls?.quantity).toBe("688");
    expect(demand).toHaveLength(8);
    expect(layout.lines).toHaveLength(2);
  });

  it("同一 X 轴电机能沿独立的支承与转子分支定位实物并累乘数量", () => {
    const cnc = layout.resources.find(r => r.id === "cnc-a")!;
    function at(slots: string[]) {
      let current = installed.get(cnc.packageKey)!, count = 1;
      for (const id of slots) {
        const part = getDeviceParts(current).find(p => p.id === id);
        if (!part) throw new Error(`部件 ${current.model} 缺少槽位 ${id}`);
        count *= part.quantity;
        current = installed.get(part.packageKey)!;
      }
      return { model: current.model, kind: current.composition?.kind, count };
    }
    expect(at(["feed", "x", "motor", "supports", "bearing", "balls"])).toEqual({ model: "BALL-4", kind: "leaf", count: 16 });
    expect(at(["feed", "x", "motor", "rotor", "magnets"])).toEqual({ model: "ROTOR-MAGNET", kind: "leaf", count: 4 });
    expect(at(["feed", "x", "motor", "stator", "winding"])).toEqual({ model: "PHASE-WIRE", kind: "leaf", count: 3 });
    expect(rollupDeviceParts(ws.packages, [{ packageKey: cnc.packageKey, quantity: 1 }]).leafQuantity).toBe("747");
  });
});
