import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { PENDING_PUBLISHER_WINDOW_MS, planPublisher } from "../src/component/publisherPlan";
import type { TrustedPublisher, TrustedPublisherClaims } from "../src/component/validators";

const wanted: TrustedPublisherClaims = {
  provider: "github",
  repository: { owner: "chaine-dance", name: "jive-test-package" },
  workflowFile: "pipeline.yml",
  environment: "latest",
};
const NOW = 1_800_000_000_000;

describe("planPublisher", () => {
  test("registers when no publisher matches", () => {
    const other: TrustedPublisher = { id: "p1", claims: { ...wanted, environment: "next" }, status: "validated" };
    expect(planPublisher({ listed: [other], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "register", removeIds: [] });
  });

  test("keeps a validated publisher, matching owner and name case-insensitively", () => {
    const listed: TrustedPublisher = { id: "p1", claims: { ...wanted, repository: { owner: "Chaine-Dance", name: "Jive-Test-Package" } }, status: "validated" };
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "keep" });
  });

  test("keeps an unvalidated publisher Jive registered inside the window", () => {
    const listed: TrustedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    const registeredAt = NOW - PENDING_PUBLISHER_WINDOW_MS + 1;
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.some(registeredAt), now: NOW })).toEqual({ action: "keep" });
  });

  test("replaces an unvalidated publisher registered too long ago, which npm may have expired", () => {
    const listed: TrustedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    const registeredAt = NOW - PENDING_PUBLISHER_WINDOW_MS;
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.some(registeredAt), now: NOW }))
      .toEqual({ action: "register", removeIds: ["p1"] });
  });

  test("replaces an unvalidated publisher Jive has no record of registering", () => {
    const listed: TrustedPublisher = { id: "p1", claims: wanted, status: "unvalidated" };
    expect(planPublisher({ listed: [listed], wanted, maybeRegisteredAt: Option.none(), now: NOW })).toEqual({ action: "register", removeIds: ["p1"] });
  });
});
