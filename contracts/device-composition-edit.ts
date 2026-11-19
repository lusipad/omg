import { deviceCompositionClosure, getDeviceParts, type CompositionShape, type DeviceComposition } from "./device-composition";
import { getFactoryModel, resolveFactoryParameters } from "./factory";
import { packageKey, parseDevicePackage, type DevicePackage } from "./twin-device";
import { installPackage, type TwinWorkspace } from "./twin-simulation";

export interface LocalLeafInput {
  manufacturer: string; model: string; revision: string;
  shape?: CompositionShape; note?: string; ratings?: DeviceComposition["ratings"];
}

export function createLocalLeaf({ manufacturer, model, revision, shape, note, ratings }: LocalLeafInput) {
  return parseDevicePackage({
    schemaVersion: 1, manufacturer, model, revision, ports: [], rules: [],
    source: { kind: "local", url: "", title: "工程基础件定义", locator: model.trim(),
      excerpt: note?.trim() || "本工程以此修订为最小装配件。" },
    composition: { kind: "leaf", ...(shape && { shape }), ...(note?.trim() && { note: note.trim() }), ...(ratings && { ratings }) },
  });
}

export function compositionPath(packages: readonly DevicePackage[], rootKey: string, path: readonly string[]): DevicePackage[] {
  const catalog = new Map(packages.map(pkg => [packageKey(pkg), pkg])), root = catalog.get(rootKey);
  if (!root) throw new Error("请先安装要编辑的根设备修订。");
  const trail = [root];
  for (const slot of path) {
    const parent = trail[trail.length - 1];
    const part = getDeviceParts(parent).find(p => p.id === slot);
    if (!part) throw new Error(`“${parent.model}”没有槽位 ${slot}，请重新选择编辑位置。`);
    const child = catalog.get(part.packageKey);
    if (!child) throw new Error(`“${parent.model}”的“${part.label}”缺少设备修订 ${part.packageKey}。`);
    trail.push(child);
  }
  return trail;
}

function incrementRevision(previous: string, i: number) {
  const suffix = "-" + i;
  return previous.slice(0, 160 - suffix.length) + suffix;
}

export function nextStructureRevision(workspace: TwinWorkspace, rootKey: string) {
  const [root] = compositionPath(workspace.packages, rootKey, []);
  const revisions = new Set(workspace.packages.filter(p => p.manufacturer === root.manufacturer && p.model === root.model).map(p => p.revision));
  let revision = "", i = 0;
  do { revision = incrementRevision(root.revision, ++i); } while (revisions.has(revision));
  return revision;
}

function rebindSlot(parent: DevicePackage, slot: string, key: string): DevicePackage {
  if (parent.mechanics?.kind === "assembly") {
    const a = parent.mechanics.assembly;
    return { ...parent, mechanics: { ...parent.mechanics, assembly: { ...a,
      nodes: a.nodes.map(node => node.id === slot ? { ...node, packageKey: key } : node) } } };
  }
  const composition = parent.composition;
  if (composition?.kind !== "assembly") throw new Error(`“${parent.model}”没有可重新连接的子件槽位。`);
  return { ...parent, composition: { ...composition, parts: composition.parts.map(part =>
    part.id === slot ? { ...part, packageKey: key } : part) } };
}

type CompositionEdit = { path: readonly string[]; composition: DeviceComposition };
type EditNode = { original: DevicePackage; children: Map<string, EditNode>; composition?: DeviceComposition };

/** Copy each affected occurrence once, including the common ancestors of several edited slots. */
export function deriveDeviceCompositions(workspace: TwinWorkspace, rootKey: string, edits: readonly CompositionEdit[],
  rootRevision: string, additions: readonly DevicePackage[] = [], rootPorts?: Pick<DevicePackage, "axisPorts" | "contour">) {
  const [root] = compositionPath(workspace.packages, rootKey, []);
  const tree: EditNode = { original: root, children: new Map() };
  for (const { path, composition } of edits) {
    const trail = compositionPath(workspace.packages, rootKey, path);
    let node = tree;
    for (const [i, slot] of path.entries()) {
      if (node.composition) throw new Error("同一次修订不能同时替换祖先与后代的组成。");
      let child = node.children.get(slot);
      if (!child) { child = { original: trail[i + 1], children: new Map() }; node.children.set(slot, child); }
      node = child;
    }
    if (node.composition || node.children.size) throw new Error("组成编辑路径重复或包含另一条编辑路径。");
    if (node.original.mechanics?.kind === "assembly") throw new Error("此层的槽位来自机械安装点，请通过“安装点与关节”编辑这一层。");
    node.composition = composition;
  }
  const revision = rootRevision.trim();
  if (!revision || revision.length > 160 || revision === root.revision) throw new Error("请为根设备填写与原修订不同的新修订号，最多 160 个字符。");
  const catalog = new Map(workspace.packages.map(p => [packageKey(p), p]));
  const rootTarget = packageKey({ ...root, revision });
  const same = (a: DevicePackage, b: DevicePackage) => JSON.stringify(parseDevicePackage(a)) === JSON.stringify(b);
  function stage(pkg: DevicePackage) {
    const key = packageKey(pkg), previous = catalog.get(key);
    if (previous && !same(previous, pkg)) throw new Error(`“${pkg.model}”的修订“${pkg.revision}”已用于不同内容，请更改修订号。`);
    catalog.set(key, previous ?? pkg);
    return key;
  }
  for (const pkg of additions) stage(parseDevicePackage(pkg));
  const changed: DevicePackage[] = [];
  function derive(node: EditNode): string {
    const previous = node.original;
    let contents = node.composition ? { ...previous, composition: node.composition } : previous;
    for (const [slot, child] of node.children) contents = rebindSlot(contents, slot, derive(child));
    if (node === tree && rootPorts) contents = { ...contents, ...rootPorts };
    let counter = 1;
    let pkg = parseDevicePackage({ ...contents, revision: node === tree ? revision : incrementRevision(previous.revision, counter) });
    // An identical intermediate revision can be reused on retry. A manual root revision must match exactly.
    while (node !== tree) {
      const key = packageKey(pkg), existing = catalog.get(key);
      if (key !== rootTarget && (!existing || same(existing, pkg))) break;
      pkg = parseDevicePackage({ ...contents, revision: incrementRevision(previous.revision, ++counter) });
    }
    changed.push(pkg);
    return stage(pkg);
  }
  derive(tree);
  const closure = deviceCompositionClosure([...catalog.values()], [rootTarget]);
  if (closure.missing.length) throw new Error("组成中缺少以下设备修订，请先安装或重新选件。\n" + closure.missing.join("\n"));
  for (const pkg of changed) {
    const factory = pkg.factory, model = getFactoryModel(factory?.modelRef);
    if (!factory?.partParameters || !model) continue;
    const { issues } = resolveFactoryParameters(pkg, model, catalog, {}, false);
    if (issues.length) throw new Error(`“${pkg.model}”的部件参数需要核对。\n` + issues.join("\n"));
  }
  const next = closure.packages.reduce(installPackage, workspace);
  return { workspace: next, rootKey: rootTarget };
}

/** Copy the edited node and its selected ancestors. The old revisions stay available to other slots and machines. */
export function deriveDeviceComposition(workspace: TwinWorkspace, rootKey: string, path: readonly string[], composition: DeviceComposition,
  rootRevision: string, additions: readonly DevicePackage[] = []): { workspace: TwinWorkspace; rootKey: string } {
  return deriveDeviceCompositions(workspace, rootKey, [{ path, composition }], rootRevision, additions);
}
