import { v, type Infer } from "convex/values";

/**
 * The validators of `packageRegistry`'s functions, which make their generated types the ones
 * `PackageRegistryComponentApi` (jive-abstract-resource-connector-package-registry) names; the build checks they still do.
 */

/** The account an operation acts as: a token from that person's own npm login. No second factor is held. */
export const account = v.object({ token: v.string() });
export type Account = Infer<typeof account>;

export const trustedPublisherClaims = v.object({
  provider: v.literal("github"),
  repository: v.object({ owner: v.string(), name: v.string() }),
  workflowFile: v.string(),
  environment: v.optional(v.string()),
});
export type TrustedPublisherClaims = Infer<typeof trustedPublisherClaims>;

export const trustedPublisherStatus = v.union(v.literal("validated"), v.literal("unvalidated"));

export const trustedPublisher = v.object({ id: v.string(), claims: trustedPublisherClaims, status: trustedPublisherStatus });
export type TrustedPublisher = Infer<typeof trustedPublisher>;

/** npm wants its security key. `pageUrl` is npm's page. This connector does not take a password. */
export const secondFactorRequired = v.object({ status: v.literal("secondFactorRequired"), pageUrl: v.string(), resultUrl: v.string() });

export const createPlaceholderResult = v.union(
  v.object({ status: v.literal("created"), version: v.string() }),
  v.object({ status: v.literal("alreadyExists") }),
  v.object({ status: v.literal("maintainedByAnotherAccount") }),
  secondFactorRequired,
);

export const registerTrustedPublisherResult = v.union(
  v.object({ status: v.literal("registered") }),
  v.object({ status: v.literal("alreadyRegistered"), id: v.string() }),
  secondFactorRequired,
);

/** One package, as a package's jive block declares it: an instance of this resource. */
export const packageInstance = v.object({ packageName: v.string() });

/** The deploy job asking, as the installing app verified it (`ResourceCaller`, jive-abstract-resource). */
export const resourceCaller = v.object({
  codeRepository: v.object({ id: v.string(), owner: v.string(), name: v.string() }),
  environment: v.string(),
  workflowFile: v.string(),
});
export type ResourceCaller = Infer<typeof resourceCaller>;

/** `EnsureInstanceResult<{ packageName }>` (jive-abstract-resource). */
export const ensureInstanceResult = v.union(
  v.object({ status: v.literal("ready"), instanceId: v.string(), instance: packageInstance }),
  v.object({ status: v.literal("inProgress"), retryAfterSeconds: v.number() }),
  v.object({ status: v.literal("personNeeded"), reason: v.string(), url: v.string(), resultUrl: v.optional(v.string()) }),
  v.object({ status: v.literal("refused"), reason: v.string() }),
);
export type EnsureInstanceResult = Infer<typeof ensureInstanceResult>;

export const removeTrustedPublisherResult = v.union(
  v.object({ status: v.literal("removed") }),
  v.object({ status: v.literal("notFound") }),
  secondFactorRequired,
);
