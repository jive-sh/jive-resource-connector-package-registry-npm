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
const MAINTAINED = "maintained-by-the-account";
const SOMEONE_ELSES = "maintained-by-someone-else";
const TIMEOUT = 2 * 60 * 1000;

async function convex(args: ReadonlyArray<string>) {
  // Async, never spawnSync: the fake registry is served by this process, which must keep answering meanwhile.
  const child = Bun.spawn(["bunx", "convex", ...args], { cwd: APP_DIR, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** Everything `convex run` printed, across calls, to check the account token never reaches a log. */
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
  /** A guarded write returns npm's security-key page. Set false only to assert a write npm accepts with no key. */
  securityKeyRequired: true,
  nextTrustId: 1,
};

/** npm's answer when a write must be answered with the account's security key: the page and its done address, and no one-time-password header. */
function secondFactorChallenge(): Response {
  return Response.json(
    { authUrl: "https://www.npmjs.com/auth/cli/approve-1", doneUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
    { status: 401 },
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
      const allowed = !registry.securityKeyRequired;

      if (url.pathname === "/-/whoami") {
        return authorized ? Response.json({ username: USERNAME }) : new Response("Unauthorized", { status: 401 });
      }
      const trust = url.pathname.match(/^\/-\/package\/([^/]+)\/trust(?:\/([^/]+))?$/);
      if (trust !== null) {
        const name = decodeURIComponent(trust[1]!);
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (request.method === "GET") return Response.json(registry.trust.get(name) ?? []);
        if (!allowed) return secondFactorChallenge();
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
        if (!allowed) return secondFactorChallenge();
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

  test("createPlaceholder hands back npm's security-key page and publishes nothing", async () => {
    const packageName = "@jive-sh/placeholder-guarded";
    registry.securityKeyRequired = true;
    expect(await call("createPlaceholder", { packageName, account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.publishes.some((publish) => publish.name === packageName)).toBe(false);
  }, TIMEOUT);

  test("createPlaceholder publishes an installable 0.0.0 when npm does not ask for the security key, and sends no npm-otp", async () => {
    const packageName = "@jive-sh/placeholder-example";
    registry.securityKeyRequired = false;
    expect(await call("createPlaceholder", { packageName, account }))
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
    expect(registry.publishes.filter((publish) => publish.name === packageName)).toHaveLength(1);
    expect(registry.oneTimePasswordsSeen).toEqual([]);
    registry.securityKeyRequired = true;
  }, TIMEOUT);

  test("createPlaceholder leaves a package another account maintains alone, and says so", async () => {
    expect(await call("createPlaceholder", { packageName: SOMEONE_ELSES, account }))
      .toEqual({ ok: true, value: { status: "maintainedByAnotherAccount" } });
    expect(await call("createPlaceholder", { packageName: MAINTAINED, account })).toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes.filter((publish) => publish.name === "@jive-sh/placeholder-example")).toHaveLength(1);
  }, TIMEOUT);

  test("registerTrustedPublisher hands back npm's security-key page, then registers once when npm does not ask, and sends no npm-otp", async () => {
    const packageName = MAINTAINED;
    registry.securityKeyRequired = true;
    expect(await call("registerTrustedPublisher", { packageName, publisher, account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.trustRequests).toHaveLength(0);
    registry.securityKeyRequired = false;
    expect(await call("registerTrustedPublisher", { packageName, publisher, account }))
      .toEqual({ ok: true, value: { status: "registered" } });
    expect(registry.trustRequests).toEqual([[{
      type: "github",
      claims: { repository: "jive-sh/example", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
      permissions: ["createPackage"],
    }]]);

    const differentCase = { ...publisher, repository: { owner: "Jive-SH", name: "Example" } };
    registry.securityKeyRequired = true;
    expect(await call("registerTrustedPublisher", { packageName, publisher: differentCase, account }))
      .toEqual({ ok: true, value: { status: "alreadyRegistered", id: "trust-1" } });
    expect(registry.trustRequests).toHaveLength(1);
    expect(registry.oneTimePasswordsSeen).toEqual([]);
  }, TIMEOUT);

  test("listTrustedPublishers marks a publisher validated once a version was published through it", async () => {
    const packageName = MAINTAINED;
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "unvalidated" }] });
    registry.publishedThrough.set(packageName, ["trust-1"]);
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "validated" }] });
  }, TIMEOUT);

  test("removeTrustedPublisher hands back npm's security-key page, then deletes once npm does not ask", async () => {
    const packageName = MAINTAINED;
    registry.securityKeyRequired = true;
    expect(await call("removeTrustedPublisher", { packageName, id: "trust-1", account })).toEqual({ ok: true, value: secondFactorRequired });
    expect(registry.trust.get(packageName)).toHaveLength(1);
    registry.securityKeyRequired = false;
    const answered = { packageName, id: "trust-1", account };
    expect(await call("removeTrustedPublisher", answered)).toEqual({ ok: true, value: { status: "removed" } });
    expect(registry.trust.get(packageName)).toEqual([]);
    expect(await call("removeTrustedPublisher", answered)).toEqual({ ok: true, value: { status: "notFound" } });
    expect(registry.deletes).toEqual(["trust-1", "trust-1"]);
    expect(registry.oneTimePasswordsSeen).toEqual([]);
    registry.securityKeyRequired = true;
  }, TIMEOUT);

  test("a refused credential fails the call with the registry's answer", async () => {
    const result = await call("listTrustedPublishers", { packageName: MAINTAINED, account: { ...account, token: "wrong" } });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(`could not list the trusted publishers of ${MAINTAINED}: it answered 401`);
  }, TIMEOUT);

  describe("resource.ensureInstance", () => {
    const caller = (id: string) => ({ codeRepository: { id, owner: "jive-sh", name: "example" }, environment: "latest", workflowFile: "pipeline.yml" });
    const ensure = (packageName: string, codeRepositoryId: string) => call("ensureInstance", { instance: { packageName }, caller: caller(codeRepositoryId), account });
    /** A package the account maintains, with one publisher for jive-sh/example's pipeline.yml in `latest`. */
    function maintainedWithPublisher(packageName: string, id: string, input: { readonly published: boolean }) {
      registry.maintainers.set(packageName, [USERNAME]);
      registry.trust.set(packageName, [{
        id,
        type: "github",
        claims: { repository: "jive-sh/example", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
        permissions: ["createPackage"],
      }]);
      if (input.published) registry.publishedThrough.set(packageName, [id]);
    }

    test("a new package answers personNeeded with npm's page, publishing nothing, and releases its claim", async () => {
      const packageName = "@jive-sh/ensure-new";
      const publishes = registry.publishes.length;
      const personNeeded = {
        ok: true,
        value: {
          status: "personNeeded",
          reason: `npm asks for its security key to publish ${packageName}'s placeholder`,
          url: "https://www.npmjs.com/auth/cli/approve-1",
          resultUrl: "https://registry.npmjs.org/-/v1/done?authId=1",
        },
      };
      expect(await ensure(packageName, "repo-1")).toEqual(personNeeded);
      // Not inProgress: the first call released its claim.
      expect(await ensure(packageName, "repo-1")).toEqual(personNeeded);
      expect(registry.publishes).toHaveLength(publishes);
    }, TIMEOUT);

    test("a new package becomes ready when npm does not ask for the security key, and no npm-otp is sent", async () => {
      const packageName = "ensure-answered";
      registry.securityKeyRequired = false;
      const result = await call("ensureInstance", {
        instance: { packageName },
        caller: caller("repo-answered"),
        account,
      });
      expect(result).toMatchObject({ ok: true, value: { status: "ready", instance: { packageName } } });
      expect(registry.publishes.some((publish) => publish.name === packageName)).toBe(true);
      expect(registry.oneTimePasswordsSeen).toEqual([]);
      registry.securityKeyRequired = true;
    }, TIMEOUT);

    test("a package whose publisher for the caller has published is ready with no write, with the same instanceId every time", async () => {
      const packageName = "ensure-ready";
      maintainedWithPublisher(packageName, "trust-ready", { published: true });
      const trustRequests = registry.trustRequests.length;
      const first = await ensure(packageName, "repo-1");
      expect(first).toMatchObject({ ok: true, value: { status: "ready", instance: { packageName } } });
      const instanceId = first.ok ? first.value.instanceId : undefined;
      expect(instanceId).toBeString();
      expect(await ensure(packageName, "repo-1")).toEqual({ ok: true, value: { status: "ready", instanceId, instance: { packageName } } });
      expect(registry.trustRequests).toHaveLength(trustRequests);
    }, TIMEOUT);

    test("the package is bound to the code repository that provisioned it; another is refused before npm is asked", async () => {
      expect(await ensure("ensure-ready", "repo-2"))
        .toEqual({ ok: true, value: { status: "refused", reason: "ensure-ready is provisioned for another code repository" } });
    }, TIMEOUT);

    test("a package another npm account maintains is refused", async () => {
      expect(await ensure(SOMEONE_ELSES, "repo-1")).toEqual({
        ok: true,
        value: { status: "refused", reason: `${SOMEONE_ELSES} exists on npm and the organization's npm account does not maintain it` },
      });
    }, TIMEOUT);

    test("an unvalidated publisher Jive has no record of registering may have expired, so it is replaced: npm's page for the removal", async () => {
      maintainedWithPublisher("ensure-stale", "trust-stale", { published: false });
      const result = await ensure("ensure-stale", "repo-1");
      expect(result).toMatchObject({ ok: true, value: { status: "personNeeded", reason: expect.stringContaining("remove trusted publisher trust-stale from ensure-stale") } });
    }, TIMEOUT);

    test("while another caller holds the package's claim, the answer is inProgress", async () => {
      const claimed = await convex(["run", "--component", "packageRegistryNpm", "resource:claim", JSON.stringify({ packageName: "ensure-ready", holder: "another-job" })]);
      expect(claimed.exitCode, claimed.stderr).toBe(0);
      expect(await ensure("ensure-ready", "repo-1")).toEqual({ ok: true, value: { status: "inProgress", retryAfterSeconds: 10 } });
      const released = await convex(["run", "--component", "packageRegistryNpm", "resource:release", JSON.stringify({ packageName: "ensure-ready", holder: "another-job" })]);
      expect(released.exitCode, released.stderr).toBe(0);
      expect(await ensure("ensure-ready", "repo-1")).toMatchObject({ ok: true, value: { status: "ready" } });
    }, TIMEOUT);
  });

  test("nothing the calls printed contains the token, and no npm-otp was sent", () => {
    const output = printed.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(registry.oneTimePasswordsSeen).toEqual([]);
  });
});
