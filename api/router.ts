import { authRouter } from "./auth-router";
import { catalogRouter } from "./catalog-router";
import { projectRouter } from "./project-router";
import { twinAiRouter } from "./twin-ai-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  catalog: catalogRouter,
  project: projectRouter,
  twinAi: twinAiRouter,
});

export type AppRouter = typeof appRouter;
