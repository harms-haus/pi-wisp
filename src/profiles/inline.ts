/**
 * Inline profile support.
 *
 * In-workflow profiles defined via `wf.profile(name, { ... })` in the DSL.
 * They are ephemeral (not written to disk) and scoped to the workflow being
 * compiled. The builder stores them in the builder IR and the executor
 * resolves them via the same `resolveProfile` path (S7) with the `"inline"`
 * source scope.
 *
 * An inline profile behaves the same as a persisted one: it uses the same
 * field set, defaults `agentType` to `"pi"`, and has no special privileges.
 */

import { DEFAULT_AGENT_TYPE } from "../constants.js";
import type { WispProfile } from "./types.js";

/**
 * Create a WispProfile from inline DSL fields.
 *
 * The `name` parameter is the profile's map key (not a WispProfile field) and
 * is stripped from the returned object. `agentType` defaults to `"pi"` when
 * absent.
 */
export function inlineProfile(fields: Partial<WispProfile> & { name: string }): WispProfile {
  // `name` is the profile's map key (not a WispProfile field) — strip it.
  const profile = { ...fields } as WispProfile;
  delete (profile as WispProfile & { name?: string }).name;

  if (!profile.agentType) {
    profile.agentType = DEFAULT_AGENT_TYPE;
  }

  return profile;
}
