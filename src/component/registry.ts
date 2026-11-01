import { Effect, pipe } from "effect";
import { env } from "./_generated/server";
import { npmRegistryLayer } from "./npm/impl";
import type { NpmRegistry } from "./npm/interface";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/**
 * Runs one Effect program against the configured registry, as an action's runtime boundary: an unexpected failure
 * becomes the action's error, with its message. No message carries the account's token.
 */
export function runAgainstRegistry<A, E extends { readonly message: string }>(program: Effect.Effect<A, E, NpmRegistry>): Promise<A> {
  return Effect.runPromise(pipe(
    program,
    Effect.mapError((e) => new Error(e.message)),
    Effect.provide(npmRegistryLayer(env.NPM_REGISTRY_URL ?? NPM_REGISTRY_URL)),
  ));
}
