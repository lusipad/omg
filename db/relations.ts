import { relations } from "drizzle-orm";
import {
  auditEvents,
  calculationRuns,
  calculationSteps,
  componentRevisions,
  components,
  manufacturers,
  moduleDefinitions,
  moduleVersions,
  projectModules,
  projectVersions,
  projects,
  users,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  modules: many(projectModules),
  calculationRuns: many(calculationRuns),
  versions: many(projectVersions),
  auditEvents: many(auditEvents),
}));

export const moduleDefinitionsRelations = relations(moduleDefinitions, ({ many }) => ({
  versions: many(moduleVersions),
  projectModules: many(projectModules),
}));

export const moduleVersionsRelations = relations(moduleVersions, ({ one, many }) => ({
  definition: one(moduleDefinitions, { fields: [moduleVersions.definitionId], references: [moduleDefinitions.id] }),
  projectModules: many(projectModules),
}));

export const manufacturersRelations = relations(manufacturers, ({ many }) => ({
  components: many(components),
}));

export const componentsRelations = relations(components, ({ one, many }) => ({
  manufacturer: one(manufacturers, { fields: [components.manufacturerId], references: [manufacturers.id] }),
  revisions: many(componentRevisions),
}));

export const componentRevisionsRelations = relations(componentRevisions, ({ one }) => ({
  component: one(components, { fields: [componentRevisions.componentId], references: [components.id] }),
}));

export const projectModulesRelations = relations(projectModules, ({ one, many }) => ({
  project: one(projects, { fields: [projectModules.projectId], references: [projects.id] }),
  moduleVersion: one(moduleVersions, { fields: [projectModules.moduleVersionId], references: [moduleVersions.id] }),
  calculationRuns: many(calculationRuns),
}));

export const calculationRunsRelations = relations(calculationRuns, ({ one, many }) => ({
  project: one(projects, { fields: [calculationRuns.projectId], references: [projects.id] }),
  projectModule: one(projectModules, { fields: [calculationRuns.projectModuleId], references: [projectModules.id] }),
  moduleVersion: one(moduleVersions, { fields: [calculationRuns.moduleVersionId], references: [moduleVersions.id] }),
  steps: many(calculationSteps),
}));

export const calculationStepsRelations = relations(calculationSteps, ({ one }) => ({
  run: one(calculationRuns, { fields: [calculationSteps.runId], references: [calculationRuns.id] }),
}));

export const projectVersionsRelations = relations(projectVersions, ({ one }) => ({
  project: one(projects, { fields: [projectVersions.projectId], references: [projects.id] }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  project: one(projects, { fields: [auditEvents.projectId], references: [projects.id] }),
  actor: one(users, { fields: [auditEvents.actorId], references: [users.id] }),
}));
