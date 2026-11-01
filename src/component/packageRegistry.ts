import { v } from "convex/values";
import { Effect, Option } from "effect";
import { action } from "./_generated/server";
import { sameClaims } from "./claims";
import { NpmRegistry } from "./npm/interface";
import { PLACEHOLDER_VERSION, placeholderDescription } from "./placeholder";
import { runAgainstRegistry } from "./registry";
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
 * becomes the action's error, with its message. No message carries the account's token. A write npm guards with
 * its security key answers `secondFactorRequired` with npm's own page. This connector does not send `npm-otp`.
 * OpenSK answers that key once it has been registered on the npm account, which is part of instantiating the
 * connection.
 */

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
  args: { packageName: v.string(), account },
  returns: createPlaceholderResult,
  handler: (_ctx, { packageName, account }) => runAgainstRegistry(Effect.gen(function* () {
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
      version: PLACEHOLDER_VERSION,
      description: placeholderDescription(packageName),
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
  args: { packageName: v.string(), publisher: trustedPublisherClaims, account },
  returns: registerTrustedPublisherResult,
  handler: (_ctx, { packageName, publisher, account }) => runAgainstRegistry(Effect.gen(function* () {
    const npm = yield* NpmRegistry;
    const existing = (yield* npm.listTrustedPublishers({ packageName, account })).find((candidate) => sameClaims(candidate.claims, publisher));
    if (existing !== undefined) return { status: "alreadyRegistered", id: existing.id } as const;
    const added = yield* npm.addTrustedPublisher({ packageName, account, claims: publisher });
    if (added.status === "secondFactorRequired") return added;
    return { status: "registered" } as const;
  })),
});

/** Deletes one trusted publisher by the id `listTrustedPublishers` reported; one already gone is `notFound`. */
export const removeTrustedPublisher = action({
  args: { packageName: v.string(), id: v.string(), account },
  returns: removeTrustedPublisherResult,
  handler: (_ctx, { packageName, id, account }) => runAgainstRegistry(Effect.gen(function* () {
    const removed = yield* (yield* NpmRegistry).removeTrustedPublisher({ packageName, id, account });
    if (removed.status === "secondFactorRequired") return removed;
    return removed.value ? { status: "removed" } as const : { status: "notFound" } as const;
  })),
});
