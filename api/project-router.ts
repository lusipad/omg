import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditEvents, projects } from "@db/schema";
import { createRouter, authedQuery } from "./middleware";
import { autoProjectInputSchema } from "@contracts/automation";
import {
  createAutomatedProject,
  createProjectSnapshot,
  createProjectWithTemplate,
  removeProjectModule,
  saveProjectModule,
} from "./module-service";
import { getDb } from "./queries/connection";
import { findOwnedProject, findProjectWorkspace, listProjects } from "./queries/projects";
import { findComponentRevisions } from "./queries/components";

const projectIdInput = z.object({ projectId: z.number().int().positive() });
const selectionSchema = z.record(z.string(), z.number().int().positive());
const configurationSchema = z.record(z.string(), z.number().finite());

export const projectRouter = createRouter({
  list: authedQuery.query(({ ctx }) => listProjects(ctx.user.id)),

  detail: authedQuery.input(projectIdInput).query(async ({ ctx, input }) => {
    const project = await findProjectWorkspace(input.projectId, ctx.user.id);
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在或当前账号无权访问" });
    return project;
  }),

  create: authedQuery.input(z.object({
    code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/, "仅支持字母、数字、连字符与下划线"),
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).optional(),
    template: z.enum(["blank", "cnc", "arm", "mobile"]),
  })).mutation(({ ctx, input }) => createProjectWithTemplate(ctx.user.id, input)),

  createAutomatic: authedQuery.input(autoProjectInputSchema).mutation(({ ctx, input }) => (
    createAutomatedProject(ctx.user.id, input)
  )),

  update: authedQuery.input(z.object({
    projectId: z.number().int().positive(),
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000),
    status: z.enum(["draft", "in_review", "pilot_ready", "archived"]),
  })).mutation(async ({ ctx, input }) => {
    const project = await findOwnedProject(input.projectId, ctx.user.id);
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
    await getDb().update(projects).set({
      name: input.name,
      description: input.description,
      status: input.status,
      updatedAt: new Date(),
    }).where(eq(projects.id, input.projectId));
    await getDb().insert(auditEvents).values({
      projectId: input.projectId,
      actorId: ctx.user.id,
      action: "project.updated",
      entityType: "project",
      entityId: String(input.projectId),
      metadata: { status: input.status },
    });
    return { updated: true };
  }),

  saveModule: authedQuery.input(z.object({
    projectId: z.number().int().positive(),
    projectModuleId: z.number().int().positive().optional(),
    moduleVersionId: z.number().int().positive(),
    instanceName: z.string().trim().min(1).max(120),
    configuration: configurationSchema,
    selectedComponentRevisionIds: selectionSchema,
    sortOrder: z.number().int().min(0).optional(),
  })).mutation(({ ctx, input }) => saveProjectModule(ctx.user.id, input)),

  removeModule: authedQuery.input(z.object({
    projectId: z.number().int().positive(),
    projectModuleId: z.number().int().positive(),
  })).mutation(({ ctx, input }) => removeProjectModule(ctx.user.id, input.projectId, input.projectModuleId)),

  createVersion: authedQuery.input(z.object({
    projectId: z.number().int().positive(),
    changeNote: z.string().trim().min(3).max(1000),
  })).mutation(({ ctx, input }) => createProjectSnapshot(ctx.user.id, input.projectId, input.changeNote)),

  export: authedQuery.input(projectIdInput).query(async ({ ctx, input }) => {
    const workspace = await findProjectWorkspace(input.projectId, ctx.user.id);
    if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
    const revisionIds = [...new Set(workspace.modules.flatMap((module) => Object.values(module.selectedComponentRevisionIds)))];
    const selectedRevisions = await findComponentRevisions(revisionIds);
    const automationEvent = workspace.auditEvents.find((event) => event.action === "project.auto_generated");
    return {
      schemaVersion: 1,
      automation: automationEvent?.metadata ?? null,
      exportedAt: new Date(),
      project: {
        code: workspace.code,
        name: workspace.name,
        description: workspace.description,
        applicationType: workspace.applicationType,
        status: workspace.status,
        currentVersionNo: workspace.currentVersionNo,
      },
      modules: workspace.modules.map((module) => ({
        id: module.id,
        instanceName: module.instanceName,
        moduleKey: module.moduleVersion.definition.key,
        moduleName: module.moduleVersion.definition.name,
        moduleVersion: module.moduleVersion.version,
        ruleVersion: module.moduleVersion.ruleVersion,
        configuration: module.configuration,
        selectedComponentRevisionIds: module.selectedComponentRevisionIds,
        calculations: module.calculationRuns.map((run) => ({
          id: run.id,
          engineVersion: run.engineVersion,
          inputDigest: run.inputDigest,
          status: run.status,
          input: run.inputSnapshot,
          result: run.resultSnapshot,
          steps: run.steps,
          createdAt: run.createdAt,
        })),
      })),
      componentRevisions: selectedRevisions,
      versions: workspace.versions.map((version) => ({
        versionNo: version.versionNo,
        changeNote: version.changeNote,
        contentHash: version.contentHash,
        createdAt: version.createdAt,
        snapshot: version.snapshot,
      })),
      verificationBoundary: {
        engineering: "结果仅用于方案初算；强度、寿命、热、刚度、附着、制动与安全功能必须另行验证。",
        supplier: "source_recorded 仅表示已记录制造商资料来源，不表示供应商确认或工程师复核。",
        modelica: "本客户工程尚未完成针对选定模型的 OpenModelica 编译、数值工况对照与具名工程师复核。",
        manufacturing: "本导出不是生产图纸、采购定单或可直接制造的设计包。",
      },
    };
  }),
});
