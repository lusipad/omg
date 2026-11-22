import { Matrix4, Quaternion, Vector3 } from "three";
import { inspectMechanicalAssembly, type MechanicalAssembly, type MechanicalFrame, type MechanicalPart } from "./mechanical-assembly";
import { primitiveBoundingBoxMm } from "./primitive-parts";
import type { RuntimeTrace, TwinSystemAssembly } from "./system-twin";
import { buildPrimitivePartPackage, packageKey, type DevicePackage } from "./twin-device";
import { installPackage, parseWorkspace, type TwinWorkspace } from "./twin-simulation";

export interface ArticulatedLeaderLine {
  readonly nodePath: string;
  readonly fromMm: readonly [number, number, number];
  readonly toMm: readonly [number, number, number];
}

export interface SolvedArticulatedNode {
  readonly path: string;
  readonly id: string;
  readonly label: string;
  readonly parentPath: string | null;
  readonly packageKey: string;
  readonly pkg?: DevicePackage;
  readonly depth: number;
  readonly explodeStep: number;
  readonly assembledMatrix: Matrix4;
  readonly explodedMatrix: Matrix4;
  readonly assembledPosMm: readonly [number, number, number];
  readonly explodedPosMm: readonly [number, number, number];
  readonly explodeDeltaMm: readonly [number, number, number];
  readonly joint: MechanicalPart["joint"];
  readonly activeValue: number;
  readonly coupledTo?: NonNullable<MechanicalAssembly["nodes"][number]["coupledTo"]>;
}

export interface ArticulatedControlSpec {
  readonly path: string;
  readonly label: string;
  readonly joint: Exclude<MechanicalPart["joint"], { type: "fixed" }>;
  readonly value: number;
  readonly isCoupled: boolean;
  readonly coupledSummary?: string;
}

export interface ArticulatedSolveResult {
  readonly nodes: readonly SolvedArticulatedNode[];
  readonly activeControls: readonly ArticulatedControlSpec[];
  readonly coupledControls: readonly ArticulatedControlSpec[];
  readonly leaderLines: readonly ArticulatedLeaderLine[];
  readonly observationPointMm: readonly [number, number, number];
  readonly explodedObservationPointMm: readonly [number, number, number];
  readonly issues: readonly string[];
}

const IDENTITY_QUAT: [number, number, number, number] = [1, 0, 0, 0];
const ONE_SCALE = new Vector3(1, 1, 1);

function clamp(v: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, v));
}

function normalizedVector(xyz: readonly [number, number, number], fallback: readonly [number, number, number] = [0, 0, 1]): Vector3 {
  const v = new Vector3(xyz[0], xyz[1], xyz[2]);
  if (v.lengthSq() <= 1e-9) {
    return new Vector3(fallback[0], fallback[1], fallback[2]).normalize();
  }
  return v.normalize();
}

export function frameToMatrixMm(frame: MechanicalFrame): Matrix4 {
  const [w, x, y, z] = frame.quatWxyz;
  const norm = Math.hypot(w, x, y, z) || 1;
  return new Matrix4().compose(
    new Vector3(frame.positionMm[0], frame.positionMm[1], frame.positionMm[2]),
    new Quaternion(x / norm, y / norm, z / norm, w / norm).normalize(),
    ONE_SCALE,
  );
}

function matrixPosMm(matrix: Matrix4): [number, number, number] {
  const p = new Vector3().setFromMatrixPosition(matrix);
  return [p.x, p.y, p.z];
}

function jointLocalTransform(joint: MechanicalPart["joint"], value: number): Matrix4 {
  if (joint.type === "fixed") return new Matrix4();
  const axis = normalizedVector(joint.axis);
  if (joint.type === "hinge") {
    return new Matrix4().makeRotationAxis(axis, (value * Math.PI) / 180);
  }
  return new Matrix4().makeTranslation(axis.x * value, axis.y * value, axis.z * value);
}

function partNominalSpanMm(pkg?: DevicePackage): number {
  if (!pkg) return 60;
  if (pkg.primitive) {
    const [dx, dy, dz] = primitiveBoundingBoxMm(pkg.primitive);
    return Math.max(dx, dy, dz, 30);
  }
  if (pkg.mechanics?.kind === "part") {
    const spans = [
      Math.hypot(...pkg.mechanics.input.positionMm),
      ...pkg.mechanics.outputs.map((o) => Math.hypot(...o.positionMm)),
    ];
    return Math.max(40, ...spans);
  }
  return 60;
}

function defaultExplodeStepVectorMm(
  parentMount: MechanicalFrame | undefined,
  part: MechanicalPart,
  parentPkg: DevicePackage | undefined,
  childPkg: DevicePackage | undefined,
): Vector3 {
  const scaleMm = 0.28 * Math.min(280, Math.max(partNominalSpanMm(parentPkg), partNominalSpanMm(childPkg))) + 48;
  if (parentMount && Math.hypot(...parentMount.positionMm) > 2) {
    return normalizedVector(parentMount.positionMm).multiplyScalar(scaleMm);
  }
  if (part.joint.type !== "fixed") {
    return normalizedVector(part.joint.axis).multiplyScalar(scaleMm);
  }
  return new Vector3(0, 0, scaleMm);
}

/**
 * 求解多分支可动装配的正运动学与层级三维爆炸视图位姿（全部使用 Z-up 毫米坐标系）。
 */
export function solveArticulatedAssembly(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  options?: {
    commandOverrides?: Record<string, number>;
    explodeFactor?: number;
    explodeSubtreeRoot?: string;
  },
): ArticulatedSolveResult {
  const issues = inspectMechanicalAssembly(ws, assembly);
  const catalog = new Map<string, DevicePackage>(ws.packages.map((p) => [packageKey(p), p]));
  const explodeFactor = clamp(options?.explodeFactor ?? 0, 0, 1);
  const subtreeRoot = options?.explodeSubtreeRoot?.trim() || undefined;

  type ExpandedRaw = {
    path: string;
    id: string;
    label: string;
    parentPath: string | null;
    parentMountId: string | null;
    packageKey: string;
    pkg?: DevicePackage;
    part: MechanicalPart;
    depth: number;
    explodeStep: number;
    explicitExplodeVec?: readonly [number, number, number];
    coupledTo?: MechanicalAssembly["nodes"][number]["coupledTo"];
    mountById: Map<string, Matrix4>;
    mountFrameById: Map<string, MechanicalFrame>;
    baseValue: number;
  };

  const expandedList: ExpandedRaw[] = [];
  const rawByPath = new Map<string, ExpandedRaw>();

  function expandLevel(
    def: MechanicalAssembly,
    prefix: string,
    graftPath: string | null,
    graftMountId: string | null,
    depthOffset: number,
  ): { outputPath: string; outputMount: string } | undefined {
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    const ordered: MechanicalAssembly["nodes"] = [];
    const visited = new Set<string>();
    const enqueue = (node: MechanicalAssembly["nodes"][number]) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      ordered.push(node);
    };
    const roots = def.nodes.filter((n) => !n.parent);
    roots.forEach(enqueue);
    for (let i = 0; i < ordered.length; i++) {
      for (const child of def.nodes) {
        if (child.parent?.node === ordered[i].id) enqueue(child);
      }
    }
    for (const node of def.nodes) enqueue(node);

    const localOutputRef = new Map<string, { path: string; mount: string }>();

    for (const node of ordered) {
      const path = prefix ? `${prefix}/${node.id}` : node.id;
      const pkg = catalog.get(node.packageKey);
      const mechanics = pkg?.mechanics;

      const resolvedParent = node.parent
        ? localOutputRef.get(node.parent.node)
          ? { path: localOutputRef.get(node.parent.node)!.path, mountId: localOutputRef.get(node.parent.node)!.mount }
          : { path: prefix ? `${prefix}/${node.parent.node}` : node.parent.node, mountId: node.parent.mount }
        : graftPath && graftMountId
          ? { path: graftPath, mountId: graftMountId }
          : null;

      if (mechanics?.kind === "assembly") {
        const sub = expandLevel(mechanics.assembly, path, resolvedParent?.path ?? null, resolvedParent?.mountId ?? null, depthOffset + 1);
        if (sub) localOutputRef.set(node.id, { path: sub.outputPath, mount: sub.outputMount });
        continue;
      }

      const fallbackPart: MechanicalPart = {
        kind: "part",
        input: { positionMm: [0, 0, 0], quatWxyz: IDENTITY_QUAT },
        joint: { type: "fixed" },
        outputs: [{ id: "out", positionMm: [0, 0, 0], quatWxyz: IDENTITY_QUAT }],
      };
      const part = mechanics?.kind === "part" ? mechanics : fallbackPart;
      const mountById = new Map<string, Matrix4>();
      const mountFrameById = new Map<string, MechanicalFrame>();
      for (const out of part.outputs) {
        mountById.set(out.id, frameToMatrixMm(out));
        mountFrameById.set(out.id, out);
      }

      const parentEntry = resolvedParent ? rawByPath.get(resolvedParent.path) : undefined;
      const depth = parentEntry ? parentEntry.depth + 1 : depthOffset;
      const defaultZero =
        part.joint.type === "fixed" ? 0 : clamp(0, part.joint.range[0], part.joint.range[1]);
      const cmdRaw = options?.commandOverrides?.[path] ?? def.commands[path] ?? defaultZero;
      const clampedValue =
        part.joint.type === "fixed" ? 0 : clamp(cmdRaw, part.joint.range[0], part.joint.range[1]);

      const entry: ExpandedRaw = {
        path,
        id: node.id,
        label: node.label?.trim() || (pkg ? `${pkg.model}` : node.id),
        parentPath: resolvedParent?.path ?? null,
        parentMountId: resolvedParent?.mountId ?? null,
        packageKey: node.packageKey,
        pkg,
        part,
        depth,
        explodeStep: node.explodeStep ?? depth,
        explicitExplodeVec: node.explodeVectorMm,
        coupledTo: node.coupledTo
          ? {
              ...node.coupledTo,
              path: prefix ? `${prefix}/${node.coupledTo.path}` : node.coupledTo.path,
            }
          : undefined,
        mountById,
        mountFrameById,
        baseValue: clampedValue,
      };
      expandedList.push(entry);
      rawByPath.set(path, entry);
      if (byId.has(node.id)) localOutputRef.set(node.id, { path, mount: part.outputs[0]?.id ?? "out" });
    }

    const outTarget = localOutputRef.get(def.output.node);
    const outPath = outTarget?.path ?? (prefix ? `${prefix}/${def.output.node}` : def.output.node);
    return { outputPath: outPath, outputMount: def.output.mount };
  }

  const rootOutput = expandLevel(assembly, "", null, null, 0);

  // 两遍解析主动与耦合从动关节值
  const activeValueByPath = new Map<string, number>();
  for (const item of expandedList) {
    if (!item.coupledTo) {
      activeValueByPath.set(item.path, item.baseValue);
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const item of expandedList) {
      if (!item.coupledTo) continue;
      if (item.part.joint.type === "fixed") {
        activeValueByPath.set(item.path, 0);
        continue;
      }
      const override = options?.commandOverrides?.[item.path];
      if (override !== undefined) {
        activeValueByPath.set(item.path, clamp(override, item.part.joint.range[0], item.part.joint.range[1]));
        continue;
      }
      const masterVal = activeValueByPath.get(item.coupledTo.path) ?? 0;
      const computed = masterVal * item.coupledTo.ratio + (item.coupledTo.offset ?? 0);
      activeValueByPath.set(item.path, clamp(computed, item.part.joint.range[0], item.part.joint.range[1]));
    }
  }

  const scopePaths = new Set<string>();
  if (subtreeRoot) {
    for (const item of expandedList) {
      if (
        item.path === subtreeRoot
        || item.path.startsWith(`${subtreeRoot}/`)
        || (item.parentPath !== null && scopePaths.has(item.parentPath))
      ) {
        scopePaths.add(item.path);
      }
    }
  }

  const solvedByPath = new Map<string, SolvedArticulatedNode>();
  const solvedNodes: SolvedArticulatedNode[] = [];
  const activeControls: ArticulatedControlSpec[] = [];
  const coupledControls: ArticulatedControlSpec[] = [];
  const leaderLines: ArticulatedLeaderLine[] = [];

  for (const item of expandedList) {
    const activeValue = activeValueByPath.get(item.path) ?? 0;
    const parentSolved = item.parentPath ? solvedByPath.get(item.parentPath) : undefined;
    const parentRaw = item.parentPath ? rawByPath.get(item.parentPath) : undefined;
    const mountMatrix =
      parentRaw && item.parentMountId
        ? (parentRaw.mountById.get(item.parentMountId) ?? new Matrix4())
        : new Matrix4();
    const mountFrame =
      parentRaw && item.parentMountId ? parentRaw.mountFrameById.get(item.parentMountId) : undefined;

    const parentAssembled = parentSolved ? parentSolved.assembledMatrix : new Matrix4();
    const mountWorldAssembled = parentAssembled.clone().multiply(mountMatrix);
    const inputInv = frameToMatrixMm(item.part.input).invert();
    const neutral = mountWorldAssembled.clone().multiply(inputInv);
    const assembledMatrix = neutral.clone().multiply(jointLocalTransform(item.part.joint, activeValue));

    const inScope = !subtreeRoot || scopePaths.has(item.path);
    const parentDelta = parentSolved
      ? new Vector3(parentSolved.explodeDeltaMm[0], parentSolved.explodeDeltaMm[1], parentSolved.explodeDeltaMm[2])
      : new Vector3();

    let stepDeltaWorld = new Vector3();
    if (explodeFactor > 0 && parentSolved && inScope) {
      const parentQuat = new Quaternion().setFromRotationMatrix(parentAssembled).normalize();
      const localStep = item.explicitExplodeVec
        ? new Vector3(item.explicitExplodeVec[0], item.explicitExplodeVec[1], item.explicitExplodeVec[2])
        : defaultExplodeStepVectorMm(mountFrame, item.part, parentRaw?.pkg, item.pkg);
      stepDeltaWorld = localStep.applyQuaternion(parentQuat).multiplyScalar(explodeFactor);
    }

    const totalDelta = parentDelta.clone().add(stepDeltaWorld);
    const explodedMatrix = assembledMatrix.clone();
    const assembledPos = new Vector3().setFromMatrixPosition(assembledMatrix);
    const explodedPos = assembledPos.clone().add(totalDelta);
    explodedMatrix.setPosition(explodedPos);

    if (explodeFactor > 0 && parentSolved && inScope && stepDeltaWorld.length() > 0.5) {
      const baseAnchor = new Vector3().setFromMatrixPosition(mountWorldAssembled);
      const fromPos = baseAnchor.clone().add(parentDelta);
      const toPos = baseAnchor.clone().add(totalDelta);
      leaderLines.push({
        nodePath: item.path,
        fromMm: [fromPos.x, fromPos.y, fromPos.z],
        toMm: [toPos.x, toPos.y, toPos.z],
      });
    }

    const solved: SolvedArticulatedNode = {
      path: item.path,
      id: item.id,
      label: item.label,
      parentPath: item.parentPath,
      packageKey: item.packageKey,
      pkg: item.pkg,
      depth: item.depth,
      explodeStep: item.explodeStep,
      assembledMatrix,
      explodedMatrix,
      assembledPosMm: matrixPosMm(assembledMatrix),
      explodedPosMm: matrixPosMm(explodedMatrix),
      explodeDeltaMm: [totalDelta.x, totalDelta.y, totalDelta.z],
      joint: item.part.joint,
      activeValue,
      coupledTo: item.coupledTo,
    };
    solvedNodes.push(solved);
    solvedByPath.set(item.path, solved);

    if (item.part.joint.type !== "fixed") {
      if (item.coupledTo) {
        const masterLabel = rawByPath.get(item.coupledTo.path)?.label ?? item.coupledTo.path;
        coupledControls.push({
          path: item.path,
          label: item.label,
          joint: item.part.joint,
          value: activeValue,
          isCoupled: true,
          coupledSummary: `随「${masterLabel}」×${item.coupledTo.ratio}`,
        });
      } else {
        activeControls.push({
          path: item.path,
          label: item.label,
          joint: item.part.joint,
          value: activeValue,
          isCoupled: false,
        });
      }
    }
  }

  let observationPointMm: [number, number, number] = [0, 0, 0];
  let explodedObservationPointMm: [number, number, number] = [0, 0, 0];
  if (rootOutput) {
    const outSolved = solvedByPath.get(rootOutput.outputPath);
    const outRaw = rawByPath.get(rootOutput.outputPath);
    if (outSolved && outRaw) {
      const mountMat = outRaw.mountById.get(rootOutput.outputMount) ?? new Matrix4();
      observationPointMm = matrixPosMm(outSolved.assembledMatrix.clone().multiply(mountMat));
      explodedObservationPointMm = matrixPosMm(outSolved.explodedMatrix.clone().multiply(mountMat));
    }
  }

  return {
    nodes: solvedNodes,
    activeControls,
    coupledControls,
    leaderLines,
    observationPointMm,
    explodedObservationPointMm,
    issues,
  };
}

/**
 * 将机电控闭环仿真单帧位置映射到机械装配中的移动关节指令（coupledTo 丝杠等自动随动旋转）。
 */
export function mapSystemTraceFrameToCommands(
  assembly: MechanicalAssembly,
  frame: RuntimeTrace["frames"][number] | undefined,
): Record<string, number> {
  const axisEntries = frame?.axes ? Object.entries(frame.axes) : [];
  if (!axisEntries.length) return {};
  const out: Record<string, number> = {};
  const movableCandidates = assembly.nodes.filter((n) => !n.coupledTo);

  for (let i = 0; i < axisEntries.length; i++) {
    const [axisKey, ax] = axisEntries[i]!;
    const axisTag = axisKey.toLowerCase();
    const matched =
      movableCandidates.find((n) => n.id.toLowerCase() === axisTag || n.id.toLowerCase().includes(axisTag))
      ?? movableCandidates[i];
    if (matched) {
      out[matched.id] = ax.positionMm;
    }
  }
  return out;
}

const Q_ID: [number, number, number, number] = [1, 0, 0, 0];

/**
 * 用 100% 标准化基本几何体与工业参数化基元拼出一台三轴立式铣床样板（可多轴实时联动 + 层级三维爆炸视图）。
 */
export function buildComposableMiloMillTemplate(): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const pkgCenterBeam = buildPrimitivePartPackage({
    model: "2080铝型材床身中梁",
    revision: "P1",
    title: "2080铝型材床身中梁（560 mm）",
    primitive: { shape: "extrusion_profile", series: "2080", lengthMm: 560, axis: "y", finish: "anodized_black" },
    extraOutputs: [
      { id: "left_beam_mount", positionMm: [-115, 0, 10], quatWxyz: Q_ID },
      { id: "right_beam_mount", positionMm: [115, 0, 10], quatWxyz: Q_ID },
      { id: "front_plate_mount", positionMm: [0, -287, 10], quatWxyz: Q_ID },
      { id: "rear_plate_mount", positionMm: [0, 287, 10], quatWxyz: Q_ID },
      { id: "y_rail_mount", positionMm: [0, -10, 10], quatWxyz: Q_ID },
      { id: "y_screw_mount", positionMm: [50, -10, 22], quatWxyz: Q_ID },
      { id: "y_motor_mount", positionMm: [50, -326, 22], quatWxyz: Q_ID },
      { id: "column_mount", positionMm: [0, 250, 220], quatWxyz: Q_ID },
      { id: "left_gusset_mount", positionMm: [-56, 210, 20], quatWxyz: Q_ID },
      { id: "right_gusset_mount", positionMm: [56, 210, 20], quatWxyz: Q_ID },
    ],
  });

  const pkgSideBeam = buildPrimitivePartPackage({
    model: "2040铝型材床身纵梁",
    revision: "P1",
    title: "2040铝型材床身纵梁（560 mm）",
    primitive: { shape: "extrusion_profile", series: "2040", lengthMm: 560, axis: "y", finish: "anodized_black" },
  });

  const pkgEndPlate = buildPrimitivePartPackage({
    model: "底座端封板",
    revision: "P1",
    title: "底座前后连接封板（260×14×44 mm）",
    primitive: { shape: "box", widthMm: 260, depthMm: 14, heightMm: 44, finish: "steel" },
  });

  const pkgYRail = buildPrimitivePartPackage({
    model: "Y轴直线导轨滑块副",
    revision: "P1",
    title: "Y轴直线导轨与加长滑块（460 mm）",
    primitive: {
      shape: "linear_rail_block",
      railLengthMm: 460,
      railWidthMm: 15,
      blockLengthMm: 62,
      blockWidthMm: 46,
      heightMm: 22,
      axis: "y",
      finish: "steel",
    },
    input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
  });

  const pkgYSaddle = buildPrimitivePartPackage({
    model: "Y轴鞍座基板",
    revision: "P1",
    title: "Y轴十字滑台鞍座板（240×170×14 mm）",
    primitive: { shape: "plate", widthMm: 240, depthMm: 170, thicknessMm: 14, finish: "aluminum" },
    input: { positionMm: [0, 0, -7], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 1, 0], unit: "mm", range: [-100, 100] },
    extraOutputs: [
      { id: "x_rail_mount", positionMm: [0, 0, 7], quatWxyz: Q_ID },
      { id: "x_screw_mount", positionMm: [0, -48, 18], quatWxyz: Q_ID },
      { id: "x_motor_mount", positionMm: [188, -48, 18], quatWxyz: Q_ID },
    ],
  });

  const pkgYScrew = buildPrimitivePartPackage({
    model: "Y轴滚珠丝杠SFU1208",
    revision: "P1",
    title: "Y轴滚珠丝杠（Ø12 · 导程 8 mm/rev）",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 480, leadMm: 8, axis: "y", finish: "steel" },
    joint: { type: "hinge", axis: [0, 1, 0], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgYMotor = buildPrimitivePartPackage({
    model: "NEMA23伺服电机-Y",
    revision: "P1",
    title: "Y轴闭环步进/伺服电机（400W）",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 62, shaftDiameterMm: 8, shaftLengthMm: 22, axis: "y", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgXRail = buildPrimitivePartPackage({
    model: "X轴直线导轨滑块副",
    revision: "P1",
    title: "X轴直线导轨与滑块（280 mm）",
    primitive: {
      shape: "linear_rail_block",
      railLengthMm: 280,
      railWidthMm: 15,
      blockLengthMm: 58,
      blockWidthMm: 42,
      heightMm: 20,
      axis: "x",
      finish: "steel",
    },
    input: { positionMm: [0, 0, -10], quatWxyz: Q_ID },
  });

  const pkgXTable = buildPrimitivePartPackage({
    model: "X轴开槽工作台板",
    revision: "P1",
    title: "X轴铝制开槽工作台面（300×150×16 mm）",
    primitive: { shape: "plate", widthMm: 300, depthMm: 150, thicknessMm: 16, holeDiameterMm: 8, holeInsetMm: 16, finish: "aluminum" },
    input: { positionMm: [0, 0, -8], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-120, 120] },
    behavior: { kind: "moving_table", massKg: 6.5 },
  });

  const pkgXScrew = buildPrimitivePartPackage({
    model: "X轴滚珠丝杠SFU1208",
    revision: "P1",
    title: "X轴滚珠丝杠（Ø12 · 导程 8 mm/rev）",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 290, leadMm: 8, axis: "x", finish: "steel" },
    joint: { type: "hinge", axis: [1, 0, 0], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgXMotor = buildPrimitivePartPackage({
    model: "NEMA23伺服电机-X",
    revision: "P1",
    title: "X轴伺服电机（400W）",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 58, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgWorkpiece = buildPrimitivePartPackage({
    model: "铝合金测试毛坯块",
    revision: "P1",
    title: "6061铝合金铣削毛坯（110×90×26 mm）",
    primitive: { shape: "box", widthMm: 110, depthMm: 90, heightMm: 26, finish: "workpiece_alloy" },
    input: { positionMm: [0, 0, -13], quatWxyz: Q_ID },
  });

  const pkgColumn = buildPrimitivePartPackage({
    model: "4080重型立柱型材",
    revision: "P1",
    title: "4080重型铝型材立柱（420 mm）",
    primitive: { shape: "extrusion_profile", series: "4080", lengthMm: 420, axis: "z", finish: "anodized_black" },
    extraOutputs: [
      { id: "z_rail_mount", positionMm: [0, -20, 30], quatWxyz: Q_ID },
      { id: "z_screw_mount", positionMm: [50, -34, 30], quatWxyz: Q_ID },
      { id: "z_motor_mount", positionMm: [0, -34, 240], quatWxyz: Q_ID },
    ],
  });

  const pkgGusset = buildPrimitivePartPackage({
    model: "立柱L型加强角件",
    revision: "P1",
    title: "立柱 L 型铸铝加强角件（28×75×95 mm）",
    primitive: { shape: "angle_bracket", widthMm: 28, legAMm: 75, legBMm: 95, thicknessMm: 10, finish: "steel" },
    input: { positionMm: [0, 0, -47.5], quatWxyz: Q_ID },
  });

  const pkgZRail = buildPrimitivePartPackage({
    model: "Z轴重型线性导轨副",
    revision: "P1",
    title: "Z轴直线导轨与滑块（300 mm）",
    primitive: {
      shape: "linear_rail_block",
      railLengthMm: 300,
      railWidthMm: 15,
      blockLengthMm: 64,
      blockWidthMm: 46,
      heightMm: 22,
      axis: "z",
      finish: "steel",
    },
    input: { positionMm: [0, 11, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "carriage_front", positionMm: [0, -11, 0], quatWxyz: Q_ID }],
  });

  const pkgZCarriage = buildPrimitivePartPackage({
    model: "Z轴垂直滑板",
    revision: "P1",
    title: "Z轴主轴滑板（110×16×140 mm）",
    primitive: { shape: "box", widthMm: 110, depthMm: 16, heightMm: 140, finish: "aluminum" },
    input: { positionMm: [0, 8, 0], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [0, 0, 1], unit: "mm", range: [-95, 55] },
    extraOutputs: [{ id: "arm_mount", positionMm: [0, -8, 0], quatWxyz: Q_ID }],
  });

  const pkgZScrew = buildPrimitivePartPackage({
    model: "Z轴滚珠丝杠SFU1208",
    revision: "P1",
    title: "Z轴滚珠丝杠（Ø12 · 导程 8 mm/rev）",
    primitive: { shape: "lead_screw", diameterMm: 12, lengthMm: 300, leadMm: 8, axis: "z", finish: "steel" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-18000, 18000] },
    behavior: { kind: "lead_screw", leadMmPerRev: 8 },
  });

  const pkgZMotor = buildPrimitivePartPackage({
    model: "NEMA23伺服电机-Z",
    revision: "P1",
    title: "Z轴伺服电机（400W）",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 58, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "z", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgSpindleArm = buildPrimitivePartPackage({
    model: "悬臂主轴箱体",
    revision: "P1",
    title: "主轴悬臂支撑箱（92×220×56 mm）",
    primitive: { shape: "box", widthMm: 92, depthMm: 220, heightMm: 56, finish: "spindle_red" },
    input: { positionMm: [0, 110, 0], quatWxyz: Q_ID },
    extraOutputs: [{ id: "spindle_clamp", positionMm: [0, -110, 0], quatWxyz: Q_ID }],
  });

  const pkgSpindleCutter = buildPrimitivePartPackage({
    model: "ER16电主轴与Ø10立铣刀",
    revision: "P1",
    title: "高频电主轴与Ø10平底立铣刀",
    primitive: { shape: "spindle_cutter", bodyDiameterMm: 62, bodyLengthMm: 135, toolDiameterMm: 10, toolStickoutMm: 38, finish: "spindle_red" },
    joint: { type: "hinge", axis: [0, 0, 1], unit: "deg", range: [-36000, 36000] },
  });

  const allPkgs = [
    pkgCenterBeam,
    pkgSideBeam,
    pkgEndPlate,
    pkgYRail,
    pkgYSaddle,
    pkgYScrew,
    pkgYMotor,
    pkgXRail,
    pkgXTable,
    pkgXScrew,
    pkgXMotor,
    pkgWorkpiece,
    pkgColumn,
    pkgGusset,
    pkgZRail,
    pkgZCarriage,
    pkgZScrew,
    pkgZMotor,
    pkgSpindleArm,
    pkgSpindleCutter,
  ];

  const assembly: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: "composable-milo-mill",
    name: "拼装式三轴立式铣床（基本件·可动·爆炸图）",
    nodes: [
      { id: "base_center", label: "床身中梁 2080", packageKey: packageKey(pkgCenterBeam), parent: null, explodeStep: 0 },
      { id: "base_left", label: "左侧纵梁 2040", packageKey: packageKey(pkgSideBeam), parent: { node: "base_center", mount: "left_beam_mount" }, explodeStep: 1, explodeVectorMm: [-95, 0, 0] },
      { id: "base_right", label: "右侧纵梁 2040", packageKey: packageKey(pkgSideBeam), parent: { node: "base_center", mount: "right_beam_mount" }, explodeStep: 1, explodeVectorMm: [95, 0, 0] },
      { id: "base_front_plate", label: "前底座端板", packageKey: packageKey(pkgEndPlate), parent: { node: "base_center", mount: "front_plate_mount" }, explodeStep: 1, explodeVectorMm: [0, -90, 0] },
      { id: "base_rear_plate", label: "后底座端板", packageKey: packageKey(pkgEndPlate), parent: { node: "base_center", mount: "rear_plate_mount" }, explodeStep: 1, explodeVectorMm: [0, 95, 0] },

      { id: "y_rail", label: "Y 轴线性导轨", packageKey: packageKey(pkgYRail), parent: { node: "base_center", mount: "y_rail_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 55] },
      { id: "y_screw", label: "Y 轴滚珠丝杠", packageKey: packageKey(pkgYScrew), parent: { node: "base_center", mount: "y_screw_mount" }, explodeStep: 1, explodeVectorMm: [65, 0, 45], coupledTo: { path: "y_saddle", ratio: 45 } },
      { id: "y_motor", label: "Y 轴伺服电机", packageKey: packageKey(pkgYMotor), parent: { node: "base_center", mount: "y_motor_mount" }, explodeStep: 2, explodeVectorMm: [0, -85, 0] },
      { id: "y_saddle", label: "Y 轴移动鞍座", packageKey: packageKey(pkgYSaddle), parent: { node: "y_rail", mount: "carriage_top" }, explodeStep: 2, explodeVectorMm: [0, 0, 65] },

      { id: "x_rail", label: "X 轴线性导轨", packageKey: packageKey(pkgXRail), parent: { node: "y_saddle", mount: "x_rail_mount" }, explodeStep: 3, explodeVectorMm: [0, 0, 55] },
      { id: "x_screw", label: "X 轴滚珠丝杠", packageKey: packageKey(pkgXScrew), parent: { node: "y_saddle", mount: "x_screw_mount" }, explodeStep: 3, explodeVectorMm: [0, -70, 35], coupledTo: { path: "x_table", ratio: 45 } },
      { id: "x_motor", label: "X 轴伺服电机", packageKey: packageKey(pkgXMotor), parent: { node: "y_saddle", mount: "x_motor_mount" }, explodeStep: 3, explodeVectorMm: [90, 0, 0] },
      { id: "x_table", label: "X 轴开槽工作台", packageKey: packageKey(pkgXTable), parent: { node: "x_rail", mount: "carriage_top" }, explodeStep: 4, explodeVectorMm: [0, 0, 75] },
      { id: "workpiece", label: "铝合金待铣毛坯", packageKey: packageKey(pkgWorkpiece), parent: { node: "x_table", mount: "top" }, explodeStep: 5, explodeVectorMm: [0, 0, 85] },

      { id: "column_pillar", label: "后置重型立柱 4080", packageKey: packageKey(pkgColumn), parent: { node: "base_center", mount: "column_mount" }, explodeStep: 1, explodeVectorMm: [0, 80, 90] },
      { id: "left_gusset", label: "立柱左加强角件", packageKey: packageKey(pkgGusset), parent: { node: "base_center", mount: "left_gusset_mount" }, explodeStep: 1, explodeVectorMm: [-70, 0, 45] },
      { id: "right_gusset", label: "立柱右加强角件", packageKey: packageKey(pkgGusset), parent: { node: "base_center", mount: "right_gusset_mount" }, explodeStep: 1, explodeVectorMm: [70, 0, 45] },

      { id: "z_rail", label: "Z 轴线性导轨", packageKey: packageKey(pkgZRail), parent: { node: "column_pillar", mount: "z_rail_mount" }, explodeStep: 2, explodeVectorMm: [0, -65, 0] },
      { id: "z_screw", label: "Z 轴滚珠丝杠", packageKey: packageKey(pkgZScrew), parent: { node: "column_pillar", mount: "z_screw_mount" }, explodeStep: 2, explodeVectorMm: [65, -55, 0], coupledTo: { path: "z_carriage", ratio: 45 } },
      { id: "z_motor", label: "Z 轴伺服电机", packageKey: packageKey(pkgZMotor), parent: { node: "column_pillar", mount: "z_motor_mount" }, explodeStep: 3, explodeVectorMm: [0, 0, 85] },
      { id: "z_carriage", label: "Z 轴升降滑板", packageKey: packageKey(pkgZCarriage), parent: { node: "z_rail", mount: "carriage_front" }, explodeStep: 3, explodeVectorMm: [0, -75, 0] },
      { id: "spindle_arm", label: "悬臂主轴箱体", packageKey: packageKey(pkgSpindleArm), parent: { node: "z_carriage", mount: "arm_mount" }, explodeStep: 4, explodeVectorMm: [0, -85, 0] },
      { id: "spindle_unit", label: "电主轴与立铣刀", packageKey: packageKey(pkgSpindleCutter), parent: { node: "spindle_arm", mount: "spindle_clamp" }, explodeStep: 5, explodeVectorMm: [0, -60, -65] },
    ],
    output: { node: "spindle_unit", mount: "tool_tip" },
    commands: {
      x_table: 0,
      y_saddle: 0,
      z_carriage: 0,
      spindle_unit: 0,
    },
  };

  let workspace = parseWorkspace({ schemaVersion: 1, packages: [], instances: [], connections: [] });
  for (const pkg of allPkgs) workspace = installPackage(workspace, pkg);
  workspace = { ...workspace, mechanisms: [assembly] };
  return { workspace, assembly };
}

/**
 * 为机电控闭环系统构建配套的单轴可动与三维爆炸模组视图（随 RuntimeTrace 轨迹实时联动）。
 */
export function buildComposableFeedModuleTemplate(sys?: TwinSystemAssembly): { workspace: TwinWorkspace; assembly: MechanicalAssembly } {
  const firstAxis = sys?.axes[0];
  const firstCtrl = sys?.controllers[0];
  const firstSensor = sys?.sensors[0];
  const triggerMm = firstSensor?.triggerPositionMm ?? 115;
  const targetMm = firstCtrl?.targetMm ?? 120;
  const maxTravel = Math.max(220, Math.abs(targetMm) + 80, Math.abs(triggerMm) + 60);
  const screwLead = firstAxis?.overrideLeadMmPerRev ?? 10;

  const pkgBase = buildPrimitivePartPackage({
    model: "单轴模组4080基座型材",
    revision: "P1",
    title: "单轴闭环进给模组基座（4080）",
    primitive: { shape: "extrusion_profile", series: "4080", lengthMm: maxTravel + 140, axis: "x", finish: "anodized_black" },
    extraOutputs: [
      { id: "rail_mount", positionMm: [0, 0, 20], quatWxyz: Q_ID },
      { id: "screw_mount", positionMm: [0, 26, 32], quatWxyz: Q_ID },
      { id: "motor_mount", positionMm: [-(maxTravel + 140) / 2 - 44, 26, 32], quatWxyz: Q_ID },
      { id: "bearing_mount", positionMm: [(maxTravel + 140) / 2 - 12, 26, 32], quatWxyz: Q_ID },
      { id: "sensor_mount", positionMm: [clamp(triggerMm - maxTravel / 4, -maxTravel / 2, maxTravel / 2), -44, 24], quatWxyz: Q_ID },
    ],
  });

  const pkgRail = buildPrimitivePartPackage({
    model: "单轴线性导轨滑块副",
    revision: "P1",
    primitive: { shape: "linear_rail_block", railLengthMm: maxTravel + 40, railWidthMm: 16, blockLengthMm: 62, blockWidthMm: 44, heightMm: 22, axis: "x", finish: "steel" },
    input: { positionMm: [0, 0, -11], quatWxyz: Q_ID },
  });

  const pkgCarriage = buildPrimitivePartPackage({
    model: "进给滑台负载工作台",
    revision: "P1",
    primitive: { shape: "plate", widthMm: 95, depthMm: 86, thicknessMm: 16, finish: "aluminum" },
    input: { positionMm: [0, 0, -8], quatWxyz: Q_ID },
    joint: { type: "slide", axis: [1, 0, 0], unit: "mm", range: [-Math.max(150, maxTravel / 2), Math.max(200, maxTravel)] },
    behavior: { kind: "moving_table", massKg: firstAxis?.overrideTableMassKg ?? 8 },
  });

  const pkgScrew = buildPrimitivePartPackage({
    model: `进给滚珠丝杠-${screwLead}mm`,
    revision: "P1",
    primitive: { shape: "lead_screw", diameterMm: 14, lengthMm: maxTravel + 60, leadMm: screwLead, axis: "x", finish: "steel" },
    joint: { type: "hinge", axis: [1, 0, 0], unit: "deg", range: [-36000, 36000] },
    behavior: { kind: "lead_screw", leadMmPerRev: screwLead },
  });

  const pkgMotor = buildPrimitivePartPackage({
    model: "单轴伺服电机",
    revision: "P1",
    primitive: { shape: "servo_motor_body", flangeMm: 57, bodyLengthMm: 60, shaftDiameterMm: 8, shaftLengthMm: 20, axis: "x", finish: "anodized_black" },
    behavior: { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 },
  });

  const pkgBearing = buildPrimitivePartPackage({
    model: "BF端轴承固定座",
    revision: "P1",
    primitive: { shape: "bearing_pillow", widthMm: 24, depthMm: 42, heightMm: 36, boreDiameterMm: 12, axis: "x", finish: "steel" },
  });

  const pkgSensor = buildPrimitivePartPackage({
    model: firstSensor?.name || "限位接近开关传感器",
    revision: "P1",
    primitive: { shape: "box", widthMm: 26, depthMm: 18, heightMm: 22, finish: "sensor_amber" },
  });

  const assembly: MechanicalAssembly = {
    schemaVersion: 1,
    kind: "mechanical-assembly",
    id: sys ? `system-mech-${sys.id}` : "feed-module-demo",
    name: sys ? `${sys.name}（基本件三维结构）` : "单轴伺服进给丝杠模组（基本件·可动·爆炸图）",
    nodes: [
      { id: "axis_base", label: "模组铝型材底座", packageKey: packageKey(pkgBase), parent: null, explodeStep: 0 },
      { id: "axis_rail", label: "线性导轨滑块", packageKey: packageKey(pkgRail), parent: { node: "axis_base", mount: "rail_mount" }, explodeStep: 1, explodeVectorMm: [0, 0, 48] },
      { id: "axis_screw", label: `滚珠丝杠（导程 ${screwLead} mm）`, packageKey: packageKey(pkgScrew), parent: { node: "axis_base", mount: "screw_mount" }, explodeStep: 1, explodeVectorMm: [0, 60, 35], coupledTo: { path: "axis_x", ratio: 360 / screwLead } },
      { id: "axis_motor", label: "伺服驱动电机", packageKey: packageKey(pkgMotor), parent: { node: "axis_base", mount: "motor_mount" }, explodeStep: 2, explodeVectorMm: [-75, 0, 0] },
      { id: "axis_bearing", label: "尾端轴承支座", packageKey: packageKey(pkgBearing), parent: { node: "axis_base", mount: "bearing_mount" }, explodeStep: 2, explodeVectorMm: [70, 0, 0] },
      { id: "limit_sensor", label: "限位开关传感器", packageKey: packageKey(pkgSensor), parent: { node: "axis_base", mount: "sensor_mount" }, explodeStep: 2, explodeVectorMm: [0, -55, 30] },
      { id: "axis_x", label: "滑动工作台负载", packageKey: packageKey(pkgCarriage), parent: { node: "axis_rail", mount: "carriage_top" }, explodeStep: 3, explodeVectorMm: [0, 0, 72] },
    ],
    output: { node: "axis_x", mount: "top" },
    commands: { axis_x: 0 },
  };

  let workspace = parseWorkspace({ schemaVersion: 1, packages: [], instances: [], connections: [] });
  for (const pkg of [pkgBase, pkgRail, pkgCarriage, pkgScrew, pkgMotor, pkgBearing, pkgSensor]) {
    workspace = installPackage(workspace, pkg);
  }
  workspace = { ...workspace, mechanisms: [assembly] };
  return { workspace, assembly };
}
