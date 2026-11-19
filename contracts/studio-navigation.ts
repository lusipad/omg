import digitalModule from "../examples/GL10-1600END-A03.device.json";
import servoDrive from "../examples/SV660NS2R8I-FS-INT.device.json";
import { PICK_PLACE_EXAMPLE, ROBOT_EXAMPLES } from "./robot-examples";
import { signalIdSchema } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export type StudioExampleKind = "wiring" | "servo" | "so101" | "milo" | "physics";
export interface StudioExample {
  id: string;
  name: string;
  category: string;
  description: string;
  kind: StudioExampleKind;
  /** 站内资源路径相对于部署基址，不以 / 开头。 */
  preview: string;
  source?: string;
  sourceNotes?: string;
  entry?: string;
  download?: string;
  bytes?: number;
  author?: string;
  license?: string;
}

export const STUDIO_EXAMPLES: readonly StudioExample[] = [
  { id: "wiring-demo", kind: "wiring", name: "信号接线", category: "数字量输入",
    description: "将可调电压源接入汇川 GL10 输入模块，改变电压并观察 10 ms 滤波后的通道状态。",
    preview: "examples/previews/wiring.webp", source: digitalModule.source.url },
  { id: "inovance-servo", kind: "servo", name: "汇川伺服轴", category: "伺服驱动",
    description: "用 SV660N 驱动器和配套电机组成单轴，改变目标角度或负载惯量，比较位置和速度曲线。",
    preview: "examples/previews/servo.webp", source: servoDrive.source.url },
  { id: "so101-follower", kind: "so101", name: "SO-101 从臂", category: "六关节机器人",
    description: "核对从臂采购表，编辑关节关键帧，查看夹爪轨迹和实际关节响应。",
    preview: "models/so101/preview.png", source: "https://github.com/TheRobotStudio/SO-ARM100",
    sourceNotes: "models/so101/SOURCE.md", download: "models/so101/follower-bom.md" },
  { id: "milo-v1-5", kind: "milo", name: "Milo v1.5 三轴铣床", category: "数控加工",
    description: "回放三轴铣削圆形凹槽的过程，对照 G 代码、刀尖轨迹和毛坯切深。",
    preview: "examples/previews/milo.webp", source: "https://millenniummachines.github.io/docs/milo_1.5/",
    sourceNotes: "machines/milo-v1-5/SOURCE.md", download: "machines/milo-v1-5/circular-pocket.nc" },
  { id: "spring-carriage", kind: "physics", name: "弹簧滑台", category: "直线运动",
    description: "改变滑台推力，观察弹簧和阻尼作用下的位置与速度。",
    preview: "examples/previews/spring.webp", entry: "spring-carriage.xml", download: "examples/spring-carriage.xml" },
  { id: PICK_PLACE_EXAMPLE.id, kind: "physics", name: PICK_PLACE_EXAMPLE.name, category: "组合工位",
    description: PICK_PLACE_EXAMPLE.description, preview: `robots/${PICK_PLACE_EXAMPLE.id}/preview.webp`,
    sourceNotes: `workcells/${PICK_PLACE_EXAMPLE.id}/SOURCE.md` },
  ...ROBOT_EXAMPLES.map((robot): StudioExample => ({
    id: robot.id, kind: "physics", name: robot.name, category: robot.category, description: robot.description,
    preview: `robots/${robot.id}/preview.webp`, source: robot.sourceUrl, sourceNotes: `robots/${robot.id}/SOURCE.md`,
    entry: robot.entry, download: `robots/${robot.id}/model.zip?v=${robot.sha256}`, bytes: robot.bytes, author: robot.author, license: robot.license,
  })),
];

export function getStudioExample(id: string | null | undefined): StudioExample | undefined {
  return STUDIO_EXAMPLES.find((item) => item.id === id);
}

export type StudioResourceSection = "device" | "material" | "physics" | "system" | "author";
export type StudioTarget = "wiring" | "servo" | "so101" | "milo" | "incoming" | "assembly-new" | `model:${string}` | `assembly:${string}`;
export type StudioRoute =
  | { view: "resources"; section?: StudioResourceSection }
  | { view: "examples" }
  | ({ view: "workbench" } & (
    | { target?: StudioTarget; exampleId?: never; unavailableTarget?: never }
    | { exampleId: string; target?: never; unavailableTarget?: never }
    | { unavailableTarget: string; target?: never; exampleId?: never }
  ));

export function readStudioRoute(search: string | URLSearchParams, hash = ""): StudioRoute {
  const [query, inlineHash] = typeof search === "string" ? search.split("#", 2) : ["", ""];
  const params = typeof search === "string" ? new URLSearchParams(query) : search;
  const view = params.get("view");
  if ((view === "milo" || (!view && !params.has("robot") && !params.has("section"))) &&
    (hash || inlineHash || "").replace(/^#/, "") === "milo-pocket") {
    return { view: "workbench", exampleId: "milo-v1-5" };
  }
  if (view === "workbench") {
    const exampleId = params.get("example"), target = params.get("target");
    if (exampleId !== null) return { view, exampleId };
    if (target === null) return { view };
    if (target === "wiring" || target === "servo" || target === "so101" || target === "milo" || target === "incoming" || target === "assembly-new") return { view, target };
    if (target.startsWith("assembly:")) {
      const id = signalIdSchema.safeParse(target.slice("assembly:".length));
      if (id.success) return { view, target: `assembly:${id.data}` };
    }
    if (/^model:[a-f0-9]{64}$/.test(target)) return { view, target: `model:${target.slice(6)}` };
    return { view, unavailableTarget: target };
  }
  if (view === "examples") return { view };
  if (view === "library") return { view: "resources", section: "author" };
  if (view === "simulation") return { view: "workbench", target: "wiring" };
  if (view === "servo" || view === "so101" || view === "milo") return { view: "workbench", target: view };
  if (!view || view === "import") {
    const robot = params.get("robot");
    if (robot !== null) return { view: "workbench", exampleId: robot };
  }
  if (view === "resources" || view === "import" || !view) {
    const section = params.get("section");
    if (section === "device" || section === "material" || section === "physics" || section === "system" || section === "author") return { view: "resources", section };
  }
  return { view: "resources" };
}

export function studioHref(route: StudioRoute, hash = ""): string {
  const params = new URLSearchParams({ view: route.view });
  if (route.view === "resources" && route.section) params.set("section", route.section);
  if (route.view === "workbench") {
    if (route.exampleId !== undefined) params.set("example", route.exampleId);
    else if (route.target !== undefined) params.set("target", route.target);
    else if (route.unavailableTarget !== undefined) params.set("target", route.unavailableTarget);
  }
  return "?" + params.toString() + (hash ? "#" + hash.replace(/^#/, "") : "");
}

export interface StudioTargetOption { id: StudioTarget; name: string }
export function getWorkbenchTargets(workspace: TwinWorkspace): StudioTargetOption[] {
  const targets: StudioTargetOption[] = [];
  const wiring = { id: "wiring", name: "信号接线" } as const, servo = { id: "servo", name: "伺服轴" } as const;
  const milo = { id: "milo", name: "Milo 三轴铣床" } as const;
  if (workspace.instances.length) targets.push(wiring);
  if (workspace.servoAxis) targets.push(servo);
  if (workspace.so101) targets.push({ id: "so101", name: "SO-101 从臂" });
  if (workspace.milo?.assembled.length) targets.push(milo);
  for (const assembly of workspace.assemblies ?? []) targets.push({ id: `assembly:${assembly.id}`, name: assembly.name });
  for (const model of workspace.catalog?.models ?? []) targets.push({ id: `model:${model.id}`, name: model.name });
  if (workspace.milo && !workspace.milo.assembled.length && (workspace.milo.bom?.length || workspace.milo.program.trim())) targets.push(milo);
  if (!workspace.instances.length && workspace.packages.some((p) => !p.servo)) targets.push(wiring);
  if (!workspace.servoAxis && workspace.packages.some((p) => p.servo)) targets.push(servo);
  return targets;
}
