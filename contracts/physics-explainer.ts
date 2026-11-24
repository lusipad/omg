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

export type FromZeroLabAction =
  | { readonly kind: "block"; readonly blockId: string; readonly label: string }
  | { readonly kind: "set_free"; readonly label: string }
  | { readonly kind: "encapsulate_engine"; readonly label: string }
  | { readonly kind: "attach_module"; readonly moduleId: string; readonly label: string }
  | { readonly kind: "couple_counter_rotor"; readonly label: string };

export interface FromZeroLabStep {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly done: boolean;
  readonly suggestedBlockId?: string;
  readonly action?: FromZeroLabAction;
}

export type FromZeroLabId = "lab-rocket" | "lab-rover" | "lab-coaxial";

export interface FromZeroLabDef {
  readonly id: FromZeroLabId;
  readonly title: string;
  readonly goalEquation: string;
  readonly summary: string;
  readonly recommendedArena: "flat_ramp" | "launch_complex";
}

export const FROM_ZERO_LABS: readonly FromZeroLabDef[] = [
  {
    id: "lab-rocket",
    title: "实验 1：从电机开始搭火箭（发动机总成 → 整箭）",
    goalEquation: "ω_pump → ṁ ⇒ F_thrust = ṁ v_e ,  T/W = ΣF / (M g) > 1.2",
    summary: "先用「无刷电机 + 离心泵叶轮 + TVC舵机 + 纯喷管」拼出电泵发动机并封装成子总成，再装到贮箱箭体上点火升空。",
    recommendedArena: "launch_complex",
  },
  {
    id: "lab-rover",
    title: "实验 2：从轮毂电机与纯胶胎搭四轮爬坡车",
    goalEquation: "τ_motor / R ≤ μ N_i ,  ΣF_drive ≥ M g sin α  (α = 10°)",
    summary: "从 0 件起步，先搭车架为 6-DOF 自由底盘，再对称安装 4 套「轮毂驱动电机 → 纯橡胶轮胎」验证牵引力锥。",
    recommendedArena: "flat_ramp",
  },
  {
    id: "lab-coaxial",
    title: "实验 3：从无刷电机与纯桨叶搭共轴飞行器",
    goalEquation: "F_lift = k_F ω² ,  ω₂ = -ω₁ ⇒ Στ_drag = 0 且 T/W > 1.15",
    summary: "从承力机身起步装入双高速无刷电机与无源气动桨叶，设置 ratio = -1 反扭抵消并按 ω² 升力垂直起飞。",
    recommendedArena: "launch_complex",
  },
];

const G_ACCEL = 9.81;

function resolveFrameMass(pkg: DevicePackage | undefined): number {
  return estimatePackagePhysicsMassKg(pkg);
}

function isPumpImpellerLike(
  node: MechanicalAssembly["nodes"][number],
  pkg: DevicePackage | undefined,
): boolean {
  const txt = `${node.id} ${node.label ?? ""} ${pkg?.model ?? ""}`.toLowerCase();
  return txt.includes("pump_impeller") || txt.includes("impeller") || txt.includes("叶轮");
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
  const childrenById = new Map<string, MechanicalAssembly["nodes"][number][]>();
  for (const n of assembly.nodes) {
    if (!n.parent?.node) continue;
    const list = childrenById.get(n.parent.node) ?? [];
    list.push(n);
    childrenById.set(n.parent.node, list);
  }
  const solvedByPath = new Map(solved.nodes.map((n) => [n.path, n]));

  const isHingeRaw = (n: MechanicalAssembly["nodes"][number]): boolean => {
    const pkg = pkgByKey.get(n.packageKey);
    return pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "hinge";
  };

  const hasImpellerUnder = (rootId: string): boolean => {
    const q = [...(childrenById.get(rootId) ?? [])];
    for (let i = 0; i < q.length; i++) {
      const cur = q[i]!;
      if (isPumpImpellerLike(cur, pkgByKey.get(cur.packageKey))) return true;
      for (const ch of childrenById.get(cur.id) ?? []) q.push(ch);
    }
    return false;
  };

  const findPumpDriverNode = (nozzle: MechanicalAssembly["nodes"][number]): MechanicalAssembly["nodes"][number] | null => {
    if (nozzle.thruster?.sourceNodePath) {
      const explicit = rawById.get(nozzle.thruster.sourceNodePath);
      if (explicit && isHingeRaw(explicit) && hasImpellerUnder(explicit.id)) return explicit;
      return null;
    }
    const anc = new Set<string>();
    let cur: string | null = nozzle.id;
    while (cur) {
      anc.add(cur);
      cur = rawById.get(cur)?.parent?.node ?? null;
    }
    const candidates = assembly.nodes.filter((n) => isHingeRaw(n) && hasImpellerUnder(n.id));
    if (candidates.length === 0) return null;
    let best: MechanicalAssembly["nodes"][number] | null = null;
    let bestDepth = -1;
    for (const c of candidates) {
      let ptr: string | null = c.id;
      let d = 0;
      while (ptr) {
        if (anc.has(ptr)) {
          if (100 - d > bestDepth) {
            bestDepth = 100 - d;
            best = c;
          }
          break;
        }
        ptr = rawById.get(ptr)?.parent?.node ?? null;
        d++;
      }
    }
    return best ?? candidates[0]!;
  };

  const findAncestorHingeNode = (nodeId: string): MechanicalAssembly["nodes"][number] | null => {
    let cur: string | null = nodeId;
    while (cur) {
      const r = rawById.get(cur);
      if (r && isHingeRaw(r)) return r;
      cur = r?.parent?.node ?? null;
    }
    return null;
  };

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
  let directThrusterCount = 0;
  let pumpNozzleCount = 0;
  let unpoweredNozzleCount = 0;
  let activeRotorCount = 0;
  let unpoweredBladeCount = 0;
  let thrustWeightedX = 0;
  let wheelRadiusMm = 42;
  let motorizedWheelCount = 0;
  let unpoweredWheelCount = 0;
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
        if (pkg?.primitive?.finish === "rubber_grip") {
          motorizedWheelCount++;
          if (pkg.primitive.shape === "cylinder") wheelRadiusMm = pkg.primitive.radiusMm;
        }
      }
    }

    if (pkg?.primitive?.finish === "rubber_grip" && pkg.primitive.shape === "cylinder") {
      wheelRadiusMm = pkg.primitive.radiusMm;
      if (sNode.joint.type === "fixed") {
        const driver = raw ? findAncestorHingeNode(raw.id) : null;
        if (driver) motorizedWheelCount++;
        else unpoweredWheelCount++;
      }
    }

    if (raw?.thruster) {
      thrusterCount++;
      const coupleMode = raw.thruster.coupleMode ?? "direct";
      if (coupleMode === "direct") {
        directThrusterCount++;
        maxThrustN += raw.thruster.maxForceN;
        thrustWeightedX += raw.thruster.maxForceN * sNode.assembledPosMm[0];
      } else if (coupleMode === "pump_speed") {
        const driver = findPumpDriverNode(raw);
        if (driver) {
          pumpNozzleCount++;
          maxThrustN += raw.thruster.maxForceN;
          thrustWeightedX += raw.thruster.maxForceN * sNode.assembledPosMm[0];
        } else {
          unpoweredNozzleCount++;
        }
      } else {
        const driver = findAncestorHingeNode(raw.id);
        if (driver) {
          activeRotorCount++;
          maxThrustN += raw.thruster.maxForceN;
          thrustWeightedX += raw.thruster.maxForceN * sNode.assembledPosMm[0];
        } else {
          unpoweredBladeCount++;
        }
      }
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

  let actuatorCount = directThrusterCount;
  for (const raw of assembly.nodes) {
    const sNode = solvedByPath.get(raw.id);
    if (sNode && sNode.joint.type !== "fixed" && !raw.coupledTo && raw.jointMode !== "passive") {
      actuatorCount++;
    }
  }

  const netDof = Math.max(0, baseDof + jointDof - coupledCount - closureConstraintDof);
  const sections: PhysicsEquationSection[] = [];

  // Section 1: Thruster / Motor-Driven Flight & Attitude Dynamics
  if (thrusterCount > 0) {
    const twRatio = weightN > 0 ? maxThrustN / weightN : 0;
    const peakAccelMs2 = (maxThrustN - weightN) / safeMass;
    const thrustXMm = maxThrustN > 0 ? thrustWeightedX / maxThrustN : 0;
    const deltaXComMm = comMm[0] - thrustXMm;
    const hasHealthyTw = twRatio > 1.05;
    const hasCenteredCom = Math.abs(deltaXComMm) <= 12;

    const isPumpDomain = pumpNozzleCount > 0 || unpoweredNozzleCount > 0;
    const isRotorDomain = !isPumpDomain && (activeRotorCount > 0 || unpoweredBladeCount > 0);
    const missingPump = unpoweredNozzleCount > 0;
    const missingRotorMotor = unpoweredBladeCount > 0;
    const singleUncompensatedRotor = isRotorDomain && activeRotorCount === 1 && counterCoupledCount === 0;

    const sectionTitle = isPumpDomain
      ? "电泵循环矢量推力与姿态力矩方程"
      : isRotorDomain
        ? "旋翼气动升力 (∝ ω²) 与飞行姿态方程"
        : "推力飞行与姿态力矩方程";

    const sectionEq = isPumpDomain
      ? "ω_pump → ṁ = ṁ_max·|ω_pump|/ω₀ ⇒ F = ṁ·v_e ,  I_y θ̈ = F·L_z sin δ - M g·Δx_COM"
      : isRotorDomain
        ? "F_lift(ω) = k_F · ω² ,  τ_drag(ω) = -sign(ω) k_M ω² ,  T/W = ΣF_lift / (M g)"
        : "M z̈ = F_max cos θ - M g ,   I_y θ̈ = F_max · L_z sin δ - M g · Δx_COM";

    const ok =
      !missingPump &&
      !missingRotorMotor &&
      !singleUncompensatedRotor &&
      hasHealthyTw &&
      hasCenteredCom;

    const explanation = missingPump
      ? "检测到纯拉瓦尔喷管未耦合「高速无刷电机 → 离心涡轮泵叶轮」供流，质量流量 ṁ = 0 ⇒ MuJoCo 实际推力为 0 N。"
      : missingRotorMotor
        ? "纯无源气动桨叶未挂载在高速电机转轴上，角速度 ω = 0 ⇒ 升力为 0 N。"
        : singleUncompensatedRotor
          ? "仅装单组旋翼电机而未设反转抵消（coupledTo ratio = -1），旋翼气动反扭 τ_drag 会使机身偏航高速自旋！"
          : !hasHealthyTw
            ? "有效推重比 T/W ≤ 1.05，电机驱动产生的总推力/升力不足以克服重力，需增大推进单元或减轻载荷。"
            : !hasCenteredCom
              ? `总质心 X (${comMm[0]} mm) 偏离推力作用线 ${Math.abs(deltaXComMm).toFixed(1)} mm > 12 mm，重力臂会在离地瞬间引起严重俯仰翻滚。`
              : isPumpDomain
                ? "电泵电机驱动离心叶轮增压供流，按转速比例输出喷管推力；TVC 伺服舵机偏转角 δ 控制俯仰力矩矢量。"
                : "高速无刷电机旋转带动桨叶，在 MuJoCo 中按实测角速度 ω² 计算升力与反扭扭矩，共轴反转时净反扭归零。";

    sections.push({
      id: "thrust",
      title: sectionTitle,
      status: ok ? "pass" : "warn",
      equation: sectionEq,
      metrics: [
        { label: "有效电机耦合推力 F_max", value: `${maxThrustN.toFixed(1)} N` },
        { label: "重力载荷 M·g", value: `${weightN.toFixed(2)} N` },
        { label: "有效推重比 T/W", value: `${twRatio.toFixed(2)}` },
        { label: "垂直净加速度 a_z", value: `${peakAccelMs2 >= 0 ? "+" : ""}${peakAccelMs2.toFixed(1)} m/s²` },
        { label: "质心-推力线偏距 Δx", value: `${deltaXComMm >= 0 ? "+" : ""}${deltaXComMm.toFixed(2)} mm` },
      ],
      explanation,
    });
  }

  // Section 2: Coaxial Counter-Torque Cancellation
  if (counterCoupledCount > 0) {
    sections.push({
      id: "coaxial",
      title: "共轴等速反转扭矩抵消",
      status: "pass",
      equation: "q₂(t) = -q₁(t)  ⇒  τ_drag,1 + τ_drag,2 = -k_M ω₁² + k_M (-ω₁)² = 0",
      metrics: [
        { label: "反向耦合副数", value: `${counterCoupledCount} 组 (<joint polycoef="0 -1">)` },
        { label: "净偏航反扭矩", value: "≈ 0 N·m（理论抵消）" },
      ],
      explanation: "上下无刷电机通过多项式约束严格反向等速转动，抵消各自桨叶产生的空气动力反扭力矩。",
    });
  }

  // Section 3: Coulomb Wheel Traction & Slope Climbing
  if (baseMobility === "free" && (motorizedWheelCount > 0 || unpoweredWheelCount > 0)) {
    const slopeRad = (10 * Math.PI) / 180;
    const mu = 1.35;
    const slopeDemandN = weightN * Math.sin(slopeRad);
    const maxTractionN = mu * weightN * Math.cos(slopeRad);
    const maxSlopeDeg = (Math.atan(mu) * 180) / Math.PI;
    const hasMotors = motorizedWheelCount > 0;
    const allMotorized = hasMotors && unpoweredWheelCount === 0;
    sections.push({
      id: "wheels",
      title: "轮毂电机力矩与库仑摩擦牵引锥",
      status: allMotorized && maxTractionN > slopeDemandN * 1.1 ? "pass" : "warn",
      equation: "τ_motor / R ≤ μ N_i ,   F_slope = M g sin α ,   v = ω R",
      metrics: [
        { label: "电驱主动轮 / 无动力轮", value: `${motorizedWheelCount} 驱 / ${unpoweredWheelCount} 从动 (R=${wheelRadiusMm} mm)` },
        { label: "10° 坡道下滑分力", value: `${slopeDemandN.toFixed(2)} N` },
        { label: "橡胶静摩擦极限 (μ=1.35)", value: `${maxTractionN.toFixed(2)} N (α_max=${maxSlopeDeg.toFixed(0)}°)` },
      ],
      explanation: !hasMotors
        ? "检测到轮胎直接固接在车架上（未通过「轮毂驱动电机」驱动），电机力矩为 0，在 10° 坡道只会溜车滑下。"
        : unpoweredWheelCount > 0
          ? `尚有 ${unpoweredWheelCount} 只轮胎未安装到轮毂驱动电机上，仅受电驱轮提供牵引。`
          : "每只轮胎经轮毂电机转轴输出转速与扭矩，通过 MuJoCo 接触静摩擦力产生沿地面推进力，无滑移爬上 10° 斜坡。",
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
          ? {
              thrusterText: (() => {
                const cm = raw.thruster.coupleMode ?? "direct";
                if (cm === "pump_speed") {
                  const drv = findPumpDriverNode(raw);
                  return drv
                    ? `电泵耦合拉瓦尔推力：F_max = ${raw.thruster.maxForceN} N（受 ${drv.label ?? drv.id} 转速 ω 驱动）`
                    : `纯无源拉瓦尔喷管：当前 0 N（缺少无刷电机+离心涡轮泵叶轮供流）`;
                }
                if (cm === "rotor_aero") {
                  const drv = findAncestorHingeNode(raw.id);
                  return drv
                    ? `旋翼气动升力 (∝ω²)：F_max = ${raw.thruster.maxForceN} N（由 ${drv.label ?? drv.id} 驱动）`
                    : `纯无源桨叶：当前 0 N（未挂载在高速电机轴上）`;
                }
                return `局部 +Z 推力器：F_max = ${raw.thruster.maxForceN} N`;
              })(),
            }
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
  options?: { readonly engineModuleSaved?: boolean; readonly engineModuleId?: string },
): {
  readonly def: FromZeroLabDef;
  readonly steps: readonly FromZeroLabStep[];
  readonly readyForSim: boolean;
  readonly phaseLabel?: string;
} {
  const def = FROM_ZERO_LABS.find((l) => l.id === labId) ?? FROM_ZERO_LABS[0]!;
  const pkgByKey = new Map(ws.packages.map((p) => [packageKey(p), p]));
  const rawById = new Map(assembly.nodes.map((n) => [n.id, n]));
  const childrenById = new Map<string, MechanicalAssembly["nodes"][number][]>();
  for (const n of assembly.nodes) {
    if (!n.parent?.node) continue;
    const list = childrenById.get(n.parent.node) ?? [];
    list.push(n);
    childrenById.set(n.parent.node, list);
  }

  const isHingeNode = (n: MechanicalAssembly["nodes"][number]) => {
    const pkg = pkgByKey.get(n.packageKey);
    return pkg?.mechanics?.kind === "part" && pkg.mechanics.joint.type === "hinge";
  };

  const hasAncestorHinge = (nodeId: string): boolean => {
    let cur: string | null = nodeId;
    while (cur) {
      const n = rawById.get(cur);
      if (n && isHingeNode(n)) return true;
      cur = n?.parent?.node ?? null;
    }
    return false;
  };

  const hasImpellerOnMotor = (motorId: string): boolean => {
    const q = [...(childrenById.get(motorId) ?? [])];
    for (let i = 0; i < q.length; i++) {
      const cur = q[i]!;
      if (isPumpImpellerLike(cur, pkgByKey.get(cur.packageKey))) return true;
      for (const ch of childrenById.get(cur.id) ?? []) q.push(ch);
    }
    return false;
  };

  const hubMotorNodes = assembly.nodes.filter((n) => {
    const pkg = pkgByKey.get(n.packageKey);
    const j = pkg?.mechanics?.kind === "part" ? pkg.mechanics.joint : undefined;
    return j?.type === "hinge" && Math.abs(j.axis[1]) > 0.5 && (n.jointMode === "velocity" || Math.abs(j.range[1] - j.range[0]) >= 3600);
  });
  const motorizedWheels = assembly.nodes.filter((n) => {
    const pkg = pkgByKey.get(n.packageKey);
    return pkg?.primitive?.finish === "rubber_grip" && pkg.primitive.shape === "cylinder" && hasAncestorHinge(n.id);
  });

  const bldcMotors = assembly.nodes.filter((n) => {
    const pkg = pkgByKey.get(n.packageKey);
    const j = pkg?.mechanics?.kind === "part" ? pkg.mechanics.joint : undefined;
    return j?.type === "hinge" && Math.abs(j.axis[2]) > 0.5 && (n.jointMode === "velocity" || Math.abs(j.range[1] - j.range[0]) >= 3600);
  });
  const pumpMotors = bldcMotors.filter((m) => hasImpellerOnMotor(m.id));
  const rotorBladesWithMotor = assembly.nodes.filter(
    (n) => n.thruster?.coupleMode === "rotor_aero" && hasAncestorHinge(n.id),
  );
  const directOrPumpNozzles = assembly.nodes.filter(
    (n) => n.thruster && (n.thruster.coupleMode ?? "direct") !== "rotor_aero",
  );
  const coupledNozzles = directOrPumpNozzles.filter(
    (n) => (n.thruster?.coupleMode ?? "direct") === "direct" || pumpMotors.length > 0,
  );
  const hasCounterCouple = assembly.nodes.some((n) => Boolean(n.coupledTo && n.coupledTo.ratio < 0));

  const thrustSec = model.sections.find((s) => s.id === "thrust");
  const effectiveTw = (() => {
    const item = thrustSec?.metrics.find((m) => m.label.includes("推重比"));
    return item ? Number(item.value) : 0;
  })();

  let steps: FromZeroLabStep[] = [];
  let phaseLabel: string | undefined;

  if (labId === "lab-rocket") {
    const hasTank = assembly.nodes.some((n) => {
      const pkg = pkgByKey.get(n.packageKey);
      return n.id.startsWith("tank_cylinder") || (pkg?.primitive?.shape === "cylinder" && pkg.primitive.lengthMm >= 120);
    });
    const hasNoseCone = assembly.nodes.some((n) => pkgByKey.get(n.packageKey)?.primitive?.shape === "cone" && !n.thruster);
    const hasYoke = assembly.nodes.some((n) => n.id.startsWith("gimbal_yoke") || pkgByKey.get(n.packageKey)?.primitive?.shape === "tube");
    const hasGimbalServo = assembly.nodes.some((n) => {
      const pkg = pkgByKey.get(n.packageKey);
      const j = pkg?.mechanics?.kind === "part" ? pkg.mechanics.joint : undefined;
      return n.id.startsWith("gimbal_servo") || (j?.type === "hinge" && Math.abs(j.axis[1]) > 0.5 && Math.abs(j.range[1] - j.range[0]) < 360);
    });
    const hasImpeller = assembly.nodes.some((n) => isPumpImpellerLike(n, pkgByKey.get(n.packageKey)));

    const inAirframePhase = hasTank || Boolean(options?.engineModuleSaved);
    if (!inAirframePhase) {
      phaseLabel = "第 1 阶段 / 2：从电机搭出电泵矢量发动机总成";
      const engineBuilt = hasYoke && pumpMotors.length >= 1 && hasGimbalServo && coupledNozzles.length >= 1;
      steps = [
        {
          id: "e1",
          title: "放置「发动机承力环 / 万向节架」（0 → 1）",
          hint: "先放承力桁架框，建立同轴泵舱位（pump_bay）与下方舵机挂载面。",
          done: hasYoke,
          suggestedBlockId: "gimbal_yoke",
          action: { kind: "block", blockId: "gimbal_yoke", label: "+放承力环" },
        },
        {
          id: "e2",
          title: "装入「高速无刷电机 (Z 轴)」作为涡轮泵原动机",
          hint: "这是火箭供流系统的真正动力源，负责驱动高压泵叶轮旋转。",
          done: bldcMotors.length >= 1,
          suggestedBlockId: "bldc_motor",
          action: { kind: "block", blockId: "bldc_motor", label: "+装无刷电机" },
        },
        {
          id: "e3",
          title: "电机轴端加装「离心涡轮泵叶轮」",
          hint: "把叶轮扣在无刷电机出轴端 shaft_tip，构成真正能泵送推进剂的电泵。",
          done: hasImpeller && pumpMotors.length >= 1,
          suggestedBlockId: "pump_impeller",
          action: { kind: "block", blockId: "pump_impeller", label: "+装泵叶轮" },
        },
        {
          id: "e4",
          title: "承力环下方挂「TVC 位置伺服舵机 (±20°)」",
          hint: "让喷管能够俯仰摆动推力方向，实现程序转弯与姿态平衡。",
          done: hasGimbalServo,
          suggestedBlockId: "gimbal_servo",
          action: { kind: "block", blockId: "gimbal_servo", label: "+挂伺服舵机" },
        },
        {
          id: "e5",
          title: "舵机底端装「纯拉瓦尔喷管」（由电泵转速激活）",
          hint: "无电机叶轮时它只有 0 N；挂入后将耦合刚才的无刷电机转速 ω 产生最高 85 N 推力。",
          done: coupledNozzles.length >= 1,
          suggestedBlockId: "laval_nozzle",
          action: { kind: "block", blockId: "laval_nozzle", label: "+装纯喷管" },
        },
        {
          id: "e6",
          title: "封装为「发动机总成」并进入第 2 阶段整箭总装",
          hint: "前 5 件装配完成后点击右侧按钮封装为可复用子总成模块，随后回到 0 件放贮箱并把发动机挂上去。",
          done: Boolean(options?.engineModuleSaved),
          ...(engineBuilt ? { action: { kind: "encapsulate_engine", label: "封装并进箭体总装" } } : {}),
        },
      ];
      return { def, steps, readyForSim: false, phaseLabel };
    }

    phaseLabel = "第 2 阶段 / 2：搭箭体并挂载发动机总成";
    const mountModuleId = options?.engineModuleId || "mod_epump_tvc_engine";
    steps = [
      {
        id: "k1",
        title: "放置「圆筒舱段 / 火箭贮箱」（建立箭体坐标系）",
        hint: "点击放上主推进剂贮箱作为整箭基准刚体。",
        done: hasTank,
        suggestedBlockId: "tank_cylinder",
        action: { kind: "block", blockId: "tank_cylinder", label: "+放贮箱" },
      },
      {
        id: "k2",
        title: "设为 6-DOF 自由底盘（允许重力学场离台）",
        hint: "把箭体切换为「自由落地底盘」，解除世界坐标固接。",
        done: model.baseMobility === "free",
        action: { kind: "set_free", label: "设自由底盘" },
      },
      {
        id: "k3",
        title: "贮箱顶部加装「气动整流罩 / 尖锥」",
        hint: "为箭体上方补齐气动头部与顶部追踪点。",
        done: hasNoseCone,
        suggestedBlockId: "nose_cone",
        action: { kind: "block", blockId: "nose_cone", label: "+装头锥" },
      },
      {
        id: "k4",
        title: "底部挂载刚刚封装的「电泵矢量发动机总成」",
        hint: "点右侧按钮把 5 合 1 发动机子总成直接挂在贮箱底部（也可连点挂多台并联！）",
        done: coupledNozzles.length >= 1 && pumpMotors.length >= 1,
        action: { kind: "attach_module", moduleId: mountModuleId, label: "+挂发动机总成" },
      },
      {
        id: "k5",
        title: `确认电泵有效 T/W > 1.2 且质心居中 (${effectiveTw.toFixed(2)})`,
        hint: "确认右侧物理模型呈现「推重比 > 1.2 且电泵电机已耦合」，立即进入 MuJoCo 点火升空！",
        done: coupledNozzles.length >= 1 && pumpMotors.length >= 1 && model.baseMobility === "free" && effectiveTw > 1.2 && Math.abs(model.comMm[0]) <= 12,
      },
    ];
  } else if (labId === "lab-rover") {
    steps = [
      {
        id: "r1",
        title: "放置车架基准板（从 0 → 1）",
        hint: "点击放置「带孔铝合金工作台板」作为四轮承载车架。",
        done: assembly.nodes.length >= 1,
        suggestedBlockId: "table_plate",
        action: { kind: "block", blockId: "table_plate", label: "+放车架" },
      },
      {
        id: "r2",
        title: "设为 6-DOF 自由底盘",
        hint: "切换为「自由落地底盘」，让车辆在重力下真实落到坡道上。",
        done: model.baseMobility === "free",
        action: { kind: "set_free", label: "设自由底盘" },
      },
      {
        id: "r3",
        title: `安装 4 套「轮毂驱动电机 → 纯橡胶轮胎」(${Math.min(4, motorizedWheels.length)}/4)`,
        hint: "每组由 1 台 Y 轴轮毂电机 + 1 只无动力橡胶胎构成，或直接调用「轮毂电驱车轮总成」对称安装 4 轮。",
        done: motorizedWheels.length >= 4 && hubMotorNodes.length >= 4,
        action: { kind: "attach_module", moduleId: "mod_wheel_drive_pod", label: "+装一套电驱轮" },
      },
      {
        id: "r4",
        title: `质量与库仑摩擦牵引锥达标 (${model.totalMassKg} kg)`,
        hint: "全车质量 ≤ 8.5 kg 且 4 轮全数受电机驱动后，点下方进入 MuJoCo 10° 坡道攀爬实测。",
        done: motorizedWheels.length >= 4 && model.baseMobility === "free" && model.totalMassKg > 0 && model.totalMassKg <= 8.5,
      },
    ];
  } else {
    steps = [
      {
        id: "c1",
        title: "放置机身承力架与 6-DOF 自由底盘",
        hint: "先放 1 件承力机身（如「发动机承力环 / 万向节架」或台板）并设为自由底盘。",
        done: assembly.nodes.length >= 1 && model.baseMobility === "free",
        suggestedBlockId: "gimbal_yoke",
        action: assembly.nodes.length === 0
          ? { kind: "block", blockId: "gimbal_yoke", label: "+放机身架" }
          : { kind: "set_free", label: "设自由底盘" },
      },
      {
        id: "c2",
        title: `装入 2 台高速无刷电机 + 2 副纯桨叶 (${Math.min(2, rotorBladesWithMotor.length)}/2)`,
        hint: "每副无源桨叶须挂在无刷电机 shaft_tip 上才能因 ω² 产生气动升力；也可用左侧「共轴双电机旋翼头」总成一步到位。",
        done: bldcMotors.length >= 2 && rotorBladesWithMotor.length >= 2,
        suggestedBlockId: bldcMotors.length <= rotorBladesWithMotor.length ? "bldc_motor" : "passive_blade",
        action:
          bldcMotors.length === 0 && rotorBladesWithMotor.length === 0
            ? { kind: "block", blockId: "bldc_motor", label: "+装无刷电机" }
            : bldcMotors.length > rotorBladesWithMotor.length
              ? { kind: "block", blockId: "passive_blade", label: "+装气动桨叶" }
              : { kind: "block", blockId: "bldc_motor", label: "+装第2电机" },
      },
      {
        id: "c3",
        title: "第 2 电机耦合 ratio = -1 抵消气动反扭",
        hint: "把第 2 台无刷电机耦合到第 1 台、传动比设为 -1，消除旋翼反扭扭矩引起的偏航打转。",
        done: hasCounterCouple,
        ...(bldcMotors.length >= 2 && !hasCounterCouple
          ? { action: { kind: "couple_counter_rotor", label: "一键设 ratio=-1" } }
          : {}),
      },
      {
        id: "c4",
        title: `满足气动升力 T/W > 1.15 且质心居中 (${effectiveTw.toFixed(2)})`,
        hint: "确认两路旋转升力与反扭抵消后，直接进入 MuJoCo 观察起飞与自稳状态。",
        done: rotorBladesWithMotor.length >= 2 && hasCounterCouple && model.baseMobility === "free" && effectiveTw > 1.15 && Math.abs(model.comMm[0]) <= 8,
      },
    ];
  }

  return {
    def,
    steps,
    readyForSim: steps.every((s) => s.done),
    ...(phaseLabel ? { phaseLabel } : {}),
  };
}
