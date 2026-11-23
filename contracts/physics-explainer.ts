import { Vector3 } from "three";
import { solveArticulatedAssembly } from "./articulated-kinematics";
import type { MechanicalAssembly } from "./mechanical-assembly";
import { estimatePackagePhysicsMassKg } from "./mujoco-compiler";
import { primitiveBoundingBoxMm } from "./primitive-parts";
import { packageKey, type DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export interface PhysicsMetricItem {
  readonly label: string;
  readonly value: string;
}

export interface PhysicsEquationSection {
  readonly id: string;
  readonly title: string;
  readonly status: "pass" | "warn" | "info";
  readonly equation: string;
  readonly metrics: readonly PhysicsMetricItem[];
  readonly explanation: string;
}

export interface SelectedNodeMath {
  readonly id: string;
  readonly label: string;
  readonly worldPosMm: readonly [number, number, number];
  readonly massKg: number;
  readonly massSharePct: number;
  readonly jointText: string;
  readonly coupledText?: string;
  readonly thrusterText?: string;
}

export interface AssemblyPhysicsModel {
  readonly bodyCount: number;
  readonly baseMobility: "fixed" | "free";
  readonly baseDof: number;
  readonly jointDof: number;
  readonly coupledCount: number;
  readonly closureConstraintDof: number;
  readonly netDof: number;
  readonly actuatorCount: number;
  readonly thrusterCount: number;
  readonly totalMassKg: number;
  readonly weightN: number;
  readonly comMm: readonly [number, number, number];
  readonly kinematicsEquation: string;
  readonly dynamicsEquation: string;
  readonly sections: readonly PhysicsEquationSection[];
  readonly selectedNodeMath: SelectedNodeMath | null;
}

export interface FromZeroLabStep {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly done: boolean;
  readonly suggestedBlockId?: string;
}

export type FromZeroLabId = "lab-rover" | "lab-rocket" | "lab-coaxial";

export interface FromZeroLabDef {
  readonly id: FromZeroLabId;
  readonly title: string;
  readonly goalEquation: string;
  readonly summary: string;
  readonly recommendedArena: "flat_ramp" | "launch_complex";
}

export const FROM_ZERO_LABS: readonly FromZeroLabDef[] = [
  {
    id: "lab-rover",
    title: "实验 1：从零搭四轮爬坡车",
    goalEquation: "F_trac = μ M g cos α ≥ M g sin α  (α = 10°)",
    summary: "从 0 件空白画布起步，放置车架为自由底盘，对称挂上 4 个驱动轮并在 MuJoCo 坡道验证牵引力锥。",
    recommendedArena: "flat_ramp",
  },
  {
    id: "lab-rocket",
    title: "实验 2：从零搭单级矢量火箭",
    goalEquation: "T/W = F_max / (M·g) > 1.0  ⇒  z̈ = (F_max - M g)/M",
    summary: "以贮箱为第 1 件基准体，顶装头锥、底挂矢量推力喷管，控制质心对齐推力轴线并验证垂直升空。",
    recommendedArena: "launch_complex",
  },
  {
    id: "lab-coaxial",
    title: "实验 3：从零搭共轴反扭飞行器",
    goalEquation: "q₂ = -q₁ ⇒ Στ_drag = 0  且  T/W > 1.15",
    summary: "从机身起步叠装上下两层旋翼，设置 coupledTo = -1 物理抵消反扭力矩，避免单旋翼偏航自旋。",
    recommendedArena: "launch_complex",
  },
];

const G_ACCEL = 9.81;

function resolveFrameMass(pkg: DevicePackage | undefined): number {
  return estimatePackagePhysicsMassKg(pkg);
}

export function deriveAssemblyPhysicsModel(
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  selectedNodeId?: string,
): AssemblyPhysicsModel {
  if (assembly.nodes.length === 0) {
    return {
      bodyCount: 0,
      baseMobility: assembly.baseMobility ?? "fixed",
      baseDof: assembly.baseMobility === "free" ? 6 : 0,
      jointDof: 0,
      coupledCount: 0,
      closureConstraintDof: 0,
      netDof: 0,
      actuatorCount: 0,
      thrusterCount: 0,
      totalMassKg: 0,
      weightN: 0,
      comMm: [0, 0, 0],
      kinematicsEquation: "T_i(q) = T_parent(q) · T_mount · exp(ξ_i · q_i) · T_input⁻¹",
      dynamicsEquation: "M(q) q̈ + C(q, q̇) + G(q) = τ_act + J_sᵀ F_thrust + J_cᵀ λ + J_nᵀ f_c",
      sections: [
        {
          id: "empty-guide",
          title: "空画布待命：建立第 1 个刚体坐标系",
          status: "info",
          equation: "B₀ ∈ SE(3)  ⇒  固定基座 (0 DOF) 或 自由浮基 freejoint (6 DOF)",
          metrics: [
            { label: "当前刚体数", value: "0 体" },
            { label: "重力加速度 g", value: "-9.81 m/s² (Z 向)" },
          ],
          explanation: "从左侧积木箱点击任意原语（如铝合金板、圆筒贮箱）或打开「自定义参数化零件」，即创建系统世界坐标下的首个刚体坐标系。",
        },
      ],
      selectedNodeMath: null,
    };
  }

  const solved = solveArticulatedAssembly(ws, assembly);
  const pkgByKey = new Map(ws.packages.map((p) => [packageKey(p), p]));
  const rawById = new Map(assembly.nodes.map((n) => [n.id, n]));
  const solvedByPath = new Map(solved.nodes.map((n) => [n.path, n]));

  let totalMassKg = 0;
  let comX = 0;
  let comY = 0;
  let comZ = 0;
  let jointDof = 0;
  let coupledCount = 0;
  let rotaryVelocityCount = 0;
  let slideCount = 0;
  let screwCount = 0;
  let counterCoupledCount = 0;
  let maxThrustN = 0;
  let thrusterCount = 0;
  let thrustWeightedX = 0;
  let wheelRadiusMm = 42;
  let driveWheelCount = 0;
  const fixedTierLabels: string[] = [];

  for (const sNode of solved.nodes) {
    const raw = rawById.get(sNode.id);
    const pkg = sNode.pkg ?? pkgByKey.get(sNode.packageKey);
    const massKg = resolveFrameMass(pkg);
    totalMassKg += massKg;
    comX += massKg * sNode.assembledPosMm[0];
    comY += massKg * sNode.assembledPosMm[1];
    comZ += massKg * sNode.assembledPosMm[2];

    if (sNode.joint.type !== "fixed") {
      jointDof++;
      if (sNode.joint.type === "slide") slideCount++;
      if (pkg?.primitive?.shape === "lead_screw") screwCount++;
      if (raw?.coupledTo) {
        coupledCount++;
        if (sNode.joint.type === "hinge" && raw.coupledTo.ratio < 0) counterCoupledCount++;
      } else if (raw?.jointMode === "velocity" && sNode.joint.type === "hinge") {
        rotaryVelocityCount++;
        fixedTierLabels.push(sNode.label);
        if (pkg?.primitive?.finish === "rubber_grip" || sNode.id.includes("wheel")) {
          driveWheelCount++;
          if (pkg?.primitive?.shape === "cylinder") wheelRadiusMm = pkg.primitive.radiusMm;
        }
      }
    }

    if (raw?.thruster) {
      thrusterCount++;
      maxThrustN += raw.thruster.maxForceN;
      thrustWeightedX += raw.thruster.maxForceN * sNode.assembledPosMm[0];
    }
  }

  const safeMass = Math.max(totalMassKg, 0.001);
  const comMm: [number, number, number] = [
    Number((comX / safeMass).toFixed(2)),
    Number((comY / safeMass).toFixed(2)),
    Number((comZ / safeMass).toFixed(2)),
  ];
  const weightN = totalMassKg * G_ACCEL;
  const baseMobility = assembly.baseMobility ?? "fixed";
  const baseDof = baseMobility === "free" ? 6 : 0;

  let closureConstraintDof = 0;
  let springCount = 0;
  let connectCount = 0;
  let weldCount = 0;
  let maxGapMm = 0;
  let springStiffness = 0;
  let springDamping = 0;

  for (const cl of assembly.closures ?? []) {
    const kind = cl.kind ?? "connect";
    if (kind === "spring") {
      springCount++;
      springStiffness = cl.stiffnessNpm ?? 260;
      springDamping = cl.dampingNsPm ?? 5.5;
    } else {
      if (kind === "weld") {
        weldCount++;
        closureConstraintDof += 6;
      } else {
        connectCount++;
        closureConstraintDof += 3;
      }
      const nodeA = solvedByPath.get(cl.nodeA);
      const nodeB = solvedByPath.get(cl.nodeB);
      const outA = nodeA?.pkg?.mechanics?.kind === "part"
        ? nodeA.pkg.mechanics.outputs.find((o) => o.id === cl.mountA)
        : undefined;
      const outB = nodeB?.pkg?.mechanics?.kind === "part"
        ? nodeB.pkg.mechanics.outputs.find((o) => o.id === cl.mountB)
        : undefined;
      if (nodeA && nodeB && outA && outB) {
        const pA = new Vector3(...outA.positionMm).applyMatrix4(nodeA.assembledMatrix);
        const pB = new Vector3(...outB.positionMm).applyMatrix4(nodeB.assembledMatrix);
        maxGapMm = Math.max(maxGapMm, pA.distanceTo(pB));
      }
    }
  }

  let actuatorCount = thrusterCount;
  for (const raw of assembly.nodes) {
    const sNode = solvedByPath.get(raw.id);
    if (sNode && sNode.joint.type !== "fixed" && !raw.coupledTo && raw.jointMode !== "passive") {
      actuatorCount++;
    }
  }

  const netDof = Math.max(0, baseDof + jointDof - coupledCount - closureConstraintDof);
  const sections: PhysicsEquationSection[] = [];

  // Section 1: Thruster Flight & Attitude Dynamics
  if (thrusterCount > 0) {
    const twRatio = weightN > 0 ? maxThrustN / weightN : 0;
    const peakAccelMs2 = (maxThrustN - weightN) / safeMass;
    const thrustXMm = thrustWeightedX / Math.max(maxThrustN, 1);
    const deltaXComMm = comMm[0] - thrustXMm;
    const hasHealthyTw = twRatio > 1.05;
    const hasCenteredCom = Math.abs(deltaXComMm) <= 12;

    sections.push({
      id: "thrust",
      title: "推力飞行与姿态力矩方程",
      status: hasHealthyTw && hasCenteredCom ? "pass" : "warn",
      equation: "M z̈ = F_max cos θ - M g ,   I_y θ̈ = F_max · L_z sin δ - M g · Δx_COM",
      metrics: [
        { label: "峰值总推力 F_max", value: `${maxThrustN.toFixed(1)} N` },
        { label: "重力载荷 M·g", value: `${weightN.toFixed(2)} N` },
        { label: "推重比 T/W", value: `${twRatio.toFixed(2)}` },
        { label: "垂直净加速度 a_z", value: `${peakAccelMs2 >= 0 ? "+" : ""}${peakAccelMs2.toFixed(1)} m/s²` },
        { label: "质心-推力线偏距 Δx", value: `${deltaXComMm >= 0 ? "+" : ""}${deltaXComMm.toFixed(2)} mm` },
      ],
      explanation: !hasHealthyTw
        ? "推重比 T/W ≤ 1.05，局部轴向推力不足以克服自重，需增大喷管推力或减轻级间质量。"
        : !hasCenteredCom
          ? `总质心 X (${comMm[0]} mm) 偏离推力作用线 ${Math.abs(deltaXComMm).toFixed(1)} mm > 12 mm，重力臂会在离地瞬间引起严重俯仰翻滚。`
          : "T/W > 1 且质心基本落于推力作用线上，局部 <motor site> 推力随载体姿态矢量变换。",
    });
  }

  // Section 2: Coaxial Counter-Torque Cancellation
  if (counterCoupledCount > 0) {
    sections.push({
      id: "coaxial",
      title: "共轴等速反转扭矩抵消",
      status: "pass",
      equation: "q₂(t) = -q₁(t)  ⇒  τ_drag,1 + τ_drag,2 = -k_d ω₁ - k_d (-ω₁) = 0",
      metrics: [
        { label: "反向耦合副数", value: `${counterCoupledCount} 组 (<joint polycoef="0 -1">)` },
        { label: "净偏航反扭矩", value: "≈ 0 N·m（理论抵消）" },
      ],
      explanation: "上下旋翼通过多项式约束严格反向等速转动，无需尾桨即可抵消旋翼空气动力反扭力矩。",
    });
  }

  // Section 3: Coulomb Wheel Traction & Slope Climbing
  if (baseMobility === "free" && driveWheelCount > 0) {
    const slopeRad = (10 * Math.PI) / 180;
    const mu = 1.35;
    const slopeDemandN = weightN * Math.sin(slopeRad);
    const maxTractionN = mu * weightN * Math.cos(slopeRad);
    const maxSlopeDeg = (Math.atan(mu) * 180) / Math.PI;
    sections.push({
      id: "wheels",
      title: "轮地库仑摩擦与坡道牵引锥",
      status: maxTractionN > slopeDemandN * 1.1 ? "pass" : "warn",
      equation: "F_trac ≤ μ M g cos α ,   F_slope = M g sin α ,   v = ω R",
      metrics: [
        { label: "速度驱动轮", value: `${driveWheelCount} 轮 (R = ${wheelRadiusMm} mm)` },
        { label: "10° 坡道下滑分力", value: `${slopeDemandN.toFixed(2)} N` },
        { label: "橡胶静摩擦极限 (μ=1.35)", value: `${maxTractionN.toFixed(2)} N (α_max=${maxSlopeDeg.toFixed(0)}°)` },
      ],
      explanation: "轮胎通过 MuJoCo 接触求解器产生法向支承力 N 与切向静摩擦力，只要坡度角 α < arctan(μ) 即可无滑移爬坡。",
    });
  }

  // Section 4: Closed-Chain Holonomic Constraints
  if (connectCount + weldCount > 0) {
    sections.push({
      id: "closure",
      title: "闭链完整约束与 Lagrange 乘子",
      status: maxGapMm <= 5 ? "pass" : "warn",
      equation: "c(q) = p_A(q) - p_B(q) = 0 ,   τ_constraint = J_cᵀ λ",
      metrics: [
        { label: "闭环约束数", value: `${connectCount} 球铰 + ${weldCount} 固焊` },
        { label: "剥离自由度", value: `-${closureConstraintDof} DOF` },
        { label: "初始装配闭合残差", value: `${maxGapMm.toFixed(2)} mm` },
      ],
      explanation: maxGapMm <= 5
        ? "跨分支端点 p_A 与 p_B 几何误差极小，<connect>/<weld> 约束求解器通过乘子 λ 保持闭合环不断裂。"
        : `当前闭环两端点初始间距为 ${maxGapMm.toFixed(1)} mm，请调整杆长或安装点使端点接近重合后再运行动态闭合。`,
    });
  }

  // Section 5: 2nd-Order Spring-Damper Oscillator
  if (springCount > 0) {
    const effMass = Math.max(0.2, totalMassKg * 0.35);
    const omegaN = Math.sqrt(springStiffness / effMass);
    const freqHz = omegaN / (2 * Math.PI);
    const zeta = springDamping / (2 * Math.sqrt(springStiffness * effMass));
    const staticSagMm = ((effMass * G_ACCEL) / springStiffness) * 1000;
    sections.push({
      id: "spring",
      title: "二阶弹簧-阻尼振动微分方程",
      status: "info",
      equation: "m_eff z̈ + c ż + k z = m_eff g ,   f_n = (1/2π)√(k/m_eff)",
      metrics: [
        { label: "弹性刚度 / 阻尼", value: `k=${springStiffness} N/m · c=${springDamping} N·s/m` },
        { label: "固有频率 f_n", value: `${freqHz.toFixed(2)} Hz` },
        { label: "阻尼比 ζ", value: `${zeta.toFixed(3)} (${zeta < 1 ? "欠阻尼振荡" : "过阻尼衰减"})` },
        { label: "静平衡估算下沉", value: `${staticSagMm.toFixed(1)} mm` },
      ],
      explanation: "<tendon><spatial> 沿两挂载点实时计算空间弦长 ΔL，当 ζ < 1 时在重力阶跃下呈现典型指数衰减正弦振荡。",
    });
  }

  // Section 6: Industrial Feed / Grip / Fixed-Axis Rotary Systems
  if (screwCount > 0 || (baseMobility === "fixed" && rotaryVelocityCount >= 2) || slideCount > 0) {
    const lines: PhysicsMetricItem[] = [];
    if (screwCount > 0) lines.push({ label: "滚珠丝杠耦合副", value: `${screwCount} 根 (x = θ·p / 360°)` });
    if (slideCount > 0) lines.push({ label: "直线平动副", value: `${slideCount} 轴` });
    if (baseMobility === "fixed" && rotaryVelocityCount > 0) {
      lines.push({ label: "定轴速度回转环", value: `${rotaryVelocityCount} 组 (${fixedTierLabels.slice(0, 3).join(" / ")})` });
    }
    sections.push({
      id: "mechanism-kinematics",
      title: baseMobility === "fixed" && rotaryVelocityCount >= 2 ? "多级定轴回转运动学方程" : "机械传动与运动映射",
      status: "info",
      equation:
        baseMobility === "fixed" && rotaryVelocityCount >= 2
          ? "θ_k(t) = ω_k t ,   v_tangential = ω_k · R_k"
          : "F_axial = 2π η τ / p ,   J_total = J_m + m·(p / 2π)²",
      metrics: lines,
      explanation: "每个可动关节在树形坐标链上施加局部旋量变换 exp(ξ·q)，并由 MuJoCo 伺服位置或速度执行器驱动至设定目标。",
    });
  }

  if (sections.length === 0) {
    sections.push({
      id: "rigid-static",
      title: "多体刚体静态与坐标系组合",
      status: "info",
      equation: "T_i = T_parent · T_mount · T_input⁻¹ ,   r_COM = Σ(m_i r_i) / Σm_i",
      metrics: [
        { label: "刚体总质量 M", value: `${totalMassKg.toFixed(2)} kg` },
        { label: "静置重力载荷 W", value: `${weightN.toFixed(2)} N` },
      ],
      explanation: "当前装配由刚性连接零件组成。在左/右栏为零件添加铰链（hinge/slide）、推力器或自由底盘后，即可观察实时动力学演进。",
    });
  }

  let selectedNodeMath: SelectedNodeMath | null = null;
  if (selectedNodeId) {
    const sNode = solvedByPath.get(selectedNodeId);
    const raw = rawById.get(selectedNodeId);
    if (sNode) {
      const pkg = sNode.pkg ?? pkgByKey.get(sNode.packageKey);
      const massKg = resolveFrameMass(pkg);
      const box = pkg?.primitive ? primitiveBoundingBoxMm(pkg.primitive) : undefined;
      const axisName =
        sNode.joint.type === "fixed"
          ? ""
          : Math.abs(sNode.joint.axis[0]) > 0.5
            ? "X"
            : Math.abs(sNode.joint.axis[1]) > 0.5
              ? "Y"
              : "Z";
      const jointText =
        sNode.joint.type === "fixed"
          ? `fixed 刚性固连${box ? ` · 外包 ${box[0].toFixed(0)}×${box[1].toFixed(0)}×${box[2].toFixed(0)} mm` : ""}`
          : `${sNode.joint.type} 沿/绕 ${axisName} 轴 [${sNode.joint.range[0]}..${sNode.joint.range[1]} ${sNode.joint.unit}] (${raw?.jointMode ?? "actuated"})`;

      selectedNodeMath = {
        id: sNode.id,
        label: sNode.label,
        worldPosMm: [
          Number(sNode.assembledPosMm[0].toFixed(1)),
          Number(sNode.assembledPosMm[1].toFixed(1)),
          Number(sNode.assembledPosMm[2].toFixed(1)),
        ],
        massKg: Number(massKg.toFixed(3)),
        massSharePct: Number(((massKg / safeMass) * 100).toFixed(1)),
        jointText,
        ...(raw?.coupledTo
          ? { coupledText: `从动耦合：q = ${raw.coupledTo.ratio} · q(${raw.coupledTo.path})` }
          : {}),
        ...(raw?.thruster
          ? { thrusterText: `局部 +Z 推力器：F_max = ${raw.thruster.maxForceN} N` }
          : {}),
      };
    }
  }

  return {
    bodyCount: solved.nodes.length,
    baseMobility,
    baseDof,
    jointDof,
    coupledCount,
    closureConstraintDof,
    netDof,
    actuatorCount,
    thrusterCount,
    totalMassKg: Number(totalMassKg.toFixed(3)),
    weightN: Number(weightN.toFixed(2)),
    comMm,
    kinematicsEquation: "T_i(q) = T_parent(q) · T_mount · exp(ξ_i · q_i) · T_input⁻¹",
    dynamicsEquation: "M(q) q̈ + C(q, q̇) + G(q) = τ_act + J_sᵀ F_thrust + J_cᵀ λ + J_nᵀ f_c",
    sections,
    selectedNodeMath,
  };
}

export function evaluateFromZeroLab(
  labId: FromZeroLabId,
  ws: TwinWorkspace,
  assembly: MechanicalAssembly,
  model: AssemblyPhysicsModel,
): { readonly def: FromZeroLabDef; readonly steps: readonly FromZeroLabStep[]; readonly readyForSim: boolean } {
  const def = FROM_ZERO_LABS.find((l) => l.id === labId) ?? FROM_ZERO_LABS[0]!;
  const pkgByKey = new Map(ws.packages.map((p) => [packageKey(p), p]));

  const wheelNodes = assembly.nodes.filter((n) => {
    const pkg = pkgByKey.get(n.packageKey);
    const isRot = pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "hinge";
    return isRot && (n.id.startsWith("drive_wheel") || pkg?.primitive?.finish === "rubber_grip");
  });
  const rotaryVelNodes = assembly.nodes.filter((n) => {
    const pkg = pkgByKey.get(n.packageKey);
    const isRot = pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "hinge";
    return isRot && (n.jointMode === "velocity" || n.coupledTo !== undefined);
  });
  const hasCounterCouple = assembly.nodes.some((n) => Boolean(n.coupledTo && n.coupledTo.ratio < 0));
  const thrusterNodes = assembly.nodes.filter((n) => Boolean(n.thruster));
  const totalThrustN = thrusterNodes.reduce((s, n) => s + (n.thruster?.maxForceN ?? 0), 0);
  const tw = model.weightN > 0 ? totalThrustN / model.weightN : 0;

  let steps: FromZeroLabStep[] = [];
  if (labId === "lab-rover") {
    steps = [
      {
        id: "r1",
        title: "放置车架基准板（从 0 → 1）",
        hint: "点击左侧「带孔铝合金工作台板」或型材横梁作为根底盘。",
        done: assembly.nodes.length >= 1,
        suggestedBlockId: "table_plate",
      },
      {
        id: "r2",
        title: "设为 6-DOF 自由底盘",
        hint: "在右栏「底盘与闭链约束」点击切换为「自由落地底盘」。",
        done: model.baseMobility === "free",
      },
      {
        id: "r3",
        title: `对称加装 4 个驱动车轮 (${wheelNodes.length}/4)`,
        hint: "点击 4 次「高摩擦橡胶驱动轮」自动吸附至底板前后两侧安装点。",
        done: wheelNodes.length >= 4,
        suggestedBlockId: "drive_wheel",
      },
      {
        id: "r4",
        title: "推重与质量校核后进入 MuJoCo 爬坡",
        hint: "若底盘太重可直接在右栏调轻底盘质量 (例如 1.2 kg)，再点「在 MuJoCo 中运行刚体仿真」。",
        done: wheelNodes.length >= 4 && model.baseMobility === "free" && model.totalMassKg > 0 && model.totalMassKg <= 4.5,
      },
    ];
  } else if (labId === "lab-rocket") {
    steps = [
      {
        id: "k1",
        title: "放置圆筒舱段 / 贮箱作为芯级（从 0 → 1）",
        hint: "点击左侧「圆筒舱段 / 火箭贮箱」建立级间主坐标系。",
        done: assembly.nodes.length >= 1,
        suggestedBlockId: "tank_cylinder",
      },
      {
        id: "k2",
        title: "设为 6-DOF 自由底盘（允许在重力场离台）",
        hint: "在右栏启用「自由落地底盘」解除地面固接。",
        done: model.baseMobility === "free",
      },
      {
        id: "k3",
        title: "底部装矢量火箭喷管 & 顶部装尖锥整流罩",
        hint: "点击「矢量火箭发动机喷管」和「气动整流罩 / 天线塔尖」完成首尾气动与推力配置。",
        done: thrusterNodes.length >= 1 && assembly.nodes.length >= 3,
        suggestedBlockId: thrusterNodes.length === 0 ? "rocket_thruster" : "nose_cone",
      },
      {
        id: "k4",
        title: `保证 T/W > 1.3 且质心对齐 (${tw.toFixed(2)})`,
        hint: "观察右侧数学物理模型中的推重比 T/W，达标后点击进入 MuJoCo 试飞。",
        done: tw > 1.3 && Math.abs(model.comMm[0]) <= 12,
      },
    ];
  } else {
    steps = [
      {
        id: "c1",
        title: "放置机身与 6-DOF 自由底盘",
        hint: "放 1 块基准件并在右栏设为「自由落地底盘」。",
        done: assembly.nodes.length >= 1 && model.baseMobility === "free",
        suggestedBlockId: "table_plate",
      },
      {
        id: "c2",
        title: `叠加 2 副旋翼桨盘 (${Math.min(2, rotaryVelNodes.length)}/2)`,
        hint: "安装 2 个「高速升力旋翼桨盘」形成共轴双层桨。",
        done: rotaryVelNodes.length >= 2 && thrusterNodes.length >= 1,
        suggestedBlockId: "rotor_propeller",
      },
      {
        id: "c3",
        title: "设定从动耦合 coupledTo ratio = -1",
        hint: "在 3D 或树状图选中第 2 个旋翼，在右栏耦合栏将其关联到第 1 个旋翼、比例设为 -1。",
        done: hasCounterCouple,
      },
      {
        id: "c4",
        title: `满足 T/W > 1.15 且质心偏差 ≤ 8 mm (${tw.toFixed(2)})`,
        hint: "如质量过重可调轻机身质量或增大推力 N 后运行 MuJoCo 试飞。",
        done: hasCounterCouple && tw > 1.15 && Math.abs(model.comMm[0]) <= 8,
      },
    ];
  }

  return {
    def,
    steps,
    readyForSim: steps.every((s) => s.done),
  };
}
