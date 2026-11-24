import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Blocks,
  Camera,
  Check,
  CheckCircle2,
  Compass,
  Download,
  Eye,
  FolderOpen,
  Info,
  Layers,
  Link2,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { solveArticulatedAssembly } from "@contracts/articulated-kinematics";
import { parseImportCatalog, type ModelRef } from "@contracts/import-catalog";
import {
  analyzeMachinePhysics,
  buildGantryMillTemplate,
  encapsulateSubtreeModule,
  encapsulateUserModule,
  MODULE_BLUEPRINTS,
  snapModuleOntoAssembly,
  type CustomModuleRecord,
} from "@contracts/machine-evolution";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { upsertMechanicalAssembly } from "@contracts/mechanical-assembly";
import { compileAssemblyToMujoco } from "@contracts/mujoco-compiler";
import {
  deriveAssemblyPhysicsModel,
  evaluateFromZeroLab,
  type FromZeroLabAction,
  type FromZeroLabId,
} from "@contracts/physics-explainer";
import { primitiveBoundingBoxMm, type AxisDir, type PrimitiveFinish } from "@contracts/primitive-parts";
import {
  addAssemblyClosure,
  attachCustomPackageToSandbox,
  buildAssemblyTreeRows,
  convertSandboxToSystemTwin,
  createChallengeStarter,
  createZeroBlankSandbox,
  deleteSandboxMachineFromWorkspace,
  extractSandboxBomSummary,
  findBestSnapTarget,
  listSavedSandboxMachines,
  loadSandboxMachineFromWorkspace,
  placeRootBlockInSandbox,
  REAL_VENDOR_BOM_PRESETS,
  removeAssemblyClosure,
  removeSandboxNode,
  SANDBOX_BLOCKS,
  sandboxBomToCsv,
  saveSandboxMachineToWorkspace,
  setAssemblyBaseMobility,
  snapBlockOntoAssembly,
  updateSandboxNode,
  type SandboxChallengeDef,
} from "@contracts/sandbox-challenges";
import { type StudioRoute } from "@contracts/studio-navigation";
import { packageKey } from "@contracts/twin-device";
import { parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import { loadUniversalArchetype } from "@contracts/universal-archetypes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IS_PAGES } from "@/const";
import { downloadBlob } from "@/lib/download";
import { describeModel, putModelBundle } from "@/lib/model-files";
import PrimitivePartCreator from "./PrimitivePartCreator";
import { SandboxBlockIcon } from "./SandboxBlockIcon";
import SandboxViewport3D from "./SandboxViewport3D";
import StudioStartGallery, { type ShowcaseTemplateId } from "./StudioStartGallery";
import { VisionIntakePanel } from "./VisionIntakePanel";

const MujocoSandboxArena = lazy(() => import("./MujocoSandboxArena"));

export interface SandboxBuilderStudioProps {
  workspace: TwinWorkspace;
  initialChallengeId?: string;
  onSaveWorkspace: (next: TwinWorkspace) => void;
  onNavigate: (route: StudioRoute, message?: string) => void;
}

type StudioStage = "start" | "build" | "simulate";
type PaletteFilter = "all" | "frame" | "motion" | "actuator" | "modules";

interface MachineEditorSession {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  commands: Record<string, number>;
  dirty: boolean;
  history: Array<{ workspace: TwinWorkspace; assembly: MechanicalAssembly }>;
}

const CUSTOM_MODULES_KEY = "gouyuan.custom_modules.v1";

const LEGACY_CHALLENGE_IDS: ReadonlySet<string> = new Set([
  "level-1-axis",
  "level-2-xy-stage",
  "level-3-cnc-mill",
  "level-4-robot-arm",
]);

const FILTER_TABS: ReadonlyArray<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "frame", label: "骨架" },
  { id: "motion", label: "关节" },
  { id: "actuator", label: "动力" },
  { id: "modules", label: "总成" },
];

const FINISH_EDIT_OPTIONS: Array<{ value: PrimitiveFinish; label: string }> = [
  { value: "aluminum", label: "铝合金本色" },
  { value: "anodized_black", label: "黑色阳极氧化" },
  { value: "steel", label: "碳钢 / 不锈钢" },
  { value: "brass", label: "铜合金" },
  { value: "spindle_red", label: "工业红漆" },
  { value: "workpiece_alloy", label: "毛坯灰绿" },
  { value: "sensor_amber", label: "传感琥珀色" },
  { value: "rubber_grip", label: "高摩擦橡胶" },
  { value: "aerospace_white", label: "航天白色复合" },
  { value: "pearl_crimson", label: "黛紫红金属板" },
  { value: "concrete_gray", label: "清水混凝土灰" },
  { value: "curtain_glass", label: "冰蓝玻璃幕墙" },
];

const formatNum = (v: number) => Number(v.toFixed(1)).toString();

function readCustomModules(): CustomModuleRecord[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_MODULES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomModuleRecord[]) : [];
  } catch {
    return [];
  }
}

function writeCustomModules(mods: readonly CustomModuleRecord[]): void {
  try {
    window.localStorage.setItem(CUSTOM_MODULES_KEY, JSON.stringify(mods));
  } catch {
    // ignore storage quota errors
  }
}

function getPrimaryLengthMm(
  bbox?: ReturnType<typeof primitiveBoundingBoxMm>,
  rawSpec?: Record<string, unknown>,
): number | undefined {
  if (!rawSpec) return bbox?.[0];
  if (typeof rawSpec.lengthMm === "number") return rawSpec.lengthMm;
  if (typeof rawSpec.railLengthMm === "number") return rawSpec.railLengthMm;
  if (typeof rawSpec.widthMm === "number") return rawSpec.widthMm;
  if (typeof rawSpec.bodyLengthMm === "number") return rawSpec.bodyLengthMm;
  return bbox?.[0];
}

function makeInitialSession(initialChallengeId?: string): { stage: StudioStage; session: MachineEditorSession } {
  if (initialChallengeId === "free-sandbox") {
    const zero = createZeroBlankSandbox();
    return {
      stage: "build",
      session: { workspace: zero.workspace, assembly: zero.assembly, commands: {}, dirty: false, history: [] },
    };
  }
  if (initialChallengeId && LEGACY_CHALLENGE_IDS.has(initialChallengeId)) {
    const starter = createChallengeStarter(initialChallengeId as SandboxChallengeDef["id"]);
    return {
      stage: "build",
      session: {
        workspace: starter.workspace,
        assembly: starter.assembly,
        commands: { ...starter.assembly.commands },
        dirty: false,
        history: [],
      },
    };
  }
  const preset = loadUniversalArchetype("reusable-tvc-rocket");
  return {
    stage: "start",
    session: {
      workspace: preset.workspace,
      assembly: preset.assembly,
      commands: { ...preset.assembly.commands },
      dirty: false,
      history: [],
    },
  };
}

export default function SandboxBuilderStudio({
  workspace,
  initialChallengeId,
  onSaveWorkspace,
  onNavigate,
}: SandboxBuilderStudioProps) {
  const initialState = useMemo(() => makeInitialSession(initialChallengeId), [initialChallengeId]);

  const [stage, setStage] = useState<StudioStage>(initialState.stage);
  const [session, setSession] = useState<MachineEditorSession>(initialState.session);
  const [customModules, setCustomModules] = useState<CustomModuleRecord[]>(readCustomModules);
  const [encapsulateDraft, setEncapsulateDraft] = useState("");

  // Guided lab state
  const [fromZeroLabId, setFromZeroLabId] = useState<FromZeroLabId | "">("");
  const [labEngineModuleId, setLabEngineModuleId] = useState("");

  // 3D viewport & part editor state
  const [xrayMode, setXrayMode] = useState(false);
  const [explodePct, setExplodePct] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [preferredParentId, setPreferredParentId] = useState("");
  const [armedItem, setArmedItem] = useState<{ kind: "block" | "module" | "custom"; id: string } | null>(null);
  const [paletteFilter, setPaletteFilter] = useState<PaletteFilter>("all");
  const [hoverHint, setHoverHint] = useState("");
  const [outlinerOpen, setOutlinerOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<"left" | "right">("left");
  const [fitToken, setFitToken] = useState(1);

  // Selected part secondary drafts
  const [customWidthInput, setCustomWidthInput] = useState("");
  const [customMassInput, setCustomMassInput] = useState("");
  const [thrusterDraftN, setThrusterDraftN] = useState("");
  const [coupleTargetDraft, setCoupleTargetDraft] = useState("");
  const [coupleRatioDraft, setCoupleRatioDraft] = useState("-1");

  // Closure builder drafts
  const [closureNodeA, setClosureNodeA] = useState("");
  const [closureNodeB, setClosureNodeB] = useState("");
  const [closureKind, setClosureKind] = useState<"connect" | "weld" | "spring">("connect");

  // Modals & transient feedback
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [bomOpen, setBomOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [customCreatorOpen, setCustomCreatorOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState("");
  const [saveFeedback, setSaveFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    writeCustomModules(customModules);
  }, [customModules]);

  useEffect(() => {
    if (!saveFeedback) return;
    const timer = window.setTimeout(() => setSaveFeedback(""), 2400);
    return () => window.clearTimeout(timer);
  }, [saveFeedback]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setArmedItem(null);
        setPreferredParentId("");
        setHoverHint("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const solved = useMemo(
    () =>
      solveArticulatedAssembly(session.workspace, session.assembly, {
        commandOverrides: session.commands,
        explodeFactor: explodePct / 100,
      }),
    [session.workspace, session.assembly, session.commands, explodePct],
  );

  const treeRows = useMemo(
    () => buildAssemblyTreeRows(session.workspace, session.assembly, solved),
    [session.workspace, session.assembly, solved],
  );

  const bomRows = useMemo(
    () => extractSandboxBomSummary(session.workspace, session.assembly),
    [session.workspace, session.assembly],
  );

  const savedMachines = useMemo(() => listSavedSandboxMachines(workspace), [workspace]);

  const livePhysics = useMemo(
    () => analyzeMachinePhysics(session.workspace, session.assembly),
    [session.workspace, session.assembly],
  );

  const physicsModel = useMemo(
    () => deriveAssemblyPhysicsModel(session.workspace, session.assembly, selectedNodeId),
    [session.workspace, session.assembly, selectedNodeId],
  );

  const activeLabEval = useMemo(
    () =>
      fromZeroLabId
        ? evaluateFromZeroLab(fromZeroLabId, session.workspace, session.assembly, physicsModel, {
            engineModuleSaved: Boolean(labEngineModuleId),
            engineModuleId: labEngineModuleId || undefined,
          })
        : null,
    [fromZeroLabId, session.workspace, session.assembly, physicsModel, labEngineModuleId],
  );

  const filteredBlocks = useMemo(
    () =>
      paletteFilter === "all" || paletteFilter === "modules"
        ? SANDBOX_BLOCKS
        : SANDBOX_BLOCKS.filter((b) => b.category === paletteFilter),
    [paletteFilter],
  );

  const physicsHighlight = useMemo(
    () => ({
      overloadedNodeIds: livePhysics.overloadedNodeIds,
      columnDeflectionUm: livePhysics.columnDeflectionUm,
      cuttingForceN: livePhysics.cuttingForceN,
      thrustForceN: livePhysics.thrustForceN,
      hasSpindle: livePhysics.hasSpindle,
    }),
    [livePhysics],
  );

  const pushSessionUpdate = useCallback((nextWorkspace: TwinWorkspace, nextAssembly: MechanicalAssembly) => {
    setSession((prev) => ({
      workspace: nextWorkspace,
      assembly: nextAssembly,
      commands: { ...nextAssembly.commands },
      dirty: true,
      history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
    }));
  }, []);

  function resolveModuleData(item: { kind: "module" | "custom"; id: string }) {
    return item.kind === "module"
      ? MODULE_BLUEPRINTS.find((m) => m.id === item.id)?.buildFn()
      : (() => {
          const cm = customModules.find((c) => c.id === item.id);
          return cm ? { workspace: cm.workspace, assembly: cm.assembly } : undefined;
        })();
  }

  function inferModuleProbeBlockId(modData: { workspace: TwinWorkspace; assembly: MechanicalAssembly }): string {
    const modPkgs = new Map(modData.workspace.packages.map((p) => [packageKey(p), p]));
    if (modData.assembly.nodes.some((n) => n.thruster?.coupleMode === "pump_speed" || n.thruster?.coupleMode === "direct")) {
      return "laval_nozzle";
    }
    if (modData.assembly.nodes.some((n) => n.thruster?.coupleMode === "rotor_aero")) {
      return "bldc_motor";
    }
    if (modData.assembly.nodes.some((n) => modPkgs.get(n.packageKey)?.primitive?.finish === "rubber_grip")) {
      return "hub_motor_y";
    }
    return "table_plate";
  }

  function openModuleForEdit(modData: { workspace: TwinWorkspace; assembly: MechanicalAssembly }) {
    setError("");
    pushSessionUpdate(modData.workspace, modData.assembly);
    setSelectedNodeId("");
    setPreferredParentId("");
    setArmedItem(null);
    setFitToken((n) => n + 1);
    setHoverHint(`已拆开总成「${modData.assembly.name}」逐件编辑`);
  }

  function applyModularInsert(
    item: { kind: "block" | "module" | "custom"; id: string },
    parentNodeId: string,
    parentMountId: string,
  ) {
    setError("");
    try {
      if (item.kind === "block") {
        const res = snapBlockOntoAssembly(session.workspace, session.assembly, item.id, parentNodeId, parentMountId);
        pushSessionUpdate(res.workspace, res.assembly);
        setSelectedNodeId(res.addedNodeId);
      } else {
        const modData = resolveModuleData({ kind: item.kind, id: item.id });
        if (!modData) throw new Error(`找不到封装模块：${item.id}`);
        const res = snapModuleOntoAssembly(session.workspace, session.assembly, modData, parentNodeId, parentMountId);
        pushSessionUpdate(res.workspace, res.assembly);
        setSelectedNodeId(res.outputNodeId);
      }
      setArmedItem(null);
      setPreferredParentId("");
      setHoverHint("");
      setCustomWidthInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "装配吸附失败，请检查安装面。");
    }
  }

  function quickAttachItem(item: { kind: "block" | "module" | "custom"; id: string }, overrideParentId?: string) {
    setError("");
    if (session.assembly.nodes.length === 0) {
      if (item.kind === "module" || item.kind === "custom") {
        const modData = resolveModuleData({ kind: item.kind, id: item.id });
        if (!modData) {
          setError(`找不到封装模块：${item.id}`);
          return;
        }
        openModuleForEdit(modData);
        return;
      }
      try {
        const res = placeRootBlockInSandbox(session.workspace, session.assembly, item.id);
        pushSessionUpdate(res.workspace, res.assembly);
        setSelectedNodeId(res.addedNodeId);
        setArmedItem(null);
        setFitToken((n) => n + 1);
        setHoverHint("已放置第 1 件基准刚体并建立根坐标系");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "放置根零件失败。");
      }
      return;
    }

    const hintParent = overrideParentId ?? (preferredParentId || undefined);
    const probeBlockId =
      item.kind === "block"
        ? item.id
        : (() => {
            const modData = resolveModuleData({ kind: item.kind, id: item.id });
            return modData ? inferModuleProbeBlockId(modData) : "table_plate";
          })();
    const best = findBestSnapTarget(session.workspace, session.assembly, probeBlockId, hintParent);
    if (!best) {
      setError("当前没有合适的空闲安装面，请在右侧结构树点 + 指定父零件。");
      return;
    }
    applyModularInsert(item, best.parentNodeId, best.parentMountId);
    setHoverHint(`已吸合到「${best.parentLabel}」的 ${best.mountLabel}`);
  }

  function startBlankCanvas(labId: FromZeroLabId | "" = "") {
    setError("");
    const zero = createZeroBlankSandbox();
    pushSessionUpdate(zero.workspace, zero.assembly);
    setFromZeroLabId(labId);
    setLabEngineModuleId("");
    setArmedItem(null);
    setSelectedNodeId("");
    setPreferredParentId("");
    setExplodePct(0);
    setXrayMode(false);
    setPaletteFilter("all");
    setHoverHint("");
    setStage("build");
    setFitToken((n) => n + 1);
  }

  function handleLoadShowcase(id: ShowcaseTemplateId, targetStage: "build" | "simulate") {
    setError("");
    const loaded = id === "gantry-mill" ? buildGantryMillTemplate() : loadUniversalArchetype(id);
    pushSessionUpdate(loaded.workspace, loaded.assembly);
    setFromZeroLabId("");
    setLabEngineModuleId("");
    setArmedItem(null);
    setSelectedNodeId("");
    setPreferredParentId("");
    setExplodePct(0);
    setXrayMode(false);
    setHoverHint("");
    setStage(targetStage);
    setFitToken((n) => n + 1);
  }

  function handleLabEncapsulateEngine() {
    setError("");
    try {
      const rec = encapsulateUserModule(session.workspace, session.assembly, "自造电泵矢量发动机总成");
      setCustomModules((prev) => [rec, ...prev.slice(0, 15)]);
      setLabEngineModuleId(rec.id);
      const zero = createZeroBlankSandbox();
      pushSessionUpdate(zero.workspace, zero.assembly);
      setArmedItem(null);
      setSelectedNodeId("");
      setPreferredParentId("");
      setFitToken((n) => n + 1);
      setSaveFeedback(`已封装「${rec.name}」，请放置贮箱并挂载该总成！`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "封装发动机总成失败。");
    }
  }

  function handleAutoCoupleCounterRotor() {
    const motors = session.assembly.nodes.filter((n) => {
      const pkg = session.workspace.packages.find((p) => packageKey(p) === n.packageKey);
      const j = pkg?.mechanics?.kind === "part" ? pkg.mechanics.joint : undefined;
      return j?.type === "hinge" && Math.abs(j.axis[2]) > 0.5;
    });
    if (motors.length < 2) return;
    mutateSelectedNode(motors[1]!.id, { coupledTo: { path: motors[0]!.id, ratio: -1 } });
  }

  function handleLabStepAction(action: FromZeroLabAction) {
    if (action.kind === "block") {
      quickAttachItem({ kind: "block", id: action.blockId });
    } else if (action.kind === "set_free") {
      mutateAssemblyConfig((asm) => setAssemblyBaseMobility(asm, "free"));
    } else if (action.kind === "encapsulate_engine") {
      handleLabEncapsulateEngine();
    } else if (action.kind === "attach_module") {
      const isCustom = customModules.some((c) => c.id === action.moduleId);
      quickAttachItem({ kind: isCustom ? "custom" : "module", id: action.moduleId });
    } else {
      handleAutoCoupleCounterRotor();
    }
  }

  function undoBuild() {
    setSession((prev) => {
      const last = prev.history.at(-1);
      if (!last) return prev;
      return {
        workspace: last.workspace,
        assembly: last.assembly,
        commands: { ...last.assembly.commands },
        dirty: true,
        history: prev.history.slice(0, -1),
      };
    });
    setSelectedNodeId("");
    setPreferredParentId("");
    setArmedItem(null);
    setHoverHint("");
  }

  function mutateSelectedNode(nodeId: string, patch: Parameters<typeof updateSandboxNode>[3]) {
    setError("");
    try {
      const res = updateSandboxNode(session.workspace, session.assembly, nodeId, patch);
      setSession((prev) => ({
        ...prev,
        workspace: res.workspace,
        assembly: res.assembly,
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改零件参数失败。");
    }
  }

  function mutateAssemblyConfig(updater: (asm: MechanicalAssembly) => MechanicalAssembly) {
    setError("");
    try {
      const nextAsm = updater(session.assembly);
      setSession((prev) => ({
        ...prev,
        assembly: nextAsm,
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改装配物理设置失败。");
    }
  }

  function deleteNodeById(nodeId: string) {
    setError("");
    try {
      const nextAsm = removeSandboxNode(session.workspace, session.assembly, nodeId);
      pushSessionUpdate(session.workspace, nextAsm);
      if (selectedNodeId === nodeId) setSelectedNodeId("");
      if (preferredParentId === nodeId) setPreferredParentId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除零件失败。");
    }
  }

  function handleSaveCurrentMachine(options?: { asNewCopy?: boolean; customName?: string }) {
    setError("");
    try {
      const res = saveSandboxMachineToWorkspace(workspace, session.workspace, session.assembly, options);
      onSaveWorkspace(res.workspace);
      setSession((prev) => ({ ...prev, assembly: res.savedAssembly, dirty: false }));
      setSaveFeedback(`已保存「${res.savedAssembly.name}」`);
      setSaveNameDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存机器失败。");
    }
  }

  function handleOpenSaved(assemblyId: string, targetStage: "build" | "simulate") {
    setError("");
    try {
      const loaded = loadSandboxMachineFromWorkspace(workspace, assemblyId);
      setSession({
        workspace: loaded.workspace,
        assembly: loaded.assembly,
        commands: { ...loaded.assembly.commands },
        dirty: false,
        history: [],
      });
      setFromZeroLabId("");
      setLabEngineModuleId("");
      setLibraryOpen(false);
      setSelectedNodeId("");
      setPreferredParentId("");
      setArmedItem(null);
      setStage(targetStage);
      setFitToken((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "载入作品失败。");
    }
  }

  function handleEncapsulateAsModule() {
    setError("");
    try {
      const rec = encapsulateUserModule(
        session.workspace,
        session.assembly,
        encapsulateDraft || session.assembly.name,
      );
      setCustomModules((prev) => [rec, ...prev.slice(0, 15)]);
      setEncapsulateDraft("");
      setSaveFeedback(`已封装模块「${rec.name}」`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "封装模块失败。");
    }
  }

  function launchClosedLoopTwin() {
    setError("");
    try {
      const { workspace: convertedWs, system } = convertSandboxToSystemTwin(session.workspace, session.assembly);
      const merged = upsertMechanicalAssembly(convertedWs, session.assembly);
      const finalWs: TwinWorkspace = {
        ...workspace,
        ...merged,
        packages: [
          ...workspace.packages.filter((p) => !merged.packages.some((mp) => packageKey(mp) === packageKey(p))),
          ...merged.packages,
        ],
        systems: [...(workspace.systems ?? []).filter((s) => s.id !== system.id), system],
      };
      onSaveWorkspace(finalWs);
      setBomOpen(false);
      onNavigate({ view: "workbench", target: `system:${system.id}` }, `已生成闭环仿真系统「${system.name}」。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转换 Modelica 闭环系统失败。");
    }
  }

  async function launchMujocoPro() {
    setError("");
    try {
      const compiled = compileAssemblyToMujoco(session.workspace, session.assembly);
      const baseRef = await describeModel(compiled.bundle);
      const ref: ModelRef = { ...baseRef, run: compiled.recommendedRun };
      await putModelBundle(ref, compiled.bundle);
      const baseWs = parseWorkspace(workspace);
      const existingCatalog = baseWs.catalog ?? { models: [], materials: [] };
      const finalWs: TwinWorkspace = {
        ...baseWs,
        catalog: parseImportCatalog(
          {
            models: [...existingCatalog.models.filter((m) => m.id !== ref.id), ref],
            materials: existingCatalog.materials,
          },
          baseWs.packages,
        ),
      };
      onSaveWorkspace(finalWs);
      setBomOpen(false);
      onNavigate({ view: "workbench", target: `model:${ref.id}` }, `已载入专业台 MuJoCo 求解器「${session.assembly.name}」。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "送入 MuJoCo 多体求解台失败。");
    }
  }

  const selectedSolved = solved.nodes.find((n) => n.path === selectedNodeId);
  const selectedRawNode = session.assembly.nodes.find((n) => n.id === selectedNodeId);
  const selectedPkg = selectedRawNode
    ? session.workspace.packages.find((p) => packageKey(p) === selectedRawNode.packageKey)
    : undefined;
  const selectedPart = selectedPkg?.mechanics?.kind === "part" ? selectedPkg.mechanics : undefined;
  const selectedPrimaryLen = selectedPkg?.primitive
    ? getPrimaryLengthMm(
        primitiveBoundingBoxMm(selectedPkg.primitive),
        selectedPkg.primitive as unknown as Record<string, unknown>,
      )
    : undefined;
  const selectedControl = selectedSolved
    ? solved.activeControls.find((c) => c.path === selectedSolved.path)
    : undefined;

  const preferredParentNode = preferredParentId
    ? session.assembly.nodes.find((n) => n.id === preferredParentId)
    : undefined;

  const leadPhysicsSection = physicsModel.sections[0];

  const viewportHudText = armedItem
    ? preferredParentNode
      ? `已拿起模块 — 点击「${preferredParentNode.label ?? preferredParentNode.id}」的蓝色发光球吸附`
      : "已拿起零件 — 点击 3D 视口青色发光球吸附（或点击右栏 + 号）"
    : hoverHint ||
      (session.assembly.nodes.length === 0
        ? "空白画布 (0 件) — 从左侧选零件放置第 1 件基准刚体"
        : `${session.assembly.name} · ${session.assembly.nodes.length}件`);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* Minimal 3-Stage Studio Header */}
      <header className="surface flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
            <Blocks className="size-4 text-primary" />
            <span>构元 · 造物台</span>
          </h1>
          <Button
            size="sm"
            variant="outline"
            className="h-7 max-w-[14rem] gap-1 px-2 text-xs"
            onClick={() => {
              setSaveNameDraft(session.assembly.name);
              setLibraryOpen(true);
            }}
          >
            <FolderOpen className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{session.assembly.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {session.assembly.nodes.length}件
            </span>
          </Button>
        </div>

        {/* 3 Clean Linear Stages */}
        <div role="tablist" aria-label="造物工作流阶段" className="flex items-center gap-1 rounded-md border bg-background/70 p-0.5">
          <Button
            size="sm"
            role="tab"
            aria-selected={stage === "start"}
            variant={stage === "start" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setStage("start");
            }}
          >
            <Compass className="size-3.5" /> 起点与样机
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={stage === "build"}
            variant={stage === "build" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setStage("build");
              setFitToken((n) => n + 1);
            }}
          >
            <Blocks className="size-3.5" /> 拼装设计
            <span className="ml-0.5 rounded bg-background/40 px-1 text-[10px]">
              {session.assembly.nodes.length}
            </span>
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={stage === "simulate"}
            variant={stage === "simulate" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setStage("simulate");
            }}
          >
            <Play className="size-3.5" /> 物理仿真
          </Button>
        </div>

        {/* Clean Secondary Actions */}
        <div className="flex items-center gap-1.5">
          {saveFeedback && (
            <span className="hidden items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-300 sm:inline-flex">
              <Check className="size-3" /> {saveFeedback}
            </span>
          )}
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setBomOpen(true)}>
            <Package className="size-3.5" />
            {session.assembly.nodes.length > 0 ? `BOM (¥${livePhysics.totalCostCny})` : "BOM 清单"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" className="h-7 px-2 text-xs">
                <Wrench className="size-3.5" /> 进阶工程
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => handleSaveCurrentMachine()} disabled={session.assembly.nodes.length === 0}>
                <Save /> 保存当前作品到本地
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setSaveNameDraft(session.assembly.name);
                  setLibraryOpen(true);
                }}
              >
                <FolderOpen /> 我的已存作品 ({savedMachines.length})
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>专业多求解器工作台</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void launchMujocoPro()} disabled={session.assembly.nodes.length === 0}>
                <Play /> 送入专业 MuJoCo 求解台
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={launchClosedLoopTwin} disabled={session.assembly.nodes.length === 0}>
                <Sparkles /> 送入 Modelica 机电闭环台
              </DropdownMenuItem>
              {!IS_PAGES && (
                <DropdownMenuItem onSelect={() => setPhotoOpen(true)}>
                  <Camera /> 拍照识别实物铭牌入库
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onNavigate({ view: "examples" })}>
                <Compass /> 浏览器件库与 16 个标准算例
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Stage 1: Calm Start & Showcase Hub */}
      {stage === "start" && (
        <StudioStartGallery
          savedMachines={savedMachines}
          onStartBlank={() => startBlankCanvas("")}
          onStartGuidedLab={(labId) => startBlankCanvas(labId)}
          onLoadShowcase={handleLoadShowcase}
          onOpenSaved={handleOpenSaved}
          onDeleteSaved={(id) => onSaveWorkspace(deleteSandboxMachineFromWorkspace(workspace, id))}
        />
      )}

      {/* Stage 2: Focused 3-Pane Build Workbench */}
      {stage === "build" && (
        <div
          className={`grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden max-md:grid-rows-[44dvh_auto_minmax(0,1fr)] ${
            outlinerOpen
              ? "md:grid-cols-[16.5rem_minmax(0,1fr)_16.5rem] xl:grid-cols-[18.5rem_minmax(0,1fr)_18.5rem]"
              : "md:grid-cols-[16.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_minmax(0,1fr)]"
          }`}
        >
          {/* Mobile Pane Switcher (<768px) */}
          <div className="flex shrink-0 gap-1.5 md:hidden" role="tablist" aria-label="移动端面板切换">
            <Button
              size="sm"
              role="tab"
              aria-selected={mobileTab === "left"}
              variant={mobileTab === "left" ? "default" : "outline"}
              className="h-8 flex-1 text-xs"
              onClick={() => setMobileTab("left")}
            >
              零件与总成
            </Button>
            <Button
              size="sm"
              role="tab"
              aria-selected={mobileTab === "right"}
              variant={mobileTab === "right" ? "default" : "outline"}
              className="h-8 flex-1 text-xs"
              onClick={() => setMobileTab("right")}
            >
              结构与属性 ({session.assembly.nodes.length})
            </Button>
          </div>

          {/* LEFT PANE: Parts & Subassemblies */}
          <aside
            aria-label="零件与总成面板"
            className={`surface min-h-0 flex-col gap-2 overflow-hidden p-3 text-xs max-md:row-start-3 md:col-start-1 md:row-start-1 ${
              mobileTab === "left" ? "flex" : "hidden md:flex"
            }`}
          >
            {/* 5 Clean Category Tabs */}
            <div className="grid shrink-0 grid-cols-5 gap-1 rounded-md border bg-background/60 p-0.5" role="tablist">
              {FILTER_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={paletteFilter === t.id}
                  onClick={() => setPaletteFilter(t.id)}
                  className={`truncate rounded px-1 py-1 text-[11px] font-medium transition-colors ${
                    paletteFilter === t.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {paletteFilter === "modules" ? (
              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
                <div className="flex gap-1.5">
                  <Input
                    className="h-8 min-w-0 flex-1 text-xs"
                    aria-label="封装模块名称"
                    placeholder="为当前构型命名封装…"
                    value={encapsulateDraft}
                    onChange={(e) => setEncapsulateDraft(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 shrink-0 px-2.5 text-xs"
                    disabled={session.assembly.nodes.length === 0}
                    onClick={handleEncapsulateAsModule}
                  >
                    封装
                  </Button>
                </div>

                {customModules.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold text-emerald-300">我的封装总成（双击挂载）</p>
                    {customModules.map((cm) => (
                      <div
                        key={cm.id}
                        className="flex w-full items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs hover:border-emerald-400"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (session.assembly.nodes.length === 0) quickAttachItem({ kind: "custom", id: cm.id });
                            else setArmedItem({ kind: "custom", id: cm.id });
                          }}
                          onDoubleClick={() => quickAttachItem({ kind: "custom", id: cm.id })}
                          className="flex min-w-0 flex-1 items-center justify-between gap-1 text-left"
                        >
                          <span className="truncate font-medium">{cm.name}</span>
                          <span className="shrink-0 text-[11px] text-emerald-300">{cm.nodeCount}件</span>
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-emerald-400/40 px-1.5 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-500/20"
                          onClick={() => openModuleForEdit({ workspace: cm.workspace, assembly: cm.assembly })}
                        >
                          拆看
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-sky-300">内置标准总成（双击挂载）</p>
                  {MODULE_BLUEPRINTS.map((m) => (
                    <div
                      key={m.id}
                      className="flex w-full items-center gap-1.5 rounded-md border border-sky-500/35 bg-sky-500/10 px-2 py-1.5 text-xs hover:border-sky-400"
                    >
                      <button
                        type="button"
                        title={m.subtitle}
                        onClick={() => {
                          if (session.assembly.nodes.length === 0) quickAttachItem({ kind: "module", id: m.id });
                          else setArmedItem({ kind: "module", id: m.id });
                        }}
                        onDoubleClick={() => quickAttachItem({ kind: "module", id: m.id })}
                        className="flex min-w-0 flex-1 items-center justify-between gap-1 text-left"
                      >
                        <span className="truncate font-medium">{m.name}</span>
                        <span className="shrink-0 text-[11px] text-sky-300">总成</span>
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded border border-sky-400/40 px-1.5 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/20"
                        onClick={() => openModuleForEdit(m.buildFn())}
                      >
                        拆看
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-full border-dashed border-primary/40 text-xs text-primary hover:bg-primary/10"
                  onClick={() => setCustomCreatorOpen(true)}
                >
                  <Plus /> 自定义几何零件 (13 类)
                </Button>
                <p className="text-[11px] text-muted-foreground">单击选位安装 · 双击自动吸合</p>

                <div className="grid grid-cols-2 gap-2">
                  {filteredBlocks.map((blk) => {
                    const isArmed = armedItem?.kind === "block" && armedItem.id === blk.id;
                    return (
                      <button
                        key={blk.id}
                        type="button"
                        title={blk.subtitle}
                        onClick={() => {
                          if (session.assembly.nodes.length === 0) {
                            quickAttachItem({ kind: "block", id: blk.id });
                          } else if (preferredParentId) {
                            quickAttachItem({ kind: "block", id: blk.id }, preferredParentId);
                          } else {
                            setArmedItem(isArmed ? null : { kind: "block", id: blk.id });
                          }
                        }}
                        onDoubleClick={() => quickAttachItem({ kind: "block", id: blk.id })}
                        className={`relative flex flex-col items-center gap-1.5 rounded-md border p-2.5 text-center transition-colors ${
                          isArmed
                            ? "border-primary bg-primary/15 ring-1 ring-primary"
                            : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                        }`}
                      >
                        {blk.defaultJoint.type !== "fixed" && (
                          <span className="absolute left-1.5 top-1.5 rounded bg-muted px-1 text-[10px] text-primary">
                            {blk.defaultJoint.type === "slide" ? "滑" : "转"}
                          </span>
                        )}
                        <SandboxBlockIcon shape={blk.spec.shape} finish={blk.spec.finish} blockId={blk.id} className="size-8" />
                        <span className="line-clamp-2 text-xs font-medium leading-tight">{blk.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="shrink-0 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                {error}
              </p>
            )}
          </aside>

          {/* CENTER PANE: 3D Assembly Viewport */}
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:row-start-1 md:col-start-2 md:row-start-1">
            {/* Top Floating Viewport Bar */}
            <div className="pointer-events-none absolute inset-x-2.5 top-2.5 z-10 flex items-start justify-between gap-2">
              <div className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-1.5 rounded-full border border-primary/30 bg-[#101c1a]/92 px-3 py-1 text-xs text-foreground shadow-md backdrop-blur">
                <span className="truncate">{viewportHudText}</span>
                {armedItem && (
                  <>
                    <Button size="sm" className="h-5 px-2 text-[10px]" onClick={() => quickAttachItem(armedItem)}>
                      <Zap className="size-3" /> 自动吸上
                    </Button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                      onClick={() => {
                        setArmedItem(null);
                        setPreferredParentId("");
                        setHoverHint("");
                      }}
                    >
                      取消
                    </button>
                  </>
                )}
              </div>

              <div className="pointer-events-auto flex shrink-0 items-center gap-1">
                {session.history.length > 0 && (
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-xs shadow-md" onClick={undoBuild}>
                    <Undo2 className="size-3.5" /> 撤销
                  </Button>
                )}
                {session.assembly.nodes.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs shadow-md"
                    onClick={() => startBlankCanvas("")}
                  >
                    清空
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={explodePct > 0 ? "default" : "secondary"}
                  className="h-7 px-2 text-xs shadow-md"
                  onClick={() => setExplodePct((v) => (v > 0 ? 0 : 55))}
                >
                  <Layers className="size-3.5" /> {explodePct > 0 ? "收拢" : "爆炸图"}
                </Button>
                <Button
                  size="sm"
                  variant={xrayMode ? "default" : "secondary"}
                  className="h-7 px-2 text-xs shadow-md"
                  onClick={() => setXrayMode((v) => !v)}
                >
                  <Eye className="size-3.5" /> 透视
                </Button>
                <Button size="sm" variant="secondary" className="h-7 px-2 text-xs shadow-md" onClick={() => setFitToken((n) => n + 1)}>
                  <RotateCcw className="size-3.5" /> 居中
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="hidden h-7 px-2 text-xs shadow-md md:inline-flex"
                  aria-label={outlinerOpen ? "收起右侧结构与属性栏" : "展开右侧结构与属性栏"}
                  onClick={() => setOutlinerOpen((v) => !v)}
                >
                  {outlinerOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
                </Button>
              </div>
            </div>

            <SandboxViewport3D
              workspace={session.workspace}
              assembly={session.assembly}
              mode={explodePct > 0 ? "explode" : "build"}
              armedBlockId={armedItem?.kind === "block" ? armedItem.id : armedItem ? "table_plate" : null}
              selectedNodeId={selectedNodeId}
              preferredParentId={preferredParentId}
              commands={session.commands}
              explodePct={explodePct}
              subtreeOnly={false}
              showLeaders={explodePct > 0}
              showLabels={explodePct > 0 || Boolean(selectedNodeId)}
              worldTargets={[]}
              fitRequestToken={fitToken}
              onSelectNode={(id) => {
                setSelectedNodeId(id);
                setCustomWidthInput("");
                setCustomMassInput("");
                setThrusterDraftN("");
                setCoupleTargetDraft("");
              }}
              onSnapBlock={(parentNodeId, parentMountId) => {
                if (armedItem) applyModularInsert(armedItem, parentNodeId, parentMountId);
              }}
              onHoverSnapChange={setHoverHint}
              xrayMode={xrayMode}
              physicsHighlight={physicsHighlight}
            />

            {/* Empty Canvas Helpful Overlay */}
            {session.assembly.nodes.length === 0 && !activeLabEval && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
                <div className="pointer-events-auto max-w-sm space-y-2 rounded-lg border border-dashed border-primary/50 bg-[#0b1412]/88 px-4 py-3 text-center text-xs text-foreground shadow-lg backdrop-blur">
                  <p className="font-semibold text-primary">空白画布（0 件）</p>
                  <p className="leading-relaxed text-muted-foreground">
                    点击左侧任意零件或「自定义几何零件」放置第 1 件基准刚体，也可以直接载入成品样机拆改。
                  </p>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setStage("start")}>
                    <Compass className="size-3.5" /> 打开起点与样机库 →
                  </Button>
                </div>
              </div>
            )}

            {/* Floating Bottom Step Guide Card (only when a Guided From-Zero Lab is active) */}
            {activeLabEval && (() => {
              const doneCount = activeLabEval.steps.filter((s) => s.done).length;
              const totalCount = activeLabEval.steps.length;
              const nextStep = activeLabEval.steps.find((s) => !s.done);
              return (
                <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
                  <div className="pointer-events-auto w-full max-w-lg rounded-lg border border-primary/45 bg-[#0c1614]/94 p-3 text-xs shadow-xl backdrop-blur">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="truncate font-semibold text-foreground">{activeLabEval.def.title}</div>
                        {activeLabEval.phaseLabel && (
                          <div className="inline-block max-w-full truncate rounded bg-primary/20 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                            {activeLabEval.phaseLabel}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        <span className="mono font-semibold text-primary">
                          {doneCount}/{totalCount}
                        </span>
                        <button
                          type="button"
                          aria-label="退出分步引导"
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => setFromZeroLabId("")}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    </div>

                    {activeLabEval.readyForSim ? (
                      <div className="mt-2 space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5">
                        <p className="font-medium text-emerald-200">所有装配与物理判据已通过！</p>
                        <Button
                          size="sm"
                          className="h-8 w-full text-xs"
                          onClick={() => {
                            setArmedItem(null);
                            setStage("simulate");
                          }}
                        >
                          <Play className="size-3.5" /> 进入物理仿真检验 →
                        </Button>
                      </div>
                    ) : nextStep ? (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-foreground">下一步：{nextStep.title}</p>
                          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{nextStep.hint}</p>
                        </div>
                        {nextStep.action ? (
                          <Button
                            size="sm"
                            className="h-8 shrink-0 text-xs"
                            onClick={() => handleLabStepAction(nextStep.action!)}
                          >
                            {nextStep.action.label}
                          </Button>
                        ) : nextStep.suggestedBlockId ? (
                          <Button
                            size="sm"
                            className="h-8 shrink-0 text-xs"
                            onClick={() => quickAttachItem({ kind: "block", id: nextStep.suggestedBlockId! })}
                          >
                            +放置
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    <details className="mt-2 text-[11px]">
                      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                        查看全部步骤 ({doneCount}/{totalCount}) · {activeLabEval.def.goalEquation}
                      </summary>
                      <div className="mt-1.5 space-y-1 border-t pt-1.5">
                        {activeLabEval.steps.map((st) => (
                          <div key={st.id} className="flex items-center justify-between gap-2">
                            <span className={st.done ? "text-emerald-300" : "text-muted-foreground"}>
                              {st.done ? "✓" : "○"} {st.title}
                            </span>
                            {!st.done && st.action && (
                              <button
                                type="button"
                                className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/30"
                                onClick={() => handleLabStepAction(st.action!)}
                              >
                                {st.action.label}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                </div>
              );
            })()}
          </main>

          {/* RIGHT PANE: Unified Structure & Inspector (No Sub-Tabs) */}
          <aside
            aria-label="右栏装配结构与属性"
            className={`surface min-h-0 flex-col gap-2 overflow-hidden p-3 text-xs max-md:row-start-3 md:col-start-3 md:row-start-1 ${
              mobileTab === "right" ? "flex" : outlinerOpen ? "hidden md:flex" : "hidden"
            }`}
          >
            {/* Header & Inline Mobility Toggle */}
            <div className="flex shrink-0 items-center justify-between gap-1.5 border-b pb-1.5">
              <h2 className="truncate text-xs font-semibold text-foreground">
                装配结构 ({session.assembly.nodes.length}件 · {physicsModel.totalMassKg.toFixed(2)}kg)
              </h2>
              <button
                type="button"
                title="切换底座是固定在地面还是 6-DOF 自由运动"
                className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium ${
                  session.assembly.baseMobility === "free"
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                }`}
                onClick={() =>
                  mutateAssemblyConfig((asm) =>
                    setAssemblyBaseMobility(asm, asm.baseMobility === "free" ? "fixed" : "free"),
                  )
                }
              >
                {session.assembly.baseMobility === "free" ? "🛞 自由底盘" : "🔩 固定基座"}
              </button>
            </div>

            {/* 1-Line Live Physics Readiness Strip */}
            {session.assembly.nodes.length > 0 && leadPhysicsSection && (
              <div
                className={`shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] ${
                  leadPhysicsSection.status === "pass"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : leadPhysicsSection.status === "warn"
                      ? "border-amber-500/45 bg-amber-500/10 text-amber-200"
                      : "border-border bg-background/50 text-muted-foreground"
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {leadPhysicsSection.status === "pass" ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
                  ) : leadPhysicsSection.status === "warn" ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-300" />
                  ) : (
                    <Info className="size-3.5 shrink-0 text-sky-300" />
                  )}
                  <span className="truncate">{leadPhysicsSection.title}</span>
                </div>
                {leadPhysicsSection.status === "warn" && (
                  <p className="mt-1 leading-snug text-amber-200/90">{leadPhysicsSection.explanation}</p>
                )}
              </div>
            )}

            {/* Assembly Hierarchy Tree */}
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
              {treeRows.map((row) => {
                const isSel = selectedNodeId === row.id;
                return (
                  <div
                    key={row.id}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors ${
                      isSel
                        ? "border-primary bg-primary/15 text-foreground"
                        : preferredParentId === row.id
                          ? "border-sky-400/60 bg-sky-500/10"
                          : "border-transparent bg-background/40 hover:border-border"
                    }`}
                    style={{ paddingLeft: `${8 + Math.min(row.depth, 5) * 10}px` }}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      onClick={() => {
                        setSelectedNodeId(row.id);
                        setCustomWidthInput("");
                      }}
                    >
                      <SandboxBlockIcon shape={row.shape} finish={row.finish} className="size-4 shrink-0" />
                      <span className="truncate text-xs font-medium">{row.label}</span>
                      {row.isOutputTip && (
                        <span className="shrink-0 rounded bg-orange-500/20 px-1 text-[10px] text-orange-300">端</span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{row.jointSummary}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`在 ${row.label} 下挂载新零件`}
                      title="指定将下一个零件装到这个零件上"
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-primary/20 hover:text-primary"
                      onClick={() => {
                        setPreferredParentId(row.id);
                        setSelectedNodeId(row.id);
                        setMobileTab("left");
                      }}
                    >
                      <Plus className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`拆除 ${row.label}`}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                      onClick={() => deleteNodeById(row.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Unified Selected Part Inspector + Inline Joint Slider */}
            {selectedSolved && selectedRawNode && (
              <div className="max-h-[52%] shrink-0 space-y-2 overflow-y-auto border-t pt-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-primary">调整 · {selectedSolved.label}</span>
                  <button type="button" aria-label="关闭零件编辑" onClick={() => setSelectedNodeId("")}>
                    <X className="size-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>

                {selectedPkg?.primitive && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={(selectedPrimaryLen ?? 40) <= 30}
                      onClick={() =>
                        selectedPrimaryLen &&
                        mutateSelectedNode(selectedRawNode.id, { primaryLengthMm: Math.max(15, selectedPrimaryLen - 20) })
                      }
                    >
                      -20
                    </Button>
                    <Input
                      type="number"
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder={selectedPrimaryLen ? `${selectedPrimaryLen}mm` : "毫米"}
                      value={customWidthInput}
                      onChange={(e) => setCustomWidthInput(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        const v = Number(customWidthInput);
                        if (v > 0) mutateSelectedNode(selectedRawNode.id, { primaryLengthMm: v });
                      }}
                    >
                      改
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        selectedPrimaryLen &&
                        mutateSelectedNode(selectedRawNode.id, { primaryLengthMm: selectedPrimaryLen + 20 })
                      }
                    >
                      +20
                    </Button>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-1 text-[11px]"
                    onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "x" })}
                  >
                    绕X 90°
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-1 text-[11px]"
                    onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "y" })}
                  >
                    绕Y 90°
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-1 text-[11px]"
                    onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "z" })}
                  >
                    绕Z 90°
                  </Button>
                </div>

                {selectedPart && (
                  <select
                    aria-label="运动连接副类型"
                    className="h-7 w-full rounded border bg-background px-2 text-xs"
                    value={selectedPart.joint.type}
                    onChange={(e) =>
                      mutateSelectedNode(selectedRawNode.id, { jointType: e.target.value as "fixed" | "slide" | "hinge" })
                    }
                  >
                    <option value="fixed">fixed（刚性固定）</option>
                    <option value="slide">slide（直线滑动）</option>
                    <option value="hinge">hinge（旋转关节）</option>
                  </select>
                )}

                {selectedPart && selectedPart.joint.type !== "fixed" && (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      <select
                        aria-label="关节运动轴"
                        className="h-7 rounded border bg-background px-1.5 text-xs"
                        value={
                          Math.abs(selectedPart.joint.axis[0]) > 0.5
                            ? "x"
                            : Math.abs(selectedPart.joint.axis[1]) > 0.5
                              ? "y"
                              : "z"
                        }
                        onChange={(e) => mutateSelectedNode(selectedRawNode.id, { jointAxis: e.target.value as AxisDir })}
                      >
                        <option value="x">轴：X</option>
                        <option value="y">轴：Y</option>
                        <option value="z">轴：Z</option>
                      </select>
                      <select
                        aria-label="MuJoCo 驱动模式"
                        className="h-7 rounded border bg-background px-1.5 text-xs"
                        value={selectedRawNode.jointMode ?? "actuated"}
                        onChange={(e) =>
                          mutateSelectedNode(selectedRawNode.id, {
                            jointMode: e.target.value as "actuated" | "passive" | "velocity",
                          })
                        }
                      >
                        <option value="actuated">伺服位置</option>
                        {selectedPart.joint.type === "hinge" && <option value="velocity">连续转速</option>}
                        <option value="passive">无源随动</option>
                      </select>
                    </div>

                    {selectedControl && (
                      <label className="block space-y-1 rounded border bg-background/50 p-2">
                        <div className="flex justify-between gap-2 text-[11px]">
                          <span className="text-muted-foreground">关节试动预览</span>
                          <span className="mono text-primary">
                            {formatNum(selectedControl.value)} {selectedControl.joint.type === "slide" ? "mm" : "°"}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={selectedControl.joint.range[0]}
                          max={selectedControl.joint.range[1]}
                          step={selectedControl.joint.type === "slide" ? 0.5 : 1}
                          value={selectedControl.value}
                          className="h-3.5 w-full accent-primary"
                          onChange={(e) => {
                            const val = Number(e.currentTarget.value);
                            setSession((prev) => ({
                              ...prev,
                              commands: { ...prev.commands, [selectedControl.path]: val },
                            }));
                          }}
                        />
                      </label>
                    )}
                  </>
                )}

                <details className="rounded border bg-background/40 p-2 text-xs">
                  <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
                    更多设置（耦合 / 偏移 / 材质 / 推力 / 品牌）
                  </summary>
                  <div className="mt-2 space-y-2">
                    {selectedPart && selectedPart.joint.type !== "fixed" && (
                      <div className="space-y-1 rounded border bg-background/50 p-1.5">
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>从动耦合 (coupledTo)</span>
                          {selectedRawNode.coupledTo && (
                            <button
                              type="button"
                              className="text-destructive hover:underline"
                              onClick={() => mutateSelectedNode(selectedRawNode.id, { coupledTo: null })}
                            >
                              解除耦合
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <select
                            aria-label="耦合主关节"
                            className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-[11px]"
                            value={coupleTargetDraft || selectedRawNode.coupledTo?.path || ""}
                            onChange={(e) => setCoupleTargetDraft(e.target.value)}
                          >
                            <option value="">主关节…</option>
                            {session.assembly.nodes
                              .filter((n) => n.id !== selectedRawNode.id && n.parent !== undefined)
                              .map((n) => (
                                <option key={n.id} value={n.id}>
                                  {n.label ?? n.id}
                                </option>
                              ))}
                          </select>
                          <Input
                            type="number"
                            step="0.5"
                            className="h-7 w-14 text-[11px]"
                            aria-label="耦合传动比"
                            value={coupleRatioDraft}
                            onChange={(e) => setCoupleRatioDraft(e.target.value)}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px]"
                            disabled={!(coupleTargetDraft || selectedRawNode.coupledTo?.path)}
                            onClick={() => {
                              const targetPath = coupleTargetDraft || selectedRawNode.coupledTo?.path || "";
                              const ratio = Number(coupleRatioDraft);
                              if (targetPath && Number.isFinite(ratio)) {
                                mutateSelectedNode(selectedRawNode.id, { coupledTo: { path: targetPath, ratio } });
                              }
                            }}
                          >
                            耦合
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-6 gap-1">
                      {(
                        [
                          { label: "-X", d: [-10, 0, 0] as const },
                          { label: "+X", d: [10, 0, 0] as const },
                          { label: "-Y", d: [0, -10, 0] as const },
                          { label: "+Y", d: [0, 10, 0] as const },
                          { label: "-Z", d: [0, 0, -10] as const },
                          { label: "+Z", d: [0, 0, 10] as const },
                        ] as const
                      ).map((nudge) => (
                        <Button
                          key={nudge.label}
                          size="sm"
                          variant="outline"
                          className="h-6 px-0 text-[10px]"
                          onClick={() => mutateSelectedNode(selectedRawNode.id, { inputOffsetDeltaMm: nudge.d })}
                        >
                          {nudge.label}
                        </Button>
                      ))}
                    </div>

                    {selectedPkg?.primitive && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <select
                          aria-label="更换表面材质与密度"
                          className="h-7 rounded border bg-background px-1.5 text-[11px]"
                          value={selectedPkg.primitive.finish ?? "aluminum"}
                          onChange={(e) => mutateSelectedNode(selectedRawNode.id, { finish: e.target.value as PrimitiveFinish })}
                        >
                          {FINISH_EDIT_OPTIONS.map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            step="0.1"
                            className="h-7 min-w-0 flex-1 text-[11px]"
                            placeholder="质量kg"
                            value={customMassInput}
                            onChange={(e) => setCustomMassInput(e.target.value)}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-1.5 text-[11px]"
                            onClick={() => {
                              const kg = Number(customMassInput);
                              if (kg > 0) mutateSelectedNode(selectedRawNode.id, { massKg: kg });
                            }}
                          >
                            定重
                          </Button>
                        </div>
                      </div>
                    )}

                    {selectedPkg?.primitive && "axis" in selectedPkg.primitive && (
                      <select
                        aria-label="切换零件几何朝向轴"
                        className="h-7 w-full rounded border bg-background px-2 text-[11px]"
                        value={selectedPkg.primitive.axis}
                        onChange={(e) => mutateSelectedNode(selectedRawNode.id, { axis: e.target.value as AxisDir })}
                      >
                        <option value="x">零件朝向：沿 X 轴</option>
                        <option value="y">零件朝向：沿 Y 轴</option>
                        <option value="z">零件朝向：沿 Z 轴</option>
                      </select>
                    )}

                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        className="h-7 min-w-0 flex-1 text-[11px]"
                        aria-label="局部轴向推力 N"
                        placeholder={selectedRawNode.thruster ? `推力 ${selectedRawNode.thruster.maxForceN} N` : "设局部推力 N"}
                        value={thrusterDraftN}
                        onChange={(e) => setThrusterDraftN(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          const f = Number(thrusterDraftN);
                          if (f > 0) mutateSelectedNode(selectedRawNode.id, { thrusterMaxForceN: f });
                        }}
                      >
                        设推力
                      </Button>
                      {selectedRawNode.thruster && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-1.5 text-[11px] text-destructive"
                          onClick={() => mutateSelectedNode(selectedRawNode.id, { thrusterMaxForceN: null })}
                        >
                          移除
                        </Button>
                      )}
                    </div>

                    <select
                      aria-label="更换为真实厂商零件型号"
                      className="h-7 w-full rounded border bg-background px-2 text-[11px]"
                      value=""
                      onChange={(e) => e.target.value && mutateSelectedNode(selectedRawNode.id, { vendorPresetId: e.target.value })}
                    >
                      <option value="">换现实品牌：{selectedPkg?.manufacturer} · {selectedPkg?.model}</option>
                      {REAL_VENDOR_BOM_PRESETS.map((v) => (
                        <option key={v.id} value={v.id}>换为 {v.label}</option>
                      ))}
                    </select>

                    {session.assembly.nodes.some((n) => n.parent?.node === selectedRawNode.id) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-full text-[11px]"
                        onClick={() => {
                          setError("");
                          try {
                            const rec = encapsulateSubtreeModule(
                              session.workspace,
                              session.assembly,
                              selectedRawNode.id,
                              `${selectedRawNode.label ?? selectedRawNode.id} 子总成`,
                            );
                            setCustomModules((prev) => [rec, ...prev.slice(0, 15)]);
                            setSaveFeedback(`已将分支封装为可复用模块「${rec.name}」`);
                          } catch (cause) {
                            setError(cause instanceof Error ? cause.message : "封装分支子总成失败。");
                          }
                        }}
                      >
                        <Package className="size-3.5" /> 封装此组件及下级为子总成
                      </Button>
                    )}
                  </div>
                </details>

                <Button size="sm" variant="destructive" className="h-7 w-full text-xs" onClick={() => deleteNodeById(selectedRawNode.id)}>
                  <Trash2 /> {selectedRawNode.parent !== null ? "拆掉此零件及下级" : "拆掉根件回到 0 件"}
                </Button>
              </div>
            )}

            {/* Collapsible Cross-Branch Closures & Spring Connectors */}
            {session.assembly.nodes.length >= 2 && (
              <details
                className="shrink-0 border-t pt-2 text-xs"
                open={(session.assembly.closures?.length ?? 0) > 0}
              >
                <summary className="flex cursor-pointer select-none items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground">
                  <span className="flex items-center gap-1.5">
                    <Link2 className="size-3.5 text-primary" /> 跨分支闭环与弹簧 ({session.assembly.closures?.length ?? 0})
                  </span>
                </summary>
                <div className="mt-2 space-y-1.5">
                  {(session.assembly.closures?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      {session.assembly.closures!.map((cl) => (
                        <div key={cl.id} className="flex items-center justify-between gap-1 rounded border bg-background/50 px-2 py-1 text-[11px]">
                          <span className="truncate">
                            {cl.kind ?? "connect"} · {cl.nodeA} ↔ {cl.nodeB}
                          </span>
                          <button
                            type="button"
                            aria-label={`移除闭环约束 ${cl.id}`}
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => mutateAssemblyConfig((asm) => removeAssemblyClosure(asm, cl.id))}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1">
                    <select
                      aria-label="闭环端点 A"
                      className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-[11px]"
                      value={closureNodeA}
                      onChange={(e) => setClosureNodeA(e.target.value)}
                    >
                      <option value="">节点A…</option>
                      {session.assembly.nodes.map((n) => (
                        <option key={n.id} value={n.id}>{n.label ?? n.id}</option>
                      ))}
                    </select>
                    <select
                      aria-label="闭环端点 B"
                      className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-[11px]"
                      value={closureNodeB}
                      onChange={(e) => setClosureNodeB(e.target.value)}
                    >
                      <option value="">节点B…</option>
                      {session.assembly.nodes.map((n) => (
                        <option key={n.id} value={n.id}>{n.label ?? n.id}</option>
                      ))}
                    </select>
                    <select
                      aria-label="闭环类型"
                      className="h-7 rounded border bg-background px-1.5 text-[11px]"
                      value={closureKind}
                      onChange={(e) => setClosureKind(e.target.value as "connect" | "weld" | "spring")}
                    >
                      <option value="connect">销铰</option>
                      <option value="weld">固焊</option>
                      <option value="spring">弹簧</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!closureNodeA || !closureNodeB || closureNodeA === closureNodeB}
                      onClick={() => {
                        mutateAssemblyConfig((asm) =>
                          addAssemblyClosure(asm, {
                            kind: closureKind,
                            nodeA: closureNodeA,
                            mountA: "center",
                            nodeB: closureNodeB,
                            mountB: "center",
                            ...(closureKind === "spring" ? { stiffnessNpm: 320, dampingNsPm: 8 } : {}),
                          }),
                        );
                        setClosureNodeA("");
                        setClosureNodeB("");
                      }}
                    >
                      ＋连
                    </Button>
                  </div>
                </div>
              </details>
            )}

            {/* Primary CTA to Simulate Current Build */}
            <div className="mt-auto shrink-0 border-t pt-2">
              <Button
                size="sm"
                className="h-8 w-full text-xs"
                disabled={session.assembly.nodes.length === 0}
                onClick={() => {
                  setArmedItem(null);
                  setStage("simulate");
                }}
              >
                <Play className="size-3.5" /> 运行物理仿真 <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </aside>
        </div>
      )}

      {/* Stage 3: MuJoCo Physics Simulation for Unified Active Machine */}
      {stage === "simulate" && (
        <Suspense
          fallback={
            <div className="surface flex flex-1 items-center justify-center text-xs text-muted-foreground">
              正在加载 MuJoCo 刚体物理环境…
            </div>
          }
        >
          <MujocoSandboxArena
            key={session.assembly.id}
            currentWorkspace={session.workspace}
            currentAssembly={session.assembly}
            onBackToBuild={() => {
              setStage("build");
              setFitToken((n) => n + 1);
            }}
            onOpenTemplates={() => setStage("start")}
            onChangeBaseMobility={(mob) =>
              mutateAssemblyConfig((asm) => setAssemblyBaseMobility(asm, mob))
            }
          />
        </Suspense>
      )}

      {/* Saved Works Library Modal */}
      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>保存与打开我的机械作品</DialogTitle>
            <DialogDescription>
              将当前装配保存到本地工程档案，随时在「拼装设计」继续修改或送入「物理仿真」检验。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2 rounded border bg-background/60 p-2.5">
              <Input
                className="h-8 min-w-44 flex-1 text-xs"
                aria-label="保存的机器名称"
                value={saveNameDraft}
                onChange={(e) => setSaveNameDraft(e.target.value)}
                placeholder="填写作品名称（如：双电机向量实验箭）"
              />
              <Button
                size="sm"
                disabled={session.assembly.nodes.length === 0}
                onClick={() => handleSaveCurrentMachine({ customName: saveNameDraft })}
              >
                <Save /> 保存当前
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={session.assembly.nodes.length === 0}
                onClick={() => handleSaveCurrentMachine({ asNewCopy: true, customName: saveNameDraft })}
              >
                另存副本
              </Button>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-foreground">已保存作品（{savedMachines.length}件）</p>
              {savedMachines.length === 0 ? (
                <p className="rounded border border-dashed p-4 text-center text-muted-foreground">
                  暂无保存作品。在拼装设计中点击「进阶工程 → 保存当前作品」即可收录在此。
                </p>
              ) : (
                savedMachines.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 rounded border bg-background/60 p-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{m.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {m.nodes.length} 个零件 · {Object.keys(m.commands).length} 个可动自由度
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => handleOpenSaved(m.id, "build")}>
                        拼装
                      </Button>
                      <Button size="sm" onClick={() => handleOpenSaved(m.id, "simulate")}>
                        仿真
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`删除 ${m.name}`}
                        onClick={() => onSaveWorkspace(deleteSandboxMachineFromWorkspace(workspace, m.id))}
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Hardware BOM Modal */}
      <Dialog open={bomOpen} onOpenChange={setBomOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>现实采购 BOM 清单（预估总价 ¥{livePhysics.totalCostCny} · 整机 {livePhysics.totalMassKg} kg）</DialogTitle>
            <DialogDescription>
              支持将当前零件更换为真实厂商标准型号，或导出为 CSV 采购清单。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div className="max-h-72 overflow-y-auto rounded border">
              <table className="w-full text-left">
                <thead className="border-b bg-muted/40 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="p-2">品牌 / 型号</th>
                    <th className="p-2">类别</th>
                    <th className="p-2">包络尺寸</th>
                    <th className="p-2 text-right">用量</th>
                    <th className="p-2">真实件映射 / 状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bomRows.map((row) => (
                    <tr key={row.packageKey}>
                      <td className="p-2">
                        <div className="font-medium">{row.model}</div>
                        <div className="text-[10px] text-muted-foreground">{row.manufacturer}</div>
                      </td>
                      <td className="p-2 text-muted-foreground">{row.shapeLabel}</td>
                      <td className="mono p-2 text-[11px]">{row.dimensionsText}</td>
                      <td className="mono p-2 text-right">×{row.quantity}</td>
                      <td className="p-2">
                        {row.suggestedPresetCategory ? (
                          <select
                            aria-label={`替换 ${row.model} 为真实厂商件`}
                            className="h-7 max-w-44 rounded border bg-background px-1.5 text-[11px]"
                            value=""
                            onChange={(e) => {
                              const presetId = e.target.value;
                              const firstNodeId = row.nodeIds[0];
                              if (presetId && firstNodeId) mutateSelectedNode(firstNodeId, { vendorPresetId: presetId });
                            }}
                          >
                            <option value="">{row.hasRealBehavior ? "已绑定物理型号 · 可换" : "选真实品牌…"}</option>
                            {REAL_VENDOR_BOM_PRESETS.filter((p) => p.category === row.suggestedPresetCategory).map((v) => (
                              <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                          </select>
                        ) : (
                          <span className={row.hasRealBehavior ? "text-emerald-400" : "text-muted-foreground"}>
                            {row.hasRealBehavior ? "带质量/惯量行为" : "标准结构基本件"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={bomRows.length === 0}
                onClick={() => downloadBlob(sandboxBomToCsv(bomRows), `${session.assembly.name}-bom.csv`, "text/csv;charset=utf-8")}
              >
                <Download /> 导出采购 BOM CSV
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBomOpen(false);
                  onNavigate({ view: "resources", section: "author" });
                }}
              >
                去器件库录入自定义规格 →
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Photo Nameplate Vision Intake Modal */}
      {!IS_PAGES && (
        <Dialog open={photoOpen} onOpenChange={setPhotoOpen}>
          <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>拍照识别实物铭牌入库</DialogTitle>
              <DialogDescription>
                上传电机、丝杠或机械设备照片，解析为真实物理组件参数并加入工作区资产库。
              </DialogDescription>
            </DialogHeader>
            <VisionIntakePanel
              workspace={workspace}
              onApply={(nextWs, opts) => {
                onSaveWorkspace(nextWs);
                if (opts?.openTarget) {
                  setPhotoOpen(false);
                  onNavigate({ view: "workbench", target: opts.openTarget });
                }
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Custom Parametric Primitive Creator Modal */}
      <Dialog open={customCreatorOpen} onOpenChange={setCustomCreatorOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建自定义参数化几何零件</DialogTitle>
            <DialogDescription>
              从 13 类几何原语与 12 种材料涂装创建部件；若当前画布为空，将作为第 1 件基准刚体放置。
            </DialogDescription>
          </DialogHeader>
          <PrimitivePartCreator
            submitLabel={session.assembly.nodes.length === 0 ? "放置为第 1 件基准刚体" : "创建并吸附到当前装配"}
            onCancel={() => setCustomCreatorOpen(false)}
            onCreate={(pkg) => {
              setError("");
              try {
                const res = attachCustomPackageToSandbox(
                  session.workspace,
                  session.assembly,
                  pkg,
                  preferredParentId || undefined,
                );
                pushSessionUpdate(res.workspace, res.assembly);
                setSelectedNodeId(res.addedNodeId);
                setPreferredParentId("");
                setCustomCreatorOpen(false);
                setFitToken((n) => n + 1);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "自定义零件插入失败。");
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
