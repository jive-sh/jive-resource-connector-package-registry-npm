import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The component's own tables; an installing app cannot read them except through the component's functions.
export default defineSchema({
  /**
   * Each package `resource.ensureInstance` provisioned: an instance of this resource. It is bound to the code
   * repository that first provisioned it (`codeRepositoryId`, the installing app's id). `trustedPublishers` records
   * when Jive registered each environment's publisher, because npm doesn't say whether an unvalidated publisher is
   * still waiting for its first publish or expired.
   */
  packages: defineTable({
    packageName: v.string(),
    codeRepositoryId: v.string(),
    trustedPublishers: v.array(v.object({ environment: v.string(), registeredAt: v.number() })),
    lastProvisionedAt: v.number(),
  }).index("by_package_name", ["packageName"]),

  /**
   * At most one provisioning of a package at a time: taken in a mutation, so Convex's serializable transactions let
   * one caller win, before the action calls npm. An action that dies never releases its claim, so a claim past
   * `expiresAt` may be taken over.
   */
  provisioningClaims: defineTable({
    packageName: v.string(),
    holder: v.string(),
    expiresAt: v.number(),
  }).index("by_package_name", ["packageName"]),
});
