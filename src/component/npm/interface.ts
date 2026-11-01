import { Context, Data, type Effect, type Option } from "effect";
import type { Account, TrustedPublisher, TrustedPublisherClaims } from "../validators";

/** The registry answered something other than what the operation expects, or could not be reached. */
export class RegistryRequestFailed extends Data.TaggedError("RegistryRequestFailed")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `npm registry: could not ${this.operation}: ${this.detail}`;
  }
}

/** One registry operation acting as a person's account. */
export interface AsAccount {
  readonly packageName: string;
  readonly account: Account;
}

/** A write acting as a person's account, retried with the one-time password a person's answer produced. */
export interface WriteAsAccount extends AsAccount {
  readonly maybeOneTimePassword: Option.Option<string>;
}

/**
 * npm wants its second factor before this write: a person answers on `pageUrl` (npm's `authUrl`, a page on
 * www.npmjs.com, in their own browser), and `resultUrl` (npm's `doneUrl`, on the registry) then gives the one-time
 * password to retry the write with. Nothing here answers it.
 */
export interface SecondFactorRequired {
  readonly status: "secondFactorRequired";
  readonly pageUrl: string;
  readonly resultUrl: string;
}

/** A write's result: what it did, or the second factor a person must answer first. */
export type WriteAnswer<A> = { readonly status: "done"; readonly value: A } | SecondFactorRequired;

/**
 * One npm registry, reached over its HTTP API. It holds no credential: each call that acts as an account brings
 * it. A write npm guards with its second factor answers `secondFactorRequired` with npm's own page for a person,
 * and succeeds when repeated with the one-time password that page's answer produced.
 */
export interface INpmRegistry {
  /** Whether the registry has any version of the package (404 is no; anything but 200 or 404 fails). */
  packageExists(packageName: string): Effect.fn.Return<boolean, RegistryRequestFailed>;
  /** The package's maintainers' npm usernames, or none when the package does not exist. */
  maintainers(packageName: string): Effect.fn.Return<Option.Option<ReadonlyArray<string>>, RegistryRequestFailed>;
  /** The npm username `account`'s token belongs to. */
  username(account: Account): Effect.fn.Return<string, RegistryRequestFailed>;
  /** Publishes `version` of a new package holding only `package.json`, under the `latest` dist-tag. */
  publishPlaceholder(input: WriteAsAccount & { readonly version: string; readonly description: string }): Effect.fn.Return<
    WriteAnswer<void>,
    RegistryRequestFailed
  >;
  /**
   * The package's GitHub Actions trusted publishers, each `validated` when some version of the package names it as
   * its publisher; publishers of other providers are left out. A read: npm asking for a second factor fails it.
   */
  listTrustedPublishers(input: AsAccount): Effect.fn.Return<ReadonlyArray<TrustedPublisher>, RegistryRequestFailed>;
  /** Adds a trusted publisher allowed to publish the package. */
  addTrustedPublisher(input: WriteAsAccount & { readonly claims: TrustedPublisherClaims }): Effect.fn.Return<
    WriteAnswer<void>,
    RegistryRequestFailed
  >;
  /** Deletes one trusted publisher; false when the registry has no publisher with that id. */
  removeTrustedPublisher(input: WriteAsAccount & { readonly id: string }): Effect.fn.Return<WriteAnswer<boolean>, RegistryRequestFailed>;
}

export class NpmRegistry extends Context.Service<NpmRegistry, INpmRegistry>()("NpmRegistry") {}
