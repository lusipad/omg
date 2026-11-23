import { Matrix4, Quaternion, Vector3 } from "three";
import { frameToMatrixMm } from "./articulated-kinematics";
import type { ModelBundle } from "./import-catalog";
import type { ImportedRunSettings } from "./imported-physics";
import {
  inspectMechanicalAssembly,
  type MechanicalAssembly,
  type MechanicalClosure,
  type MechanicalFrame,
  type MechanicalPart,
} from "./mechanical-assembly";
import {
  EXTRUSION_SERIES_SECTION_MM,
  primitiveBoundingBoxMm,
  type AxisDir,
  type PrimitiveFinish,
  type PrimitivePartSpec,
} from "./primitive-parts";
import { packageKey, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export type ArenaPresetId = "flat_ramp" | "grasp_pedestal" | "step_obstacles" | "launch_complex" | "lab_floor";

export interface ArenaPresetInfo {
  readonly id: ArenaPresetId;
  readonly label: string;
  readonly shortLabel: string;
  readonly summary: string;
}

export const ARENA_PRESETS: readonly ArenaPresetInfo[] = [
  {
    id: "launch_complex",
    label: "航天发射台与开阔空域（火箭 / 直升机起飞场）",
    shortLabel: "航天发射场",
    summary: "8×8 m 广域发射场与混凝土发射坪，零阻力空中矢量推力升空、共轴旋翼悬停与程序转弯。",
  },
  {
    id: "flat_ramp",
    label: "重力平地 + 10° 越障坡道",
    shortLabel: "坡道越障场",
    summary: "带 1.2 高摩擦平地与 +X 方向 10° 上坡斜台，适合验证小车行驶、抓地与爬坡动力。",
  },
  {
    id: "grasp_pedestal",
    label: "刚体抓取实验台（含 80g 自由物块）",
    shortLabel: "刚体抓物台",
    summary: "前方矮台上放置带 6-DOF 自由关节的高摩擦方块，检验夹爪纯粹靠接触摩擦力夹持抬升。",
  },
  {
    id: "step_obstacles",
    label: "减速坎与推箱障碍场",
    shortLabel: "越障推箱场",
    summary: "平地上设置双道减速凸坎与可推动自由方箱，检验底盘悬架越障与推力接触响应。",
  },
  {
    id: "lab_floor",
    label: "标准重力实验地坪",
    shortLabel: "纯净重力场",
    summary: "-9.81 m/s² 重力硬质混凝土地面，适合测试闭链连杆、弹簧摆臂、东方明珠与工业机构。",
  },
];

export interface CompiledMujocoActuatorMeta {
  readonly index: number;
  readonly name: string;
  readonly nodePath: string;
  readonly label: string;
  readonly mode: "actuated" | "velocity" | "thrust";
  readonly unit: "rad/s" | "rad" | "m" | "N";
  readonly range: readonly [number, number];
}

export interface CompiledMujocoResult {
  readonly bundle: ModelBundle;
  readonly xml: string;
  readonly stats: {
    readonly bodyCount: number;
    readonly jointCount: number;
    readonly actuatorCount: number;
    readonly equalityCount: number;
    readonly tendonCount: number;
    readonly totalMassKg: number;
    readonly baseMobility: "fixed" | "free";
    readonly arena: ArenaPresetId;
  };
  readonly actuatorMeta: readonly CompiledMujocoActuatorMeta[];
  readonly recommendedRun: ImportedRunSettings;
  readonly payloadSiteId?: string;
}

export interface CompileMujocoOptions {
  readonly arena?: ArenaPresetId;
  readonly baseMobility?: "fixed" | "free";
  readonly timestepS?: number;
}

const encodeUtf8 = new TextEncoder();

const FINISH_RGBA: Record<PrimitiveFinish, string> = {
  aluminum: "0.73 0.77 0.80 1",
  anodized_black: "0.18 0.21 0.24 1",
  steel: "0.55 0.60 0.64 1",
  brass: "0.79 0.61 0.32 1",
  spindle_red: "0.79 0.29 0.25 1",
  workpiece_alloy: "0.42 0.72 0.65 1",
  sensor_amber: "0.89 0.61 0.23 1",
  rubber_grip: "0.11 0.14 0.17 1",
  aerospace_white: "0.94 0.96 0.98 1",
  pearl_crimson: "0.86 0.16 0.48 1",
};

const FINISH_DENSITY_KG_M3: Record<PrimitiveFinish, number> = {
  aluminum: 2700,
  anodized_black: 2700,
  steel: 7850,
  brass: 8400,
  spindle_red: 5200,
  workpiece_alloy: 2700,
  sensor_amber: 1800,
  rubber_grip: 1250,
  aerospace_white: 1950,
  pearl_crimson: 2400,
};

function escAttr(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmt(n: number): string {
  const v = Math.abs(n) < 1e-9 ? 0 : n;
  return Number(v.toFixed(6)).toString();
}

function fmtVec3M(mm: readonly [number, number, number]): string {
  return `${fmt(mm[0] * 0.001)} ${fmt(mm[1] * 0.001)} ${fmt(mm[2] * 0.001)}`;
}

function fmtQuatWxyz(q: Quaternion): string {
  const n = q.clone().normalize();
  return `${fmt(n.w)} ${fmt(n.x)} ${fmt(n.y)} ${fmt(n.z)}`;
}

function sanitizeMjName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+/, "");
  return cleaned || "item";
}

function axisQuaternion(axis: AxisDir): Quaternion {
  const q = new Quaternion();
  if (axis === "x") {
    const m = new Matrix4().makeBasis(
      new Vector3(0, 1, 0),
      new Vector3(0, 0, 1),
      new Vector3(1, 0, 0),
    );
    q.setFromRotationMatrix(m);
  } else if (axis === "y") {
    q.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(0, 1, 0));
  }
  return q;
}

function resolveDefaultFinish(spec: PrimitivePartSpec): PrimitiveFinish {
  if (spec.finish) return spec.finish;
  if (spec.shape === "extrusion_profile" || spec.shape === "servo_motor_body") return "anodized_black";
  if (spec.shape === "spindle_cutter") return "spindle_red";
  if (spec.shape === "linear_rail_block" || spec.shape === "lead_screw" || spec.shape === "bearing_pillow") return "steel";
  return "aluminum";
}

function estimatePartMassKg(pkg: DevicePackage | undefined, finish: PrimitiveFinish): number {
  const explicitMass = pkg?.parameters?.massKg;
  if (explicitMass && explicitMass.status !== "pending" && typeof explicitMass.value === "number" && explicitMass.value > 0) {
    return Math.min(80, Math.max(0.02, explicitMass.value));
  }
  if (!pkg?.primitive) return 0.25;
  const spec = pkg.primitive;
  const mm3ToM3 = 1e-9;
  let volM3 = 0;
  switch (spec.shape) {
    case "box":
      volM3 = spec.widthMm * spec.depthMm * spec.heightMm * mm3ToM3;
      break;
    case "plate":
      volM3 = spec.widthMm * spec.depthMm * spec.thicknessMm * mm3ToM3;
      break;
    case "cylinder":
      volM3 = Math.PI * spec.radiusMm * spec.radiusMm * spec.lengthMm * mm3ToM3;
      break;
    case "tube":
      volM3 = Math.PI * (spec.outerRadiusMm ** 2 - spec.innerRadiusMm ** 2) * spec.lengthMm * mm3ToM3;
      break;
    case "extrusion_profile": {
      const [w, h] = EXTRUSION_SERIES_SECTION_MM[spec.series];
      volM3 = w * h * spec.lengthMm * 0.55 * mm3ToM3;
      break;
    }
    case "linear_rail_block":
      volM3 = (spec.railLengthMm * spec.railWidthMm * spec.heightMm * 0.45 + spec.blockLengthMm * spec.blockWidthMm * spec.heightMm * 0.6) * mm3ToM3;
      break;
    case "lead_screw":
      volM3 = Math.PI * (spec.diameterMm / 2) ** 2 * spec.lengthMm * mm3ToM3;
      break;
    case "servo_motor_body":
      volM3 = spec.flangeMm * spec.flangeMm * spec.bodyLengthMm * 0.85 * mm3ToM3;
      break;
    case "spindle_cutter":
      volM3 = Math.PI * (spec.bodyDiameterMm / 2) ** 2 * spec.bodyLengthMm * 0.78 * mm3ToM3;
      break;
    case "angle_bracket":
      volM3 = spec.widthMm * spec.thicknessMm * (spec.legAMm + spec.legBMm) * mm3ToM3;
      break;
    case "bearing_pillow":
      volM3 = spec.widthMm * spec.depthMm * spec.heightMm * 0.65 * mm3ToM3;
      break;
    case "sphere":
      volM3 = (4 / 3) * Math.PI * spec.radiusMm ** 3 * mm3ToM3;
      break;
    case "cone":
      volM3 =
        (Math.PI *
          spec.lengthMm *
          (spec.radiusBottomMm ** 2 + spec.radiusBottomMm * spec.radiusTopMm + spec.radiusTopMm ** 2)) /
        3 *
        mm3ToM3;
      break;
    case "external_mesh":
      volM3 = spec.approxBoundsMm[0] * spec.approxBoundsMm[1] * spec.approxBoundsMm[2] * 0.5 * mm3ToM3;
      break;
  }
  const density = FINISH_DENSITY_KG_M3[finish];
  // Scale industrial frame profiles mildly lighter to behave realistically in small-scale dynamic rigs
  return Math.min(35, Math.max(0.025, Number((volM3 * density).toFixed(4))));
}

interface GeomXmlSpec {
  readonly kind: "box" | "cylinder" | "sphere";
  readonly posM: readonly [number, number, number];
  readonly quat: Quaternion;
  readonly sizeM: readonly number[];
  readonly rgba: string;
  readonly massKg: number;
  readonly isHighGrip: boolean;
}

function buildPartGeoms(pkg: DevicePackage | undefined): { geoms: GeomXmlSpec[]; totalMassKg: number } {
  if (!pkg?.primitive) {
    const m = pkg?.mechanics;
    if (m?.kind === "part" && m.outputs.length > 0) {
      const target = m.outputs[0]!.positionMm;
      const lenM = Math.max(0.024, Math.hypot(...target) * 0.001);
      return {
        geoms: [{
          kind: "box",
          posM: [target[0] * 0.0005, target[1] * 0.0005, target[2] * 0.0005],
          quat: new Quaternion(),
          sizeM: [lenM / 2, 0.012, 0.009],
          rgba: FINISH_RGBA.aluminum,
          massKg: 0.15,
          isHighGrip: false,
        }],
        totalMassKg: 0.15,
      };
    }
    return {
      geoms: [{
        kind: "box",
        posM: [0, 0, 0],
        quat: new Quaternion(),
        sizeM: [0.02, 0.02, 0.015],
        rgba: FINISH_RGBA.aluminum,
        massKg: 0.1,
        isHighGrip: false,
      }],
      totalMassKg: 0.1,
    };
  }

  const spec = pkg.primitive;
  const finish = resolveDefaultFinish(spec);
  const rgba = FINISH_RGBA[finish];
  const isHighGrip = finish === "rubber_grip";
  const totalMassKg = estimatePartMassKg(pkg, finish);
  const geoms: GeomXmlSpec[] = [];

  switch (spec.shape) {
    case "box":
    case "plate":
    case "extrusion_profile":
    case "bearing_pillow":
    case "external_mesh": {
      const [dx, dy, dz] = primitiveBoundingBoxMm(spec);
      geoms.push({
        kind: "box",
        posM: [0, 0, 0],
        quat: new Quaternion(),
        sizeM: [dx * 0.0005, dy * 0.0005, dz * 0.0005],
        rgba,
        massKg: totalMassKg,
        isHighGrip,
      });
      break;
    }
    case "cylinder": {
      geoms.push({
        kind: "cylinder",
        posM: [0, 0, 0],
        quat: axisQuaternion(spec.axis),
        sizeM: [spec.radiusMm * 0.001, spec.lengthMm * 0.0005],
        rgba,
        massKg: totalMassKg,
        isHighGrip,
      });
      break;
    }
    case "tube": {
      geoms.push({
        kind: "cylinder",
        posM: [0, 0, 0],
        quat: axisQuaternion(spec.axis),
        sizeM: [spec.outerRadiusMm * 0.001, spec.lengthMm * 0.0005],
        rgba,
        massKg: totalMassKg,
        isHighGrip,
      });
      break;
    }
    case "lead_screw": {
      geoms.push({
        kind: "cylinder",
        posM: [0, 0, 0],
        quat: axisQuaternion(spec.axis),
        sizeM: [spec.diameterMm * 0.0005, spec.lengthMm * 0.0005],
        rgba,
        massKg: totalMassKg,
        isHighGrip: false,
      });
      break;
    }
    case "linear_rail_block": {
      if (spec.axis === "z") {
        geoms.push(
          {
            kind: "box",
            posM: [0, spec.heightMm * 0.00024, 0],
            quat: new Quaternion(),
            sizeM: [spec.railWidthMm * 0.0005, spec.heightMm * 0.00024, spec.railLengthMm * 0.0005],
            rgba: FINISH_RGBA.steel,
            massKg: totalMassKg * 0.55,
            isHighGrip: false,
          },
          {
            kind: "box",
            posM: [0, -spec.heightMm * 0.00016, 0],
            quat: new Quaternion(),
            sizeM: [spec.blockWidthMm * 0.0005, spec.heightMm * 0.00031, spec.blockLengthMm * 0.0005],
            rgba: FINISH_RGBA.anodized_black,
            massKg: totalMassKg * 0.45,
            isHighGrip: false,
          },
        );
      } else if (spec.axis === "y") {
        geoms.push(
          {
            kind: "box",
            posM: [0, 0, -spec.heightMm * 0.00024],
            quat: new Quaternion(),
            sizeM: [spec.railWidthMm * 0.0005, spec.railLengthMm * 0.0005, spec.heightMm * 0.00024],
            rgba: FINISH_RGBA.steel,
            massKg: totalMassKg * 0.55,
            isHighGrip: false,
          },
          {
            kind: "box",
            posM: [0, 0, spec.heightMm * 0.00016],
            quat: new Quaternion(),
            sizeM: [spec.blockWidthMm * 0.0005, spec.blockLengthMm * 0.0005, spec.heightMm * 0.00031],
            rgba: FINISH_RGBA.anodized_black,
            massKg: totalMassKg * 0.45,
            isHighGrip: false,
          },
        );
      } else {
        geoms.push(
          {
            kind: "box",
            posM: [0, 0, -spec.heightMm * 0.00024],
            quat: new Quaternion(),
            sizeM: [spec.railLengthMm * 0.0005, spec.railWidthMm * 0.0005, spec.heightMm * 0.00024],
            rgba: FINISH_RGBA.steel,
            massKg: totalMassKg * 0.55,
            isHighGrip: false,
          },
          {
            kind: "box",
            posM: [0, 0, spec.heightMm * 0.00016],
            quat: new Quaternion(),
            sizeM: [spec.blockLengthMm * 0.0005, spec.blockWidthMm * 0.0005, spec.heightMm * 0.00031],
            rgba: FINISH_RGBA.anodized_black,
            massKg: totalMassKg * 0.45,
            isHighGrip: false,
          },
        );
      }
      break;
    }
    case "servo_motor_body": {
      const q = axisQuaternion(spec.axis);
      const shaftLocal = new Vector3(0, 0, (spec.bodyLengthMm / 2 + spec.shaftLengthMm / 2) * 0.001).applyQuaternion(q);
      geoms.push(
        {
          kind: "box",
          posM: [0, 0, 0],
          quat: q,
          sizeM: [spec.flangeMm * 0.0005, spec.flangeMm * 0.0005, spec.bodyLengthMm * 0.0005],
          rgba,
          massKg: totalMassKg * 0.85,
          isHighGrip: false,
        },
        {
          kind: "cylinder",
          posM: [shaftLocal.x, shaftLocal.y, shaftLocal.z],
          quat: q,
          sizeM: [spec.shaftDiameterMm * 0.0005, spec.shaftLengthMm * 0.0005],
          rgba: FINISH_RGBA.steel,
          massKg: Math.max(0.015, totalMassKg * 0.15),
          isHighGrip: false,
        },
      );
      break;
    }
    case "spindle_cutter": {
      geoms.push(
        {
          kind: "cylinder",
          posM: [0, 0, 0],
          quat: new Quaternion(),
          sizeM: [spec.bodyDiameterMm * 0.0005, spec.bodyLengthMm * 0.0005],
          rgba,
          massKg: totalMassKg * 0.85,
          isHighGrip: false,
        },
        {
          kind: "cylinder",
          posM: [0, 0, -(spec.bodyLengthMm / 2 + spec.toolStickoutMm / 2) * 0.001],
          quat: new Quaternion(),
          sizeM: [spec.toolDiameterMm * 0.0005, spec.toolStickoutMm * 0.0005],
          rgba: FINISH_RGBA.brass,
          massKg: Math.max(0.015, totalMassKg * 0.15),
          isHighGrip: false,
        },
      );
      break;
    }
    case "angle_bracket": {
      const t = Math.min(spec.thicknessMm, spec.legAMm * 0.45, spec.legBMm * 0.45);
      geoms.push(
        {
          kind: "box",
          posM: [0, 0, (-spec.legBMm / 2 + t / 2) * 0.001],
          quat: new Quaternion(),
          sizeM: [spec.widthMm * 0.0005, spec.legAMm * 0.0005, t * 0.0005],
          rgba,
          massKg: totalMassKg * 0.5,
          isHighGrip: false,
        },
        {
          kind: "box",
          posM: [0, (-spec.legAMm / 2 + t / 2) * 0.001, 0],
          quat: new Quaternion(),
          sizeM: [spec.widthMm * 0.0005, t * 0.0005, spec.legBMm * 0.0005],
          rgba,
          massKg: totalMassKg * 0.5,
          isHighGrip: false,
        },
      );
      break;
    }
    case "sphere": {
      geoms.push({
        kind: "sphere",
        posM: [0, 0, 0],
        quat: new Quaternion(),
        sizeM: [spec.radiusMm * 0.001],
        rgba,
        massKg: totalMassKg,
        isHighGrip: false,
      });
      break;
    }
    case "cone": {
      // Split conical frustum into 3 stepped coaxial cylinders along spec.axis so MuJoCo contact & Three.js preview match cleanly without external meshes
      const q = axisQuaternion(spec.axis);
      const halfSegLenM = (spec.lengthMm / 6) * 0.001;
      const fracs = [1 / 6, 0.5, 5 / 6] as const;
      const offsetsMm = [-spec.lengthMm / 3, 0, spec.lengthMm / 3] as const;
      const segRadiiM = fracs.map((t) =>
        Math.max(0.0015, ((spec.radiusBottomMm * (1 - t) + spec.radiusTopMm * t) * 0.001)),
      );
      const sumR2 = segRadiiM.reduce((acc, r) => acc + r * r, 0) || 1;
      for (let i = 0; i < 3; i++) {
        const localShift = new Vector3(0, 0, offsetsMm[i]! * 0.001).applyQuaternion(q);
        geoms.push({
          kind: "cylinder",
          posM: [localShift.x, localShift.y, localShift.z],
          quat: q,
          sizeM: [segRadiiM[i]!, halfSegLenM],
          rgba,
          massKg: Math.max(0.006, (totalMassKg * segRadiiM[i]! * segRadiiM[i]!) / sumR2),
          isHighGrip: false,
        });
      }
      break;
    }
  }

  return { geoms, totalMassKg };
}

interface FlatCompiledNode {
  readonly path: string;
  readonly id: string;
  readonly label: string;
  readonly parentPath: string | null;
  readonly parentMountId: string | null;
  readonly pkg?: DevicePackage;
  readonly part: MechanicalPart;
  readonly jointMode?: "actuated" | "passive" | "velocity";
  readonly thruster?: NonNullable<MechanicalAssembly["nodes"][number]["thruster"]>;
  readonly coupledTo?: NonNullable<MechanicalAssembly["nodes"][number]["coupledTo"]>;
  readonly mountById: Map<string, Matrix4>;
  readonly mountFrameById: Map<string, MechanicalFrame>;
}

function flattenAssemblyForPhysics(ws: TwinWorkspace, rootAssembly: MechanicalAssembly): {
  nodes: FlatCompiledNode[];
  closures: Array<MechanicalClosure & { resolvedA: string; resolvedB: string }>;
  outputPath: string;
  outputMount: string;
} {
  const catalog = new Map<string, DevicePackage>(ws.packages.map((p) => [packageKey(p), p]));
  const flatNodes: FlatCompiledNode[] = [];
  const flatClosures: Array<MechanicalClosure & { resolvedA: string; resolvedB: string }> = [];

  function expand(
    def: MechanicalAssembly,
    prefix: string,
    graftPath: string | null,
    graftMountId: string | null,
  ): { outputPath: string; outputMount: string } {
    const ordered: MechanicalAssembly["nodes"] = [];
    const seen = new Set<string>();
    const enqueue = (node: MechanicalAssembly["nodes"][number]) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      ordered.push(node);
    };
    def.nodes.filter((n) => !n.parent).forEach(enqueue);
    for (let i = 0; i < ordered.length; i++) {
      for (const child of def.nodes) {
        if (child.parent?.node === ordered[i]!.id) enqueue(child);
      }
    }

    const localOut = new Map<string, { outputPath: string; outputMount: string }>();
    const nodeRootPathMap = new Map<string, string>();
    const remapPath = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);

    for (const node of ordered) {
      const path = remapPath(node.id);
      const pkg = catalog.get(node.packageKey);
      const mechanics = pkg?.mechanics;
      const isRoot = !node.parent;

      const resolvedParent = isRoot
        ? { path: graftPath, mount: graftMountId }
        : (() => {
            const pTarget = localOut.get(node.parent!.node);
            return pTarget
              ? { path: pTarget.outputPath, mount: pTarget.outputMount }
              : { path: remapPath(node.parent!.node), mount: node.parent!.mount };
          })();

      if (mechanics?.kind === "assembly") {
        const subOut = expand(mechanics.assembly, path, resolvedParent.path, resolvedParent.mount);
        localOut.set(node.id, subOut);
        nodeRootPathMap.set(node.id, subOut.outputPath);
        continue;
      }

      const part: MechanicalPart = mechanics?.kind === "part"
        ? mechanics
        : { kind: "part", input: { positionMm: [0, 0, 0], quatWxyz: [1, 0, 0, 0] }, joint: { type: "fixed" }, outputs: [] };

      nodeRootPathMap.set(node.id, path);
      flatNodes.push({
        path,
        id: node.id,
        label: node.label?.trim() || pkg?.model || node.id,
        parentPath: resolvedParent.path,
        parentMountId: resolvedParent.mount,
        pkg,
        part,
        jointMode: node.jointMode,
        thruster: node.thruster,
        coupledTo: node.coupledTo ? { ...node.coupledTo, path: remapPath(node.coupledTo.path) } : undefined,
        mountById: new Map(part.outputs.map((m) => [m.id, frameToMatrixMm(m)])),
        mountFrameById: new Map(part.outputs.map((m) => [m.id, m])),
      });
    }

    for (const c of def.closures ?? []) {
      const targetA = nodeRootPathMap.get(c.nodeA) ?? remapPath(c.nodeA);
      const targetB = nodeRootPathMap.get(c.nodeB) ?? remapPath(c.nodeB);
      flatClosures.push({
        ...c,
        id: prefix ? `${prefix}_${c.id}` : c.id,
        resolvedA: targetA,
        resolvedB: targetB,
      });
    }

    const mappedOut = localOut.get(def.output.node);
    return mappedOut ?? { outputPath: remapPath(def.output.node), outputMount: def.output.mount };
  }

  const rootOut = expand(rootAssembly, "", null, null);
  return {
    nodes: flatNodes,
    closures: flatClosures,
    outputPath: rootOut.outputPath,
    outputMount: rootOut.outputMount,
  };
}

function inferEffectiveJointMode(
  node: FlatCompiledNode,
  pkg?: DevicePackage,
): "actuated" | "passive" | "velocity" {
  if (node.jointMode) return node.jointMode;
  if (node.part.joint.type === "hinge") {
    const span = Math.abs(node.part.joint.range[1] - node.part.joint.range[0]);
    if (span >= 3600 || pkg?.primitive?.finish === "rubber_grip") return "velocity";
  }
  return "actuated";
}

export function inferDefaultArenaAndMobility(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
): { arena: ArenaPresetId; baseMobility: "fixed" | "free" } {
  const pkgMap = new Map(ws.packages.map((p) => [packageKey(p), p]));
  let hasWheel = false;
  let hasGripper = false;
  const hasThruster = assembly.nodes.some((n) => Boolean(n.thruster));
  const hasSpring = Boolean(assembly.closures?.some((c) => c.kind === "spring"));
  const hasLoop = Boolean(assembly.closures?.some((c) => !c.kind || c.kind === "connect" || c.kind === "weld"));

  for (const node of assembly.nodes) {
    const pkg = pkgMap.get(node.packageKey);
    const idL = node.id.toLowerCase();
    const labelL = (node.label ?? pkg?.model ?? "").toLowerCase();
    if (pkg?.primitive?.finish === "rubber_grip" && pkg.primitive.shape === "cylinder") {
      hasWheel = true;
    }
    if (idL.includes("jaw") || idL.includes("gripper") || labelL.includes("夹爪") || labelL.includes("手指")) {
      hasGripper = true;
    }
  }

  const baseMobility: "fixed" | "free" = assembly.baseMobility ?? (hasWheel || hasThruster ? "free" : "fixed");
  const arena: ArenaPresetId = hasThruster
    ? "launch_complex"
    : assembly.id.includes("suspension") || hasSpring
      ? "lab_floor"
      : assembly.id.includes("linkage") || hasLoop
        ? "lab_floor"
        : hasGripper
          ? "grasp_pedestal"
          : baseMobility === "free" || hasWheel
            ? "flat_ramp"
            : "lab_floor";
  return { arena, baseMobility };
}

function renderArenaWorldbodyXml(arena: ArenaPresetId): { xml: string; payloadSiteName?: string } {
  switch (arena) {
    case "launch_complex":
      return {
        xml: [
          `    <geom name="arena_ground" type="plane" pos="0 0 0" size="8 8 0.05" contype="2" conaffinity="3" condim="4" friction="1.2 0.015 0.003" rgba="0.13 0.19 0.18 1"/>`,
          `    <geom name="arena_pad" type="box" pos="0 0 0.004" size="0.16 0.16 0.004" contype="2" conaffinity="3" condim="4" friction="1.4 0.02 0.004" rgba="0.24 0.30 0.34 1"/>`,
        ].join("\n"),
      };
    case "flat_ramp": {
      // Right-handed +Y rotation by -10 deg raises +X toward +Z.
      const rad = (-10 * Math.PI) / 180;
      const qRamp = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad);
      // Center rotated box (hx=0.30, hz=0.02) at pos=(0.56, 0, 0.0324) so leading top edge aligns flush with Z=0 at X~0.264m.
      return {
        xml: [
          `    <geom name="arena_ground" type="plane" pos="0 0 0" size="3 3 0.05" contype="2" conaffinity="3" condim="4" friction="1.4 0.02 0.004" rgba="0.14 0.21 0.19 1"/>`,
          `    <geom name="arena_ramp" type="box" pos="0.56 0 0.0324" quat="${fmtQuatWxyz(qRamp)}" size="0.30 0.24 0.02" contype="2" conaffinity="3" condim="4" friction="1.6 0.02 0.004" rgba="0.22 0.34 0.31 1"/>`,
          `    <geom name="arena_plateau" type="box" pos="0.98 0 0.0422" size="0.14 0.24 0.0422" contype="2" conaffinity="3" condim="4" friction="1.4 0.02 0.004" rgba="0.20 0.30 0.28 1"/>`,
        ].join("\n"),
      };
    }
    case "grasp_pedestal":
      return {
        payloadSiteName: "payload_center",
        xml: [
          `    <geom name="arena_ground" type="plane" pos="0 0 0" size="2.5 2.5 0.05" contype="2" conaffinity="3" friction="1.2 0.01 0.002" rgba="0.14 0.21 0.19 1"/>`,
          `    <geom name="arena_pedestal" type="box" pos="0.14 0 0.0325" size="0.042 0.045 0.0325" contype="2" conaffinity="3" condim="4" friction="1.1 0.01 0.002" rgba="0.24 0.30 0.33 1"/>`,
          `    <body name="payload_cube" pos="0.14 0 0.085">`,
          `      <freejoint name="payload_free"/>`,
          `      <geom name="payload_geom" type="box" size="0.020 0.020 0.020" mass="0.08" contype="2" conaffinity="3" condim="4" friction="1.65 0.02 0.005" solref="0.004 1" rgba="0.96 0.62 0.18 1"/>`,
          `      <site name="payload_center" pos="0 0 0"/>`,
          `    </body>`,
        ].join("\n"),
      };
    case "step_obstacles":
      return {
        payloadSiteName: "push_box_center",
        xml: [
          `    <geom name="arena_ground" type="plane" pos="0 0 0" size="3 3 0.05" contype="2" conaffinity="3" condim="4" friction="1.35 0.02 0.004" rgba="0.14 0.21 0.19 1"/>`,
          `    <geom name="speed_bump_1" type="box" pos="0.26 0 0.006" size="0.022 0.25 0.006" contype="2" conaffinity="3" condim="4" friction="1.4 0.02 0.004" rgba="0.86 0.65 0.22 1"/>`,
          `    <geom name="speed_bump_2" type="box" pos="0.44 0 0.007" size="0.024 0.25 0.007" contype="2" conaffinity="3" condim="4" friction="1.4 0.02 0.004" rgba="0.86 0.65 0.22 1"/>`,
          `    <body name="push_crate" pos="0.64 0 0.035">`,
          `      <freejoint name="crate_free"/>`,
          `      <geom name="crate_geom" type="box" size="0.035 0.055 0.035" mass="0.25" contype="2" conaffinity="3" condim="4" friction="0.7 0.01 0.002" rgba="0.84 0.45 0.28 1"/>`,
          `      <site name="push_box_center" pos="0 0 0"/>`,
          `    </body>`,
        ].join("\n"),
      };
    case "lab_floor":
      return {
        xml: `    <geom name="arena_ground" type="plane" pos="0 0 0" size="2.5 2.5 0.05" contype="2" conaffinity="3" condim="4" friction="1.2 0.01 0.002" rgba="0.14 0.21 0.19 1"/>`,
      };
  }
}

export function compileAssemblyToMujoco(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  options?: CompileMujocoOptions,
): CompiledMujocoResult {
  const issues = inspectMechanicalAssembly(ws, assembly);
  if (issues.length > 0) {
    throw new Error(`装配尚未闭环或存在错误，无法编译到 MuJoCo：\n${issues.join("\n")}`);
  }

  const defaults = inferDefaultArenaAndMobility(ws, assembly);
  const arena = options?.arena ?? defaults.arena;
  const baseMobility = options?.baseMobility ?? defaults.baseMobility;
  const timestepS = Math.min(0.01, Math.max(0.0005, options?.timestepS ?? 0.002));

  const flat = flattenAssemblyForPhysics(ws, assembly);
  if (flat.nodes.length === 0) {
    throw new Error("当前装配中没有可用的实体零件，无法生成物理模型。");
  }

  const byPath = new Map(flat.nodes.map((n) => [n.path, n]));
  const childrenMap = new Map<string | null, FlatCompiledNode[]>();
  for (const n of flat.nodes) {
    const list = childrenMap.get(n.parentPath) ?? [];
    list.push(n);
    childrenMap.set(n.parentPath, list);
  }

  // Compute q=0 world transforms of all nodes so we can accurately elevate root above ground Z=0
  const neutralWorldByPath = new Map<string, Matrix4>();
  const localTransformByPath = new Map<string, { posM: readonly [number, number, number]; quat: Quaternion }>();
  let minZMm = Infinity;

  for (const n of flat.nodes) {
    const parentRaw = n.parentPath ? byPath.get(n.parentPath) : undefined;
    const parentWorld = n.parentPath ? (neutralWorldByPath.get(n.parentPath) ?? new Matrix4()) : new Matrix4();
    const mountMat = parentRaw && n.parentMountId ? (parentRaw.mountById.get(n.parentMountId) ?? new Matrix4()) : new Matrix4();
    const inputInv = frameToMatrixMm(n.part.input).invert();
    const worldMat = parentWorld.clone().multiply(mountMat).multiply(inputInv);
    neutralWorldByPath.set(n.path, worldMat);

    const relMat = n.parentPath === null ? worldMat : mountMat.clone().multiply(inputInv);
    const relPos = new Vector3().setFromMatrixPosition(relMat);
    const relQuat = new Quaternion().setFromRotationMatrix(relMat).normalize();
    localTransformByPath.set(n.path, { posM: [relPos.x * 0.001, relPos.y * 0.001, relPos.z * 0.001], quat: relQuat });

    // Compute rotated world-space AABB min Z for accurate ground resting placement
    const bounds = n.pkg?.primitive ? primitiveBoundingBoxMm(n.pkg.primitive) : ([40, 40, 30] as const);
    const hx = bounds[0] / 2;
    const hy = bounds[1] / 2;
    const hz = bounds[2] / 2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const corner = new Vector3(sx * hx, sy * hy, sz * hz).applyMatrix4(worldMat);
          if (corner.z < minZMm) minZMm = corner.z;
        }
      }
    }
  }

  const padTopMm = arena === "launch_complex" ? 8 : 0;
  const groundClearanceMm = (baseMobility === "free" ? 2.5 : 0) + padTopMm;
  const rootLiftM = Number.isFinite(minZMm) ? -minZMm * 0.001 + groundClearanceMm * 0.001 : 0.05;

  const rootNode = flat.nodes.find((n) => n.parentPath === null);
  if (!rootNode) throw new Error("装配体缺少唯一根节点。");

  const usedNames = new Set<string>(["world", "arena_ground", "arena_pad", "arena_ramp", "arena_plateau", "payload_cube", "payload_free", "payload_geom", "payload_center", "push_crate", "crate_free", "crate_geom", "push_box_center", "chassis_free", "tcp_site"]);
  const uniqueName = (seed: string) => {
    const base = sanitizeMjName(seed);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let idx = 2;
    while (usedNames.has(`${base}_${idx}`)) idx++;
    const picked = `${base}_${idx}`;
    usedNames.add(picked);
    return picked;
  };

  // Preassign MuJoCo joint & body names so equality / tendon references can look them up regardless of traversal order
  const bodyNameByPath = new Map<string, string>();
  const jointSpecByPath = new Map<string, {
    mjName: string;
    mode: "actuated" | "passive" | "velocity";
    partJoint: Exclude<MechanicalPart["joint"], { type: "fixed" }>;
    coupledTo?: NonNullable<MechanicalAssembly["nodes"][number]["coupledTo"]>;
  }>();

  for (const n of flat.nodes) {
    bodyNameByPath.set(n.path, uniqueName(`body_${n.path}`));
    if (n.part.joint.type !== "fixed") {
      jointSpecByPath.set(n.path, {
        mjName: uniqueName(`jnt_${n.path}`),
        mode: inferEffectiveJointMode(n, n.pkg),
        partJoint: n.part.joint,
        coupledTo: n.coupledTo,
      });
    }
  }

  // Group closure sites by owning body path (plus spring initial distances)
  const extraSitesByPath = new Map<string, Array<{ siteName: string; posM: readonly [number, number, number] }>>();
  const addSiteToNode = (nodePath: string, siteName: string, posMm: readonly [number, number, number]) => {
    const list = extraSitesByPath.get(nodePath) ?? [];
    list.push({ siteName, posM: [posMm[0] * 0.001, posMm[1] * 0.001, posMm[2] * 0.001] });
    extraSitesByPath.set(nodePath, list);
  };

  const closureBindings: Array<{
    closure: MechanicalClosure & { resolvedA: string; resolvedB: string };
    siteA: string;
    siteB: string;
    restLengthM: number;
  }> = [];

  for (const c of flat.closures) {
    const nodeA = byPath.get(c.resolvedA);
    const nodeB = byPath.get(c.resolvedB);
    if (!nodeA || !nodeB) continue;
    const frameA = nodeA.mountFrameById.get(c.mountA);
    const frameB = nodeB.mountFrameById.get(c.mountB);
    if (!frameA || !frameB) continue;

    const siteA = uniqueName(`cl_${c.id}_a`);
    const siteB = uniqueName(`cl_${c.id}_b`);
    addSiteToNode(nodeA.path, siteA, frameA.positionMm);
    addSiteToNode(nodeB.path, siteB, frameB.positionMm);

    const worldMatA = neutralWorldByPath.get(nodeA.path)!;
    const worldMatB = neutralWorldByPath.get(nodeB.path)!;
    const worldPosA = new Vector3(...frameA.positionMm).applyMatrix4(worldMatA);
    const worldPosB = new Vector3(...frameB.positionMm).applyMatrix4(worldMatB);
    const restLengthM = Math.max(0.01, worldPosA.distanceTo(worldPosB) * 0.001);
    closureBindings.push({ closure: c, siteA, siteB, restLengthM });
  }

  let bodyCount = 0;
  let jointCount = 0;
  let totalMassKg = 0;
  const actuatorLines: string[] = [];
  const actuatorMeta: CompiledMujocoActuatorMeta[] = [];
  const equalityLines: string[] = [];
  const tendonLines: string[] = [];

  const arenaSpec = renderArenaWorldbodyXml(arena);
  // Site order matters: imported-physics reads `site:0` as the first `<site>` in the compiled MJCF!
  // For mobile vehicles we prioritize root chassis center or explicit output so trajectory points track cleanly;
  // notice `tcp_site` is placed at `flat.outputPath/flat.outputMount`.

  function emitBodyXml(node: FlatCompiledNode, indent: string): string {
    bodyCount++;
    const bodyName = bodyNameByPath.get(node.path)!;
    const localXform = localTransformByPath.get(node.path)!;
    const posStr = node.parentPath === null
      ? `${fmt(localXform.posM[0])} ${fmt(localXform.posM[1])} ${fmt(localXform.posM[2] + rootLiftM)}`
      : `${fmt(localXform.posM[0])} ${fmt(localXform.posM[1])} ${fmt(localXform.posM[2])}`;
    const quatStr = fmtQuatWxyz(localXform.quat);

    const lines: string[] = [];
    lines.push(`${indent}<body name="${escAttr(bodyName)}" pos="${posStr}" quat="${quatStr}">`);

    if (node.parentPath === null && baseMobility === "free") {
      jointCount++;
      lines.push(`${indent}  <freejoint name="chassis_free"/>`);
    }

    const jSpec = jointSpecByPath.get(node.path);
    if (jSpec) {
      jointCount++;
      const pj = jSpec.partJoint;
      const axVec = new Vector3(...pj.axis).normalize();
      const axStr = `${fmt(axVec.x)} ${fmt(axVec.y)} ${fmt(axVec.z)}`;
      if (pj.type === "slide") {
        const minM = pj.range[0] * 0.001;
        const maxM = pj.range[1] * 0.001;
        lines.push(`${indent}  <joint name="${escAttr(jSpec.mjName)}" type="slide" axis="${axStr}" range="${fmt(minM)} ${fmt(maxM)}" damping="32" armature="0.05"/>`);
        if (!jSpec.coupledTo && jSpec.mode !== "passive") {
          const actIdx = actuatorMeta.length;
          const actName = uniqueName(`act_${node.path}`);
          actuatorLines.push(
            `    <position name="${escAttr(actName)}" joint="${escAttr(jSpec.mjName)}" kp="1500" kv="78" ctrlrange="${fmt(minM)} ${fmt(maxM)}" forcerange="-90 90"/>`,
          );
          actuatorMeta.push({
            index: actIdx,
            name: actName,
            nodePath: node.path,
            label: node.label,
            mode: "actuated",
            unit: "m",
            range: [minM, maxM],
          });
        }
      } else if (jSpec.mode === "velocity") {
        lines.push(`${indent}  <joint name="${escAttr(jSpec.mjName)}" type="hinge" axis="${axStr}" damping="0.06" armature="0.004"/>`);
        if (!jSpec.coupledTo) {
          const actIdx = actuatorMeta.length;
          const actName = uniqueName(`vel_${node.path}`);
          actuatorLines.push(
            `    <velocity name="${escAttr(actName)}" joint="${escAttr(jSpec.mjName)}" kv="2.4" ctrlrange="-18 18" forcerange="-12 12"/>`,
          );
          actuatorMeta.push({
            index: actIdx,
            name: actName,
            nodePath: node.path,
            label: node.label,
            mode: "velocity",
            unit: "rad/s",
            range: [-18, 18],
          });
        }
      } else if (jSpec.mode === "passive") {
        const minR = (pj.range[0] * Math.PI) / 180;
        const maxR = (pj.range[1] * Math.PI) / 180;
        const limited = Math.abs(pj.range[1] - pj.range[0]) < 360;
        lines.push(
          limited
            ? `${indent}  <joint name="${escAttr(jSpec.mjName)}" type="hinge" axis="${axStr}" range="${fmt(minR)} ${fmt(maxR)}" damping="0.04" armature="0.002"/>`
            : `${indent}  <joint name="${escAttr(jSpec.mjName)}" type="hinge" axis="${axStr}" damping="0.04" armature="0.002"/>`,
        );
      } else {
        const minR = (pj.range[0] * Math.PI) / 180;
        const maxR = (pj.range[1] * Math.PI) / 180;
        lines.push(`${indent}  <joint name="${escAttr(jSpec.mjName)}" type="hinge" axis="${axStr}" range="${fmt(minR)} ${fmt(maxR)}" damping="1.8" armature="0.015"/>`);
        if (!jSpec.coupledTo) {
          const actIdx = actuatorMeta.length;
          const actName = uniqueName(`act_${node.path}`);
          actuatorLines.push(
            `    <position name="${escAttr(actName)}" joint="${escAttr(jSpec.mjName)}" kp="90" kv="5.8" ctrlrange="${fmt(minR)} ${fmt(maxR)}" forcerange="-45 45"/>`,
          );
          actuatorMeta.push({
            index: actIdx,
            name: actName,
            nodePath: node.path,
            label: node.label,
            mode: "actuated",
            unit: "rad",
            range: [minR, maxR],
          });
        }
      }

      // Wire coupledTo constraints as MuJoCo equality polynomials in SI units (m / rad)
      if (jSpec.coupledTo) {
        const masterSpec = jointSpecByPath.get(jSpec.coupledTo.path);
        if (masterSpec) {
          const toSiFactor = (j: Exclude<MechanicalPart["joint"], { type: "fixed" }>) =>
            j.type === "slide" ? 0.001 : Math.PI / 180;
          const slaveScale = toSiFactor(pj);
          const masterScale = toSiFactor(masterSpec.partJoint);
          // slave_native = ratio * master_native + offset  =>  slave_si = (ratio * slaveScale / masterScale) * master_si + offset * slaveScale
          const c1 = (jSpec.coupledTo.ratio * slaveScale) / masterScale;
          const c0 = (jSpec.coupledTo.offset ?? 0) * slaveScale;
          equalityLines.push(
            `    <joint joint1="${escAttr(jSpec.mjName)}" joint2="${escAttr(masterSpec.mjName)}" polycoef="${fmt(c0)} ${fmt(c1)} 0 0 0" solref="0.004 1"/>`,
          );
        }
      }
    }

    const partGeoms = buildPartGeoms(node.pkg);
    totalMassKg += partGeoms.totalMassKg;
    for (let gIdx = 0; gIdx < partGeoms.geoms.length; gIdx++) {
      const g = partGeoms.geoms[gIdx]!;
      const gName = uniqueName(`g_${node.path}_${gIdx}`);
      const contactAttrs = g.isHighGrip
        ? `contype="1" conaffinity="2" condim="4" friction="1.85 0.02 0.005" solref="0.004 1"`
        : `contype="1" conaffinity="2" condim="3" friction="0.8 0.008 0.002" solref="0.005 1"`;
      const sizeStr = g.sizeM.map(fmt).join(" ");
      lines.push(
        `${indent}  <geom name="${escAttr(gName)}" type="${g.kind}" pos="${fmt(g.posM[0])} ${fmt(g.posM[1])} ${fmt(g.posM[2])}" quat="${fmtQuatWxyz(g.quat)}" size="${sizeStr}" mass="${fmt(g.massKg)}" ${contactAttrs} rgba="${g.rgba}"/>`,
      );
    }

    // Emit TCP site on the assembly output node/mount
    if (node.path === flat.outputPath) {
      const outFrame = node.mountFrameById.get(flat.outputMount);
      const tcpMm: readonly [number, number, number] = outFrame?.positionMm ?? [0, 0, 0];
      lines.push(`${indent}  <site name="tcp_site" pos="${fmtVec3M(tcpMm)}"/>`);
    }

    for (const s of extraSitesByPath.get(node.path) ?? []) {
      lines.push(`${indent}  <site name="${escAttr(s.siteName)}" pos="${fmt(s.posM[0])} ${fmt(s.posM[1])} ${fmt(s.posM[2])}"/>`);
    }

    if (node.thruster) {
      const thrSiteName = uniqueName(`thr_site_${node.path}`);
      const thrActName = uniqueName(`thr_${node.path}`);
      const thrDir = new Vector3(...(node.thruster.direction ?? [0, 0, 1])).normalize();
      const thrQuat = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), thrDir);
      lines.push(`${indent}  <site name="${escAttr(thrSiteName)}" pos="0 0 0" quat="${fmtQuatWxyz(thrQuat)}"/>`);
      const actIdx = actuatorMeta.length;
      actuatorLines.push(
        `    <motor name="${escAttr(thrActName)}" site="${escAttr(thrSiteName)}" gear="0 0 1 0 0 0" ctrlrange="0 ${fmt(node.thruster.maxForceN)}"/>`,
      );
      actuatorMeta.push({
        index: actIdx,
        name: thrActName,
        nodePath: node.path,
        label: node.thruster.label?.trim() || `${node.label} · 推力`,
        mode: "thrust",
        unit: "N",
        range: [0, node.thruster.maxForceN],
      });
    }

    for (const child of childrenMap.get(node.path) ?? []) {
      lines.push(emitBodyXml(child, `${indent}  `));
    }

    lines.push(`${indent}</body>`);
    return lines.join("\n");
  }

  const machineBodyXml = emitBodyXml(rootNode, "    ");

  for (const { closure, siteA, siteB, restLengthM } of closureBindings) {
    const kind = closure.kind ?? "connect";
    if (kind === "weld") {
      equalityLines.push(`    <weld site1="${escAttr(siteA)}" site2="${escAttr(siteB)}" solref="0.004 1"/>`);
    } else if (kind === "spring") {
      const stiffness = closure.stiffnessNpm ?? 650;
      const damping = closure.dampingNsPm ?? 14;
      tendonLines.push(
        `    <spatial name="${escAttr(uniqueName(`spr_${closure.id}`))}" width="0.004" stiffness="${fmt(stiffness)}" damping="${fmt(damping)}" springlength="${fmt(restLengthM)}" rgba="0.38 0.85 0.74 0.9">`,
        `      <site site="${escAttr(siteA)}"/>`,
        `      <site site="${escAttr(siteB)}"/>`,
        `    </spatial>`,
      );
    } else {
      equalityLines.push(`    <connect site1="${escAttr(siteA)}" site2="${escAttr(siteB)}" solref="0.003 1"/>`);
    }
  }

  const sections: string[] = [
    `<mujoco model="${escAttr(assembly.name)}">`,
    `  <compiler angle="radian" autolimits="true"/>`,
    `  <option timestep="${fmt(timestepS)}" gravity="0 0 -9.81" integrator="implicitfast" iterations="60"/>`,
    `  <visual><global offwidth="1024" offheight="768"/></visual>`,
    `  <worldbody>`,
    `    <light pos="0.3 -0.4 1.2" dir="-0.2 0.3 -1" diffuse="0.9 0.9 0.9"/>`,
    arenaSpec.xml,
    machineBodyXml,
    `  </worldbody>`,
  ];

  if (tendonLines.length > 0) {
    sections.push(`  <tendon>\n${tendonLines.join("\n")}\n  </tendon>`);
  }
  if (equalityLines.length > 0) {
    sections.push(`  <equality>\n${equalityLines.join("\n")}\n  </equality>`);
  }
  if (actuatorLines.length > 0) {
    sections.push(`  <actuator>\n${actuatorLines.join("\n")}\n  </actuator>`);
  }
  sections.push(`</mujoco>`);

  const xml = sections.join("\n");
  const entry = `${sanitizeMjName(assembly.id)}.xml`;
  const bundle: ModelBundle = {
    entry,
    files: [{ path: entry, data: encodeUtf8.encode(xml) }],
  };

  // Determine site indices matching MuJoCo XML document order of <site> elements
  const siteNamesInOrder = [...xml.matchAll(/<site\s+name="([^"]+)"/g)].map((m) => m[1]!);
  const tcpSiteIndex = Math.max(0, siteNamesInOrder.indexOf("tcp_site"));
  const tcpSiteId = `site:${tcpSiteIndex}`;
  const payloadSiteIndex = arenaSpec.payloadSiteName
    ? siteNamesInOrder.indexOf(arenaSpec.payloadSiteName)
    : -1;
  const payloadSiteId = payloadSiteIndex >= 0 ? `site:${payloadSiteIndex}` : undefined;

  const recommendedRun = buildRecommendedRunSettings({
    assembly,
    arena,
    baseMobility,
    totalMassKg,
    actuatorMeta,
    tcpSiteId,
    payloadSiteId,
  });

  return {
    bundle,
    xml,
    stats: {
      bodyCount,
      jointCount,
      actuatorCount: actuatorMeta.length,
      equalityCount: equalityLines.length,
      tendonCount: closureBindings.filter((b) => b.closure.kind === "spring").length,
      totalMassKg: Number(totalMassKg.toFixed(3)),
      baseMobility,
      arena,
    },
    actuatorMeta,
    recommendedRun,
    payloadSiteId,
  };
}

function buildRecommendedRunSettings(args: {
  assembly: MechanicalAssembly;
  arena: ArenaPresetId;
  baseMobility: "fixed" | "free";
  totalMassKg: number;
  actuatorMeta: readonly CompiledMujocoActuatorMeta[];
  tcpSiteId: string;
  payloadSiteId?: string;
}): ImportedRunSettings {
  const { assembly, arena, baseMobility, totalMassKg, actuatorMeta, tcpSiteId, payloadSiteId } = args;
  const zeros = actuatorMeta.map(() => 0);
  const weightN = Math.max(0.5, totalMassKg * 9.81);
  const clampAct = (a: CompiledMujocoActuatorMeta, val: number) =>
    Number(Math.max(a.range[0], Math.min(a.range[1], val)).toFixed(4));

  if (actuatorMeta.length === 0) {
    return {
      durationS: 1.6,
      controls: [],
      pointId: tcpSiteId,
    };
  }

  // Case 0A: Coaxial Helicopter / Rotorcraft (thrusters + velocity rotors)
  const hasThrust = actuatorMeta.some((a) => a.mode === "thrust");
  const hasVelocity = actuatorMeta.some((a) => a.mode === "velocity");
  if (hasThrust && hasVelocity) {
    const spool = actuatorMeta.map((a) =>
      a.mode === "velocity" ? clampAct(a, 18) : a.mode === "thrust" ? clampAct(a, weightN * 0.45) : 0,
    );
    const takeoff = actuatorMeta.map((a) =>
      a.mode === "velocity"
        ? clampAct(a, 18)
        : a.mode === "thrust"
          ? clampAct(a, weightN * 1.4)
          : clampAct(a, 0.014),
    );
    const accel = actuatorMeta.map((a) =>
      a.mode === "velocity"
        ? clampAct(a, 18)
        : a.mode === "thrust"
          ? clampAct(a, weightN * 1.22)
          : clampAct(a, 0.024),
    );
    const cruise = actuatorMeta.map((a) =>
      a.mode === "velocity"
        ? clampAct(a, 18)
        : a.mode === "thrust"
          ? clampAct(a, weightN * 1.08)
          : clampAct(a, -0.024),
    );
    return {
      durationS: 2.15,
      controls: zeros,
      pointId: tcpSiteId,
      sequence: [
        { timeS: 0.35, controls: spool, label: "共轴旋翼反扭起转" },
        { timeS: 0.9, controls: takeoff, label: "总距拉升垂直起飞" },
        { timeS: 1.4, controls: accel, label: "前倾变距加速推进" },
        { timeS: 2.05, controls: cruise, label: "姿态改平空中巡航" },
      ],
    };
  }

  // Case 0B: TVC Vector-Thrust Rocket (thrusters + gimbal actuators)
  if (hasThrust) {
    const stage1 = actuatorMeta.map((a) => (a.mode === "thrust" ? clampAct(a, weightN * 1.55) : 0));
    const stage2 = actuatorMeta.map((a) =>
      a.mode === "thrust" ? clampAct(a, weightN * 1.50) : clampAct(a, 0.022),
    );
    const stage3 = actuatorMeta.map((a) =>
      a.mode === "thrust" ? clampAct(a, weightN * 1.45) : clampAct(a, -0.022),
    );
    const stage4 = actuatorMeta.map((a) => (a.mode === "thrust" ? clampAct(a, weightN * 1.28) : 0));
    return {
      durationS: 2.05,
      controls: zeros,
      pointId: tcpSiteId,
      sequence: [
        { timeS: 0.25, controls: stage1, label: "主发全推点火离台" },
        { timeS: 0.55, controls: stage2, label: "TVC 程序转弯偏移" },
        { timeS: 0.85, controls: stage3, label: "对称反向姿态修正" },
        { timeS: 1.95, controls: stage4, label: "稳定爬升与重力转弯" },
      ],
    };
  }

  // Case 1: Gripper arm on grasp pedestal -> lower Z, pinch inward, lift vertically
  const zIdx = actuatorMeta.findIndex((a) => /z|lift|升降/i.test(a.nodePath) || /升降/.test(a.label));
  const jawIdx = actuatorMeta.findIndex((a) => /jaw|grip|夹|指/i.test(a.nodePath) || /夹|指/.test(a.label));
  if (arena === "grasp_pedestal" && zIdx >= 0 && jawIdx >= 0) {
    const zMin = actuatorMeta[zIdx]!.range[0];
    const zMax = actuatorMeta[zIdx]!.range[1];
    const jawClose = actuatorMeta[jawIdx]!.range[1] * 0.72;
    const jawOpen = Math.max(actuatorMeta[jawIdx]!.range[0], 0);
    const approach = zeros.map((_, i) => (i === zIdx ? zMin * 0.84 : i === jawIdx ? jawOpen : 0));
    const clampCtrl = zeros.map((_, i) => (i === zIdx ? zMin * 0.84 : i === jawIdx ? jawClose : 0));
    const liftCtrl = zeros.map((_, i) => (i === zIdx ? zMax * 0.82 : i === jawIdx ? jawClose : 0));
    return {
      durationS: 2.2,
      controls: zeros,
      pointId: tcpSiteId,
      ...(payloadSiteId ? { referencePointId: payloadSiteId } : {}),
      sequence: [
        { timeS: 0.45, controls: approach, label: "下降对准物块" },
        { timeS: 0.95, controls: clampCtrl, label: "双指摩擦夹紧" },
        { timeS: 1.75, controls: liftCtrl, label: "垂直抬升搬运" },
      ],
    };
  }

  // Case 2: Wheeled mobile rover / free base -> ramp up wheel speed cleanly
  if (baseMobility === "free" && actuatorMeta.every((a) => a.mode === "velocity")) {
    const driveSpeed = 10.5;
    const driveCtrls = actuatorMeta.map(() => driveSpeed);
    return {
      durationS: 2.4,
      controls: driveCtrls,
      pointId: tcpSiteId,
      ...(payloadSiteId ? { referencePointId: payloadSiteId } : {}),
      sequence: [
        { timeS: 0.12, controls: actuatorMeta.map(() => 6.0), label: "四轮平稳落地起步" },
        { timeS: 1.8, controls: driveCtrls, label: arena === "flat_ramp" ? "全轮扭矩爬坡" : "全速越野推进" },
      ],
    };
  }

  // Case 2B: Multi-layer fixed rotating monument (e.g., Oriental Pearl Tower with 3 rotating tiers)
  const velCount = actuatorMeta.filter((a) => a.mode === "velocity").length;
  if (baseMobility === "fixed" && velCount >= 2) {
    const spinHarmonics = [2.4, -1.6, 3.0, -2.0];
    let velOrder = 0;
    const spinCtrls = actuatorMeta.map((a) => {
      if (a.mode !== "velocity") return 0;
      const spd = spinHarmonics[velOrder % spinHarmonics.length]!;
      velOrder++;
      return clampAct(a, spd);
    });
    return {
      durationS: 2.6,
      controls: spinCtrls,
      pointId: tcpSiteId,
      sequence: [
        { timeS: 0.25, controls: spinCtrls, label: "多级观光转盘平稳启动" },
        { timeS: 2.4, controls: spinCtrls, label: "观景环廊 / 旋转餐厅 / 太空舱同步运转" },
      ],
    };
  }

  // Case 3: Closed-chain linkage or rotating crank
  const hasVelocityCrank = actuatorMeta.some((a) => a.mode === "velocity");
  if (hasVelocityCrank) {
    const startCtrls = actuatorMeta.map((a) => (a.mode === "velocity" ? 4.8 : 0));
    return {
      durationS: 2.2,
      controls: startCtrls,
      pointId: tcpSiteId,
      sequence: [
        { timeS: 0.2, controls: startCtrls, label: "曲柄稳定匀速回转" },
        { timeS: 2.0, controls: startCtrls, label: "完整闭链周期扫描" },
      ],
    };
  }

  // Case 4: General multi-axis machine / robot arm -> synchronized mid-stroke exercise
  const midTarget = actuatorMeta.map((a) => {
    const cmd = assembly.commands[a.nodePath];
    if (cmd !== undefined) {
      const valSi = a.unit === "m" ? cmd * 0.001 : a.unit === "rad" ? (cmd * Math.PI) / 180 : cmd;
      if (Math.abs(valSi) > 1e-4) return Number(valSi.toFixed(4));
    }
    return Number((a.range[1] * 0.55).toFixed(4));
  });
  const oppTarget = actuatorMeta.map((a) => Number((a.range[0] * 0.45).toFixed(4)));
  return {
    durationS: 1.8,
    controls: zeros,
    pointId: tcpSiteId,
    ...(payloadSiteId ? { referencePointId: payloadSiteId } : {}),
    sequence: [
      { timeS: 0.75, controls: midTarget, label: "正向联动行程" },
      { timeS: 1.5, controls: oppTarget, label: "反向回程校核" },
    ],
  };
}
