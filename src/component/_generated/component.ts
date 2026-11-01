/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    packageRegistry: {
      createPlaceholder: FunctionReference<
        "action",
        "internal",
        {
          account: { token: string };
          oneTimePassword?: string;
          packageName: string;
        },
        | { status: "created"; version: string }
        | { status: "alreadyExists" }
        | { status: "maintainedByAnotherAccount" }
        | {
            pageUrl: string;
            resultUrl: string;
            status: "secondFactorRequired";
          },
        Name
      >;
      listTrustedPublishers: FunctionReference<
        "action",
        "internal",
        { account: { token: string }; packageName: string },
        Array<{
          claims: {
            environment?: string;
            provider: "github";
            repository: { name: string; owner: string };
            workflowFile: string;
          };
          id: string;
          status: "validated" | "unvalidated";
        }>,
        Name
      >;
      packageExists: FunctionReference<
        "action",
        "internal",
        { packageName: string },
        boolean,
        Name
      >;
      registerTrustedPublisher: FunctionReference<
        "action",
        "internal",
        {
          account: { token: string };
          oneTimePassword?: string;
          packageName: string;
          publisher: {
            environment?: string;
            provider: "github";
            repository: { name: string; owner: string };
            workflowFile: string;
          };
        },
        | { status: "registered" }
        | { id: string; status: "alreadyRegistered" }
        | {
            pageUrl: string;
            resultUrl: string;
            status: "secondFactorRequired";
          },
        Name
      >;
      removeTrustedPublisher: FunctionReference<
        "action",
        "internal",
        {
          account: { token: string };
          id: string;
          oneTimePassword?: string;
          packageName: string;
        },
        | { status: "removed" }
        | { status: "notFound" }
        | {
            pageUrl: string;
            resultUrl: string;
            status: "secondFactorRequired";
          },
        Name
      >;
    };
  };
