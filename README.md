# jive-resource-connector-package-registry-npm

A Jive connector to npm: a [Convex component](https://docs.convex.dev/components) that checks whether a package
exists, creates a new package as a person's own npm account, and lets a package's CI workflow publish it through
npm's trusted publishing. It implements the contract of
[`jive-abstract-resource-connector-package-registry`](https://github.com/jive-sh/jive-abstract-resource-connector-package-registry),
whose CLI builds, audits and publishes it.

This package was `jive-connector-package-registry-npm` until 0.2.0. An account is `{ token }`. npm's second factor is
the account's security key. Adding that key to the npm account is part of instantiating the connection, and OpenSK
answers the prompt. This connector does not take a password.

## Install it in a Convex app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import packageRegistryNpm from "jive-resource-connector-package-registry-npm/convex.config.js";

const app = defineApp();
app.use(packageRegistryNpm);
export default app;
```

The app then calls `components.packageRegistryNpm.packageRegistry.<function>` from its actions. The component
reads one optional environment variable, `NPM_REGISTRY_URL` (default `https://registry.npmjs.org`), passed as
`app.use(packageRegistryNpm, { env: { NPM_REGISTRY_URL: … } })`. [`example/convex`](example/convex) is a working app.

## Accounts

One connection is one person's own npm account, such as the account that owns a project's packages. The component
stores no credentials: every function that acts as an account takes `account: { token }`, a token from that
person's npm login. It holds no second-factor secret either (below). One installed component serves every person, and where credentials
are kept (and how they are renewed) is the calling app's decision. `packageExists` acts as no account and sees
public packages only.

## The standard call: `resource.ensureInstance`

The call every resource has (jive-abstract-resource), and what `@jive-sh/server`'s `resources:provision` calls for kind
`connector-package-registry`:

```ts
ctx.runAction(components.packageRegistryNpm.resource.ensureInstance, {
  instance: { packageName: "@scope/name" },
  caller: { codeRepository: { id, owner, name }, environment: "latest", workflowFile: "pipeline.yml" },
  account: { token },
});
```

It makes sure the package exists and that the caller's workflow and environment may publish it by trusted
publishing, and answers `ready` (with `instanceId`, this component's id for the package), `inProgress`,
`personNeeded` or `refused`. Run before every publish, it reads npm before it writes:

1. **Bound to one code repository:** the first `codeRepository.id` that provisions a package owns it here; another
   is refused before npm is asked.
2. **One at a time:** a mutation claims the package (`provisioningClaims`), so of two callers only one acts; the
   other gets `inProgress` (`retryAfterSeconds: 10`). A claim lasts 5 minutes, so one left by a dead action is taken
   over.
3. **The package:** created as `0.0.0` if missing, as `createPlaceholder` does; one another npm account maintains is
   refused.
4. **The publisher:** a validated one for the caller's repository, workflow and environment is kept, and so is one
   Jive registered less than 47 hours ago. An unvalidated one that is older, or that this component never
   registered, may have expired (npm expires a publisher unused for 2 days and doesn't say so), so it is removed and
   registered again (`src/component/publisherPlan.ts`).
5. **Recorded:** the package, its repository, and when each environment's publisher was registered, in the
   component's `packages` table. The claim is released however this ends.

It sends no password. A write npm guards with its security key answers `personNeeded` with npm's page as `url`.
Adding the organization's signing passkey on that page is part of instantiating the connection; OpenSK answers the
prompt. Until npm accepts the write without asking, only a package that needs no write (it exists and its publisher
for the caller has published) comes back `ready`.

## Functions

| Function | Arguments | Returns |
| --- | --- | --- |
| `resource.ensureInstance` | `{ instance: { packageName }, caller, account }` | `ready` \| `inProgress` \| `personNeeded` \| `refused` (above) |
| `packageExists` | `{ packageName }` | `boolean` |
| `createPlaceholder` | `{ packageName, account }` | `{ status: "created", version: "0.0.0" }` \| `{ status: "alreadyExists" }` \| `{ status: "maintainedByAnotherAccount" }` \| `secondFactorRequired` |
| `listTrustedPublishers` | `{ packageName, account }` | `Array<{ id, claims, status: "validated" \| "unvalidated" }>` (GitHub Actions publishers only) |
| `registerTrustedPublisher` | `{ packageName, publisher, account }` | `{ status: "registered" }` \| `{ status: "alreadyRegistered", id }` \| `secondFactorRequired` |
| `removeTrustedPublisher` | `{ packageName, id, account }` | `{ status: "removed" }` \| `{ status: "notFound" }` \| `secondFactorRequired` |

They are the first two steps of provisioning a new package:

1. `createPlaceholder` publishes `0.0.0`, holding only a package.json, so the package exists and `account` owns
   it. npm points `latest` at a package's first version, so `latest` is this placeholder until CI's first
   release. A package that already exists is never touched: it is `alreadyExists` when `account` is among its
   maintainers (npm's `/-/whoami` against the package document's `maintainers`), and `maintainedByAnotherAccount`
   otherwise.
2. `registerTrustedPublisher` with `{ provider: "github", repository: { owner, name }, workflowFile: "pipeline.yml",
   environment: "latest" }` lets that workflow's deploy job publish with its OIDC identity. It grants direct
   publishing (`createPackage`, what `npm trust github --allow-publish` grants), not only staged publishing.
3. CI publishes every real version. npm expires a new trusted publisher whose first publish hasn't happened
   within 2 days; the expired one stays listed but "can no longer be used or edited"
   ([npm docs](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)). So register it
   only when the workflow is about to run, and replace one that never published with `removeTrustedPublisher`
   (npm's `npm trust revoke` request) and `registerTrustedPublisher`.

A listed publisher is `validated` when some version of the package names it as its publisher
(`_npmUser.trustedPublisher.oidcConfigId` in the package document, which npm records on a version published by
trusted publishing), and `unvalidated` otherwise. That the id there is the trust API's id is an inference: npm
documents neither field. npm's trust list reports no expiry either, so an unvalidated publisher may be waiting or
expired; the caller that registered it knows when it did. `listTrustedPublishers` logs the field names (never
values) npm's trust list returns, so the first live call shows whether npm marks expiry after all.

### The security key

npm asks for the account's security key before it publishes or changes trusted publishers, by refusing the request
with a 401 whose body is `{ authUrl, doneUrl }`. That body is the page where a key already on the account is used.
Every request carries `npm-auth-type: web`. The write answers `{ status: "secondFactorRequired", pageUrl, resultUrl }`
with those two, and `ensureInstance` answers `personNeeded` with the page as `url`. OpenSK, in `@jive-sh/sk-demo`,
answers that page through `POST /security-key/sign`. This connector does not send `npm-otp` and does not poll
`resultUrl`. Adding the key to the account is a different page, and npm's documentation says a security key can
only be configured on the website: sign in, then Account, then Enable 2FA, then Add security key
([Configuring two-factor authentication](https://docs.npmjs.com/configuring-two-factor-authentication/)). That
documentation gives no direct address for the account page, so this connector does not open one. No token is
returned, logged or put in an error. A read takes no password: if npm asks `listTrustedPublishers` for the key,
the call fails.

## How it is verified

`bun run jive:cicd:audit` builds the package, installs it into the example app on a local Convex backend, then
runs the tests:

- `test/registry.test.ts` calls every function through the example app, inside Convex's runtime:
  - against registry.npmjs.org, read-only: `packageExists` finds `convex` and not an unused name;
  - against a fake registry that answers as npm's source says npm does, refusing a guarded write with npm's
    security-key page and accepting a write only when that guard is off: the publish document (its tarball extracts
    with the system's `tar`, and its integrity and shasum match), the maintainer check, the trust request body,
    idempotent registration (owner and repository names compared case-insensitively), validated status, removal,
    the `secondFactorRequired` answer, a refused token, and that nothing printed contains the token and no `npm-otp`
    was sent;
  - `resource.ensureInstance` against the same fake: a new package answering `personNeeded` with npm's `authUrl`
    as `url` and `doneUrl` as `resultUrl`, publishing nothing; the same package becoming `ready` when npm does not
    ask for the key, with no `npm-otp`; a package whose publisher has published `ready` with no write and the same `instanceId`
    each time, another code repository refused, a package another account maintains refused, an unrecorded
    unvalidated publisher replaced, and a held claim answering `inProgress`.
- `test/publisherPlan.test.ts`: when a publisher is kept and when it is replaced.

Not verified against npm itself, because nothing here writes to npm: the publish, trust and revoke requests, and
npm's web second-factor flow for them (`authUrl` and `doneUrl` follow npm-registry-fetch's `check-response.js`).

## Open

- Deprecating the `0.0.0` placeholder once CI's first release lands is not built.
- How an app obtains and renews each person's npm token is undecided.
