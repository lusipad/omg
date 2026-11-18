import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  auditEvents,
  calculationRuns,
  calculationSteps,
  projectModules,
  projectVersions,
  projects,
} from "@db/schema";
import { calculateModule, MODULE_KEYS, type CalculationResult, type ModuleKey } from "@contracts/engineering";
import { defaultConfiguration, MODULE_COMPONENT_ROLES } from "@contracts/module-catalog";
import {
  applyAutomationCandidates,
  generateAutomationPlan,
  type AutoProjectInput,
  type AutomationPlan,
} from "@contracts/automation";
import { getDb } from "./queries/connection";
import { findComponentRevisions } from "./queries/components";
import { getModuleVersionWithDefinition, listComponentLibrary } from "./queries/catalog";
import { findOwnedProject, findProjectWorkspace } from "./queries/projects";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ProjectTemplate = "blank" | "cnc" | "arm" | "mobile";

type ModuleSaveInput = {
  projectId: number;
  moduleVersionId: number;
  instanceName: string;
  configuration: Record<string, number>;
  selectedComponentRevisionIds: Record<string, number>;
  sortOrder?: number;
  projectModuleId?: number;
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function ensureProjectOwner(projectId: number, ownerId: number) {
  const project = await findOwnedProject(projectId, ownerId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在或当前账号无权访问" });
  }
  if (project.status === "archived") {
    throw new TRPCError({ code: "CONFLICT", message: "已归档项目不能修改，请先恢复为草稿" });
  }
  return project;
}

async function validateComponentSelection(selection: Record<string, number>, moduleKey: ModuleKey) {
  const allowedRoles = MODULE_COMPONENT_ROLES[moduleKey];
  for (const role of Object.keys(selection)) {
    if (!allowedRoles.includes(role)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `${moduleKey} 不支持部件角色：${role}` });
    }
  }
  const ids = [...new Set(Object.values(selection))];
  const revisions = await findComponentRevisions(ids);
  if (revisions.length !== ids.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "所选部件中包含不存在的修订记录" });
  }
  const obsolete = revisions.find((revision) => revision.verificationStatus === "obsolete");
  if (obsolete) {
    throw new TRPCError({ code: "CONFLICT", message: "所选部件包含已停用修订，请更换后再计算" });
  }
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const [role, revisionId] of Object.entries(selection)) {
    const revision = revisionById.get(revisionId)!;
    if (revision.component.category !== role) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `部件类别不匹配：${revision.component.model} 不能用于 ${role} 角色` });
    }
  }
}

async function insertCalculation(
  tx: Tx,
  input: {
    projectId: number;
    projectModuleId: number;
    moduleVersionId: number;
    configuration: Record<string, number>;
    result: CalculationResult;
    actorId: number;
  },
) {
  const inputDigest = digest({
    moduleVersionId: input.moduleVersionId,
    configuration: input.configuration,
  });
  const [{ id: runId }] = await tx.insert(calculationRuns).values({
    projectId: input.projectId,
    projectModuleId: input.projectModuleId,
    moduleVersionId: input.moduleVersionId,
    engineVersion: "0.1.0-pilot",
    inputDigest,
    status: input.result.status,
    inputSnapshot: input.configuration,
    resultSnapshot: input.result,
    createdBy: input.actorId,
  }).$returningId();

  if (input.result.steps.length > 0) {
    await tx.insert(calculationSteps).values(input.result.steps.map((step) => ({
      runId,
      stepOrder: step.order,
      key: step.key,
      title: step.title,
      formula: step.formula,
      substitution: step.substitution,
      value: step.value,
      unit: step.unit,
      basis: step.basis,
    })));
  }
  return runId;
}

export async function saveProjectModule(ownerId: number, input: ModuleSaveInput) {
  await ensureProjectOwner(input.projectId, ownerId);
  const moduleVersion = await getModuleVersionWithDefinition(input.moduleVersionId);
  if (!moduleVersion || moduleVersion.status === "retired") {
    throw new TRPCError({ code: "NOT_FOUND", message: "模块版本不存在或已停用" });
  }
  const moduleKey = moduleVersion.definition.key as ModuleKey;
  if (!MODULE_KEYS.includes(moduleKey)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `不支持的模块类型：${moduleKey}` });
  }
  await validateComponentSelection(input.selectedComponentRevisionIds, moduleKey);

  let result: CalculationResult;
  try {
    result = calculateModule(moduleKey, input.configuration);
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: error instanceof Error ? `工程输入校验失败：${error.message}` : "工程输入校验失败",
    });
  }

  return getDb().transaction(async (tx) => {
    if (input.projectModuleId) {
      const existing = await tx.query.projectModules.findFirst({
        where: and(
          eq(projectModules.id, input.projectModuleId!),
          eq(projectModules.projectId, input.projectId),
        ),
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "模块实例不存在" });
      await tx.update(projectModules).set({
        moduleVersionId: input.moduleVersionId,
        instanceName: input.instanceName,
        configuration: input.configuration,
        selectedComponentRevisionIds: input.selectedComponentRevisionIds,
        updatedAt: new Date(),
      }).where(eq(projectModules.id, input.projectModuleId!));
    } else {
      const [{ id }] = await tx.insert(projectModules).values({
        projectId: input.projectId,
        moduleVersionId: input.moduleVersionId,
        instanceName: input.instanceName,
        configuration: input.configuration,
        selectedComponentRevisionIds: input.selectedComponentRevisionIds,
        sortOrder: input.sortOrder ?? 0,
      }).$returningId();
      input.projectModuleId = id;
    }

    const runId = await insertCalculation(tx, {
      projectId: input.projectId,
      projectModuleId: input.projectModuleId!,
      moduleVersionId: input.moduleVersionId,
      configuration: input.configuration,
      result,
      actorId: ownerId,
    });
    await tx.insert(auditEvents).values({
      projectId: input.projectId,
      actorId: ownerId,
      action: "module.calculated",
      entityType: "project_module",
      entityId: String(input.projectModuleId),
      metadata: { calculationRunId: runId, status: result.status },
    });
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, input.projectId));
    return { projectModuleId: input.projectModuleId!, calculationRunId: runId, result };
  });
}

const templateModules: Record<Exclude<ProjectTemplate, "blank">, Array<{ key: "linear_axis" | "rotary_joint" | "drive_wheel"; name: string }>> = {
  cnc: [
    { key: "linear_axis", name: "X 轴 · 横向进给" },
    { key: "linear_axis", name: "Y 轴 · 纵向进给" },
    { key: "linear_axis", name: "Z 轴 · 主轴进给" },
  ],
  arm: Array.from({ length: 6 }, (_, index) => ({ key: "rotary_joint" as const, name: `J${index + 1} · 旋转关节` })),
  mobile: [
    { key: "drive_wheel", name: "左驱动轮" },
    { key: "drive_wheel", name: "右驱动轮" },
  ],
};

export async function createProjectWithTemplate(ownerId: number, input: {
  code: string;
  name: string;
  description?: string;
  template: ProjectTemplate;
}) {
  const existing = await getDb().query.projects.findFirst({
    where: and(eq(projects.ownerId, ownerId), eq(projects.code, input.code)),
  });
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "项目编号已存在，请使用其他编号" });

  const library = await getDb().query.moduleDefinitions.findMany({ with: { versions: true } });
  const templates = input.template === "blank" ? [] : templateModules[input.template];
  for (const item of templates) {
    const definition = library.find((entry) => entry.key === item.key);
    if (!definition || definition.versions.length === 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `模块库尚未初始化：${item.key}` });
    }
  }

  return getDb().transaction(async (tx) => {
    const applicationType = input.template === "blank" ? "custom" : input.template;
    const [{ id: projectId }] = await tx.insert(projects).values({
      ownerId,
      code: input.code,
      name: input.name,
      description: input.description ?? "",
      applicationType,
    }).$returningId();

    for (const [index, item] of templates.entries()) {
      const definition = library.find((entry) => entry.key === item.key)!;
      const version = [...definition.versions].sort((a, b) => b.id - a.id)[0];
      const configuration = defaultConfiguration(item.key);
      const result = calculateModule(item.key, configuration);
      const [{ id: projectModuleId }] = await tx.insert(projectModules).values({
        projectId,
        moduleVersionId: version.id,
        instanceName: item.name,
        sortOrder: index,
        configuration,
        selectedComponentRevisionIds: {},
      }).$returningId();
      await insertCalculation(tx, {
        projectId,
        projectModuleId,
        moduleVersionId: version.id,
        configuration,
        result,
        actorId: ownerId,
      });
    }

    await tx.insert(auditEvents).values({
      projectId,
      actorId: ownerId,
      action: "project.created",
      entityType: "project",
      entityId: String(projectId),
      metadata: { template: input.template, moduleCount: templates.length },
    });
    return { projectId, moduleCount: templates.length };
  });
}

export async function createAutomatedProject(ownerId: number, input: AutoProjectInput) {
  const existing = await getDb().query.projects.findFirst({
    where: and(eq(projects.ownerId, ownerId), eq(projects.code, input.code)),
  });
  if (existing) throw new TRPCError({ code: "CONFLICT", message: "项目编号已存在，请使用其他编号" });

  const basePlan = generateAutomationPlan(input);
  const componentCatalog = await listComponentLibrary();
  const plan: AutomationPlan = applyAutomationCandidates(basePlan, componentCatalog);
  const library = await getDb().query.moduleDefinitions.findMany({ with: { versions: true } });

  for (const module of plan.modules) {
    const definition = library.find((entry) => entry.key === module.key);
    const version = definition ? [...definition.versions].sort((a, b) => b.id - a.id)[0] : undefined;
    if (!definition || !version || version.status === "retired") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `模块库尚未初始化或版本已停用：${module.key}` });
    }
    await validateComponentSelection(module.selectedComponentRevisionIds, module.key);
  }

  return getDb().transaction(async (tx) => {
    const [{ id: projectId }] = await tx.insert(projects).values({
      ownerId,
      code: input.code,
      name: input.name,
      description: input.description ?? "",
      applicationType: input.template,
      status: "draft",
    }).$returningId();

    const snapshotModules: Array<Record<string, unknown>> = [];
    for (const [index, module] of plan.modules.entries()) {
      const definition = library.find((entry) => entry.key === module.key)!;
      const version = [...definition.versions].sort((a, b) => b.id - a.id)[0];
      const [{ id: projectModuleId }] = await tx.insert(projectModules).values({
        projectId,
        moduleVersionId: version.id,
        instanceName: module.instanceName,
        sortOrder: index,
        configuration: module.configuration,
        selectedComponentRevisionIds: module.selectedComponentRevisionIds,
      }).$returningId();
      const calculationRunId = await insertCalculation(tx, {
        projectId,
        projectModuleId,
        moduleVersionId: version.id,
        configuration: module.configuration,
        result: module.result,
        actorId: ownerId,
      });
      await tx.insert(auditEvents).values({
        projectId,
        actorId: ownerId,
        action: "module.auto_calculated",
        entityType: "project_module",
        entityId: String(projectModuleId),
        metadata: {
          calculationRunId,
          status: module.result.status,
          candidateNotes: module.candidateNotes,
        },
      });
      snapshotModules.push({
        instanceName: module.instanceName,
        sortOrder: index,
        moduleKey: module.key,
        moduleVersion: version.version,
        ruleVersion: version.ruleVersion,
        configuration: module.configuration,
        selectedComponentRevisionIds: module.selectedComponentRevisionIds,
        latestCalculation: {
          engineVersion: "0.1.0-pilot",
          inputDigest: digest({ moduleVersionId: version.id, configuration: module.configuration }),
          status: module.result.status,
          result: module.result,
        },
      });
    }

    const snapshot = {
      schemaVersion: 1,
      project: {
        code: input.code,
        name: input.name,
        description: input.description ?? "",
        applicationType: input.template,
        status: "draft",
      },
      automation: {
        ruleVersion: plan.ruleVersion,
        requirements: plan.requirements,
        assumptions: plan.assumptions,
        warnings: plan.warnings,
        pendingConfirmations: plan.pendingConfirmations,
        candidateNotes: plan.modules.map((module) => ({ instanceName: module.instanceName, notes: module.candidateNotes })),
      },
      modules: snapshotModules,
      verificationBoundary: "自动生成的工程初算草案；未完成制造、强度、寿命、热、刚度、安全认证、供应商确认或 OpenModelica 数值回归验证。",
    };
    const contentHash = digest(snapshot);
    const [{ id: versionId }] = await tx.insert(projectVersions).values({
      projectId,
      versionNo: 1,
      snapshot,
      changeNote: "自动生成初版方案（可修改草案，待工程复核）",
      contentHash,
      createdBy: ownerId,
    }).$returningId();
    await tx.update(projects).set({ currentVersionNo: 1, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await tx.insert(auditEvents).values({
      projectId,
      actorId: ownerId,
      action: "project.auto_generated",
      entityType: "project",
      entityId: String(projectId),
      metadata: {
        initialVersionId: versionId,
        initialVersionNo: 1,
        ruleVersion: plan.ruleVersion,
        template: input.template,
        requirements: plan.requirements,
        assumptions: plan.assumptions,
        warnings: plan.warnings,
        pendingConfirmations: plan.pendingConfirmations,
        candidateNotes: plan.modules.map((module) => ({ instanceName: module.instanceName, notes: module.candidateNotes })),
      },
    });

    return {
      projectId,
      moduleCount: plan.modules.length,
      versionNo: 1,
      warningCount: plan.modules.reduce((sum, module) => sum + module.result.warnings.length, plan.warnings.length),
      blockedCount: plan.modules.filter((module) => module.result.status === "blocked").length,
      pendingConfirmationCount: plan.pendingConfirmations.length,
    };
  });
}

export async function removeProjectModule(ownerId: number, projectId: number, projectModuleId: number) {
  await ensureProjectOwner(projectId, ownerId);
  return getDb().transaction(async (tx) => {
    const existing = await tx.query.projectModules.findFirst({
      where: and(eq(projectModules.id, projectModuleId), eq(projectModules.projectId, projectId)),
    });
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "模块实例不存在" });
    await tx.delete(projectModules).where(eq(projectModules.id, projectModuleId));
    await tx.insert(auditEvents).values({
      projectId,
      actorId: ownerId,
      action: "module.removed",
      entityType: "project_module",
      entityId: String(projectModuleId),
      metadata: { instanceName: existing.instanceName },
    });
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    return { removed: true };
  });
}

export async function createProjectSnapshot(ownerId: number, projectId: number, changeNote: string) {
  await ensureProjectOwner(projectId, ownerId);
  const workspace = await findProjectWorkspace(projectId, ownerId);
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
  const snapshot = {
    schemaVersion: 1,
    project: {
      code: workspace.code,
      name: workspace.name,
      description: workspace.description,
      applicationType: workspace.applicationType,
      status: workspace.status,
    },
    modules: workspace.modules.map((module) => ({
      instanceName: module.instanceName,
      sortOrder: module.sortOrder,
      moduleKey: module.moduleVersion.definition.key,
      moduleVersion: module.moduleVersion.version,
      ruleVersion: module.moduleVersion.ruleVersion,
      configuration: module.configuration,
      selectedComponentRevisionIds: module.selectedComponentRevisionIds,
      latestCalculation: module.calculationRuns[0] ? {
        engineVersion: module.calculationRuns[0].engineVersion,
        inputDigest: module.calculationRuns[0].inputDigest,
        status: module.calculationRuns[0].status,
        result: module.calculationRuns[0].resultSnapshot,
      } : null,
    })),
    verificationBoundary: "工程初算快照；未完成制造、强度、寿命、热、刚度、安全认证或 OpenModelica 数值回归验证。",
  };
  const contentHash = digest(snapshot);

  return getDb().transaction(async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
    const versionNo = project.currentVersionNo + 1;
    const [{ id }] = await tx.insert(projectVersions).values({
      projectId,
      versionNo,
      snapshot,
      changeNote,
      contentHash,
      createdBy: ownerId,
    }).$returningId();
    await tx.update(projects).set({ currentVersionNo: versionNo, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await tx.insert(auditEvents).values({
      projectId,
      actorId: ownerId,
      action: "project.version_created",
      entityType: "project_version",
      entityId: String(id),
      metadata: { versionNo, contentHash },
    });
    return { id, versionNo, contentHash };
  });
}
