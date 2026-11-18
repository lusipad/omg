import {
  bigint,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { CalculationResult } from "@contracts/engineering";

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export const projects = mysqlTable(
  "engineering_projects",
  {
    id: serial("id").primaryKey(),
    ownerId: bigint("ownerId", { mode: "number", unsigned: true }).notNull().references(() => users.id),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    applicationType: mysqlEnum("applicationType", ["cnc", "arm", "mobile", "custom"]).default("custom").notNull(),
    status: mysqlEnum("status", ["draft", "in_review", "pilot_ready", "archived"]).default("draft").notNull(),
    currentVersionNo: int("currentVersionNo").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("project_owner_code_unique").on(table.ownerId, table.code),
    index("project_owner_idx").on(table.ownerId),
  ],
);

export const moduleDefinitions = mysqlTable("module_definitions", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  family: varchar("family", { length: 80 }).notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const moduleVersions = mysqlTable(
  "module_versions",
  {
    id: serial("id").primaryKey(),
    definitionId: bigint("definitionId", { mode: "number", unsigned: true }).notNull().references(() => moduleDefinitions.id),
    version: varchar("version", { length: 32 }).notNull(),
    ruleVersion: varchar("ruleVersion", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["pilot", "released", "retired"]).default("pilot").notNull(),
    inputSchema: json("inputSchema").notNull(),
    changeNote: text("changeNote").notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("module_definition_version_unique").on(table.definitionId, table.version)],
);

export const manufacturers = mysqlTable("manufacturers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull().unique(),
  website: text("website").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const components = mysqlTable(
  "manufacturer_components",
  {
    id: serial("id").primaryKey(),
    manufacturerId: bigint("manufacturerId", { mode: "number", unsigned: true }).notNull().references(() => manufacturers.id),
    model: varchar("model", { length: 160 }).notNull(),
    category: mysqlEnum("category", ["ball_screw", "linear_guide", "servo_motor", "servo_drive", "gearbox", "encoder", "controller", "wheel", "safety"]).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("component_manufacturer_model_unique").on(table.manufacturerId, table.model)],
);

export const componentRevisions = mysqlTable(
  "component_revisions",
  {
    id: serial("id").primaryKey(),
    componentId: bigint("componentId", { mode: "number", unsigned: true }).notNull().references(() => components.id, { onDelete: "cascade" }),
    revisionLabel: varchar("revisionLabel", { length: 80 }).notNull(),
    sourceTitle: text("sourceTitle").notNull(),
    sourceUrl: text("sourceUrl").notNull(),
    sourceVersion: varchar("sourceVersion", { length: 120 }),
    sourceLocator: varchar("sourceLocator", { length: 255 }).notNull(),
    verificationStatus: mysqlEnum("verificationStatus", ["source_recorded", "engineer_reviewed", "supplier_confirmed", "obsolete"]).default("source_recorded").notNull(),
    parameters: json("parameters").notNull(),
    sourceEvidence: text("sourceEvidence").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("component_revision_unique").on(table.componentId, table.revisionLabel)],
);

export const projectModules = mysqlTable(
  "project_modules",
  {
    id: serial("id").primaryKey(),
    projectId: bigint("projectId", { mode: "number", unsigned: true }).notNull().references(() => projects.id, { onDelete: "cascade" }),
    moduleVersionId: bigint("moduleVersionId", { mode: "number", unsigned: true }).notNull().references(() => moduleVersions.id),
    instanceName: varchar("instanceName", { length: 120 }).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    configuration: json("configuration").notNull(),
    selectedComponentRevisionIds: json("selectedComponentRevisionIds").$type<Record<string, number>>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("project_module_name_unique").on(table.projectId, table.instanceName),
    index("project_module_project_idx").on(table.projectId),
  ],
);

export const calculationRuns = mysqlTable(
  "calculation_runs",
  {
    id: serial("id").primaryKey(),
    projectId: bigint("projectId", { mode: "number", unsigned: true }).notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectModuleId: bigint("projectModuleId", { mode: "number", unsigned: true }).notNull().references(() => projectModules.id, { onDelete: "cascade" }),
    moduleVersionId: bigint("moduleVersionId", { mode: "number", unsigned: true }).notNull().references(() => moduleVersions.id),
    engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
    inputDigest: varchar("inputDigest", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["ok", "warning", "blocked"]).notNull(),
    inputSnapshot: json("inputSnapshot").notNull(),
    resultSnapshot: json("resultSnapshot").$type<CalculationResult>().notNull(),
    createdBy: bigint("createdBy", { mode: "number", unsigned: true }).notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("calculation_project_module_idx").on(table.projectModuleId, table.createdAt)],
);

export const calculationSteps = mysqlTable(
  "calculation_steps",
  {
    id: serial("id").primaryKey(),
    runId: bigint("runId", { mode: "number", unsigned: true }).notNull().references(() => calculationRuns.id, { onDelete: "cascade" }),
    stepOrder: int("stepOrder").notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    formula: text("formula").notNull(),
    substitution: text("substitution").notNull(),
    value: double("value").notNull(),
    unit: varchar("unit", { length: 40 }).notNull(),
    basis: text("basis").notNull(),
  },
  (table) => [uniqueIndex("calculation_step_order_unique").on(table.runId, table.stepOrder)],
);

export const projectVersions = mysqlTable(
  "project_versions",
  {
    id: serial("id").primaryKey(),
    projectId: bigint("projectId", { mode: "number", unsigned: true }).notNull().references(() => projects.id, { onDelete: "cascade" }),
    versionNo: int("versionNo").notNull(),
    snapshot: json("snapshot").notNull(),
    changeNote: text("changeNote").notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    createdBy: bigint("createdBy", { mode: "number", unsigned: true }).notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("project_version_unique").on(table.projectId, table.versionNo)],
);

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    projectId: bigint("projectId", { mode: "number", unsigned: true }).references(() => projects.id, { onDelete: "cascade" }),
    actorId: bigint("actorId", { mode: "number", unsigned: true }).notNull().references(() => users.id),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entityType", { length: 80 }).notNull(),
    entityId: varchar("entityId", { length: 80 }).notNull(),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("audit_project_idx").on(table.projectId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type ModuleDefinition = typeof moduleDefinitions.$inferSelect;
export type ModuleVersion = typeof moduleVersions.$inferSelect;
export type Component = typeof components.$inferSelect;
export type ComponentRevision = typeof componentRevisions.$inferSelect;
export type ProjectModule = typeof projectModules.$inferSelect;
export type CalculationRun = typeof calculationRuns.$inferSelect;
export type CalculationStep = typeof calculationSteps.$inferSelect;
export type ProjectVersion = typeof projectVersions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
