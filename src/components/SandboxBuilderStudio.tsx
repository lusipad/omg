import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Blocks,
  Box,
  Calculator,
  Camera,
  Check,
  ChevronDown,
  Download,
  Eye,
  FilePlus2,
  FolderOpen,
  Globe,
  Layers,
  Link2,
  Lock,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Unlock,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { solveArticulatedAssembly } from "@contracts/articulated-kinematics";
import { parseImportCatalog, type ModelRef } from "@contracts/import-catalog";
import {
  analyzeMachinePhysics,
  classifyNodeFunctionalLayer,
  createCommissionReferenceSolution,
  createCommissionStarter,
  encapsulateSubtreeModule,
  encapsulateUserModule,
  EVOLUTION_COMMISSIONS,
  FUNCTIONAL_LAYERS,
  loadShowroomExhibit,
  MODULE_BLUEPRINTS,
  SHOWROOM_EXHIBITS,
  simulateMachineTrial,
  snapModuleOntoAssembly,
  type CommissionId,
  type CustomModuleRecord,
  type FunctionalLayerId,
  type ShowroomExhibitId,
  type TrialMode,
} from "@contracts/machine-evolution";
import type { MechanicalAssembly } from "@contracts/mechanical-assembly";
import { upsertMechanicalAssembly } from "@contracts/mechanical-assembly";
import { compileAssemblyToMujoco } from "@contracts/mujoco-compiler";
import {
  deriveAssemblyPhysicsModel,
  evaluateFromZeroLab,
  FROM_ZERO_LABS,
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
} from "@contracts/sandbox-challenges";
import { type StudioRoute } from "@contracts/studio-navigation";
import { packageKey } from "@contracts/twin-device";
import { parseWorkspace, type TwinWorkspace } from "@contracts/twin-simulation";
import {
  loadUniversalArchetype,
  UNIVERSAL_ARCHETYPES,
  type UniversalArchetypeId,
} from "@contracts/universal-archetypes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IS_PAGES } from "@/const";
import { downloadBlob } from "@/lib/download";
import { describeModel, putModelBundle } from "@/lib/model-files";
import PhysicsModelCard from "./PhysicsModelCard";
import PrimitivePartCreator from "./PrimitivePartCreator";
import { SandboxBlockIcon } from "./SandboxBlockIcon";
import SandboxViewport3D from "./SandboxViewport3D";
import { VisionIntakePanel } from "./VisionIntakePanel";

const MujocoSandboxArena = lazy(() => import("./MujocoSandboxArena"));

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

export interface SandboxBuilderStudioProps {
  workspace: TwinWorkspace;
  initialChallengeId?: string;
  onSaveWorkspace: (next: TwinWorkspace) => void;
  onNavigate: (route: StudioRoute, message?: string) => void;
}

type PrimaryPillar = "showroom" | "commissions" | "sandbox" | "physics";
type PaletteFilter = "all" | "frame" | "motion" | "actuator" | "modules" | "manual";

interface MachineEditorSession {
  workspace: TwinWorkspace;
  assembly: MechanicalAssembly;
  commands: Record<string, number>;
  dirty: boolean;
  history: Array<{ workspace: TwinWorkspace; assembly: MechanicalAssembly }>;
}

const COMPLETED_COMM_KEY = "gouyuan.evolution.completed.v1";
const CUSTOM_MODULES_KEY = "gouyuan.custom_modules.v1";

const FILTER_TABS: ReadonlyArray<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "frame", label: "骨架" },
  { id: "motion", label: "关节" },
  { id: "actuator", label: "动力" },
  { id: "modules", label: "总成" },
  { id: "manual", label: "调试" },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const formatNum = (v: number) => Number(v.toFixed(1)).toString();

function readCompletedCommissions(): CommissionId[] {
  try {
    const raw = window.localStorage.getItem(COMPLETED_COMM_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is CommissionId => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCompletedCommissions(ids: ReadonlySet<CommissionId>): void {
  try {
    window.localStorage.setItem(COMPLETED_COMM_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota errors
  }
}

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

function mapLegacyChallengeToCommission(id?: string): CommissionId {
  if (id === "level-2-xy-stage") return "comm-2-xy";
  if (id === "level-3-cnc-mill") return "comm-3-mill";
  if (id === "level-4-robot-arm") return "comm-4-omni";
  return "comm-1-axis";
}

function makeCommissionSession(id: CommissionId): MachineEditorSession {
  const s = createCommissionStarter(id);
  return { workspace: s.workspace, assembly: s.assembly, commands: { ...s.assembly.commands }, dirty: false, history: [] };
}

function makeFreeSandboxSession(): MachineEditorSession {
  const s = createChallengeStarter("free-sandbox");
  return { workspace: s.workspace, assembly: s.assembly, commands: { ...s.assembly.commands }, dirty: false, history: [] };
}

export default function SandboxBuilderStudio({
  workspace,
  initialChallengeId,
  onSaveWorkspace,
  onNavigate,
}: SandboxBuilderStudioProps) {
  const [pillar, setPillar] = useState<PrimaryPillar>(() =>
    initialChallengeId === "free-sandbox"
      ? "sandbox"
      : initialChallengeId
        ? "commissions"
        : "showroom",
  );

  // Pillar 1: Showroom Exhibit & Destructive What-If Physics Lab
  const [exhibitId, setExhibitId] = useState<ShowroomExhibitId>("c-frame-mill");
  const [exhibitData, setExhibitData] = useState(() => loadShowroomExhibit("c-frame-mill"));
  const [megaExhibitId, setMegaExhibitId] = useState<UniversalArchetypeId | null>("oriental-pearl-tower");
  const [megaPhaseDeg, setMegaPhaseDeg] = useState(0);
  const [megaSpeedMult, setMegaSpeedMult] = useState(1);
  const [whatIfPayloadKg, setWhatIfPayloadKg] = useState(0);
  const [whatIfLeadMm, setWhatIfLeadMm] = useState(8);
  const [whatIfFeedMmS, setWhatIfFeedMmS] = useState(32);
  const [showroomPlaying, setShowroomPlaying] = useState(true);
  const [showroomFrameIdx, setShowroomFrameIdx] = useState(0);
  const [activeLayerId, setActiveLayerId] = useState<FunctionalLayerId | null>(null);

  // Pillar 2: Modular Evolution Commissions
  const [commissionId, setCommissionId] = useState<CommissionId>(() => mapLegacyChallengeToCommission(initialChallengeId));
  const [commSession, setCommSession] = useState<MachineEditorSession>(() =>
    makeCommissionSession(mapLegacyChallengeToCommission(initialChallengeId)),
  );
  const [completedComms, setCompletedComms] = useState<Set<CommissionId>>(() => new Set(readCompletedCommissions()));
  const [unlockAll, setUnlockAll] = useState(false);

  // Pillar 3: Free Sandbox & Encapsulated Custom Modules
  const [sandboxSession, setSandboxSession] = useState<MachineEditorSession>(makeFreeSandboxSession);
  const [customModules, setCustomModules] = useState<CustomModuleRecord[]>(readCustomModules);
  const [encapsulateDraft, setEncapsulateDraft] = useState("");
  const [sandboxTrialMode, setSandboxTrialMode] = useState<TrialMode>("milling-pocket");

  // Trial simulation playback (shared for Commissions & Free Sandbox runs)
  const [trialPlaying, setTrialPlaying] = useState(false);
  const [trialFrameIdx, setTrialFrameIdx] = useState(0);
  const [showTrialVerdict, setShowTrialVerdict] = useState(false);

  // Shared 3D viewport & management UI state
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState("");
  const [saveFeedback, setSaveFeedback] = useState("");
  const [bomOpen, setBomOpen] = useState(false);
  const [bomTab, setBomTab] = useState<"bom" | "photo">("bom");
  const [customWidthInput, setCustomWidthInput] = useState("");
  const [customMassInput, setCustomMassInput] = useState("");
  const [thrusterDraftN, setThrusterDraftN] = useState("");
  const [coupleTargetDraft, setCoupleTargetDraft] = useState("");
  const [coupleRatioDraft, setCoupleRatioDraft] = useState("-1");
  const [showroomRightTab, setShowroomRightTab] = useState<"math" | "layers">("math");
  const [sandboxRightTab, setSandboxRightTab] = useState<"structure" | "math">("structure");
  const [fromZeroLabId, setFromZeroLabId] = useState<FromZeroLabId | "">("");
  const [labEngineModuleId, setLabEngineModuleId] = useState("");
  const [customCreatorOpen, setCustomCreatorOpen] = useState(false);
  const [lastBuildPillar, setLastBuildPillar] = useState<"commissions" | "sandbox">("sandbox");
  const [physicsSourceHint, setPhysicsSourceHint] = useState<"current" | UniversalArchetypeId | undefined>(undefined);
  const [closureNodeA, setClosureNodeA] = useState("");
  const [closureNodeB, setClosureNodeB] = useState("");
  const [closureKind, setClosureKind] = useState<"connect" | "weld" | "spring">("connect");
  const [error, setError] = useState("");

  useEffect(() => {
    writeCompletedCommissions(completedComms);
  }, [completedComms]);

  useEffect(() => {
    writeCustomModules(customModules);
  }, [customModules]);

  useEffect(() => {
    if (!saveFeedback) return;
    const timer = window.setTimeout(() => setSaveFeedback(""), 2200);
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

  const currentCommission = useMemo(
    () => EVOLUTION_COMMISSIONS.find((c) => c.id === commissionId) ?? EVOLUTION_COMMISSIONS[0]!,
    [commissionId],
  );
  const currentExhibitDef = useMemo(
    () => SHOWROOM_EXHIBITS.find((e) => e.id === exhibitId) ?? SHOWROOM_EXHIBITS[0]!,
    [exhibitId],
  );
  const flagshipArchetypes = useMemo(
    () => UNIVERSAL_ARCHETYPES.filter((a) => a.category === "flagship"),
    [],
  );
  const activeMegaDef = useMemo(
    () => (megaExhibitId ? UNIVERSAL_ARCHETYPES.find((a) => a.id === megaExhibitId) ?? null : null),
    [megaExhibitId],
  );
  const megaExhibitData = useMemo(
    () => (megaExhibitId ? loadUniversalArchetype(megaExhibitId) : null),
    [megaExhibitId],
  );

  // Active workspace & assembly for whichever pillar is active
  const activeSession =
    pillar === "commissions"
      ? commSession
      : pillar === "sandbox"
        ? sandboxSession
        : pillar === "physics"
          ? lastBuildPillar === "commissions"
            ? commSession
            : sandboxSession
          : megaExhibitData
            ? {
                workspace: megaExhibitData.workspace,
                assembly: megaExhibitData.assembly,
                commands: megaExhibitData.assembly.commands,
                dirty: false,
                history: [],
              }
            : {
                workspace: exhibitData.workspace,
                assembly: exhibitData.assembly,
                commands: exhibitData.assembly.commands,
                dirty: false,
                history: [],
              };

  // Precomputed live Showroom Trial simulation (reacts live to What-If sliders!)
  const showroomSim = useMemo(() => {
    if (pillar !== "showroom" || megaExhibitId !== null) return null;
    return simulateMachineTrial(exhibitData.workspace, exhibitData.assembly, currentExhibitDef.simMode, {
      payloadMassKg: whatIfPayloadKg,
      screwLeadOverrideMm: whatIfLeadMm,
      feedRateMmS: whatIfFeedMmS,
    });
  }, [pillar, megaExhibitId, exhibitData, currentExhibitDef.simMode, whatIfPayloadKg, whatIfLeadMm, whatIfFeedMmS]);

  // Active Trial Simulation for Commissions or Sandbox when user hits "通电试机"
  const activeBuildSim = useMemo(() => {
    if (pillar === "showroom" || pillar === "physics" || !showTrialVerdict) return null;
    const mode = pillar === "commissions" ? currentCommission.trialMode : sandboxTrialMode;
    return simulateMachineTrial(activeSession.workspace, activeSession.assembly, mode);
  }, [pillar, showTrialVerdict, currentCommission.trialMode, sandboxTrialMode, activeSession.workspace, activeSession.assembly]);

  // Real-time structural + electrical physics pre-check for build modes
  const livePhysics = useMemo(() => {
    if (showroomSim) return showroomSim.physics;
    if (activeBuildSim) return activeBuildSim.physics;
    return analyzeMachinePhysics(activeSession.workspace, activeSession.assembly);
  }, [showroomSim, activeBuildSim, activeSession.workspace, activeSession.assembly]);

  // Loop Showroom live machining animation
  useEffect(() => {
    if (pillar !== "showroom" || !showroomPlaying || !showroomSim || showroomSim.frames.length === 0) return;
    let raf = 0;
    let lastTs = performance.now();
    let acc = 0;
    const total = showroomSim.frames.length;

    const tick = (now: number) => {
      acc += (now - lastTs) / 1000;
      lastTs = now;
      if (acc >= 0.05) {
        const steps = Math.max(1, Math.floor(acc / 0.05));
        acc = 0;
        setShowroomFrameIdx((idx) => (idx + steps) % total);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [pillar, showroomPlaying, showroomSim]);

  // Loop Flagship Space & Landmark real-time articulated showroom animation
  useEffect(() => {
    if (pillar !== "showroom" || megaExhibitId === null || !showroomPlaying) return;
    let raf = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dtSec = Math.min(0.1, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;
      setMegaPhaseDeg((prev) => (prev + dtSec * 72 * megaSpeedMult) % 36000);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [pillar, megaExhibitId, showroomPlaying, megaSpeedMult]);

  // Play trial run once (holding on final milled cut so user inspects result)
  useEffect(() => {
    if (pillar === "showroom" || pillar === "physics" || !trialPlaying || !activeBuildSim || activeBuildSim.frames.length === 0) return;
    let raf = 0;
    let lastTs = performance.now();
    let acc = 0;
    const maxIdx = activeBuildSim.frames.length - 1;

    const tick = (now: number) => {
      acc += (now - lastTs) / 1000;
      lastTs = now;
      if (acc >= 0.04) {
        const step = Math.max(1, Math.floor(acc / 0.04));
        acc = 0;
        setTrialFrameIdx((idx) => {
          const next = idx + step;
          if (next >= maxIdx) {
            setTrialPlaying(false);
            return maxIdx;
          }
          return next;
        });
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [pillar, trialPlaying, activeBuildSim]);

  // Resolve current viewport commands & real 3D carved aluminum state
  const viewportPlayback = useMemo(() => {
    if (pillar === "showroom" && megaExhibitId !== null && megaExhibitData) {
      const commands: Record<string, number> =
        megaExhibitId === "oriental-pearl-tower"
          ? {
              lower_orbit_ring: megaPhaseDeg * 0.45,
              sky_restaurant_deck: -megaPhaseDeg * 0.3,
              space_capsule_rotor: megaPhaseDeg * 0.75,
            }
          : megaExhibitId === "rescue-helicopter"
            ? {
                lower_rotor: megaPhaseDeg * 3.5,
                swashplate_tilt: Math.sin((megaPhaseDeg * Math.PI) / 180) * 8,
              }
            : {
                tvc_nozzle: Math.sin((megaPhaseDeg * 1.6 * Math.PI) / 180) * 11,
              };
      return {
        commands,
        stockState: null,
        idealTrailMm: undefined,
        actualTrailMm: undefined,
        trailInWorkpieceFrame: false,
        showTipMarker: false,
      };
    }
    if (pillar === "showroom" && showroomSim) {
      const idx = clamp(showroomFrameIdx, 0, Math.max(0, showroomSim.frames.length - 1));
      const frame = showroomSim.frames[idx];
      const stock = showroomSim.stockStates[idx] ?? null;
      return {
        commands: frame?.commands ?? activeSession.commands,
        stockState: stock,
        idealTrailMm: showroomSim.idealTrailMm,
        actualTrailMm: showroomSim.actualTrailMm,
        trailInWorkpieceFrame: showroomSim.trailInWorkpieceFrame,
        showTipMarker: true,
      };
    }
    if ((pillar === "commissions" || pillar === "sandbox") && showTrialVerdict && activeBuildSim) {
      const idx = clamp(trialFrameIdx, 0, Math.max(0, activeBuildSim.frames.length - 1));
      const frame = activeBuildSim.frames[idx];
      const stock = activeBuildSim.stockStates[idx] ?? null;
      return {
        commands: frame?.commands ?? activeSession.commands,
        stockState: stock,
        idealTrailMm: activeBuildSim.idealTrailMm,
        actualTrailMm: activeBuildSim.actualTrailMm,
        trailInWorkpieceFrame: activeBuildSim.trailInWorkpieceFrame,
        showTipMarker: true,
      };
    }
    return {
      commands: activeSession.commands,
      stockState: null,
      idealTrailMm: undefined,
      actualTrailMm: undefined,
      trailInWorkpieceFrame: false,
      showTipMarker: false,
    };
  }, [
    pillar,
    megaExhibitId,
    megaExhibitData,
    megaPhaseDeg,
    showroomSim,
    showroomFrameIdx,
    showTrialVerdict,
    activeBuildSim,
    trialFrameIdx,
    activeSession.commands,
  ]);

  const solved = useMemo(
    () =>
      solveArticulatedAssembly(activeSession.workspace, activeSession.assembly, {
        commandOverrides: viewportPlayback.commands,
        explodeFactor: explodePct / 100,
      }),
    [activeSession.workspace, activeSession.assembly, viewportPlayback.commands, explodePct],
  );

  const treeRows = useMemo(
    () => buildAssemblyTreeRows(activeSession.workspace, activeSession.assembly, solved),
    [activeSession.workspace, activeSession.assembly, solved],
  );

  const bomRows = useMemo(
    () => extractSandboxBomSummary(activeSession.workspace, activeSession.assembly),
    [activeSession.workspace, activeSession.assembly],
  );

  const savedMachines = useMemo(() => listSavedSandboxMachines(workspace), [workspace]);

  const unlockedSet = useMemo(() => {
    if (unlockAll || pillar === "sandbox") {
      return {
        blocks: new Set(SANDBOX_BLOCKS.map((b) => b.id)),
        modules: new Set(MODULE_BLUEPRINTS.map((m) => m.id)),
      };
    }
    const blocks = new Set(currentCommission.unlockedBlockIds);
    const modules = new Set(currentCommission.unlockedModuleIds);
    if (completedComms.has("comm-1-axis")) {
      modules.add("mod_feed_x");
      modules.add("mod_feed_y");
      blocks.add("slide_y");
    }
    if (completedComms.has("comm-2-xy")) {
      modules.add("mod_feed_z");
      modules.add("mod_xy_stage");
      ["column_4080", "gusset_l", "slide_z", "spindle_head", "workpiece_block"].forEach((id) => blocks.add(id));
    }
    if (completedComms.has("comm-3-mill")) {
      SANDBOX_BLOCKS.forEach((b) => blocks.add(b.id));
    }
    return { blocks, modules };
  }, [unlockAll, pillar, currentCommission, completedComms]);

  const filteredBlocks = useMemo(
    () =>
      paletteFilter === "all" || paletteFilter === "modules" || paletteFilter === "manual"
        ? SANDBOX_BLOCKS
        : SANDBOX_BLOCKS.filter((b) => b.category === paletteFilter),
    [paletteFilter],
  );

  const setActiveEditorSession = useCallback(
    (updater: (prev: MachineEditorSession) => MachineEditorSession) => {
      setShowTrialVerdict(false);
      setTrialPlaying(false);
      if (pillar === "commissions") setCommSession(updater);
      else if (pillar === "sandbox") setSandboxSession(updater);
    },
    [pillar],
  );

  function selectExhibit(nextId: ShowroomExhibitId) {
    setMegaExhibitId(null);
    setExhibitId(nextId);
    setExhibitData(loadShowroomExhibit(nextId));
    setShowroomFrameIdx(0);
    setShowroomPlaying(true);
    setActiveLayerId(null);
    setSelectedNodeId("");
    setFitToken((n) => n + 1);
  }

  function selectMegaExhibit(nextId: UniversalArchetypeId) {
    setMegaExhibitId(nextId);
    setExplodePct(0);
    setActiveLayerId(null);
    setSelectedNodeId("");
    setShowroomPlaying(true);
    setFitToken((n) => n + 1);
  }

  function selectCommission(nextId: CommissionId) {
    setCommissionId(nextId);
    setCommSession(makeCommissionSession(nextId));
    setShowTrialVerdict(false);
    setTrialPlaying(false);
    setArmedItem(null);
    setPreferredParentId("");
    setSelectedNodeId("");
    setError("");
    setFitToken((n) => n + 1);
  }

  function enterCommissionWithStarter(nextId: CommissionId) {
    setPillar("commissions");
    selectCommission(nextId);
  }

  function applyModularInsert(
    item: { kind: "block" | "module" | "custom"; id: string },
    parentNodeId: string,
    parentMountId: string,
  ) {
    setError("");
    const cur = pillar === "commissions" ? commSession : sandboxSession;
    try {
      if (item.kind === "block") {
        const res = snapBlockOntoAssembly(cur.workspace, cur.assembly, item.id, parentNodeId, parentMountId);
        setActiveEditorSession((prev) => ({
          workspace: res.workspace,
          assembly: res.assembly,
          commands: { ...res.assembly.commands },
          dirty: true,
          history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
        }));
        setSelectedNodeId(res.addedNodeId);
      } else {
        const modData =
          item.kind === "module"
            ? MODULE_BLUEPRINTS.find((m) => m.id === item.id)?.buildFn()
            : (() => {
                const cm = customModules.find((c) => c.id === item.id);
                return cm ? { workspace: cm.workspace, assembly: cm.assembly } : undefined;
              })();
        if (!modData) throw new Error(`找不到封装模块：${item.id}`);
        const res = snapModuleOntoAssembly(cur.workspace, cur.assembly, modData, parentNodeId, parentMountId);
        setActiveEditorSession((prev) => ({
          workspace: res.workspace,
          assembly: res.assembly,
          commands: { ...res.assembly.commands },
          dirty: true,
          history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
        }));
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
    setActiveEditorSession((prev) => ({
      workspace: modData.workspace,
      assembly: modData.assembly,
      commands: { ...modData.assembly.commands },
      dirty: true,
      history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
    }));
    setSelectedNodeId("");
    setPreferredParentId("");
    setArmedItem(null);
    setFitToken((n) => n + 1);
    setHoverHint(`已拆开子总成「${modData.assembly.name}」在画布上逐件编辑`);
  }

  function quickAttachItem(item: { kind: "block" | "module" | "custom"; id: string }, overrideParentId?: string) {
    const cur = pillar === "commissions" ? commSession : sandboxSession;
    if (cur.assembly.nodes.length === 0) {
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
        const res = placeRootBlockInSandbox(cur.workspace, cur.assembly, item.id);
        setActiveEditorSession((prev) => ({
          workspace: res.workspace,
          assembly: res.assembly,
          commands: { ...res.assembly.commands },
          dirty: true,
          history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
        }));
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
    const best = findBestSnapTarget(cur.workspace, cur.assembly, probeBlockId, hintParent);
    if (!best) {
      setError("当前没有合适的空闲安装面，请在右栏结构树点 + 选择安装父件。");
      return;
    }
    applyModularInsert(item, best.parentNodeId, best.parentMountId);
    setHoverHint(`已吸合到「${best.parentLabel}」的 ${best.mountLabel}`);
  }

  function startFromZeroBlank(labId: FromZeroLabId | "" = "") {
    setError("");
    const zero = createZeroBlankSandbox();
    setSandboxSession((prev) => ({
      workspace: zero.workspace,
      assembly: zero.assembly,
      commands: {},
      dirty: true,
      history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
    }));
    setFromZeroLabId(labId);
    setLabEngineModuleId("");
    setLastBuildPillar("sandbox");
    setPillar("sandbox");
    setArmedItem(null);
    setSelectedNodeId("");
    setPreferredParentId("");
    setShowTrialVerdict(false);
    setFitToken((n) => n + 1);
  }

  function handleLabEncapsulateEngine() {
    setError("");
    try {
      const rec = encapsulateUserModule(
        activeSession.workspace,
        activeSession.assembly,
        "自造电泵矢量发动机总成",
      );
      setCustomModules((prev) => [rec, ...prev.slice(0, 15)]);
      setLabEngineModuleId(rec.id);
      const zero = createZeroBlankSandbox();
      setSandboxSession((prev) => ({
        workspace: zero.workspace,
        assembly: zero.assembly,
        commands: {},
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
      setArmedItem(null);
      setSelectedNodeId("");
      setPreferredParentId("");
      setFitToken((n) => n + 1);
      setSaveFeedback(`已封装「${rec.name}」，现在放贮箱并挂上这台发动机总成！`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "封装发动机总成失败。");
    }
  }

  function handleAutoCoupleCounterRotor() {
    const motors = activeSession.assembly.nodes.filter((n) => {
      const pkg = activeSession.workspace.packages.find((p) => packageKey(p) === n.packageKey);
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

  function handleRunTrial() {
    setError("");
    setArmedItem(null);
    setShowTrialVerdict(true);
    setTrialFrameIdx(0);
    setTrialPlaying(true);

    if (pillar === "commissions") {
      const sim = simulateMachineTrial(commSession.workspace, commSession.assembly, currentCommission.trialMode);
      if (sim.verdict.passed) {
        setCompletedComms((prev) => {
          if (prev.has(commissionId)) return prev;
          const next = new Set(prev);
          next.add(commissionId);
          return next;
        });
      }
    }
  }

  function undoBuild() {
    setShowTrialVerdict(false);
    setTrialPlaying(false);
    setActiveEditorSession((prev) => {
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
  }

  function mutateSelectedNode(nodeId: string, patch: Parameters<typeof updateSandboxNode>[3]) {
    if (pillar === "showroom") return;
    setError("");
    try {
      const cur = activeSession;
      const res = updateSandboxNode(cur.workspace, cur.assembly, nodeId, patch);
      setActiveEditorSession((prev) => ({
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

  function deleteNodeById(nodeId: string) {
    if (pillar === "showroom") return;
    setError("");
    try {
      const nextAsm = removeSandboxNode(activeSession.workspace, activeSession.assembly, nodeId);
      setActiveEditorSession((prev) => ({
        ...prev,
        assembly: nextAsm,
        commands: { ...nextAsm.commands },
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
      if (selectedNodeId === nodeId) setSelectedNodeId("");
      if (preferredParentId === nodeId) setPreferredParentId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "根节点不可删除。");
    }
  }

  function handleSaveCurrentMachine(options?: { asNewCopy?: boolean; customName?: string }) {
    setError("");
    try {
      const res = saveSandboxMachineToWorkspace(workspace, activeSession.workspace, activeSession.assembly, options);
      onSaveWorkspace(res.workspace);
      if (pillar === "commissions") {
        setCommSession((prev) => ({ ...prev, assembly: res.savedAssembly, dirty: false }));
      } else if (pillar === "sandbox") {
        setSandboxSession((prev) => ({ ...prev, assembly: res.savedAssembly, dirty: false }));
      }
      setSaveFeedback(`已保存「${res.savedAssembly.name}」`);
      setSaveNameDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存机器失败。");
    }
  }

  function handleEncapsulateAsModule() {
    setError("");
    try {
      const rec = encapsulateUserModule(
        activeSession.workspace,
        activeSession.assembly,
        encapsulateDraft || activeSession.assembly.name,
      );
      setCustomModules((prev) => [rec, ...prev.slice(0, 15)]);
      setEncapsulateDraft("");
      setSaveFeedback(`已封装模块「${rec.name}」`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "封装模块失败。");
    }
  }

  function handleOpenSavedMachine(assemblyId: string) {
    setError("");
    try {
      const loaded = loadSandboxMachineFromWorkspace(workspace, assemblyId);
      setPillar("sandbox");
      setSandboxSession({
        workspace: loaded.workspace,
        assembly: loaded.assembly,
        commands: { ...loaded.assembly.commands },
        dirty: false,
        history: [],
      });
      setLibraryOpen(false);
      setSelectedNodeId("");
      setShowTrialVerdict(false);
      setFitToken((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "载入机器失败。");
    }
  }

  function launchClosedLoopTwin() {
    try {
      const { workspace: convertedWs, system } = convertSandboxToSystemTwin(
        activeSession.workspace,
        activeSession.assembly,
      );
      const merged = upsertMechanicalAssembly(convertedWs, activeSession.assembly);
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
      onNavigate({ view: "workbench", target: `system:${system.id}` }, `已由当前设计生成闭环仿真系统「${system.name}」。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转换 Modelica 闭环系统失败。");
    }
  }

  async function launchMujocoPro() {
    setError("");
    try {
      const compiled = compileAssemblyToMujoco(activeSession.workspace, activeSession.assembly);
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
      onNavigate(
        { view: "workbench", target: `model:${ref.id}` },
        `已由当前设计编译 MuJoCo 刚体模型「${activeSession.assembly.name}」并载入多体求解台。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "编译送入 MuJoCo 多体物理台失败。");
    }
  }

  function mutateAssemblyConfig(updater: (asm: MechanicalAssembly) => MechanicalAssembly) {
    if (pillar === "showroom" || pillar === "physics") return;
    setError("");
    try {
      const nextAsm = updater(activeSession.assembly);
      setActiveEditorSession((prev) => ({
        ...prev,
        assembly: nextAsm,
        dirty: true,
        history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改装配物理设置失败。");
    }
  }

  function loadArchetypeIntoSandbox(id: UniversalArchetypeId) {
    setError("");
    const loaded = loadUniversalArchetype(id);
    setPillar("sandbox");
    setSandboxSession({
      workspace: loaded.workspace,
      assembly: loaded.assembly,
      commands: { ...loaded.assembly.commands },
      dirty: true,
      history: [...sandboxSession.history.slice(-15), { workspace: sandboxSession.workspace, assembly: sandboxSession.assembly }],
    });
    setSelectedNodeId("");
    setPreferredParentId("");
    setShowTrialVerdict(false);
    setFitToken((n) => n + 1);
  }

  const nextCommission = useMemo(() => {
    const idx = EVOLUTION_COMMISSIONS.findIndex((c) => c.id === commissionId);
    return idx >= 0 && idx + 1 < EVOLUTION_COMMISSIONS.length ? EVOLUTION_COMMISSIONS[idx + 1] : null;
  }, [commissionId]);

  const selectedSolved = solved.nodes.find((n) => n.path === selectedNodeId);
  const selectedRawNode = activeSession.assembly.nodes.find((n) => n.id === selectedNodeId);
  const selectedPkg = selectedRawNode
    ? activeSession.workspace.packages.find((p) => packageKey(p) === selectedRawNode.packageKey)
    : undefined;
  const selectedPart = selectedPkg?.mechanics?.kind === "part" ? selectedPkg.mechanics : undefined;
  const selectedPrimaryLen = selectedPkg?.primitive
    ? getPrimaryLengthMm(
        primitiveBoundingBoxMm(selectedPkg.primitive),
        selectedPkg.primitive as unknown as Record<string, unknown>,
      )
    : undefined;

  const physicsHighlight = useMemo(
    () => ({
      overloadedNodeIds: pillar === "showroom" && megaExhibitId ? [] : livePhysics.overloadedNodeIds,
      columnDeflectionUm: livePhysics.columnDeflectionUm,
      cuttingForceN: livePhysics.cuttingForceN,
      thrustForceN: livePhysics.thrustForceN,
      hasSpindle: livePhysics.hasSpindle,
    }),
    [livePhysics, pillar, megaExhibitId],
  );

  const activeSimResult = pillar === "showroom" ? showroomSim : activeBuildSim;
  const verdict = activeSimResult?.verdict;
  const causalFeed = pillar === "showroom" ? whatIfFeedMmS : 28;
  const isInteractiveBuild = pillar === "commissions" || pillar === "sandbox";
  const preferredParentNode = preferredParentId
    ? activeSession.assembly.nodes.find((n) => n.id === preferredParentId)
    : undefined;

  const physicsModel = useMemo(
    () => deriveAssemblyPhysicsModel(activeSession.workspace, activeSession.assembly, selectedNodeId),
    [activeSession.workspace, activeSession.assembly, selectedNodeId],
  );
  const activeLabEval = useMemo(
    () =>
      pillar === "sandbox" && fromZeroLabId
        ? evaluateFromZeroLab(fromZeroLabId, activeSession.workspace, activeSession.assembly, physicsModel, {
            engineModuleSaved: Boolean(labEngineModuleId),
            engineModuleId: labEngineModuleId || undefined,
          })
        : null,
    [pillar, fromZeroLabId, activeSession.workspace, activeSession.assembly, physicsModel, labEngineModuleId],
  );

  const viewportHudText = armedItem
    ? preferredParentNode
      ? `已拿起模块 — 点击「${preferredParentNode.label ?? preferredParentNode.id}」的蓝色发光球吸附`
      : "已拿起积木 — 点击 3D 视口青色发光球吸附（或点右侧直接吸附）"
    : hoverHint ||
      (activeSession.assembly.nodes.length === 0
        ? "空白工作台 (0 件) — 先在左侧点击任意积木或「自定义参数化零件」放置第 1 件基准刚体"
        : pillar === "showroom"
          ? activeMegaDef
            ? `${activeMegaDef.badge} · ${activeMegaDef.title} — ${activeMegaDef.physicsHighlights}`
            : `${currentExhibitDef.badge} · ${currentExhibitDef.title} — ${currentExhibitDef.takeaway}`
          : pillar === "commissions"
            ? `${currentCommission.badge} · ${currentCommission.title}`
            : `自由创造台 · ${activeSession.assembly.name}`);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* Top Studio Header */}
      <header className="surface flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
            <Blocks className="size-4 text-primary" />
            <span>构元 · 数字机械造物台</span>
          </h1>
          <Button
            size="sm"
            variant="outline"
            className="h-7 max-w-[14rem] gap-1 px-2 text-xs"
            onClick={() => {
              setSaveNameDraft(activeSession.assembly.name);
              setLibraryOpen(true);
            }}
          >
            <FolderOpen className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{activeSession.assembly.name}</span>
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </Button>
        </div>

        {/* 4 Cohesive Pillars */}
        <div role="tablist" aria-label="核心工作区切换" className="flex flex-wrap items-center gap-1 rounded-md border bg-background/70 p-0.5">
          <Button
            size="sm"
            role="tab"
            aria-selected={pillar === "showroom"}
            variant={pillar === "showroom" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setShowTrialVerdict(false);
              setPillar("showroom");
              setFitToken((n) => n + 1);
            }}
          >
            <Eye />
            原理透视展馆
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={pillar === "commissions"}
            variant={pillar === "commissions" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setLastBuildPillar("commissions");
              setPillar("commissions");
              setFitToken((n) => n + 1);
            }}
          >
            <Zap />
            造物演进委托
            <span className="ml-0.5 rounded bg-background/40 px-1 text-[10px]">
              {completedComms.size}/4
            </span>
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={pillar === "sandbox"}
            variant={pillar === "sandbox" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setLastBuildPillar("sandbox");
              setPillar("sandbox");
              setFitToken((n) => n + 1);
            }}
          >
            <Blocks />
            自由创造与 BOM
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={pillar === "physics"}
            variant={pillar === "physics" ? "default" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setArmedItem(null);
              setPhysicsSourceHint(undefined);
              setPillar("physics");
            }}
          >
            <Globe />
            多体物理仿真
          </Button>
        </div>

        {/* Global Tools: Explode View, Save, Real BOM, Pro Mode */}
        <div className="flex flex-wrap items-center gap-1.5">
          {pillar !== "physics" && (
            <Button
              size="sm"
              variant={explodePct > 0 ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setExplodePct((v) => (v > 0 ? 0 : 55))}
            >
              <Layers className="size-3.5" />
              {explodePct > 0 ? `爆炸 ${explodePct}%` : "爆炸视图"}
            </Button>
          )}
          {(pillar === "commissions" || pillar === "sandbox") && (
            <Button
              size="sm"
              variant={saveFeedback ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => handleSaveCurrentMachine()}
            >
              {saveFeedback ? <Check /> : <Save />}
              {saveFeedback || "保存"}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setBomOpen(true)}>
            <Package />
            现实 BOM (¥{livePhysics.totalCostCny})
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" className="h-7 px-2 text-xs">
                <Wrench />
                专业工程模式
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>多求解器专业工程 IDE</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void launchMujocoPro()}>
                <Box /> 送入 MuJoCo 多体物理求解台
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={launchClosedLoopTwin}>
                <Sparkles /> 送入 Modelica 机电闭环求解台
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNavigate({ view: "workbench" })}>
                <Wrench /> 进入多求解器工作台 (Modelica / MuJoCo / 产线)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNavigate({ view: "resources" })}>
                <Package /> 器件与模型资产库
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNavigate({ view: "examples" })}>
                <Blocks /> 浏览三大引擎 16 个标准算例
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {pillar === "physics" ? (
        <Suspense
          fallback={
            <div className="surface flex flex-1 items-center justify-center text-xs text-muted-foreground">
              正在加载 MuJoCo 刚体物理环境…
            </div>
          }
        >
          <MujocoSandboxArena
            key={physicsSourceHint ?? `arena-${activeSession.assembly.id}-${activeSession.assembly.nodes.length}`}
            hostWorkspace={workspace}
            currentWorkspace={activeSession.workspace}
            currentAssembly={activeSession.assembly}
            initialSource={physicsSourceHint}
            onLoadIntoSandbox={(nextWs, nextAsm) => {
              setSandboxSession({
                workspace: nextWs,
                assembly: nextAsm,
                commands: { ...nextAsm.commands },
                dirty: true,
                history: [...sandboxSession.history.slice(-15), { workspace: sandboxSession.workspace, assembly: sandboxSession.assembly }],
              });
              setLastBuildPillar("sandbox");
              setSelectedNodeId("");
              setPreferredParentId("");
              setShowTrialVerdict(false);
              setPillar("sandbox");
              setFitToken((n) => n + 1);
            }}
            onSaveHostWorkspace={onSaveWorkspace}
            onNavigate={onNavigate}
          />
        </Suspense>
      ) : (
      /* Locked 100dvh 3-Pane Workspace */
      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden max-md:grid-rows-[44dvh_auto_minmax(0,1fr)] ${
          outlinerOpen
            ? "md:grid-cols-[16.5rem_minmax(0,1fr)_16.5rem] xl:grid-cols-[18.5rem_minmax(0,1fr)_18.5rem]"
            : "md:grid-cols-[16.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_minmax(0,1fr)]"
        }`}
      >
        {/* Mobile Panel Switcher (<768px only) */}
        <div className="flex shrink-0 gap-1.5 md:hidden" role="tablist" aria-label="移动端面板切换">
          <Button
            size="sm"
            role="tab"
            aria-selected={mobileTab === "left"}
            variant={mobileTab === "left" ? "default" : "outline"}
            className="h-8 flex-1 text-xs"
            onClick={() => setMobileTab("left")}
          >
            {pillar === "showroom" ? "🎛️ 展品与破坏实验" : "🧱 模块化积木与试切"}
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={mobileTab === "right"}
            variant={mobileTab === "right" ? "default" : "outline"}
            className="h-8 flex-1 text-xs"
            onClick={() => setMobileTab("right")}
          >
            {pillar === "showroom" ? "🔍 原理分层与结构树" : `🗂️ 物理预检与结构 (${activeSession.assembly.nodes.length})`}
          </Button>
        </div>

        {/* ============================================================ */}
        {/* LEFT PANE: Context-Adaptive Control Deck                     */}
        {/* ============================================================ */}
        <aside
          aria-label="左侧实验与积木面板"
          className={`surface min-h-0 flex-col gap-2 overflow-hidden p-3 text-xs max-md:row-start-3 md:col-start-1 md:row-start-1 ${
            mobileTab === "left" ? "flex" : "hidden md:flex"
          }`}
        >
          {pillar === "showroom" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-0.5">
              {/* Flagship Exhibits Selector */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-foreground">预置装配模型</h2>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={showroomPlaying ? "default" : "outline"}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setShowroomPlaying((p) => !p)}
                    >
                      {showroomPlaying ? <Pause className="size-3" /> : <Play className="size-3" />}
                      {showroomPlaying ? "暂停" : "运转"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => {
                        if (megaExhibitId) setMegaPhaseDeg(0);
                        else setShowroomFrameIdx(0);
                        setShowroomPlaying(true);
                      }}
                    >
                      <RotateCcw className="size-3" />
                      {megaExhibitId ? "归零" : "重切"}
                    </Button>
                  </div>
                </div>

                <p className="text-[11px] font-semibold text-muted-foreground">空天载具与建筑结构</p>
                <div className="grid gap-1">
                  {flagshipArchetypes.map((item) => {
                    const selected = megaExhibitId === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => selectMegaExhibit(item.id)}
                        className={`rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                          selected
                            ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                            : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate font-semibold">{item.title}</span>
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                            {item.badge}
                          </span>
                        </div>
                        {selected && (
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{item.subtitle}</p>
                        )}
                      </button>
                    );
                  })}
                </div>

                <p className="pt-1 text-[11px] font-semibold text-muted-foreground">数控机床与机械臂</p>
                <div className="grid gap-1">
                  {SHOWROOM_EXHIBITS.map((ex) => {
                    const selected = megaExhibitId === null && ex.id === exhibitId;
                    return (
                      <button
                        key={ex.id}
                        type="button"
                        onClick={() => selectExhibit(ex.id)}
                        className={`rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                          selected
                            ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                            : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate font-semibold">{ex.title}</span>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-primary">
                            {ex.badge}
                          </span>
                        </div>
                        {selected && (
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{ex.subtitle}</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {activeMegaDef && megaExhibitData ? (
                <div className="space-y-2 rounded-md border border-primary/30 bg-background/60 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">结构分解与运动预览</span>
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setMegaSpeedMult(1);
                        setExplodePct(0);
                        setActiveLayerId(null);
                      }}
                    >
                      恢复默认
                    </button>
                  </div>

                  <label className="block space-y-0.5">
                    <div className="flex justify-between text-[11px]">
                      <span>分层三维爆炸展开</span>
                      <span className="mono text-primary">{explodePct}%</span>
                    </div>
                    <input
                      type="range"
                      aria-label="模型三维爆炸展开"
                      min={0}
                      max={100}
                      step={2}
                      value={explodePct}
                      className="h-3.5 w-full accent-primary"
                      onChange={(e) => setExplodePct(Number(e.currentTarget.value))}
                    />
                  </label>

                  <Button
                    size="sm"
                    variant={explodePct > 0 ? "default" : "outline"}
                    className="h-7 w-full text-[11px]"
                    onClick={() => setExplodePct((v) => (v > 0 ? 0 : 65))}
                  >
                    {explodePct > 0 ? "收拢装配结构" : "展开装配爆炸图"}
                  </Button>

                  <label className="block space-y-0.5">
                    <div className="flex justify-between text-[11px]">
                      <span>运转演示速率</span>
                      <span className="mono text-primary">{megaSpeedMult.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      aria-label="机构运转演示速率"
                      min={0.4}
                      max={2.5}
                      step={0.1}
                      value={megaSpeedMult}
                      className="h-3.5 w-full accent-primary"
                      onChange={(e) => setMegaSpeedMult(Number(e.currentTarget.value))}
                    />
                  </label>

                  <Button
                    size="sm"
                    className="h-8 w-full text-xs"
                    onClick={() => {
                      setPhysicsSourceHint(activeMegaDef.id);
                      setPillar("physics");
                    }}
                  >
                    在 MuJoCo 中运行刚体仿真 →
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() => {
                      setSandboxSession({
                        workspace: megaExhibitData.workspace,
                        assembly: megaExhibitData.assembly,
                        commands: { ...megaExhibitData.assembly.commands },
                        dirty: true,
                        history: [
                          ...sandboxSession.history.slice(-15),
                          { workspace: sandboxSession.workspace, assembly: sandboxSession.assembly },
                        ],
                      });
                      setLastBuildPillar("sandbox");
                      setSelectedNodeId("");
                      setPreferredParentId("");
                      setShowTrialVerdict(false);
                      setPillar("sandbox");
                      setFitToken((n) => n + 1);
                    }}
                  >
                    载入自由创造台编辑与导出 BOM
                  </Button>
                </div>
              ) : (
                <>
                  {/* Destructive Physics Lab Sliders */}
                  <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">动手“破坏实验”看物理规律</span>
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setWhatIfPayloadKg(0);
                          setWhatIfLeadMm(8);
                          setWhatIfFeedMmS(32);
                          setExplodePct(0);
                          setActiveLayerId(null);
                        }}
                      >
                        恢复标准
                      </button>
                    </div>

                    <label className="block space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span>工件附加配重（看惯量过冲）</span>
                        <span className="mono text-primary">+{whatIfPayloadKg} kg</span>
                      </div>
                      <input
                        type="range"
                        aria-label="工件附加配重"
                        min={0}
                        max={45}
                        step={1}
                        value={whatIfPayloadKg}
                        className="h-3.5 w-full accent-primary"
                        onChange={(e) => setWhatIfPayloadKg(Number(e.currentTarget.value))}
                      />
                    </label>

                    <label className="block space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span>丝杠导程 p（机械杠杆比）</span>
                        <span className="mono text-primary">{whatIfLeadMm} mm/rev</span>
                      </div>
                      <input
                        type="range"
                        aria-label="丝杠导程"
                        min={4}
                        max={24}
                        step={2}
                        value={whatIfLeadMm}
                        className="h-3.5 w-full accent-primary"
                        onChange={(e) => setWhatIfLeadMm(Number(e.currentTarget.value))}
                      />
                    </label>

                    <label className="block space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span>切削进给速度（看让刀变形）</span>
                        <span className="mono text-primary">{whatIfFeedMmS} mm/s</span>
                      </div>
                      <input
                        type="range"
                        aria-label="切削进给速度"
                        min={10}
                        max={120}
                        step={2}
                        value={whatIfFeedMmS}
                        className="h-3.5 w-full accent-primary"
                        onChange={(e) => setWhatIfFeedMmS(Number(e.currentTarget.value))}
                      />
                    </label>

                    <label className="block space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span>分层三维爆炸展开</span>
                        <span className="mono text-primary">{explodePct}%</span>
                      </div>
                      <input
                        type="range"
                        aria-label="分层爆炸展开"
                        min={0}
                        max={100}
                        step={2}
                        value={explodePct}
                        className="h-3.5 w-full accent-primary"
                        onChange={(e) => setExplodePct(Number(e.currentTarget.value))}
                      />
                    </label>

                    {/* One-click Contrast Experiment Buttons */}
                    <div className="grid grid-cols-1 gap-1 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 justify-start text-[10px]"
                        onClick={() => {
                          if (exhibitId === "articulated-arm") selectExhibit("c-frame-mill");
                          setWhatIfPayloadKg(38);
                          setWhatIfLeadMm(10);
                          setWhatIfFeedMmS(74);
                          setXrayMode(true);
                        }}
                      >
                        ⚡ 实验 A：5倍超重负载 → 看拐角明显失圆
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 justify-start text-[10px]"
                        onClick={() => {
                          if (exhibitId === "articulated-arm") selectExhibit("c-frame-mill");
                          setWhatIfPayloadKg(14);
                          setWhatIfLeadMm(24);
                          setWhatIfFeedMmS(88);
                          setXrayMode(true);
                        }}
                      >
                        ⚡ 实验 B：大导程 24 mm → 看电机红灯过载报警
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 justify-start text-[10px]"
                        onClick={() => {
                          const target = exhibitId === "gantry-mill" ? "c-frame-mill" : "gantry-mill";
                          selectExhibit(target);
                          setWhatIfPayloadKg(6);
                          setWhatIfLeadMm(8);
                          setWhatIfFeedMmS(76);
                          setXrayMode(true);
                        }}
                      >
                        ⚡ 实验 C：一键切换 C型单柱 vs 双柱龙门对比让刀
                      </Button>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    className="mt-auto h-8 w-full text-xs"
                    onClick={() => enterCommissionWithStarter("comm-1-axis")}
                  >
                    看懂原理了？去「造物演进委托」亲手搭一台
                    <ArrowRight />
                  </Button>
                </>
              )}
            </div>
          )}

          {pillar === "commissions" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              {/* Commission Selector & Unlock Toggle */}
              <div className="shrink-0 space-y-1.5 rounded-md border bg-background/60 p-2">
                <div className="flex items-center justify-between gap-1">
                  <div className="grid flex-1 grid-cols-4 gap-1">
                    {EVOLUTION_COMMISSIONS.map((c, idx) => {
                      const active = c.id === commissionId;
                      const done = completedComms.has(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectCommission(c.id)}
                          className={`rounded border px-1 py-1 text-[10px] font-medium transition-colors ${
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : done
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                : "bg-background/50 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {done ? "✅" : `${idx + 1}.`} {c.badge.replace("委托", "阶")}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    title="临时全解锁所有组件与模组"
                    onClick={() => setUnlockAll((u) => !u)}
                    className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-1 text-[10px] ${
                      unlockAll ? "border-amber-400/60 bg-amber-500/15 text-amber-200" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {unlockAll ? <Unlock className="size-3" /> : <Lock className="size-3" />}
                    全解锁
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1">
                  <h2 className="truncate font-semibold text-foreground">{currentCommission.title}</h2>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {commSession.history.length > 0 && (
                      <button type="button" onClick={undoBuild} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                        <Undo2 className="size-3" /> 撤销
                      </button>
                    )}
                    <button type="button" onClick={() => selectCommission(commissionId)} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      <RotateCcw className="size-3" /> 重置
                    </button>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{currentCommission.clientBrief}</p>

                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" className="h-7 flex-1 text-xs" onClick={handleRunTrial}>
                    <Zap />
                    {currentCommission.trialButtonLabel}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => {
                      const sol = createCommissionReferenceSolution(commissionId);
                      setCommSession({
                        workspace: sol.workspace,
                        assembly: sol.assembly,
                        commands: { ...sol.assembly.commands },
                        dirty: true,
                        history: [...commSession.history.slice(-15), { workspace: commSession.workspace, assembly: commSession.assembly }],
                      });
                      setShowTrialVerdict(false);
                      setFitToken((n) => n + 1);
                    }}
                  >
                    载入参考样机
                  </Button>
                </div>
              </div>

              {/* Trial Cut / Physics Verdict Card */}
              {showTrialVerdict && verdict && (
                <div
                  className={`shrink-0 space-y-1.5 rounded-md border p-2 ${
                    verdict.passed ? "border-emerald-500/50 bg-emerald-500/10" : "border-destructive/50 bg-destructive/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-semibold ${verdict.passed ? "text-emerald-300" : "text-red-300"}`}>
                      {verdict.passed ? `验收通过 · ${verdict.grade} 级` : "试机未达标"}
                    </span>
                    <span className="mono text-[10px] text-muted-foreground">
                      {livePhysics.hasSpindle
                        ? `误差 ±${verdict.maxContourErrorMm}mm · 让刀 ${verdict.deflectionUm}μm`
                        : `扭矩负荷 ${verdict.peakTorquePct.toFixed(0)}% · 成本 ¥${verdict.costCny}`}
                    </span>
                  </div>
                  <p className="text-[11px] font-medium text-foreground">{verdict.headline}</p>
                  <div className="space-y-0.5">
                    {verdict.checks.map((ck) => (
                      <div key={ck.label} className="flex items-center justify-between gap-1 text-[10px]">
                        <span className={ck.passed ? "text-emerald-300" : "text-red-300"}>
                          {ck.passed ? "✅" : "❌"} {ck.label}
                        </span>
                        <span className="mono text-muted-foreground">{ck.valueText}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">{verdict.diagnosis}</p>
                  {verdict.passed && nextCommission && (
                    <Button
                      size="sm"
                      className="h-6 w-full text-[11px]"
                      onClick={() => enterCommissionWithStarter(nextCommission.id)}
                    >
                      领受下一委托：{nextCommission.title} <ArrowRight />
                    </Button>
                  )}
                </div>
              )}

              {/* Scrollable Modules + Primitives Palette */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                {/* Turing-Complete style Unlocked Macro Modules */}
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">📦 已封装高阶模组（点击一键吸合）</p>
                  <div className="grid gap-1">
                    {MODULE_BLUEPRINTS.map((mod) => {
                      const unlocked = unlockedSet.modules.has(mod.id);
                      const isArmed = armedItem?.kind === "module" && armedItem.id === mod.id;
                      const reqComm = EVOLUTION_COMMISSIONS.find((c) => c.id === mod.unlockedBy);
                      return (
                        <button
                          key={mod.id}
                          type="button"
                          disabled={!unlocked}
                          title={mod.subtitle}
                          onClick={() => {
                            if (preferredParentId) quickAttachItem({ kind: "module", id: mod.id }, preferredParentId);
                            else setArmedItem(isArmed ? null : { kind: "module", id: mod.id });
                          }}
                          onDoubleClick={() => unlocked && quickAttachItem({ kind: "module", id: mod.id })}
                          className={`flex items-center justify-between gap-1.5 rounded border px-2 py-1.5 text-left transition-colors ${
                            !unlocked
                              ? "cursor-not-allowed border-border/40 bg-background/20 opacity-50"
                              : isArmed
                                ? "border-primary bg-primary/15 ring-1 ring-primary"
                                : "border-sky-500/35 bg-sky-500/10 hover:border-sky-400"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">{mod.name}</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {unlocked ? "单击选3D蓝球 · 双击直装" : `完成【${reqComm?.badge ?? "前序"}】自动解锁封装`}
                            </div>
                          </div>
                          {unlocked ? (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                quickAttachItem({ kind: "module", id: mod.id });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.stopPropagation();
                                  quickAttachItem({ kind: "module", id: mod.id });
                                }
                              }}
                              className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/30"
                            >
                              装上
                            </span>
                          ) : (
                            <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Base Primitives */}
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">基础物理零件</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {SANDBOX_BLOCKS.map((blk) => {
                      const unlocked = unlockedSet.blocks.has(blk.id);
                      const isArmed = armedItem?.kind === "block" && armedItem.id === blk.id;
                      return (
                        <button
                          key={blk.id}
                          type="button"
                          disabled={!unlocked}
                          title={unlocked ? `${blk.name}：${blk.subtitle}（双击直装）` : "尚未在本阶段解锁"}
                          onClick={() => {
                            if (preferredParentId) quickAttachItem({ kind: "block", id: blk.id }, preferredParentId);
                            else setArmedItem(isArmed ? null : { kind: "block", id: blk.id });
                          }}
                          onDoubleClick={() => unlocked && quickAttachItem({ kind: "block", id: blk.id })}
                          className={`relative flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-all ${
                            !unlocked
                              ? "cursor-not-allowed opacity-40"
                              : isArmed
                                ? "border-primary bg-primary/15 ring-1 ring-primary"
                                : "bg-background/50 hover:border-primary/40 hover:bg-accent/40"
                          }`}
                        >
                          {!unlocked && <Lock className="absolute right-1 top-1 size-3 text-muted-foreground" />}
                          {unlocked && blk.defaultJoint.type !== "fixed" && (
                            <span className="absolute left-1 top-1 rounded bg-muted px-1 text-[9px] text-primary">
                              {blk.defaultJoint.type === "slide" ? "滑" : "转"}
                            </span>
                          )}
                          <SandboxBlockIcon shape={blk.spec.shape} finish={blk.spec.finish} blockId={blk.id} className="size-7" />
                          <span className="line-clamp-2 text-[10px] font-medium leading-tight">{blk.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {pillar === "sandbox" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
              {/* Row 1: Lab selector + Zero Reset + Undo */}
              <div className="flex shrink-0 items-center gap-1.5">
                <select
                  aria-label="从零造物实验课"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                  value={fromZeroLabId}
                  onChange={(e) => {
                    const val = e.target.value as FromZeroLabId | "";
                    if (!val) setFromZeroLabId("");
                    else startFromZeroBlank(val);
                  }}
                >
                  <option value="">实验课引导：自由创造（从 0 搭建）</option>
                  {FROM_ZERO_LABS.map((lab) => (
                    <option key={lab.id} value={lab.id}>
                      {lab.title}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 px-2 text-xs text-primary"
                  title="清空为 0 件空白画布"
                  onClick={() => startFromZeroBlank("")}
                >
                  <FilePlus2 className="size-3.5" /> 0件
                </Button>
                {sandboxSession.history.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 px-2 text-xs"
                    aria-label="撤销上一步"
                    title="撤销上一步"
                    onClick={undoBuild}
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                )}
              </div>

              {/* Row 2: Unified Palette / Subassembly / Joint Debug Tabs */}
              <div className="grid shrink-0 grid-cols-6 gap-1 rounded-md border bg-background/60 p-0.5" role="tablist">
                {FILTER_TABS.map((t) => {
                  const countBadge =
                    t.id === "modules"
                      ? `(${customModules.length + MODULE_BLUEPRINTS.length})`
                      : t.id === "manual"
                        ? `(${solved.activeControls.length})`
                        : "";
                  return (
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
                      title={`${t.label}${countBadge}`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {/* Palette Tab Content */}
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
                    <Button size="sm" variant="secondary" className="h-8 shrink-0 px-2.5 text-xs" onClick={handleEncapsulateAsModule}>
                      📦 封装模块
                    </Button>
                  </div>

                  {customModules.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold text-emerald-300">我的封装子总成（双击挂载）</p>
                      {customModules.map((cm) => (
                        <div
                          key={cm.id}
                          className="flex w-full items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs hover:border-emerald-400"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (activeSession.assembly.nodes.length === 0) quickAttachItem({ kind: "custom", id: cm.id });
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
                    <p className="text-[11px] font-semibold text-sky-300">内置工程子总成（双击挂载）</p>
                    {MODULE_BLUEPRINTS.map((m) => (
                      <div
                        key={m.id}
                        className="flex w-full items-center gap-1.5 rounded-md border border-sky-500/35 bg-sky-500/10 px-2 py-1.5 text-xs hover:border-sky-400"
                      >
                        <button
                          type="button"
                          title={m.subtitle}
                          onClick={() => {
                            if (activeSession.assembly.nodes.length === 0) quickAttachItem({ kind: "module", id: m.id });
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
              ) : paletteFilter === "manual" ? (
                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
                  <div className="space-y-1.5 rounded-md border bg-background/60 p-2.5">
                    <p className="text-[11px] font-semibold text-muted-foreground">单轴 / CNC 快速试机</p>
                    <div className="flex gap-1.5">
                      <select
                        aria-label="选择物理试机工况"
                        className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs"
                        value={sandboxTrialMode}
                        onChange={(e) => {
                          setSandboxTrialMode(e.target.value as TrialMode);
                          setShowTrialVerdict(false);
                        }}
                      >
                        <option value="milling-pocket">试切校友毛坯圆槽 (三轴铣)</option>
                        <option value="xy-circle">画 Ø56 mm 圆弧插补 (双轴)</option>
                        <option value="step-axis">单轴阶跃到位响应</option>
                        <option value="arm-orbit">多自由度机械臂空间包络</option>
                      </select>
                      <Button size="sm" className="h-8 shrink-0 px-2.5 text-xs" onClick={handleRunTrial}>
                        <Zap /> 试机
                      </Button>
                    </div>
                  </div>

                  {showTrialVerdict && verdict && (
                    <div
                      className={`space-y-1 rounded-md border p-2.5 text-xs ${
                        verdict.passed ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"
                      }`}
                    >
                      <div className="flex items-center justify-between font-semibold">
                        <span>{verdict.passed ? `试机评级 ${verdict.grade}` : "物理校核提醒"}</span>
                        <span className="mono text-[11px]">
                          误差 ±{verdict.maxContourErrorMm}mm · 扭矩 {verdict.peakTorquePct}%
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{verdict.diagnosis}</p>
                    </div>
                  )}

                  {solved.activeControls.length === 0 ? (
                    <p className="rounded-md border bg-background/50 p-3 text-xs text-muted-foreground">
                      暂无可动关节。添加导轨/电机/舵机或选中右栏零件设成 slide / hinge 即可在此手动摇动预览。
                    </p>
                  ) : (
                    solved.activeControls.map((ctrl) => (
                      <label key={ctrl.path} className="block space-y-1 rounded-md border bg-background/60 p-2.5">
                        <div className="flex justify-between gap-2 text-xs">
                          <span className="truncate font-medium">{ctrl.label}</span>
                          <span className="mono shrink-0 text-primary">
                            {formatNum(ctrl.value)} {ctrl.joint.type === "slide" ? "mm" : "°"}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={ctrl.joint.range[0]}
                          max={ctrl.joint.range[1]}
                          step={ctrl.joint.type === "slide" ? 0.5 : 1}
                          value={ctrl.value}
                          className="h-4 w-full accent-primary"
                          onChange={(e) => {
                            setShowTrialVerdict(false);
                            setTrialPlaying(false);
                            setActiveEditorSession((prev) => ({
                              ...prev,
                              commands: { ...prev.commands, [ctrl.path]: Number(e.currentTarget.value) },
                            }));
                          }}
                        />
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 w-full border-dashed border-primary/40 text-xs text-primary hover:bg-primary/10"
                    onClick={() => setCustomCreatorOpen(true)}
                  >
                    <Plus /> 自定义参数化原语零件 (13 种几何)
                  </Button>

                  <div className="grid grid-cols-2 gap-2">
                    {filteredBlocks.map((blk) => {
                      const isArmed = armedItem?.kind === "block" && armedItem.id === blk.id;
                      return (
                        <button
                          key={blk.id}
                          type="button"
                          title={blk.subtitle}
                          onClick={() => {
                            if (activeSession.assembly.nodes.length === 0) {
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

              {activeSession.assembly.nodes.length > 0 && (
                <Button
                  size="sm"
                  className="h-8 w-full shrink-0 text-xs"
                  onClick={() => {
                    setArmedItem(null);
                    setLastBuildPillar("sandbox");
                    setPhysicsSourceHint("current");
                    setPillar("physics");
                  }}
                >
                  <Globe /> 在 MuJoCo 中运行刚体仿真 →
                </Button>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="shrink-0 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </aside>

        {/* ============================================================ */}
        {/* CENTER PANE: 3D Physical Showroom & Sandbox Viewport         */}
        {/* ============================================================ */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:row-start-1 md:col-start-2 md:row-start-1">
          {/* Top Floating Banner */}
          <div className="pointer-events-none absolute inset-x-2.5 top-2.5 z-10 flex items-start justify-between gap-2">
            <div className="pointer-events-auto flex max-w-2xl flex-wrap items-center gap-1.5 rounded-full border border-primary/30 bg-[#101c1a]/92 px-3 py-1 text-xs text-foreground shadow-md backdrop-blur">
              <span>{viewportHudText}</span>
              {armedItem && isInteractiveBuild && (
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

            <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="secondary" className="h-7 px-2 text-xs shadow-md" onClick={() => setFitToken((n) => n + 1)}>
                <RotateCcw /> 居中视角
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="hidden h-7 px-2 text-xs shadow-md md:inline-flex"
                aria-label={outlinerOpen ? "收起右侧透视与结构栏" : "展开右侧透视与结构栏"}
                onClick={() => setOutlinerOpen((v) => !v)}
              >
                {outlinerOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </div>
          </div>

          <SandboxViewport3D
            workspace={activeSession.workspace}
            assembly={activeSession.assembly}
            mode={explodePct > 0 ? "explode" : isInteractiveBuild ? "build" : "test"}
            armedBlockId={armedItem?.kind === "block" ? armedItem.id : armedItem ? "table_plate" : null}
            selectedNodeId={selectedNodeId}
            preferredParentId={preferredParentId}
            commands={viewportPlayback.commands}
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
            stockState={viewportPlayback.stockState}
            xrayMode={xrayMode}
            activeLayerId={pillar === "showroom" ? activeLayerId : null}
            physicsHighlight={physicsHighlight}
            idealTrailMm={viewportPlayback.idealTrailMm}
            actualTrailMm={viewportPlayback.actualTrailMm}
            trailInWorkpieceFrame={viewportPlayback.trailInWorkpieceFrame}
            showTipMarker={viewportPlayback.showTipMarker}
          />

          {isInteractiveBuild && activeSession.assembly.nodes.length === 0 && !activeLabEval && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
              <div className="max-w-sm rounded-lg border border-dashed border-primary/50 bg-[#0b1412]/85 px-4 py-3 text-center text-xs text-foreground shadow-lg backdrop-blur">
                <p className="font-semibold text-primary">空白工作台 (0 件)</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  点击左侧任意原子件或「自定义参数化原语零件」放置第 1 件基准刚体，即开始建立世界坐标系。
                </p>
              </div>
            </div>
          )}

          {/* Floating Bottom Step Guide Card for From-Zero Guided Labs */}
          {pillar === "sandbox" && activeLabEval && (() => {
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
                        aria-label="关闭实验课引导"
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
                          setLastBuildPillar("sandbox");
                          setPhysicsSourceHint("current");
                          setPillar("physics");
                        }}
                      >
                        在 MuJoCo 中运行检验 →
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

          {/* Bottom Floating Live Causal Physics HUD */}
          {(!activeLabEval || pillar === "showroom") && (
            <div className="pointer-events-none absolute inset-x-2.5 bottom-3 z-10 hidden justify-center sm:flex">
              {pillar === "showroom" && activeMegaDef ? (
                <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#0b1412]/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-semibold text-amber-300">
                    {activeMegaDef.badge}
                  </span>
                  <span className="text-foreground">模块总成 {activeSession.assembly.nodes.length} 件</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="mono text-sky-300">总重 {livePhysics.totalMassKg.toFixed(2)} kg</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-emerald-300">{activeMegaDef.physicsHighlights}</span>
                </div>
              ) : (pillar === "commissions" || (pillar === "showroom" && !megaExhibitId)) ? (
                <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#0b1412]/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">进给指令</span>
                    <span className="mono font-medium text-sky-300">{causalFeed} mm/s</span>
                  </div>
                  <span className="text-muted-foreground/40">→</span>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">电机扭矩负荷</span>
                    <span className={`mono font-semibold ${livePhysics.peakTorquePct > 100 ? "text-red-400" : "text-emerald-300"}`}>
                      {livePhysics.peakTorquePct.toFixed(0)}%
                    </span>
                  </div>
                  {livePhysics.hasSpindle && (
                    <>
                      <span className="text-muted-foreground/40">→</span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">立柱让刀 δ</span>
                        <span className={`mono font-medium ${livePhysics.columnDeflectionUm > 48 ? "text-red-400" : "text-emerald-300"}`}>
                          {livePhysics.columnDeflectionUm} μm
                        </span>
                      </div>
                    </>
                  )}
                  {verdict && (
                    <>
                      <span className="text-muted-foreground/40">→</span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">{livePhysics.hasSpindle ? "实切误差" : "跟随精度"}</span>
                        <span className={`mono font-semibold ${verdict.passed ? "text-emerald-300" : "text-amber-300"}`}>
                          ±{verdict.maxContourErrorMm} mm ({verdict.grade})
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </main>

        {/* ============================================================ */}
        {/* RIGHT PANE: Layer Dissection (Showroom) OR Outliner & Physics*/}
        {/* ============================================================ */}
        <aside
          aria-label="右栏原理透视与结构管理"
          className={`surface min-h-0 flex-col overflow-hidden p-3 text-xs max-md:row-start-3 md:col-start-3 md:row-start-1 ${
            mobileTab === "right" ? "flex" : outlinerOpen ? "hidden md:flex" : "hidden"
          }`}
        >
          {pillar === "showroom" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <div role="tablist" aria-label="展馆右栏透视模式" className="flex shrink-0 gap-1 rounded border bg-background/60 p-0.5">
                <button
                  type="button"
                  role="tab"
                  aria-selected={showroomRightTab === "math"}
                  onClick={() => setShowroomRightTab("math")}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                    showroomRightTab === "math" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Calculator className="size-3" /> 数学物理模型
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showroomRightTab === "layers"}
                  onClick={() => setShowroomRightTab("layers")}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                    showroomRightTab === "layers" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Layers className="size-3" /> 四层结构解剖
                </button>
              </div>

              {showroomRightTab === "math" ? (
                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
                  <PhysicsModelCard
                    workspace={activeSession.workspace}
                    assembly={activeSession.assembly}
                    selectedNodeId={selectedNodeId}
                  />
                  <div className="border-t pt-2">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      整机零件拓扑 ({activeSession.assembly.nodes.length}件) · 点击零件定位
                    </p>
                    <div className="mt-1 space-y-0.5">
                      {treeRows.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedNodeId(r.id)}
                          className={`flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] ${
                            selectedNodeId === r.id ? "bg-primary/20 text-foreground" : "hover:bg-accent/40 text-muted-foreground"
                          }`}
                          style={{ paddingLeft: `${6 + Math.min(r.depth, 4) * 10}px` }}
                        >
                          <span className="truncate">{r.label}</span>
                          <span className="shrink-0 text-[9px]">{r.jointSummary}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="shrink-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 border-b pb-1.5">
                      <h2 className="font-semibold text-foreground">四层功能解剖透视</h2>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setXrayMode((v) => !v)}
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${
                            xrayMode
                              ? "border-primary/50 bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {xrayMode ? "透视：开" : "开透视"}
                        </button>
                        {activeLayerId && (
                          <button type="button" className="text-[11px] text-primary underline" onClick={() => setActiveLayerId(null)}>
                            显示全机
                          </button>
                        )}
                      </div>
                    </div>

                    {FUNCTIONAL_LAYERS.map((layer) => {
                      const active = activeLayerId === layer.id;
                      const count = solved.nodes.filter((n) => classifyNodeFunctionalLayer(n.pkg) === layer.id).length;
                      return (
                        <button
                          key={layer.id}
                          type="button"
                          onClick={() => {
                            setActiveLayerId(active ? null : layer.id);
                            setXrayMode(true);
                          }}
                          className={`w-full rounded-md border p-2 text-left transition-colors ${
                            active ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary" : "bg-background/50 hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-semibold">{layer.name}</span>
                            <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-primary">{count}件</span>
                          </div>
                          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{layer.roleSummary}</p>
                          <p className="mono mt-1 text-[10px] text-sky-300">{layer.formulaText}</p>
                        </button>
                      );
                    })}
                  </div>

                  {!megaExhibitId && livePhysics.warnings.length > 0 && (
                    <div className="shrink-0 space-y-1 rounded border border-red-400/50 bg-red-500/10 p-2 text-[10px] text-red-200">
                      {livePhysics.warnings.map((w) => (
                        <p key={w}>⚠️ {w}</p>
                      ))}
                    </div>
                  )}

                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t pt-2">
                    <p className="shrink-0 text-[11px] font-medium text-muted-foreground">
                      整机零件拓扑 ({activeSession.assembly.nodes.length}件) · 点击零件定位
                    </p>
                    <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
                      {treeRows.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedNodeId(r.id)}
                          className={`flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] ${
                            selectedNodeId === r.id ? "bg-primary/20 text-foreground" : "hover:bg-accent/40 text-muted-foreground"
                          }`}
                          style={{ paddingLeft: `${6 + Math.min(r.depth, 4) * 10}px` }}
                        >
                          <span className="truncate">{r.label}</span>
                          <span className="shrink-0 text-[9px]">{r.jointSummary}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {pillar !== "showroom" && (
            <>
              <div role="tablist" aria-label="创造台右栏视图" className="mb-2 flex shrink-0 gap-1 rounded border bg-background/60 p-0.5">
                <button
                  type="button"
                  role="tab"
                  aria-selected={sandboxRightTab === "structure"}
                  onClick={() => setSandboxRightTab("structure")}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                    sandboxRightTab === "structure" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  结构与参数 ({activeSession.assembly.nodes.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sandboxRightTab === "math"}
                  onClick={() => setSandboxRightTab("math")}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                    sandboxRightTab === "math" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Calculator className="size-3" /> 数学物理模型
                </button>
              </div>

              {sandboxRightTab === "math" ? (
                <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                  <PhysicsModelCard
                    workspace={activeSession.workspace}
                    assembly={activeSession.assembly}
                    selectedNodeId={selectedNodeId}
                  />
                </div>
              ) : (
                <>
              {/* Only show CNC Spindle/Deflection Strip when building CNC or Spindle machine */}
              {(pillar === "commissions" || livePhysics.hasSpindle) && (
                <div className="mb-2 shrink-0 space-y-1.5 rounded-md border bg-background/60 p-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground">主轴切削与电机负荷</span>
                    <span className="mono text-[11px] text-primary">¥{livePhysics.totalCostCny}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-center text-[11px]">
                    <div className="rounded bg-background/80 p-1">
                      <div className="text-muted-foreground">扭矩</div>
                      <div className={`mono font-semibold ${livePhysics.peakTorquePct > 100 ? "text-red-400" : "text-emerald-300"}`}>
                        {livePhysics.peakTorquePct.toFixed(0)}%
                      </div>
                    </div>
                    <div className="rounded bg-background/80 p-1">
                      <div className="text-muted-foreground">让刀 δ</div>
                      <div
                        className={`mono font-semibold ${
                          !livePhysics.hasSpindle
                            ? "text-muted-foreground"
                            : livePhysics.columnDeflectionUm > 48
                              ? "text-amber-300"
                              : "text-emerald-300"
                        }`}
                      >
                        {livePhysics.hasSpindle ? `${livePhysics.columnDeflectionUm}μm` : "—"}
                      </div>
                    </div>
                    <div className="rounded bg-background/80 p-1">
                      <div className="text-muted-foreground">总重</div>
                      <div className="mono font-semibold text-foreground">{livePhysics.totalMassKg}kg</div>
                    </div>
                  </div>
                  {livePhysics.warnings[0] && (
                    <p className="text-[11px] leading-snug text-amber-300">⚠️ {livePhysics.warnings[0]}</p>
                  )}
                </div>
              )}

              {/* Assembly Hierarchy Outliner Tree + Inline Mobility Toggle */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex shrink-0 items-center justify-between gap-1.5 border-b pb-1.5">
                  <h2 className="truncate text-xs font-semibold text-foreground">
                    装配结构 ({activeSession.assembly.nodes.length}件 · {physicsModel.totalMassKg.toFixed(2)}kg)
                  </h2>
                  <button
                    type="button"
                    title="切换底座是螺栓固定在地面还是 6 自由度自由运动"
                    className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium ${
                      activeSession.assembly.baseMobility === "free"
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() =>
                      mutateAssemblyConfig((asm) =>
                        setAssemblyBaseMobility(asm, asm.baseMobility === "free" ? "fixed" : "free"),
                      )
                    }
                  >
                    {activeSession.assembly.baseMobility === "free" ? "🛞 自由底盘" : "🔩 固定基座"}
                  </button>
                </div>

                <div className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
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
                          title="指定将下一个积木装到这个零件上"
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
              </div>

              {/* Progressive Selected Part Tweaker */}
              {selectedSolved && selectedRawNode && (
                <div className="mt-2 max-h-[52%] shrink-0 space-y-2 overflow-y-auto border-t pt-2.5 text-xs">
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
                        onClick={() => selectedPrimaryLen && mutateSelectedNode(selectedRawNode.id, { primaryLengthMm: Math.max(15, selectedPrimaryLen - 20) })}
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
                        onClick={() => selectedPrimaryLen && mutateSelectedNode(selectedRawNode.id, { primaryLengthMm: selectedPrimaryLen + 20 })}
                      >
                        +20
                      </Button>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-1">
                    <Button size="sm" variant="outline" className="h-7 px-1 text-[11px]" onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "x" })}>
                      绕X 90°
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-1 text-[11px]" onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "y" })}>
                      绕Y 90°
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-1 text-[11px]" onClick={() => mutateSelectedNode(selectedRawNode.id, { rotateAxis90: "z" })}>
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

                      <div className="space-y-1 rounded border bg-background/50 p-2">
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
                            {activeSession.assembly.nodes
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
                    </>
                  )}

                  <details className="rounded border bg-background/40 p-2 text-xs">
                    <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
                      高级微调（偏移 / 材质质量 / 推力 / 厂商型号）
                    </summary>
                    <div className="mt-2 space-y-2">
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
                    </div>
                  </details>

                  {pillar === "sandbox" &&
                    activeSession.assembly.nodes.some((n) => n.parent?.node === selectedRawNode.id) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-full text-xs"
                        onClick={() => {
                          setError("");
                          try {
                            const rec = encapsulateSubtreeModule(
                              activeSession.workspace,
                              activeSession.assembly,
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
                        <Package /> 封装此组件及下级为子总成
                      </Button>
                    )}

                  <Button size="sm" variant="destructive" className="h-7 w-full text-xs" onClick={() => deleteNodeById(selectedRawNode.id)}>
                    <Trash2 /> {selectedRawNode.parent !== null ? "拆掉此零件及下级" : "拆掉根件回到 0 件"}
                  </Button>
                </div>
              )}

              {/* Collapsible Cross-Branch Closures & Spring Connector */}
              <details
                className="mt-2 shrink-0 border-t pt-2 text-xs"
                open={(activeSession.assembly.closures?.length ?? 0) > 0}
              >
                <summary className="flex cursor-pointer select-none items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground">
                  <span className="flex items-center gap-1.5">
                    <Link2 className="size-3.5 text-primary" /> 跨分支闭环与弹簧 ({activeSession.assembly.closures?.length ?? 0})
                  </span>
                </summary>
                <div className="mt-2 space-y-1.5">
                  {(activeSession.assembly.closures?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      {activeSession.assembly.closures!.map((cl) => (
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

                  {activeSession.assembly.nodes.length >= 2 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <select
                        aria-label="闭环端点 A"
                        className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-[11px]"
                        value={closureNodeA}
                        onChange={(e) => setClosureNodeA(e.target.value)}
                      >
                        <option value="">节点A…</option>
                        {activeSession.assembly.nodes.map((n) => (
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
                        {activeSession.assembly.nodes.map((n) => (
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
                  )}
                </div>
              </details>
                </>
              )}
            </>
          )}
        </aside>
      </div>
      )}

      {/* Saved Machines Library & Quick Exhibit Loader Dialog */}
      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>我的机器作品库与展馆样机</DialogTitle>
            <DialogDescription>
              把你设计的构型保存到本机浏览器的工程库中，随时继续改造、封装成模块或推入 Modelica 闭环深度校验。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            {(pillar === "commissions" || pillar === "sandbox") && (
              <div className="flex flex-wrap items-center gap-2 rounded border bg-background/60 p-2.5">
                <Input
                  className="h-8 min-w-44 flex-1 text-xs"
                  aria-label="保存的机器名称"
                  value={saveNameDraft}
                  onChange={(e) => setSaveNameDraft(e.target.value)}
                  placeholder="填写作品名称（如：双立柱高刚性铣床）"
                />
                <Button size="sm" onClick={() => handleSaveCurrentMachine({ customName: saveNameDraft })}>
                  <Save /> 保存当前
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleSaveCurrentMachine({ asNewCopy: true, customName: saveNameDraft })}>
                  另存副本
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <p className="font-semibold text-foreground">已保存的机器工程（{savedMachines.length}件）</p>
              {savedMachines.length === 0 ? (
                <p className="rounded border border-dashed p-4 text-center text-muted-foreground">
                  暂无保存作品。在「⚡ 造物演进委托」或「🧱 自由创造」拼装后点击「保存」即可收录在此。
                </p>
              ) : (
                savedMachines.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 rounded border bg-background/60 p-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{m.name}</p>
                      <p className="text-[11px] text-muted-foreground">{m.nodes.length} 个零件 · {Object.keys(m.commands).length} 个可动自由度</p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => handleOpenSavedMachine(m.id)}>打开编辑</Button>
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

            <div className="space-y-1.5 border-t pt-3">
              <p className="font-semibold text-foreground">载入展馆原型样机到自由创造台拆改</p>
              <div className="grid grid-cols-2 gap-1.5">
                {UNIVERSAL_ARCHETYPES.map((arch) => (
                  <button
                    key={arch.id}
                    type="button"
                    onClick={() => {
                      setFromZeroLabId("");
                      loadArchetypeIntoSandbox(arch.id);
                      setLibraryOpen(false);
                    }}
                    className="flex items-center justify-between gap-1.5 rounded border bg-background/60 px-2.5 py-2 text-left hover:border-primary/50 hover:bg-accent/40"
                  >
                    <span className="truncate font-medium text-foreground">{arch.title}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-primary">{arch.badge}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Hardware BOM + Photo Intake + Modelica Closed-Loop Dialog */}
      <Dialog open={bomOpen} onOpenChange={setBomOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>现实采购 BOM 清单（预估总价 ¥{livePhysics.totalCostCny} · 整机 {livePhysics.totalMassKg} kg）</DialogTitle>
            <DialogDescription>
              先从数学力学构型完成验证，再在此将电机/丝杠/开关切换为汇川、松下、台达、PMI、THK、欧姆龙真实型号或导出采购 CSV。
            </DialogDescription>
          </DialogHeader>

          <div role="tablist" className="flex gap-1 border-b pb-2">
            <Button size="sm" variant={bomTab === "bom" || IS_PAGES ? "secondary" : "ghost"} onClick={() => setBomTab("bom")}>
              <Package /> BOM 与真实型号替换 ({bomRows.length}类)
            </Button>
            {!IS_PAGES && (
              <Button size="sm" variant={bomTab === "photo" ? "secondary" : "ghost"} onClick={() => setBomTab("photo")}>
                <Camera /> 拍照识别实物铭牌入库
              </Button>
            )}
          </div>

          {bomTab === "bom" || IS_PAGES ? (
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
                          {row.suggestedPresetCategory && pillar !== "showroom" ? (
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
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => downloadBlob(sandboxBomToCsv(bomRows), `${activeSession.assembly.name}-bom.csv`, "text/csv;charset=utf-8")}
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
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void launchMujocoPro()}>
                    <Box /> 送入 MuJoCo 多体物理
                  </Button>
                  <Button size="sm" onClick={launchClosedLoopTwin}>
                    <Sparkles /> 送入底层 Modelica 闭环深度校核 →
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <VisionIntakePanel
              workspace={workspace}
              onApply={(nextWs, opts) => {
                onSaveWorkspace(nextWs);
                if (opts?.openTarget) {
                  setBomOpen(false);
                  onNavigate({ view: "workbench", target: opts.openTarget });
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Parametric Custom Primitive Creator Dialog (All 13 Geometry Primitives) */}
      <Dialog open={customCreatorOpen} onOpenChange={setCustomCreatorOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建自定义参数化原语零件</DialogTitle>
            <DialogDescription>
              从 13 类工业/空天几何原语与 12 种材料涂装创建全新部件；若画布当前为 0 件，将自动作为基准根刚体创建坐标系。
            </DialogDescription>
          </DialogHeader>
          <PrimitivePartCreator
            submitLabel={activeSession.assembly.nodes.length === 0 ? "放置为第 1 件基准刚体" : "创建并吸附到当前装配"}
            onCancel={() => setCustomCreatorOpen(false)}
            onCreate={(pkg) => {
              setError("");
              try {
                const res = attachCustomPackageToSandbox(
                  sandboxSession.workspace,
                  sandboxSession.assembly,
                  pkg,
                  preferredParentId || undefined,
                );
                setSandboxSession((prev) => ({
                  workspace: res.workspace,
                  assembly: res.assembly,
                  commands: { ...res.assembly.commands },
                  dirty: true,
                  history: [...prev.history.slice(-15), { workspace: prev.workspace, assembly: prev.assembly }],
                }));
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
