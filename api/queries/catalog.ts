import { getDb } from "./connection";

export async function listModuleLibrary() {
  return getDb().query.moduleDefinitions.findMany({
    with: { versions: true },
    orderBy: (definitions, { asc }) => [asc(definitions.id)],
  });
}

export async function listComponentLibrary() {
  return getDb().query.components.findMany({
    with: {
      manufacturer: true,
      revisions: true,
    },
    orderBy: (items, { asc }) => [asc(items.category), asc(items.model)],
  });
}

export async function getModuleVersionWithDefinition(id: number) {
  return getDb().query.moduleVersions.findFirst({
    where: (versions, { eq }) => eq(versions.id, id),
    with: { definition: true },
  });
}
