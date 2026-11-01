import { v } from "convex/values";
import { Effect, Option } from "effect";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { NpmRegistry, type RegistryRequestFailed } from "./npm/interface";
import { PLACEHOLDER_VERSION, placeholderDescription } from "./placeholder";
import { planPublisher } from "./publisherPlan";
import { runAgainstRegistry } from "./registry";
import { account, ensureInstanceResult, packageInstance, resourceCaller, type Account, type EnsureInstanceResult, type ResourceCaller, type TrustedPublisherClaims } from "./validators";

/**
 * The standard call of every resource (jive-abstract-resource), for npm: make sure a package exists and that the
 * caller's workflow and environment may publish it by trusted publishing. Idempotent and run by every deploy right
 * before it publishes, so each step reads npm before it writes, and a provisioning that failed is redone by the next.
 */

/** How long a provisioning's claim on a package lasts before another caller may take it over. */
const CLAIM_MS = 5 * 60 * 1000;

/** How long a caller that found the package claimed waits before asking again. */
const RETRY_AFTER_SECONDS = 10;

/** What provisioning against npm came to, before it is recorded. */
type RegistryOutcome =
  | { readonly status: "provisioned"; readonly registeredPublisher: boolean }
  | Extract<EnsureInstanceResult, { status: "personNeeded" } | { status: "refused" }>;

/**
 * The package is bound to the first code repository that provisioned it; another one is refused before anything
 * reaches npm. One provisioning of a package runs at a time; the others answer `inProgress`. The claim is released
 * however this ends.
 */
export const ensureInstance = action({
  args: { instance: packageInstance, caller: resourceCaller, account },
  returns: ensureInstanceResult,
  handler: async (ctx, { instance, caller, account }): Promise<EnsureInstanceResult> => {
    const { packageName } = instance;
    const record = await ctx.runQuery(internal.resource.packageRecord, { packageName });
    if (record !== null && record.codeRepositoryId !== caller.codeRepository.id) {
      return { status: "refused", reason: `${packageName} is provisioned for another code repository` };
    }
    const holder = crypto.randomUUID();
    if (!await ctx.runMutation(internal.resource.claim, { packageName, holder })) {
      return { status: "inProgress", retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    try {
      const now = Date.now();
      const maybeRegisteredAt = Option.fromUndefinedOr(record?.trustedPublishers.find((publisher) => publisher.environment === caller.environment)?.registeredAt);
      const outcome = await runAgainstRegistry(provision({
        packageName,
        caller,
        account,
        maybeRegisteredAt,
        now,
      }));
      if (outcome.status !== "provisioned") return outcome;
      const instanceId = await ctx.runMutation(internal.resource.recordProvisioned, {
        packageName,
        codeRepositoryId: caller.codeRepository.id,
        registeredPublisherFor: outcome.registeredPublisher ? caller.environment : undefined,
        now,
      });
      return { status: "ready", instanceId, instance: { packageName } };
    } finally {
      await ctx.runMutation(internal.resource.release, { packageName, holder });
    }
  },
});

/** A write npm wants its security key for. `url` is npm's page. OpenSK answers it once that key is on the npm account. */
function personNeeded(operation: string, factor: { readonly pageUrl: string; readonly resultUrl: string }): RegistryOutcome {
  return {
    status: "personNeeded",
    reason: `npm asks for its security key to ${operation}`,
    url: factor.pageUrl,
    resultUrl: factor.resultUrl,
  };
}

/**
 * Creates the package if missing, refusing one another account maintains, then makes sure a publisher for the
 * caller's repository, workflow and environment can publish: a validated one, or one Jive registered less than 47
 * hours ago, is kept; an unvalidated one that is older or unknown may have expired (npm expires a publisher unused
 * for 2 days and doesn't say so), so it is removed and registered again.
 */
function provision(input: {
  readonly packageName: string;
  readonly caller: ResourceCaller;
  readonly account: Account;
  readonly maybeRegisteredAt: Option.Option<number>;
  readonly now: number;
}): Effect.Effect<RegistryOutcome, RegistryRequestFailed, NpmRegistry> {
  return Effect.gen(function* () {
    const npm = yield* NpmRegistry;
    const { packageName, caller, account } = input;

    const maybeMaintainers = yield* npm.maintainers(packageName);
    if (Option.isSome(maybeMaintainers)) {
      if (!maybeMaintainers.value.includes(yield* npm.username(account))) {
        return { status: "refused", reason: `${packageName} exists on npm and the organization's npm account does not maintain it` } as const;
      }
    } else {
      const published = yield* npm.publishPlaceholder({
        packageName,
        account,
        version: PLACEHOLDER_VERSION,
        description: placeholderDescription(packageName),
      });
      if (published.status === "secondFactorRequired") return personNeeded(`publish ${packageName}'s placeholder`, published);
    }

    const wanted: TrustedPublisherClaims = {
      provider: "github",
      repository: { owner: caller.codeRepository.owner, name: caller.codeRepository.name },
      workflowFile: caller.workflowFile,
      environment: caller.environment,
    };
    const plan = planPublisher({
      listed: yield* npm.listTrustedPublishers({ packageName, account }),
      wanted,
      maybeRegisteredAt: input.maybeRegisteredAt,
      now: input.now,
    });
    if (plan.action === "keep") return { status: "provisioned", registeredPublisher: false } as const;
    for (const id of plan.removeIds) {
      const removed = yield* npm.removeTrustedPublisher({ packageName, id, account });
      if (removed.status === "secondFactorRequired") return personNeeded(`remove trusted publisher ${id} from ${packageName}`, removed);
    }
    const added = yield* npm.addTrustedPublisher({ packageName, account, claims: wanted });
    if (added.status === "secondFactorRequired") return personNeeded(`register a trusted publisher on ${packageName}`, added);
    return { status: "provisioned", registeredPublisher: true } as const;
  });
}

export const packageRecord = internalQuery({
  args: { packageName: v.string() },
  returns: v.union(v.null(), v.object({
    codeRepositoryId: v.string(),
    trustedPublishers: v.array(v.object({ environment: v.string(), registeredAt: v.number() })),
  })),
  handler: async (ctx, { packageName }) => {
    const record = await ctx.db.query("packages").withIndex("by_package_name", (q) => q.eq("packageName", packageName)).unique();
    return record === null ? null : { codeRepositoryId: record.codeRepositoryId, trustedPublishers: record.trustedPublishers };
  },
});

/** Takes the package's claim for `holder`; false while another unexpired claim stands. */
export const claim = internalMutation({
  args: { packageName: v.string(), holder: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { packageName, holder }) => {
    const now = Date.now();
    const existing = await ctx.db.query("provisioningClaims").withIndex("by_package_name", (q) => q.eq("packageName", packageName)).unique();
    if (existing !== null && existing.expiresAt > now) return false;
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("provisioningClaims", { packageName, holder, expiresAt: now + CLAIM_MS });
    return true;
  },
});

/** Releases the claim if `holder` still holds it; one taken over after expiring is left to its new holder. */
export const release = internalMutation({
  args: { packageName: v.string(), holder: v.string() },
  returns: v.null(),
  handler: async (ctx, { packageName, holder }) => {
    const existing = await ctx.db.query("provisioningClaims").withIndex("by_package_name", (q) => q.eq("packageName", packageName)).unique();
    if (existing !== null && existing.holder === holder) await ctx.db.delete(existing._id);
    return null;
  },
});

/** Binds the package to its code repository and records a publisher Jive registered just now; returns its id. */
export const recordProvisioned = internalMutation({
  args: { packageName: v.string(), codeRepositoryId: v.string(), registeredPublisherFor: v.optional(v.string()), now: v.number() },
  returns: v.string(),
  handler: async (ctx, { packageName, codeRepositoryId, registeredPublisherFor, now }) => {
    const record = await ctx.db.query("packages").withIndex("by_package_name", (q) => q.eq("packageName", packageName)).unique();
    const kept = (record?.trustedPublishers ?? []).filter((publisher) => publisher.environment !== registeredPublisherFor);
    const trustedPublishers = registeredPublisherFor === undefined ? kept : [...kept, { environment: registeredPublisherFor, registeredAt: now }];
    if (record === null) {
      return await ctx.db.insert("packages", { packageName, codeRepositoryId, trustedPublishers, lastProvisionedAt: now });
    }
    await ctx.db.patch(record._id, { codeRepositoryId, trustedPublishers, lastProvisionedAt: now });
    return record._id;
  },
});
