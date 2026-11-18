import { and, desc, eq } from "drizzle-orm";
import { projects } from "@db/schema";
import { getDb } from "./connection";

export async function listProjects(ownerId: number) {
  return getDb().query.projects.findMany({
    where: eq(projects.ownerId, ownerId),
    with: { modules: true },
    orderBy: [desc(projects.updatedAt)],
  });
}

export async function findOwnedProject(projectId: number, ownerId: number) {
  return getDb().query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)),
  });
}

export async function findProjectWorkspace(projectId: number, ownerId: number) {
  return getDb().query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)),
    with: {
      modules: {
        with: {
          moduleVersion: { with: { definition: true } },
          calculationRuns: {
            with: { steps: true },
            orderBy: (runs, { desc: orderDesc }) => [orderDesc(runs.createdAt)],
          },
        },
        orderBy: (modules, { asc }) => [asc(modules.sortOrder), asc(modules.id)],
      },
      versions: { orderBy: (versions, { desc: orderDesc }) => [orderDesc(versions.versionNo)] },
      auditEvents: {
        with: { actor: true },
        orderBy: (events, { desc: orderDesc }) => [orderDesc(events.createdAt)],
      },
    },
  });
}
