import { parseImportCatalog, type MaterialRow } from "./import-catalog";
import { matchMaterials } from "./material-import";
import type { MiloBom } from "./milo-bom";
import { initialMiloWorkspace, parseMiloWorkspace, withMiloBom, type MiloWorkspaceState } from "./milo-workspace";
import { parseSo101Assembly, SO101_JOINTS, SO101_MODEL_ID, type So101Assembly } from "./so101";
import type { So101BomRow } from "./so101-bom";
import { isCompatibleServoPair } from "./servo-axis";
import type { DevicePackage } from "./twin-device";
import type { TwinWorkspace } from "./twin-simulation";

export function importedServoPair(devices: readonly DevicePackage[]) {
  if (devices.length !== 2) return;
  const drive = devices.find(device => device.servo?.kind === "drive");
  const motor = devices.find(device => device.servo?.kind === "motor");
  if (drive && motor && isCompatibleServoPair(drive, motor)) return { drive, motor };
}

export function applyMiloBomImport(workspace: TwinWorkspace, bom: MiloBom, source: string): TwinWorkspace & { milo: MiloWorkspaceState } {
  const milo = parseMiloWorkspace(withMiloBom(workspace.milo ?? initialMiloWorkspace, bom, source));
  return { ...workspace, milo };
}

export function applySo101BomImport(workspace: TwinWorkspace, bom: So101BomRow[]): TwinWorkspace & { so101: So101Assembly } {
  const waypoints = workspace.so101?.waypoints ?? [{ timeS: 1, anglesDeg: SO101_JOINTS.map(() => 0) }];
  return { ...workspace, so101: parseSo101Assembly({ modelId: SO101_MODEL_ID, bom, waypoints }) };
}

export function mergeImportedMaterials(workspace: TwinWorkspace, rows: MaterialRow[]): TwinWorkspace {
  const catalog = workspace.catalog ?? { models: [], materials: [] };
  const merged = new Map(catalog.materials.map(row => [row.id, row]));
  const batchIds = new Set<string>();
  for (const row of matchMaterials(rows, workspace)) {
    const old = merged.get(row.id);
    if (old && batchIds.has(row.id)) {
      // 同批重复的 ID 使用与已保存资料相同的内容冲突检查。
      matchMaterials([row], { ...workspace, catalog: { models: catalog.models, materials: [old] } });
    }
    if (!old || (!old.binding && row.binding) || (old.leadMmPerRev === undefined && row.leadMmPerRev !== undefined)
      || (old.massKg === undefined && row.massKg !== undefined)) merged.set(row.id, row);
    batchIds.add(row.id);
  }
  const next = parseImportCatalog({ ...catalog, materials: [...merged.values()] }, workspace.packages);
  return { ...workspace, catalog: next };
}
