import { v } from "convex/values";
import { Effect, Layer, Option, pipe } from "effect";
import { action, env } from "./_generated/server";
import { sameClaims } from "./claims";
import { npmRegistryLayer } from "./npm/impl";
import { NpmRegistry } from "./npm/interface";
import {
  account,
  createPlaceholderResult,
  registerTrustedPublisherResult,
  removeTrustedPublisherResult,
  trustedPublisher,
  trustedPublisherClaims,
} from "./validators";

/**
 * The `PackageRegistryComponentApi` functions (jive-abstract-resource-connector-package-registry), for npm. Each action is
 * a runtime boundary: it runs one Effect program against the configured registry, and an unexpected failure
 * becomes the action's error, with its message. No message carries the account's token or a one-time password. A
 * write npm guards with its second factor answers `secondFactorRequired` with npm's own page, which a person answers
 * in their own browser; the caller polls `resultUrl` for the one-time password and repeats the call with it as
 * `oneTimePassword`. Nothing here answers a second factor.
 */

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/**
 * The version a placeholder is published at. npm points `latest` at a package's first version whatever tag it is
 * published under, so the placeholder is the lowest version there is, and CI's first release replaces it.
 */
const PLACEHOLDER_VERSION = "0.0.0";

function runAgainstRegistry<A, E extends { readonly message: string }>(program: Effect.Effect<A, E, NpmRegistry>): Promise<A> {
  return Effect.runPromise(pipe(
    program,
    Effect.mapError((e) => new Error(e.message)),
    Effect.provide(npmRegistryLayer(env.NPM_REGISTRY_URL ?? NPM_REGISTRY_URL)),
  ));
}

/** Whether the registry has any version of the package. Public packages only: it acts as no account. */
export const packageExists = action({
  args: { packageName: v.string() },
  returns: v.boolean(),
  handler: (_ctx, { packageName }) => runAgainstRegistry(Effect.gen(function* () {
    return yield* (yield* NpmRegistry).packageExists(packageName);
  })),
});

/**
 * Creates the package by publishing `0.0.0`, holding only a package.json, as `account`, which then owns it. An
 * existing package is left alone, and reported as `alreadyExists` only when `account` is one of its maintainers.
 */
export const createPlaceholder = action({
  args: { packageName: v.string(), account, oneTimePassword: v.optional(v.string()) },
  returns: createPlaceholderResult,
  handler: (_ctx, { packageName, account, oneTimePassword }) => runAgainstRegistry(Effect.gen(function* () {
    const npm = yield* NpmRegistry;
    const maybeMaintainers = yield* npm.maintainers(packageName);
    if (Option.isSome(maybeMaintainers)) {
      const username = yield* npm.username(account);
      return maybeMaintainers.value.includes(username)
        ? { status: "alreadyExists" } as const
        : { status: "maintainedByAnotherAccount" } as const;
    }
    const published = yield* npm.publishPlaceholder({
      packageName,
      account,
      maybeOneTimePassword: Option.fromUndefinedOr(oneTimePassword),
      version: PLACEHOLDER_VERSION,
      description: `Reserved by Jive: ${packageName}'s first release is published by its CI pipeline.`,
    });
    if (published.status === "secondFactorRequired") return published;
    return { status: "created", version: PLACEHOLDER_VERSION } as const;
  })),
});

/**
 * The package's GitHub Actions trusted publishers, as seen by an account that maintains it. A publisher is
 * `validated` once a version was published through it; an `unvalidated` one is waiting for its first publish or,
 * after npm's 2 days, expired, which npm leaves listed.
 */
export const listTrustedPublishers = action({
  args: { packageName: v.string(), account },
  returns: v.array(trustedPublisher),
  handler: (_ctx, { packageName, account }) => runAgainstRegistry(Effect.gen(function* () {
    return [...yield* (yield* NpmRegistry).listTrustedPublishers({ packageName, account })];
  })),
});

/**
 * Lets one GitHub Actions workflow publish the package with its OIDC identity. A publisher with identical claims
 * already on the package is reported instead of added again, whatever its status: replacing an expired one is
 * `removeTrustedPublisher` then this. npm expires a new publisher whose first publish hasn't happened within 2
 * days, so call this just before that workflow publishes.
 */
export const registerTrustedPublisher = action({
  args: { packageName: v.string(), publisher: trustedPublisherClaims, account, oneTimePassword: v.optional(v.string()) },
  returns: registerTrustedPublisherResult,
  handler: (_ctx, { packageName, publisher, account, oneTimePassword }) => runAgainstRegistry(Effect.gen(function* () {
    const npm = yield* NpmRegistry;
    const existing = (yield* npm.listTrustedPublishers({ packageName, account })).find((candidate) => sameClaims(candidate.claims, publisher));
    if (existing !== undefined) return { status: "alreadyRegistered", id: existing.id } as const;
    const added = yield* npm.addTrustedPublisher({ packageName, account, claims: publisher, maybeOneTimePassword: Option.fromUndefinedOr(oneTimePassword) });
    if (added.status === "secondFactorRequired") return added;
    return { status: "registered" } as const;
  })),
});

/** Deletes one trusted publisher by the id `listTrustedPublishers` reported; one already gone is `notFound`. */
export const removeTrustedPublisher = action({
  args: { packageName: v.string(), id: v.string(), account, oneTimePassword: v.optional(v.string()) },
  returns: removeTrustedPublisherResult,
  handler: (_ctx, { packageName, id, account, oneTimePassword }) => runAgainstRegistry(Effect.gen(function* () {
    const removed = yield* (yield* NpmRegistry).removeTrustedPublisher({ packageName, id, account, maybeOneTimePassword: Option.fromUndefinedOr(oneTimePassword) });
    if (removed.status === "secondFactorRequired") return removed;
    return removed.value ? { status: "removed" } as const : { status: "notFound" } as const;
  })),
});
