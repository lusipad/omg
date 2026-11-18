import { z } from "zod";
import { getMiloAxisRequirements, miloAxisSchema, miloBomSchema, validateMiloAssembly, type MiloAxisId, type MiloBom } from "./milo-bom";
import { MILO_MAX_PROGRAM_CHARS, miloDemoGcode } from "./milo-motion";
import { readTwinData } from "./twin-device";

const sourceSchema = z.string().trim().min(1).max(500);
const miloWorkspaceSchema = z.strictObject({
  bom: miloBomSchema.optional(),
  bomSource: sourceSchema.optional(),
  assembled: z.array(miloAxisSchema).max(3),
  program: z.string().max(MILO_MAX_PROGRAM_CHARS),
});

export type MiloWorkspaceState = z.infer<typeof miloWorkspaceSchema>;
export const initialMiloWorkspace: MiloWorkspaceState = { assembled: [], program: miloDemoGcode };

export function parseMiloWorkspace(value: unknown): MiloWorkspaceState {
  const state = readTwinData(miloWorkspaceSchema, value, "Milo v1.5 工程");
  if (!state.bom && (state.assembled.length || state.bomSource)) throw new Error("Milo 工程缺少装配引用的 BOM。");
  if (state.bom) validateMiloAssembly(state.bom, state.assembled);
  return state;
}

export function withMiloBom(previous: MiloWorkspaceState, bom: MiloBom, source: string): MiloWorkspaceState {
  const assembled: MiloAxisId[] = [];
  for (const axis of previous.assembled) {
    if (getMiloAxisRequirements(bom, axis, assembled).every(row => row.shortfall === 0)) assembled.push(axis);
  }
  return { ...previous, bom, bomSource: readTwinData(sourceSchema, source, "BOM 来源"), assembled };
}
