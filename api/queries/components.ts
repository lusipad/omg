import { inArray } from "drizzle-orm";
import { componentRevisions } from "@db/schema";
import { getDb } from "./connection";

export async function findComponentRevisions(ids: number[]) {
  if (ids.length === 0) return [];
  return getDb().query.componentRevisions.findMany({
    where: inArray(componentRevisions.id, ids),
    with: { component: { with: { manufacturer: true } } },
  });
}
