import { v } from "convex/values";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * The connector's functions, called from an app. A real app holds each person's npm token in its own credential
 * store, sealed, and passes it in `account`; these take it as an argument only to show the shape. A write may answer
 * `secondFactorRequired`; the app sends the person to its `pageUrl` and repeats the call with `oneTimePassword`.
 */

const registry = components.packageRegistryNpm.packageRegistry;
const account = v.object({ token: v.string() });
const oneTimePassword = v.optional(v.string());
const publisher = v.object({
  provider: v.literal("github"),
  repository: v.object({ owner: v.string(), name: v.string() }),
  workflowFile: v.string(),
  environment: v.optional(v.string()),
});

export const packageExists = action({
  args: { packageName: v.string() },
  handler: (ctx, args) => ctx.runAction(registry.packageExists, args),
});

export const createPlaceholder = action({
  args: { packageName: v.string(), account, oneTimePassword },
  handler: (ctx, args) => ctx.runAction(registry.createPlaceholder, args),
});

export const listTrustedPublishers = action({
  args: { packageName: v.string(), account },
  handler: (ctx, args) => ctx.runAction(registry.listTrustedPublishers, args),
});

export const registerTrustedPublisher = action({
  args: { packageName: v.string(), publisher, account, oneTimePassword },
  handler: (ctx, args) => ctx.runAction(registry.registerTrustedPublisher, args),
});

export const removeTrustedPublisher = action({
  args: { packageName: v.string(), id: v.string(), account, oneTimePassword },
  handler: (ctx, args) => ctx.runAction(registry.removeTrustedPublisher, args),
});
