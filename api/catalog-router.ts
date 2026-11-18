import { createRouter, authedQuery } from "./middleware";
import { listComponentLibrary, listModuleLibrary } from "./queries/catalog";

export const catalogRouter = createRouter({
  modules: authedQuery.query(() => listModuleLibrary()),
  components: authedQuery.query(() => listComponentLibrary()),
});
