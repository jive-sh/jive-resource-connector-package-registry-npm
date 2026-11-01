# jive-resource-connector-package-registry-npm

A Jive connector to npm: a [Convex component](https://docs.convex.dev/components) that checks whether a package
exists, creates a new package as a person's own npm account, and lets a package's CI workflow publish it through
npm's trusted publishing. It implements the contract of
[`jive-abstract-resource-connector-package-registry`](https://github.com/jive-sh/jive-abstract-resource-connector-package-registry),
whose CLI builds, audits and publishes it.

This package was `jive-connector-package-registry-npm` until 0.2.0. Since this release an account is `{ token }` and
the second factor is answered by a person on npm's own page (below), where 0.2.0 computed it from an authenticator
secret it was given.

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

## Functions

| Function | Arguments | Returns |
| --- | --- | --- |
| `packageExists` | `{ packageName }` | `boolean` |
| `createPlaceholder` | `{ packageName, account, oneTimePassword? }` | `{ status: "created", version: "0.0.0" }` \| `{ status: "alreadyExists" }` \| `{ status: "maintainedByAnotherAccount" }` \| `secondFactorRequired` |
| `listTrustedPublishers` | `{ packageName, account }` | `Array<{ id, claims, status: "validated" \| "unvalidated" }>` (GitHub Actions publishers only) |
| `registerTrustedPublisher` | `{ packageName, publisher, account, oneTimePassword? }` | `{ status: "registered" }` \| `{ status: "alreadyRegistered", id }` \| `secondFactorRequired` |
| `removeTrustedPublisher` | `{ packageName, id, account, oneTimePassword? }` | `{ status: "removed" }` \| `{ status: "notFound" }` \| `secondFactorRequired` |

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

### The second factor

npm asks for the account's second factor before it publishes or changes trusted publishers, by refusing the
request with a 401 whose `www-authenticate` lists `otp` or whose body mentions a one-time password (npm's EOTP).
Every request carries `npm-auth-type: web`, as npm's CLI sends, so the refusal's body names npm's own page for a person
(`authUrl`, on www.npmjs.com) and where the one-time password their answer produces is fetched (`doneUrl`, on the
registry). The write then answers `{ status: "secondFactorRequired", pageUrl, resultUrl }` with those two; the caller
sends the person to `pageUrl`, polls `resultUrl`, and repeats the call with the password as `oneTimePassword`,
which goes to npm as `npm-otp`. A password npm refuses answers `secondFactorRequired` again, for a fresh answer.
The component never answers a second factor itself, and no token or one-time password is returned, logged or put
in an error. A read takes no one-time password: if npm asks `listTrustedPublishers` for a second factor, the call
fails.

## How it is verified

`bun run jive:cicd:audit` builds the package, installs it into the example app on a local Convex backend, then
runs the tests:

- `test/registry.test.ts` calls every function through the example app, inside Convex's runtime:
  - against registry.npmjs.org, read-only: `packageExists` finds `convex` and not an unused name;
  - against a fake registry that answers as npm's source says npm does, refusing a write without the
    one-time password its fake answer page hands out: the publish document (its tarball extracts with the system's `tar`,
    and its integrity and shasum match), the maintainer check, the trust request body, idempotent registration
    (owner and repository names compared case-insensitively), validated status, removal, the `secondFactorRequired` answer
    and the retry with the password, a refused password, a refused token, and that nothing printed contains the
    token or a password.

Not verified against npm itself, because nothing here writes to npm: the publish, trust and revoke requests, and
npm's web second-factor flow for them (`authUrl` and `doneUrl` follow npm-registry-fetch's `check-response.js`).

## Open

- Deprecating the `0.0.0` placeholder once CI's first release lands is not built.
- How an app obtains and renews each person's npm token is undecided.
