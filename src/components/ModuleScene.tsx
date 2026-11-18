/**
 * ModuleScene — 参数化三维示意组件（命令式 Three.js + OrbitControls）。
 *
 * 依据模块类型与配置参数实时构建三类机电模块的示意模型：
 *  - linear_axis  丝杠直线进给轴：床身 / 导轨 / 丝杠 / 滑台
 *  - rotary_joint 伺服减速旋转关节：基座 / 关节 / 连杆 / 法兰
 *  - drive_wheel  电机减速驱动轮：电机 / 减速器 / 轮毂 / 轮胎
 *
 * 注意：模型仅按配置做视觉比例缩放，用于方案沟通，非制造级 CAD。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ModuleKey = 'linear_axis' | 'rotary_joint' | 'drive_wheel';

export interface ModuleSceneProps {
  moduleKey: ModuleKey;
  configuration: Record<string, number>;
  instanceName?: string;
  className?: string;
}

const ACCENT = 0x5eead4; // 薄荷绿强调色
const ACCENT_CSS = '#5eead4';
const BG_COLOR = '#0c111c';
const DPR_CAP = 2;

const MODULE_LABEL: Record<ModuleKey, string> = {
  linear_axis: '丝杠直线进给轴',
  rotary_joint: '伺服减速旋转关节',
  drive_wheel: '电机减速驱动轮',
};

function cfgNum(configuration: Record<string, number>, key: string, fallback: number): number {
  const v = configuration[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function fmtNum(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

/** 汇总某模块在 HTML 面板中展示的关键尺寸（仅展示，不重复计算逻辑）。 */
function specLines(moduleKey: ModuleKey, c: Record<string, number>): string[] {
  switch (moduleKey) {
    case 'linear_axis':
      return [
        `有效行程 ${fmtNum(cfgNum(c, 'travelMm', 500), 0)} mm`,
        `丝杠导程 ${fmtNum(cfgNum(c, 'leadMm', 10), 1)} mm/rev`,
        `最大速度 ${fmtNum(cfgNum(c, 'maxSpeedMmS', 250), 0)} mm/s`,
      ];
    case 'rotary_joint':
      return [
        `等效负载 ${fmtNum(cfgNum(c, 'loadKg', 12), 1)} kg`,
        `质心半径 ${fmtNum(cfgNum(c, 'centerOfMassM', 0.45), 2)} m`,
        `减速比 ${fmtNum(cfgNum(c, 'gearRatio', 80), 0)} : 1`,
      ];
    case 'drive_wheel':
      return [
        `轮半径 ${fmtNum(cfgNum(c, 'wheelRadiusM', 0.1), 3)} m`,
        `最高车速 ${fmtNum(cfgNum(c, 'maxSpeedMS', 1.2), 1)} m/s`,
        `减速比 ${fmtNum(cfgNum(c, 'gearRatio', 30), 0)} : 1`,
      ];
  }
}

// ---------------------------------------------------------------------------
// 构建上下文：统一登记可释放资源与可做线框切换的材质
// ---------------------------------------------------------------------------

interface BuildContext {
  disposables: Array<{ dispose(): void }>;
  paintables: THREE.MeshStandardMaterial[];
  track<T extends { dispose(): void }>(res: T): T;
  mat(color: number, opts?: { metalness?: number; roughness?: number; emissive?: number }): THREE.MeshStandardMaterial;
}

function createBuildContext(): BuildContext {
  const disposables: Array<{ dispose(): void }> = [];
  const paintables: THREE.MeshStandardMaterial[] = [];
  const track = <T extends { dispose(): void }>(res: T): T => {
    disposables.push(res);
    return res;
  };
  const mat: BuildContext['mat'] = (color, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      metalness: opts.metalness ?? 0.35,
      roughness: opts.roughness ?? 0.55,
      emissive: opts.emissive ?? 0x000000,
    });
    paintables.push(m);
    disposables.push(m);
    return m;
  };
  return { disposables, paintables, track, mat };
}

type Axis = 'x' | 'y' | 'z';

function box(ctx: BuildContext, w: number, h: number, d: number, material: THREE.Material): THREE.Mesh {
  const geo = ctx.track(new THREE.BoxGeometry(w, h, d));
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(
  ctx: BuildContext,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  material: THREE.Material,
  axis: Axis = 'y',
  segments = 40,
): THREE.Mesh {
  const geo = ctx.track(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments));
  if (axis === 'x') geo.rotateZ(Math.PI / 2);
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 简洁尺寸线：主线 + 两端刻度，返回中点锚点供 HTML 标签跟随。 */
function makeDimension(
  ctx: BuildContext,
  from: THREE.Vector3,
  to: THREE.Vector3,
): { object: THREE.LineSegments; anchor: THREE.Object3D } {
  const dir = to.clone().sub(from).normalize();
  const perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
  if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1);
  perp.normalize().multiplyScalar(0.07);
  const pts = [
    from.clone(), to.clone(),
    from.clone().sub(perp), from.clone().add(perp),
    to.clone().sub(perp), to.clone().add(perp),
  ];
  const geo = ctx.track(new THREE.BufferGeometry().setFromPoints(pts));
  const material = ctx.track(new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 }));
  const object = new THREE.LineSegments(geo, material);
  const anchor = new THREE.Object3D();
  anchor.position.copy(from).lerp(to, 0.5);
  return { object, anchor };
}

interface BuiltModule {
  root: THREE.Group;
  /** t 为运动累计时间（暂停时冻结），dt 为帧间隔，playing 表示是否在播放。 */
  animate: (t: number, dt: number, playing: boolean) => void;
  labelAnchor: THREE.Object3D;
  labelText: string;
}

// ---------------------------------------------------------------------------
// 三类参数化模型构建
// ---------------------------------------------------------------------------

function buildLinearAxis(ctx: BuildContext, c: Record<string, number>): BuiltModule {
  const travelMm = THREE.MathUtils.clamp(cfgNum(c, 'travelMm', 500), 10, 10000);
  const leadMm = THREE.MathUtils.clamp(cfgNum(c, 'leadMm', 10), 0.5, 100);
  // 场景长度：行程毫米数按比例映射并夹取，保证极小/极大行程均可读（示意缩放）
  const len = THREE.MathUtils.clamp(travelMm / 1000, 0.4, 3.6);

  const root = new THREE.Group();
  const bedMat = ctx.mat(0x465463, { metalness: 0.45, roughness: 0.5 });
  const steelMat = ctx.mat(0x8a97a6, { metalness: 0.65, roughness: 0.35 });
  const screwMat = ctx.mat(0xb8c4d0, { metalness: 0.8, roughness: 0.25 });
  const accentMat = ctx.mat(ACCENT, { metalness: 0.25, roughness: 0.4, emissive: 0x0b3a32 });

  // 床身与床脚
  const bed = box(ctx, len + 0.7, 0.2, 0.95, bedMat);
  bed.position.y = 0.34;
  root.add(bed);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const foot = box(ctx, 0.2, 0.24, 0.2, bedMat);
      foot.position.set(sx * (len / 2 + 0.2), 0.12, sz * 0.32);
      root.add(foot);
    }
  }

  // 双导轨
  for (const sz of [-1, 1]) {
    const rail = box(ctx, len + 0.3, 0.09, 0.13, steelMat);
    rail.position.set(0, 0.485, sz * 0.28);
    root.add(rail);
  }

  // 丝杠（两端轴承座支撑）与驱动电机
  const screw = cyl(ctx, 0.055, 0.055, len, screwMat, 'x');
  screw.position.set(0, 0.53, 0);
  root.add(screw);
  for (const sx of [-1, 1]) {
    const support = box(ctx, 0.16, 0.26, 0.32, bedMat);
    support.position.set(sx * (len / 2 + 0.12), 0.57, 0);
    root.add(support);
  }
  const motor = cyl(ctx, 0.14, 0.14, 0.3, bedMat, 'x');
  motor.position.set(-(len / 2 + 0.36), 0.53, 0);
  root.add(motor);
  const motorRing = cyl(ctx, 0.15, 0.15, 0.04, accentMat, 'x');
  motorRing.position.set(-(len / 2 + 0.22), 0.53, 0);
  root.add(motorRing);

  // 滑台：滑板 + 四个滑块 + 丝杠螺母
  const table = new THREE.Group();
  const plate = box(ctx, 0.55, 0.09, 0.78, accentMat);
  plate.position.y = 0.655;
  table.add(plate);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const slider = box(ctx, 0.2, 0.08, 0.16, steelMat);
      slider.position.set(sx * 0.18, 0.57, sz * 0.28);
      table.add(slider);
    }
  }
  const nut = box(ctx, 0.18, 0.15, 0.18, screwMat);
  nut.position.set(0, 0.53, 0);
  table.add(nut);
  root.add(table);

  // 行程尺寸线（前置，避免与模型重叠）
  const dim = makeDimension(
    ctx,
    new THREE.Vector3(-len / 2, 0.5, 0.62),
    new THREE.Vector3(len / 2, 0.5, 0.62),
  );
  root.add(dim.object, dim.anchor);

  // 动画：滑台按行程往复，丝杠/电机随导程关系同步转动
  const amplitude = Math.max(len / 2 - 0.42, 0.05);
  const period = 4; // 秒，示意速度
  const animate: BuiltModule['animate'] = (t) => {
    const x = amplitude * Math.sin((t * Math.PI * 2) / period);
    table.position.x = x;
    const revolutions = (x * (travelMm / len)) / leadMm;
    screw.rotation.x = revolutions * Math.PI * 2;
    motor.rotation.x = screw.rotation.x;
  };

  return {
    root,
    animate,
    labelAnchor: dim.anchor,
    labelText: `有效行程 ${fmtNum(travelMm, 0)} mm`,
  };
}

function buildRotaryJoint(ctx: BuildContext, c: Record<string, number>): BuiltModule {
  const comM = THREE.MathUtils.clamp(cfgNum(c, 'centerOfMassM', 0.45), 0.01, 5);
  const loadKg = THREE.MathUtils.clamp(cfgNum(c, 'loadKg', 12), 0.01, 2000);
  const gearRatio = THREE.MathUtils.clamp(cfgNum(c, 'gearRatio', 80), 1, 1000);
  const armLen = THREE.MathUtils.clamp(comM * 1.6, 0.5, 2.4);
  const visRatio = Math.min(Math.max(gearRatio, 2), 10); // 视觉化的电机-输出转速差

  const root = new THREE.Group();
  const baseMat = ctx.mat(0x2b3442, { metalness: 0.5, roughness: 0.5 });
  const housingMat = ctx.mat(0x8a97a6, { metalness: 0.65, roughness: 0.35 });
  const accentMat = ctx.mat(ACCENT, { metalness: 0.25, roughness: 0.4, emissive: 0x0b3a32 });
  const payloadMat = ctx.mat(0xd8b36a, { metalness: 0.2, roughness: 0.6 });

  // 基座
  const base = cyl(ctx, 0.62, 0.7, 0.18, baseMat);
  base.position.y = 0.09;
  root.add(base);
  const pedestal = cyl(ctx, 0.42, 0.5, 0.35, baseMat);
  pedestal.position.y = 0.355;
  root.add(pedestal);

  // 关节（回转部分整体绕竖直轴摆动）
  const yaw = new THREE.Group();
  yaw.position.y = 0.53;
  root.add(yaw);

  const housing = cyl(ctx, 0.36, 0.4, 0.42, housingMat);
  housing.position.y = 0.21;
  yaw.add(housing);
  const jointRing = ctx.track(new THREE.TorusGeometry(0.37, 0.03, 16, 48));
  const ring = new THREE.Mesh(jointRing, accentMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.42;
  ring.castShadow = true;
  yaw.add(ring);

  // 关节侧置电机及其输出轴（高速转动以示意减速传动）
  const motor = cyl(ctx, 0.16, 0.16, 0.42, baseMat, 'z');
  motor.position.set(0, 0.21, -0.58);
  yaw.add(motor);
  const motorShaft = cyl(ctx, 0.05, 0.05, 0.1, accentMat, 'z');
  motorShaft.position.set(0, 0.21, -0.82);
  yaw.add(motorShaft);

  // 连杆
  const armGroup = new THREE.Group();
  armGroup.position.y = 0.5;
  yaw.add(armGroup);
  const arm = box(ctx, armLen, 0.16, 0.22, housingMat);
  arm.position.set(armLen / 2, 0.08, 0);
  armGroup.add(arm);

  // 法兰（含安装孔圈）与负载示意块
  const flange = cyl(ctx, 0.17, 0.17, 0.1, accentMat);
  flange.position.set(armLen, 0.08, 0);
  armGroup.add(flange);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const bolt = cyl(ctx, 0.018, 0.018, 0.12, baseMat, 'y', 12);
    bolt.position.set(armLen + Math.cos(a) * 0.12, 0.08, Math.sin(a) * 0.12);
    armGroup.add(bolt);
  }
  const payloadSize = THREE.MathUtils.clamp(0.12 + Math.cbrt(loadKg) * 0.05, 0.15, 0.45);
  const payload = box(ctx, payloadSize, payloadSize, payloadSize, payloadMat);
  payload.position.set(armLen, 0.08 + 0.05 + payloadSize / 2, 0);
  armGroup.add(payload);

  // 连杆长度尺寸线（随关节一起回转）
  const dim = makeDimension(
    ctx,
    new THREE.Vector3(0, 0.28, 0.42),
    new THREE.Vector3(armLen, 0.28, 0.42),
  );
  yaw.add(dim.object, dim.anchor);

  // 动画：关节 ±75° 摆动，电机轴按示意减速比高速旋转
  let shaftAngle = 0;
  const animate: BuiltModule['animate'] = (t, dt, playing) => {
    yaw.rotation.y = THREE.MathUtils.degToRad(75) * Math.sin((t * Math.PI * 2) / 5);
    if (playing) shaftAngle += dt * visRatio * 1.6;
    motorShaft.rotation.z = shaftAngle;
  };

  return {
    root,
    animate,
    labelAnchor: dim.anchor,
    labelText: `质心半径 ${fmtNum(comM, 2)} m`,
  };
}

function buildDriveWheel(ctx: BuildContext, c: Record<string, number>): BuiltModule {
  const wheelRadiusM = THREE.MathUtils.clamp(cfgNum(c, 'wheelRadiusM', 0.1), 0.01, 2);
  const gearRatio = THREE.MathUtils.clamp(cfgNum(c, 'gearRatio', 30), 1, 1000);
  const wheelR = THREE.MathUtils.clamp(wheelRadiusM * 6, 0.5, 1.7);
  const width = wheelR * 0.5;
  const visRatio = Math.min(Math.max(gearRatio, 2), 10);

  const root = new THREE.Group();
  const rubberMat = ctx.mat(0x1a1f26, { metalness: 0.05, roughness: 0.9 });
  const steelMat = ctx.mat(0x8a97a6, { metalness: 0.65, roughness: 0.35 });
  const baseMat = ctx.mat(0x2b3442, { metalness: 0.5, roughness: 0.5 });
  const accentMat = ctx.mat(ACCENT, { metalness: 0.25, roughness: 0.4, emissive: 0x0b3a32 });

  // 轮组（轮胎 + 胎面 + 轮毂 + 辐条），绕车轴（Z 轴）转动
  const wheel = new THREE.Group();
  wheel.position.y = wheelR;
  root.add(wheel);

  const tire = cyl(ctx, wheelR, wheelR, width, rubberMat, 'z', 56);
  wheel.add(tire);
  for (let i = 0; i < 18; i += 1) {
    const a = (i / 18) * Math.PI * 2;
    const tread = box(ctx, wheelR * 0.24, 0.05, width * 1.04, rubberMat);
    tread.position.set(Math.cos(a) * (wheelR + 0.01), Math.sin(a) * (wheelR + 0.01), 0);
    tread.rotation.z = a + Math.PI / 2;
    wheel.add(tread);
  }
  const rim = cyl(ctx, wheelR * 0.55, wheelR * 0.55, width * 0.82, steelMat, 'z');
  wheel.add(rim);
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2;
    const spoke = box(ctx, wheelR * 0.5, wheelR * 0.1, width * 0.86, steelMat);
    spoke.position.set(Math.cos(a) * wheelR * 0.28, Math.sin(a) * wheelR * 0.28, 0);
    spoke.rotation.z = a;
    wheel.add(spoke);
  }
  const hubCap = cyl(ctx, wheelR * 0.18, wheelR * 0.18, width * 0.92, accentMat, 'z');
  wheel.add(hubCap);

  // 减速器与电机（固定在车架侧，不随轮转动）
  const gearbox = box(ctx, wheelR * 0.7, wheelR * 0.7, 0.4, baseMat);
  gearbox.position.set(0, wheelR, width / 2 + 0.24);
  root.add(gearbox);
  const motor = cyl(ctx, wheelR * 0.3, wheelR * 0.3, wheelR * 0.75, steelMat, 'z');
  motor.position.set(0, wheelR, width / 2 + 0.44 + wheelR * 0.375);
  root.add(motor);
  const motorShaft = cyl(ctx, wheelR * 0.08, wheelR * 0.08, 0.12, accentMat, 'z');
  motorShaft.position.set(0, wheelR, width / 2 + 0.5 + wheelR * 0.75);
  root.add(motorShaft);

  // 悬挂臂与车架板（示意安装关系）
  for (const sz of [-1, 1]) {
    const armLink = box(ctx, wheelR * 1.1, 0.08, 0.12, baseMat);
    armLink.position.set(0, wheelR + wheelR * 0.55, sz * (width / 2 - 0.02));
    armLink.rotation.z = 0.45;
    root.add(armLink);
  }
  const chassis = box(ctx, wheelR * 1.7, 0.09, width + 0.5, baseMat);
  chassis.position.y = wheelR * 2 + 0.42;
  root.add(chassis);

  // 轮半径尺寸线（置于轮侧，圆心到地面）
  const dim = makeDimension(
    ctx,
    new THREE.Vector3(wheelR + 0.45, 0, -width / 2 - 0.15),
    new THREE.Vector3(wheelR + 0.45, wheelR, -width / 2 - 0.15),
  );
  root.add(dim.object, dim.anchor);

  // 动画：车轮持续转动，电机轴按示意减速比高速转动
  let wheelAngle = 0;
  let shaftAngle = 0;
  const animate: BuiltModule['animate'] = (_t, dt, playing) => {
    if (playing) {
      wheelAngle += dt * 1.4;
      shaftAngle += dt * 1.4 * visRatio;
    }
    wheel.rotation.z = -wheelAngle;
    motorShaft.rotation.z = -shaftAngle;
  };

  return {
    root,
    animate,
    labelAnchor: dim.anchor,
    labelText: `轮半径 ${fmtNum(wheelRadiusM, 3)} m`,
  };
}

function buildModule(moduleKey: ModuleKey, ctx: BuildContext, c: Record<string, number>): BuiltModule {
  switch (moduleKey) {
    case 'linear_axis':
      return buildLinearAxis(ctx, c);
    case 'rotary_joint':
      return buildRotaryJoint(ctx, c);
    case 'drive_wheel':
      return buildDriveWheel(ctx, c);
  }
}

// ---------------------------------------------------------------------------
// React 组件
// ---------------------------------------------------------------------------

/** 暴露给按钮控件的会话句柄（不触发 React 重渲染）。 */
interface SceneSession {
  setPlaying(next: boolean): void;
  setWireframe(next: boolean): void;
  resetView(): void;
}

const buttonStyle = (active: boolean): React.CSSProperties => ({
  pointerEvents: 'auto',
  padding: '6px 12px',
  fontSize: 12,
  lineHeight: '16px',
  color: active ? '#06231d' : ACCENT_CSS,
  background: active ? ACCENT_CSS : 'rgba(12, 17, 28, 0.72)',
  border: `1px solid ${ACCENT_CSS}`,
  borderRadius: 6,
  cursor: 'pointer',
  backdropFilter: 'blur(4px)',
});

export default function ModuleScene({ moduleKey, configuration, instanceName, className }: ModuleSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<SceneSession | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isWireframe, setIsWireframe] = useState(false);

  const configKey = JSON.stringify(configuration ?? {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- 渲染器（WebGL 失败时降级为文本提示） ---
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setWebglError('当前浏览器或设备无法初始化 WebGL，三维示意预览不可用；参数与工程计算结果不受影响。');
      return;
    }
    setWebglError(null);
    renderer.setClearColor(BG_COLOR);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    // --- 场景 / 相机 / 控制器 ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);
    scene.fog = new THREE.Fog(BG_COLOR, 14, 30);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false; // 自动旋转默认关闭
    controls.minDistance = 0.8;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI * 0.52;

    // --- 柔和光照 ---
    const ctx = createBuildContext();
    const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x1a2230, 1.1);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(5, 8, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    key.shadow.bias = -0.0004;
    scene.add(key);
    const rim = new THREE.DirectionalLight(ACCENT, 0.35);
    rim.position.set(-6, 3, -5);
    scene.add(rim);

    // --- 网格地面与接影平面 ---
    const grid = new THREE.GridHelper(24, 48, 0x2dd4bf, 0x1c2736);
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.35;
    ctx.track(gridMat);
    ctx.track(grid.geometry);
    scene.add(grid);
    const shadowPlane = new THREE.Mesh(
      ctx.track(new THREE.PlaneGeometry(24, 24)),
      ctx.track(new THREE.ShadowMaterial({ opacity: 0.35 })),
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // --- 参数化模型 ---
    const built = buildModule(moduleKey, ctx, configuration ?? {});
    scene.add(built.root);

    // --- 相机初始机位（按包围球自适应） ---
    const bounds = new THREE.Box3().setFromObject(built.root);
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const homeTarget = sphere.center.clone().add(new THREE.Vector3(0, sphere.radius * 0.1, 0));
    const homePosition = homeTarget
      .clone()
      .add(new THREE.Vector3(1.1, 0.75, 1.5).normalize().multiplyScalar(sphere.radius * 2.2 + 0.9));
    camera.position.copy(homePosition);
    controls.target.copy(homeTarget);
    controls.update();

    // --- HTML 尺寸标签 ---
    const labelEl = labelRef.current;
    if (labelEl) labelEl.textContent = built.labelText;
    const proj = new THREE.Vector3();
    const updateLabel = () => {
      if (!labelEl) return;
      built.labelAnchor.getWorldPosition(proj);
      proj.project(camera);
      if (proj.z > 1 || proj.z < -1) {
        labelEl.style.display = 'none';
        return;
      }
      labelEl.style.display = 'block';
      labelEl.style.left = `${(proj.x * 0.5 + 0.5) * mount.clientWidth}px`;
      labelEl.style.top = `${(-proj.y * 0.5 + 0.5) * mount.clientHeight}px`;
    };

    // --- 尺寸自适应（ResizeObserver + 设备像素比上限） ---
    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
      renderer.setSize(w, h, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    // --- 动画循环（RAF） ---
    let playing = !reducedMotion; // 尊重 reduced-motion：默认暂停
    let motionTime = 0;
    let rafId = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (playing) motionTime += dt;
      built.animate(motionTime, dt, playing);
      controls.update();
      updateLabel();
      renderer.render(scene, camera);
    };
    tick();

    // --- 控件会话 ---
    setIsPlaying(playing);
    setIsWireframe(false);
    sessionRef.current = {
      setPlaying(next) {
        playing = next;
      },
      setWireframe(next) {
        for (const m of ctx.paintables) m.wireframe = next;
      },
      resetView() {
        camera.position.copy(homePosition);
        controls.target.copy(homeTarget);
        controls.update();
      },
    };

    // --- 卸载：取消 RAF、断开观察器、释放全部 GPU 资源 ---
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      controls.dispose();
      sessionRef.current = null;
      for (const d of ctx.disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
    // configuration 以序列化结果作为依赖，避免父组件内联对象导致频繁重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, configKey]);

  const togglePlay = () => {
    const next = !isPlaying;
    sessionRef.current?.setPlaying(next);
    setIsPlaying(next);
  };
  const toggleWireframe = () => {
    const next = !isWireframe;
    sessionRef.current?.setWireframe(next);
    setIsWireframe(next);
  };
  const resetView = () => {
    sessionRef.current?.resetView();
  };

  const title = `${MODULE_LABEL[moduleKey]}${instanceName ? ` · ${instanceName}` : ''}`;

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 320,
        overflow: 'hidden',
        borderRadius: 8,
        background: BG_COLOR,
      }}
    >
      {webglError ? (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
            color: '#9fb3c8',
            fontSize: 14,
            lineHeight: '22px',
          }}
        >
          {webglError}
        </div>
      ) : (
        <>
          <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

          {/* 跟随尺寸线的 HTML 标签 */}
          <div
            ref={labelRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              display: 'none',
              transform: 'translate(-50%, -160%)',
              pointerEvents: 'none',
              padding: '2px 8px',
              fontSize: 11,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              color: ACCENT_CSS,
              background: 'rgba(12, 17, 28, 0.78)',
              border: `1px solid rgba(94, 234, 212, 0.45)`,
              borderRadius: 4,
            }}
          />

          {/* 信息面板 */}
          <div
            style={{
              position: 'absolute',
              left: 12,
              top: 12,
              pointerEvents: 'none',
              padding: '8px 12px',
              color: '#c8d6e5',
              background: 'rgba(12, 17, 28, 0.72)',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 6,
              backdropFilter: 'blur(4px)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: ACCENT_CSS, marginBottom: 4 }}>{title}</div>
            {specLines(moduleKey, configuration ?? {}).map((line) => (
              <div key={line} style={{ fontSize: 11, lineHeight: '17px' }}>
                {line}
              </div>
            ))}
            <div style={{ fontSize: 10, lineHeight: '15px', color: '#64748b', marginTop: 4 }}>
              参数化示意模型 · 非制造级 CAD
            </div>
          </div>

          {/* 控件：播放/暂停、复位视角、线框/实体 */}
          <div
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              display: 'flex',
              gap: 8,
            }}
          >
            <button type="button" onClick={togglePlay} aria-pressed={isPlaying} style={buttonStyle(false)}>
              {isPlaying ? '暂停运动' : '播放运动'}
            </button>
            <button type="button" onClick={resetView} style={buttonStyle(false)}>
              复位视角
            </button>
            <button type="button" onClick={toggleWireframe} aria-pressed={isWireframe} style={buttonStyle(isWireframe)}>
              {isWireframe ? '实体显示' : '线框显示'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
