import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Calls the connector's functions through the example app that `jive:cicd:audit` installed it into and pushed to
 * a local Convex backend (dist/audit-app), so it runs as an installing app runs it: inside Convex's runtime. The
 * registry is a fake served by this process, answering as npm's source expects npm to answer, except one
 * read-only check against registry.npmjs.org. Nothing here writes to npm.
 */

const APP_DIR = resolve(import.meta.dir, "../dist/audit-app");
const TOKEN = "fake-token";
const USERNAME = "jive-test-account";
/** The one-time password the fake registry hands out once a person "answers" its page: a stand-in for npm's doneUrl. */
const ANSWERED_PASSWORD = "731944";
const MAINTAINED = "maintained-by-the-account";
const SOMEONE_ELSES = "maintained-by-someone-else";
const TIMEOUT = 2 * 60 * 1000;

async function convex(args: ReadonlyArray<string>) {
  // Async, never spawnSync: the fake registry is served by this process, which must keep answering meanwhile.
  const child = Bun.spawn(["bunx", "convex", ...args], { cwd: APP_DIR, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** Everything `convex run` printed, across calls, to check no token or one-time password ever reaches a log. */
const printed: Array<string> = [];

async function call(fn: string, args: Record<string, unknown>) {
  const result = await convex(["run", `example:${fn}`, JSON.stringify(args)]);
  printed.push(result.stdout, result.stderr);
  if (result.exitCode !== 0) return { ok: false as const, error: result.stderr };
  return { ok: true as const, value: JSON.parse(result.stdout) };
}

type TrustConfig = { id: string; type: string; claims: unknown; permissions: unknown };

/** What the fake registry was sent, and what it holds. */
const registry = {
  maintainers: new Map<string, Array<string>>([[MAINTAINED, [USERNAME]], [SOMEONE_ELSES, ["someone-else"]]]),
  /** Per package, the trust configuration ids its versions were published through. */
  publishedThrough: new Map<string, Array<string>>(),
  publishes: [] as Array<{ name: string; document: any }>,
  trust: new Map<string, Array<TrustConfig>>(),
  trustRequests: [] as Array<unknown>,
  deletes: [] as Array<string>,
  oneTimePasswordsSeen: [] as Array<string>,
  nextTrustId: 1,
};

/** npm's answer when an account change needs the second factor and it offers approval in a browser. */
function secondFactorChallenge(): Response {
  return Response.json(
    { authUrl: "https://www.npmjs.com/auth/cli/approve-1", doneUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
    { status: 401, headers: { "www-authenticate": "OTP" } },
  );
}

function packument(name: string): Response {
  const maintainers = registry.maintainers.get(name);
  if (maintainers === undefined) return Response.json({ error: "Not found" }, { status: 404 });
  const versions = Object.fromEntries((registry.publishedThrough.get(name) ?? []).map((id, index) => [
    `1.0.${index}`,
    { _npmUser: { name: "GitHub Actions", trustedPublisher: { id: "github", oidcConfigId: id } } },
  ]));
  return Response.json({ name, maintainers: maintainers.map((maintainer) => ({ name: maintainer })), "dist-tags": {}, versions });
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized = request.headers.get("authorization") === `Bearer ${TOKEN}`;
      const oneTimePassword = request.headers.get("npm-otp");
      if (oneTimePassword !== null) registry.oneTimePasswordsSeen.push(oneTimePassword);
      const secondFactor = oneTimePassword === ANSWERED_PASSWORD;

      if (url.pathname === "/-/whoami") {
        return authorized ? Response.json({ username: USERNAME }) : new Response("Unauthorized", { status: 401 });
      }
      const trust = url.pathname.match(/^\/-\/package\/([^/]+)\/trust(?:\/([^/]+))?$/);
      if (trust !== null) {
        const name = decodeURIComponent(trust[1]!);
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (request.method === "GET") return Response.json(registry.trust.get(name) ?? []);
        if (!secondFactor) return secondFactorChallenge();
        const configs = registry.trust.get(name) ?? [];
        if (request.method === "DELETE") {
          const id = decodeURIComponent(trust[2]!);
          registry.deletes.push(id);
          if (!configs.some((config) => config.id === id)) return Response.json({ error: "Not found" }, { status: 404 });
          registry.trust.set(name, configs.filter((config) => config.id !== id));
          return new Response(null, { status: 204 });
        }
        const body = await request.json();
        registry.trustRequests.push(body);
        registry.trust.set(name, [...configs, { id: `trust-${registry.nextTrustId++}`, ...(body as Array<any>)[0] }]);
        return Response.json(body);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method === "GET") return packument(name);
      if (request.method === "PUT") {
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (!secondFactor) return secondFactorChallenge();
        registry.publishes.push({ name, document: await request.json() });
        registry.maintainers.set(name, [USERNAME]);
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  await convex(["env", "remove", "NPM_REGISTRY_URL"]);
  server.stop(true);
});

describe("against registry.npmjs.org (read-only)", () => {
  test("packageExists finds a real package and not an unused name", async () => {
    expect(await call("packageExists", { packageName: "convex" })).toEqual({ ok: true, value: true });
    expect(await call("packageExists", { packageName: `jive-no-such-package-${Date.now()}` })).toEqual({ ok: true, value: false });
  }, TIMEOUT);
});

describe("against a fake registry", () => {
  const account = { token: TOKEN };
  const secondFactorRequired = {
    status: "secondFactorRequired",
    pageUrl: "https://www.npmjs.com/auth/cli/approve-1",
    resultUrl: "https://registry.npmjs.org/-/v1/done?authId=1",
  };
  const publisher = { provider: "github", repository: { owner: "jive-sh", name: "example" }, workflowFile: "pipeline.yml", environment: "latest" };

  beforeAll(async () => {
    const set = await convex(["env", "set", "NPM_REGISTRY_URL", `http://127.0.0.1:${server.port}`]);
    expect(set.exitCode, set.stderr).toBe(0);
  }, TIMEOUT);

  test("packageExists reads the configured registry", async () => {
    expect(await call("packageExists", { packageName: MAINTAINED })).toEqual({ ok: true, value: true });
  }, TIMEOUT);

  test("createPlaceholder hands back npm's second-factor page, then publishes an installable 0.0.0 with the password a person's answer produced", async () => {
    const packageName = "@jive-sh/placeholder-example";
    expect(await call("createPlaceholder", { packageName, account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.publishes).toHaveLength(0);
    expect(await call("createPlaceholder", { packageName, account, oneTimePassword: ANSWERED_PASSWORD }))
      .toEqual({ ok: true, value: { status: "created", version: "0.0.0" } });

    const [published] = registry.publishes;
    expect(published!.name).toBe(packageName);
    const { document } = published!;
    expect(document["dist-tags"]).toEqual({ latest: "0.0.0" });
    expect(document.access).toBe("public");
    const attachment = document._attachments[`${packageName}-0.0.0.tgz`];
    const tarball = Buffer.from(attachment.data, "base64");
    expect(attachment.length).toBe(tarball.length);
    const { dist } = document.versions["0.0.0"];
    expect(dist.integrity).toBe(`sha512-${createHash("sha512").update(tarball).digest("base64")}`);
    expect(dist.shasum).toBe(createHash("sha1").update(tarball).digest("hex"));

    // The system's tar must read it the way npm will.
    const dir = mkdtempSync(join(tmpdir(), "jive-npm-placeholder-"));
    try {
      writeFileSync(join(dir, "placeholder.tgz"), tarball);
      const untar = Bun.spawnSync(["tar", "-xzf", "placeholder.tgz"], { cwd: dir, stderr: "pipe" });
      expect(untar.exitCode, untar.stderr.toString()).toBe(0);
      const manifest = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
      expect(manifest).toMatchObject({ name: packageName, version: "0.0.0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await call("createPlaceholder", { packageName, account })).toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes).toHaveLength(1);
  }, TIMEOUT);

  test("createPlaceholder leaves a package another account maintains alone, and says so", async () => {
    expect(await call("createPlaceholder", { packageName: SOMEONE_ELSES, account }))
      .toEqual({ ok: true, value: { status: "maintainedByAnotherAccount" } });
    expect(await call("createPlaceholder", { packageName: MAINTAINED, account })).toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes).toHaveLength(1);
  }, TIMEOUT);

  test("registerTrustedPublisher hands back npm's second-factor page, registers once with the answered password, then reports it registered", async () => {
    const packageName = MAINTAINED;
    expect(await call("registerTrustedPublisher", { packageName, publisher, account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.trustRequests).toHaveLength(0);
    expect(await call("registerTrustedPublisher", { packageName, publisher, account, oneTimePassword: ANSWERED_PASSWORD }))
      .toEqual({ ok: true, value: { status: "registered" } });
    expect(registry.trustRequests).toEqual([[{
      type: "github",
      claims: { repository: "jive-sh/example", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
      permissions: ["createPackage"],
    }]]);

    const differentCase = { ...publisher, repository: { owner: "Jive-SH", name: "Example" } };
    expect(await call("registerTrustedPublisher", { packageName, publisher: differentCase, account }))
      .toEqual({ ok: true, value: { status: "alreadyRegistered", id: "trust-1" } });
    expect(registry.trustRequests).toHaveLength(1);
  }, TIMEOUT);

  test("listTrustedPublishers marks a publisher validated once a version was published through it", async () => {
    const packageName = MAINTAINED;
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "unvalidated" }] });
    registry.publishedThrough.set(packageName, ["trust-1"]);
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "validated" }] });
  }, TIMEOUT);

  test("removeTrustedPublisher deletes a publisher, and reports one already gone as notFound", async () => {
    const packageName = MAINTAINED;
    expect(await call("removeTrustedPublisher", { packageName, id: "trust-1", account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.trust.get(packageName)).toHaveLength(1);
    const answered = { packageName, id: "trust-1", account, oneTimePassword: ANSWERED_PASSWORD };
    expect(await call("removeTrustedPublisher", answered)).toEqual({ ok: true, value: { status: "removed" } });
    expect(registry.trust.get(packageName)).toEqual([]);
    expect(await call("removeTrustedPublisher", answered)).toEqual({ ok: true, value: { status: "notFound" } });
    expect(registry.deletes).toEqual(["trust-1", "trust-1"]);
  }, TIMEOUT);

  test("a one-time password npm refuses hands back its page again, for a fresh answer", async () => {
    const result = await call("registerTrustedPublisher", {
      packageName: MAINTAINED,
      publisher: { ...publisher, environment: "next" },
      account,
      oneTimePassword: "000000",
    });
    expect(result).toEqual({ ok: true, value: secondFactorRequired });
  }, TIMEOUT);

  test("a refused credential fails the call with the registry's answer", async () => {
    const result = await call("listTrustedPublishers", { packageName: MAINTAINED, account: { ...account, token: "wrong" } });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(`could not list the trusted publishers of ${MAINTAINED}: it answered 401`);
  }, TIMEOUT);

  test("nothing the calls printed contains the token or a one-time password sent to npm", () => {
    const output = printed.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(registry.oneTimePasswordsSeen.length).toBeGreaterThan(0);
    for (const code of registry.oneTimePasswordsSeen) expect(output).not.toMatch(new RegExp(`\\b${code}\\b`));
  });
});
