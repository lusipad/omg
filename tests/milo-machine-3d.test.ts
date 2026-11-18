import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { MILO_MACHINE, planMiloProgram, sampleMiloMotion, type MiloVec3 } from "../contracts/milo-motion";
import { MILO_STOCK, MILO_TOOL_DIAMETER_MM } from "../contracts/milo-stock";
import { createMiloMachine3D } from "../src/components/milo-machine-3d";

const machines: ReturnType<typeof createMiloMachine3D>[] = [];
function make() {
  const machine = createMiloMachine3D();
  machines.push(machine);
  return machine;
}
afterEach(() => { for (const m of machines.splice(0)) m.dispose(); });

function named(o: THREE.Object3D, name: string) {
  const result = o.getObjectByName(name);
  if (!result) throw new Error(`模型缺少 ${name}`);
  return result;
}
const world = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
function visible(o: THREE.Object3D): boolean { return o.visible && (!o.parent || visible(o.parent)); }
function near(p: THREE.Vector3, q: readonly number[]) {
  [p.x, p.y, p.z].forEach((value, i) => expect(value).toBeCloseTo(q[i], 10));
}

describe("Milo 整机的真实坐标和资源", () => {
  it("毛坯顶面零点正对主轴，刀尖相对毛坯的位移在两个视图完全一致", () => {
    const m = make(), tip = named(m.group, "tool-tip");
    const stock = new THREE.Group(); m.workOrigin.add(stock);
    const plan = planMiloProgram("G21 G90 G1 Z0 F180\nG1 X30 Y40 F600\nG3 X50 Y40 I10 Z-3");
    const s = plan.segments[2], values = [sampleMiloMotion(plan, plan.segments[0].endS), sampleMiloMotion(plan, (s.startS + s.endS) / 2), sampleMiloMotion(plan, plan.durationS)];
    for (const sample of values) {
      m.setPose(sample, "machine");
      const [x,y,z] = sample.positionMm;
      near(world(m.workOrigin), [-x, -y, MILO_STOCK.thicknessMm]);
      near(world(tip), [0, 0, MILO_STOCK.thicknessMm + z]);
      near(stock.worldToLocal(world(tip)), sample.positionMm);
      m.setPose(sample, "stock");
      near(world(m.workOrigin), [0,0,0]); near(world(tip), sample.positionMm);
      near(stock.worldToLocal(world(tip)), sample.positionMm);
      expect(stock.parent).toBe(m.workOrigin);
    }
  });

  it("X/Y 以相反方向分层移动机台，Z 主轴独自升降，固定机座不动", () => {
    const m = make();
    const frame = named(m.group, "machine-frame"), saddle = named(m.group, "y-saddle");
    const table = named(m.group, "xy-table"), head = named(m.group, "z-head");
    m.setPose({ positionMm: [0,0,0] }, "machine");
    const f0 = world(frame), s0 = world(saddle), t0 = world(table), h0 = world(head);
    m.setPose({ positionMm: [24, -7, -3] }, "machine");
    near(world(frame).sub(f0), [0,0,0]);
    near(world(saddle).sub(s0), [0,7,0]); near(world(table).sub(t0), [-24,7,0]);
    near(world(head).sub(h0), [0,0,-3]);
    expect(m.workOrigin.parent).toBe(table);
  });

  it("特写只保留平底铣刀，切换到整机仍保持 Ø6 mm 包络和同一刀尖", () => {
    const m = make(), tool = named(m.group, "end-mill");
    const flutes = named(tool, "flat-flutes") as THREE.Mesh<THREE.BufferGeometry>;
    const vertices = flutes.geometry.getAttribute("position");
    let maxRadius = 0, tipRadius = 0, minZ = Infinity;
    for (let i=0; i<vertices.count; i++) {
      const r = Math.hypot(vertices.getX(i), vertices.getY(i)), z = vertices.getZ(i);
      maxRadius = Math.max(maxRadius,r); minZ = Math.min(minZ,z); if (z === 0) tipRadius = Math.max(tipRadius,r);
    }
    expect(minZ).toBe(0);
    expect(2 * maxRadius).toBeCloseTo(MILO_TOOL_DIAMETER_MM, 5);
    expect(2 * tipRadius).toBeCloseTo(MILO_TOOL_DIAMETER_MM, 5);
    m.setPose({positionMm:[36,30,-3]}, "stock");
    expect(visible(tool)).toBe(true);
    expect(visible(named(m.group,"machine-frame"))).toBe(false);
    expect(visible(named(m.group,"spindle-housing"))).toBe(false);
    expect(visible(m.workOrigin)).toBe(true);
    m.setPose({positionMm:[36,30,-3]}, "machine");
    expect(visible(named(m.group,"spindle-housing"))).toBe(true);
    expect(flutes.castShadow).toBe(true);
    near(tool.getWorldScale(new THREE.Vector3()),[1,1,1]);
  });

  it("行程两端的刀尖与工作原点可逆，四头丝杠每 8 mm 转一周", () => {
    const m = make(), origin = m.workOrigin, tip = named(m.group, "tool-tip");
    for (const p of [MILO_MACHINE.minMm, MILO_MACHINE.maxMm]) {
      const w: MiloVec3 = [p[0]-10,p[1]-10,p[2]+20];
      m.setPose({positionMm:w}, "machine");
      near(origin.worldToLocal(world(tip)), w);
    }
    m.setPose({positionMm:[8,8,8]}, "machine");
    expect(named(m.group,"x-lead-screw").rotation.z).toBeCloseTo(-2*Math.PI,12);
    expect(named(m.group,"y-lead-screw").rotation.z).toBeCloseTo(2*Math.PI,12);
    expect(named(m.group,"z-lead-screw").rotation.z).toBeCloseTo(-2*Math.PI,12);
  });

  it("共享几何、材质和实例各释放一次，外接毛坯与刀路由调用方负责", () => {
    const m = make(), objects = new Set<THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh>();
    m.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        objects.add(o.geometry);
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) objects.add(mat);
      }
      if (o instanceof THREE.InstancedMesh) objects.add(o);
    });
    const owned = [...objects].map((o) => vi.spyOn(o, "dispose"));
    const external = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const disposeGeom = vi.spyOn(external.geometry, "dispose"), disposeMat = vi.spyOn(external.material, "dispose");
    m.workOrigin.add(external);
    m.setPose({positionMm:[1,2,3]},"machine");
    m.dispose(); m.dispose();
    expect(owned.length).toBeGreaterThan(10); owned.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    expect(disposeGeom).not.toHaveBeenCalled(); expect(disposeMat).not.toHaveBeenCalled();
    expect(external.parent).toBe(m.workOrigin); expect(m.workOrigin.parent).toBeNull();
    external.geometry.dispose(); external.material.dispose();
  });
});
