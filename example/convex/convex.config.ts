import { defineApp } from "convex/server";
import { v } from "convex/values";
import packageRegistryNpm from "jive-resource-connector-package-registry-npm/convex.config.js";

const app = defineApp({
  env: {
    // Unset, the connector acts on https://registry.npmjs.org; the tests point it at a fake registry.
    NPM_REGISTRY_URL: v.optional(v.string()),
  },
});
app.use(packageRegistryNpm, { env: { NPM_REGISTRY_URL: app.env.NPM_REGISTRY_URL } });

export default app;
