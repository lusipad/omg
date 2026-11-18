import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appRouter } from "../api/router";
import { getDb } from "../api/queries/connection";
import { defaultConfiguration } from "../contracts/module-catalog";
import { projects, users, type User } from "../db/schema";

async function main() {
  const db = getDb();
  const suffix = randomUUID();
  let owner: User | undefined;
  let outsider: User | undefined;
  let projectId: number | undefined;
  let autoProjectId: number | undefined;
  try {
    const [{ id: ownerId }] = await db.insert(users).values({ unionId: `smoke-owner-${suffix}`, name: "持久化测试账号" }).$returningId();
    const [{ id: outsiderId }] = await db.insert(users).values({ unionId: `smoke-outsider-${suffix}`, name: "越权测试账号" }).$returningId();
    owner = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
    outsider = await db.query.users.findFirst({ where: eq(users.id, outsiderId) });
    const caller = appRouter.createCaller({ req: new Request("http://localhost"), resHeaders: new Headers(), user: owner });
    const outsiderCaller = appRouter.createCaller({ req: new Request("http://localhost"), resHeaders: new Headers(), user: outsider });

    const modules = await caller.catalog.modules();
    assert.equal(modules.length, 3, "module catalog must contain three definitions");

    const created = await caller.project.create({
      code: `SMOKE-${suffix.slice(0, 8).toUpperCase()}`,
      name: "持久化闭环验证项目",
      description: "自动化临时项目，验证后删除",
      template: "cnc",
    });
    projectId = created.projectId;
    assert.equal(created.moduleCount, 3);

    let detail = await caller.project.detail({ projectId });
    assert.equal(detail.modules.length, 3);
    assert.ok(detail.modules.every((module) => module.calculationRuns.length === 1));
    const first = detail.modules[0];
    const configuration = {
      ...defaultConfiguration(first.moduleVersion.definition.key),
      maxSpeedMmS: 275,
    };
    const componentCatalog = await caller.catalog.components();
    assert.ok(componentCatalog.length >= 8, "official component seed must be present");
    const guide = componentCatalog.find((component) => component.category === "linear_guide")!;
    const motor = componentCatalog.find((component) => component.category === "servo_motor")!;
    const guideRevisionId = guide.revisions[0].id;
    const motorRevisionId = motor.revisions[0].id;
    const moduleInput = {
      projectId,
      projectModuleId: first.id,
      moduleVersionId: first.moduleVersionId,
      instanceName: first.instanceName,
      configuration,
      sortOrder: first.sortOrder,
    };
    await assert.rejects(
      () => caller.project.saveModule({
        ...moduleInput,
        selectedComponentRevisionIds: { linear_guide: motorRevisionId },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "BAD_REQUEST",
      "a servo motor must not be accepted as a linear guide",
    );
    await assert.rejects(
      () => caller.project.saveModule({
        ...moduleInput,
        selectedComponentRevisionIds: { unsupported_role: guideRevisionId },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "BAD_REQUEST",
      "unsupported component roles must be rejected by the API",
    );
    detail = await caller.project.detail({ projectId });
    assert.equal(detail.modules[0].calculationRuns.length, 1, "rejected selections must not append calculation history");

    const saved = await caller.project.saveModule({
      ...moduleInput,
      selectedComponentRevisionIds: {
        linear_guide: guideRevisionId,
        servo_motor: motorRevisionId,
      },
    });
    assert.equal(saved.projectModuleId, first.id);

    detail = await caller.project.detail({ projectId });
    const updated = detail.modules.find((module) => module.id === first.id)!;
    assert.equal(updated.calculationRuns.length, 2);
    assert.equal((updated.configuration as Record<string, number>).maxSpeedMmS, 275);
    assert.equal(updated.calculationRuns[0].steps.length, updated.calculationRuns[0].resultSnapshot.steps.length);
    assert.notEqual(updated.calculationRuns[0].inputDigest, updated.calculationRuns[1].inputDigest);

    const version = await caller.project.createVersion({ projectId, changeNote: "自动化持久化与快照闭环验证" });
    assert.equal(version.versionNo, 1);
    const exported = await caller.project.export({ projectId });
    assert.equal(exported.versions.length, 1);
    assert.equal(exported.versions[0].contentHash, version.contentHash);
    assert.equal(exported.modules.length, 3);
    assert.ok(exported.modules.every((module) => module.calculations.length >= 1));
    assert.equal(exported.componentRevisions.length, 2);
    assert.ok(exported.componentRevisions.every((revision) => revision.sourceUrl.startsWith("https://")));
    assert.ok(exported.componentRevisions.every((revision) => revision.verificationStatus === "source_recorded"));
    assert.match(exported.verificationBoundary.modelica, /未完成/);

    const automatic = await caller.project.createAutomatic({
      code: `AUTO-${suffix.slice(0, 8).toUpperCase()}`,
      name: "整机需求自动生成闭环",
      description: "验证自动组成、候选初筛与首版快照",
      template: "cnc",
      requirements: {
        travelXMm: 600,
        travelYMm: 450,
        travelZMm: 280,
        movingMassKg: 10,
        maxSpeedMmS: 100,
        accelerationMss2: 0.5,
      },
    });
    autoProjectId = automatic.projectId;
    assert.equal(automatic.moduleCount, 3);
    assert.equal(automatic.versionNo, 1);
    const autoDetail = await caller.project.detail({ projectId: autoProjectId });
    assert.equal(autoDetail.modules.length, 3);
    assert.equal(autoDetail.currentVersionNo, 1);
    assert.equal(autoDetail.versions.length, 1);
    assert.ok(autoDetail.modules.every((module) => module.calculationRuns.length === 1));
    assert.equal((autoDetail.modules[2].configuration as Record<string, number>).inclineDeg, 90);
    assert.ok(autoDetail.modules[0].selectedComponentRevisionIds.ball_screw);
    assert.ok(autoDetail.modules[0].selectedComponentRevisionIds.linear_guide);
    assert.ok(autoDetail.modules[0].selectedComponentRevisionIds.servo_motor);
    assert.equal(autoDetail.modules[0].selectedComponentRevisionIds.servo_drive, undefined);
    assert.ok(autoDetail.auditEvents.some((event) => event.action === "project.auto_generated"));
    const autoExport = await caller.project.export({ projectId: autoProjectId });
    assert.ok(autoExport.automation);
    assert.equal(autoExport.versions.length, 1);
    assert.ok(JSON.stringify(autoExport.versions[0].snapshot).includes("automation"));

    await assert.rejects(
      () => outsiderCaller.project.detail({ projectId }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND",
    );

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "catalog seeded",
        "CNC template creates three composed modules",
        "configuration persists",
        "calculation history appends with steps and digest",
        "invalid component roles and categories are rejected without history writes",
        "project snapshot freezes content hash",
        "engineering package exports versions, calculations and official component sources",
        "automatic whole-machine requirements create modules, calculations, sourced candidates and V1 snapshot atomically",
        "cross-owner access rejected",
      ],
      projectId,
      version: version.versionNo,
    }, null, 2));
  } finally {
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (autoProjectId) await db.delete(projects).where(eq(projects.id, autoProjectId));
    if (owner) await db.delete(users).where(eq(users.id, owner.id));
    if (outsider) await db.delete(users).where(eq(users.id, outsider.id));
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
