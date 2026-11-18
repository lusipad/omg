import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ENGINE_RULE_VERSION, MODULE_BLUEPRINTS } from "../contracts/module-catalog";
import { getDb } from "../api/queries/connection";
import { COMPONENT_SEED } from "./component-seed";
import {
  componentRevisions,
  components,
  manufacturers,
  moduleDefinitions,
  moduleVersions,
} from "./schema";

async function seedModules() {
  const db = getDb();
  for (const blueprint of MODULE_BLUEPRINTS) {
    let definition = await db.query.moduleDefinitions.findFirst({
      where: eq(moduleDefinitions.key, blueprint.key),
    });
    if (!definition) {
      const [{ id }] = await db.insert(moduleDefinitions).values({
        key: blueprint.key,
        name: blueprint.name,
        family: blueprint.family,
        description: blueprint.description,
      }).$returningId();
      definition = await db.query.moduleDefinitions.findFirst({ where: eq(moduleDefinitions.id, id) });
    } else {
      await db.update(moduleDefinitions).set({
        name: blueprint.name,
        family: blueprint.family,
        description: blueprint.description,
      }).where(eq(moduleDefinitions.id, definition.id));
    }

    const version = "0.1.0";
    const inputSchema = { fields: blueprint.fields };
    const contentHash = createHash("sha256").update(JSON.stringify({ blueprint, version })).digest("hex");
    const existingVersion = await db.query.moduleVersions.findFirst({
      where: and(eq(moduleVersions.definitionId, definition!.id), eq(moduleVersions.version, version)),
    });
    if (existingVersion) {
      await db.update(moduleVersions).set({
        ruleVersion: ENGINE_RULE_VERSION,
        inputSchema,
        contentHash,
        changeNote: "客户试点基础规则；所有输入均带单位、范围与工程假设。",
      }).where(eq(moduleVersions.id, existingVersion.id));
    } else {
      await db.insert(moduleVersions).values({
        definitionId: definition!.id,
        version,
        ruleVersion: ENGINE_RULE_VERSION,
        status: "pilot",
        inputSchema,
        contentHash,
        changeNote: "客户试点基础规则；所有输入均带单位、范围与工程假设。",
      });
    }
  }
}

async function seedComponents() {
  const db = getDb();
  for (const record of COMPONENT_SEED) {
    let manufacturer = await db.query.manufacturers.findFirst({
      where: eq(manufacturers.name, record.manufacturer),
    });
    if (!manufacturer) {
      const [{ id }] = await db.insert(manufacturers).values({
        name: record.manufacturer,
        website: record.manufacturerWebsite,
      }).$returningId();
      manufacturer = await db.query.manufacturers.findFirst({ where: eq(manufacturers.id, id) });
    } else {
      await db.update(manufacturers).set({ website: record.manufacturerWebsite })
        .where(eq(manufacturers.id, manufacturer.id));
    }

    let component = await db.query.components.findFirst({
      where: and(
        eq(components.manufacturerId, manufacturer!.id),
        eq(components.model, record.model),
      ),
    });
    if (!component) {
      const [{ id }] = await db.insert(components).values({
        manufacturerId: manufacturer!.id,
        model: record.model,
        category: record.category,
      }).$returningId();
      component = await db.query.components.findFirst({ where: eq(components.id, id) });
    } else {
      await db.update(components).set({ category: record.category })
        .where(eq(components.id, component.id));
    }

    const revisionValues = {
      sourceTitle: record.sourceTitle,
      sourceUrl: record.sourceUrl,
      sourceVersion: record.sourceVersion,
      sourceLocator: record.sourceLocator,
      parameters: record.parameters,
      sourceEvidence: record.sourceEvidence,
    };
    const revision = await db.query.componentRevisions.findFirst({
      where: and(
        eq(componentRevisions.componentId, component!.id),
        eq(componentRevisions.revisionLabel, record.revisionLabel),
      ),
    });
    if (revision) {
      // 官方来源可校正，但不能由种子脚本降级后续人工或供应商确认状态。
      await db.update(componentRevisions).set(revisionValues)
        .where(eq(componentRevisions.id, revision.id));
    } else {
      await db.insert(componentRevisions).values({
        componentId: component!.id,
        revisionLabel: record.revisionLabel,
        verificationStatus: "source_recorded",
        ...revisionValues,
      });
    }
  }
}

async function seed() {
  console.log("Seeding module catalog...");
  await seedModules();
  console.log(`Seeded ${MODULE_BLUEPRINTS.length} module definitions.`);
  console.log("Seeding sourced component catalog...");
  await seedComponents();
  console.log(`Seeded ${COMPONENT_SEED.length} sourced component revisions.`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
